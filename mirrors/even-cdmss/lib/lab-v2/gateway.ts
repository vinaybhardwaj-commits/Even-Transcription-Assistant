/**
 * lib/lab-v2/gateway.ts — budget, dispatch, attribution (LAB-MCP-V2-PRD-v1.0 §6).
 *
 * Every model call a lab run makes passes through here, and the ORDER of operations is
 * the contract:
 *
 *   reserve (atomic, against the cap)  →  write the `calls` row  →  network  →  settle
 *
 * The reservation and the intent row both land BEFORE the network request. That ordering
 * is what makes a killed function accountable: if the process dies mid-call, the row says
 * a call was in flight and its money is still held against the cap, so the reaper can
 * move it to `unknown` instead of the spend simply vanishing. Reserving after the call,
 * or writing the row after the call, would both produce a budget that silently forgets.
 *
 * ATTRIBUTION IS A MEASUREMENT, NOT A CLAIM (§6.2). `requested` is what the arm named;
 * `served` is what the transport receipt says actually answered. When they disagree the
 * result is STILL STORED — throwing it away would hide the disagreement — but the item is
 * marked `attribution_status: 'invalid'` and every comparison excludes it by default.
 */
import type { Db } from './db';
import { LabError, hash, type AttributionStatus, type Provider } from './contracts';
import { PRICING_VERSION, costMicrousd, isSupportedModel } from './pricing';
import {
  openCall, settleCall, markCallUnknown, reserve, settleReservation, moveReservationToUnknown, writeStep,
} from './store';
import type { Transport } from './transport';

export interface StageSpec {
  provider: Provider;
  model: string;
  options?: Record<string, unknown>;
  max_cost_microusd: number;
}

export interface GatewayDeps {
  db: Db;
  itemId: string;
  leaseToken: number;
  budgetId: string;
  transport: Transport;
  stages: Record<string, StageSpec>;
  signal?: AbortSignal;
  /** Owner for the artifacts the steps rows point at. Defaults to 'system'. */
  owner?: string;
  /**
   * Decision 22 — the engine's per-attempt ceiling, supplied by the adapter. An arm stage may
   * override it with `options.timeout_ms`; absent both, the call runs on the SDK client default,
   * which is the state the live run was in.
   */
  defaultTimeoutMs?: number;
}

export interface StageResult { text: string; completion: unknown; actualMicrousd: number | null }

/**
 * DECISION 45 — the request hash a replay matches on.
 *
 * `sha256` of the CANONICAL request body sent to the transport, i.e. the `params` object the
 * engine built, with object keys sorted at every depth (lib/lab-v2/contracts.ts `hash`). It is the
 * prompt, the messages, the temperature, the token caps — everything that decides what the model
 * was asked. It deliberately does NOT include the provider or the model: replaying the same
 * request against a different model is a legitimate Slice B experiment, and the hash is there to
 * catch a changed QUESTION, not a changed answerer.
 *
 * `lab_v2.calls.request_hash` is a different hash of a different thing — the (provider, model,
 * options) triple — and is unchanged. Two hashes, two questions, both named.
 */
export function dependencyHash(params: unknown): string {
  return hash(params);
}

/** invalid beats unknown beats verified — the worst outcome across a run's calls wins. */
const RANK: Record<AttributionStatus, number> = {
  verified: 0,
  // DECISION 65's fourth value is UNREACHABLE HERE by construction: this class only ever notes a
  // status for a call it actually dispatched, and a replayed item dispatches none. It is ranked
  // with `verified` rather than with a failure because it is not one — but nothing reads this
  // entry, and worker.ts is where `replayed` is decided.
  replayed: 0,
  // DECISION 115's fifth value, and unreachable here for the SAME reason and more strongly: it
  // means no call was dispatched at all, so `note()` — which runs once per dispatched call — can
  // never see it. Present only because this map is exhaustive over `AttributionStatus`; inert.
  // (CLAUDE.md rule 1a: forced by contracts.ts:318, which D2a item 4 names. One entry, no logic.)
  not_applicable: 0,
  unknown: 1,
  invalid: 2,
};

export class Gateway {
  private worst: AttributionStatus = 'verified';
  private sawCall = false;
  constructor(private readonly deps: GatewayDeps) {}

  /** The item's attribution_status: the worst any of its calls achieved (§9). */
  attributionStatus(): AttributionStatus {
    return this.sawCall ? this.worst : 'unknown';
  }

  /**
   * DECISION 121 — WHETHER A CALL WAS DISPATCHED AT ALL, which `attributionStatus()` cannot say.
   *
   * That method returns `unknown` for two different facts: "one call went out and I could not
   * attribute it" and "no call went out". D2a's `not_applicable` needed the second and had only
   * the first available, so an item whose single call settled with no usage was reported as
   * having made none. This is the missing half of that question and nothing else: it is a
   * MEASUREMENT of dispatch, it never decides a status, and `worker.ts` is still the only place
   * `not_applicable` is chosen.
   */
  sawAnyCall(): boolean {
    return this.sawCall;
  }

  private note(status: AttributionStatus) {
    this.sawCall = true;
    if (RANK[status] > RANK[this.worst]) this.worst = status;
  }

  /**
   * One budgeted, attributed model call at one named stage.
   * Throws LabError('BUDGET_EXHAUSTED') when the cap refuses it; re-throws transport
   * errors after moving the reservation to `unknown`.
   */
  async call(stage: string, params: Record<string, unknown>): Promise<StageResult> {
    const spec = this.deps.stages[stage];
    if (!spec) throw new LabError('MODEL_UNSUPPORTED', `arm names no model for stage '${stage}'`);
    if (!isSupportedModel(spec.provider, spec.model)) {
      throw new LabError('MODEL_UNSUPPORTED', `(${spec.provider}, ${spec.model}) is not a priced, supported target`);
    }
    const { db, itemId, leaseToken, budgetId, transport } = this.deps;
    const requested = { provider: spec.provider, model: spec.model, options: spec.options ?? {} };
    const max = spec.max_cost_microusd;

    // 1. Reserve FIRST. Zero rows updated is the refusal, atomically (§6.3).
    const reserved = await reserve(db, budgetId, max);
    if (!reserved) {
      await openCall(db, itemId, leaseToken, stage, budgetId, requested, 0, PRICING_VERSION, 'refused');
      throw new LabError('BUDGET_EXHAUSTED', `budget refused ${max} microusd for stage '${stage}'`);
    }

    // 2. The intent row, before the network. This is the evidence a killed worker leaves.
    const callId = await openCall(db, itemId, leaseToken, stage, budgetId, requested, max, PRICING_VERSION, 'reserved');

    // 3. Dispatch.
    let result;
    // Decision 22 — the arm's own ceiling when it names one, else the engine's.
    const stageTimeout = Number(spec.options?.timeout_ms);
    const timeoutMs = Number.isFinite(stageTimeout) && stageTimeout > 0 ? stageTimeout : this.deps.defaultTimeoutMs;
    try {
      result = await transport({ provider: spec.provider, model: spec.model, params, timeoutMs, signal: this.deps.signal });
    } catch (e) {
      // A transport error with no usage: we cannot know whether the money was spent, so
      // it stays against the cap in `unknown` until an operator reconciles it (§6.3).
      await markCallUnknown(db, callId);
      await moveReservationToUnknown(db, budgetId, max);
      this.note('unknown');
      throw e;
    }

    // 4. Settle. An unpriced model yields a null cost — recorded as such, never guessed.
    const actual = result.usage ? costMicrousd(spec.provider, spec.model, result.usage.input_tokens, result.usage.output_tokens) : null;
    if (actual === null) {
      await markCallUnknown(db, callId);
      await moveReservationToUnknown(db, budgetId, max);
      this.note('unknown');
    } else {
      // Decision 16 — charge `actual`, NOT min(actual, max). The cap is enforced at
      // RESERVATION, not at settlement: by the time a response is back the money is
      // already spent, and clamping it would make `calls.actual_microusd` and
      // `budgets.spent_microusd` disagree — the budget would under-report a real overspend
      // and the two numbers could never be reconciled. An overspend above the reservation
      // is a fact, and it belongs in `spent` where it is visible.
      await settleCall(db, callId, result.served, actual);
      await settleReservation(db, budgetId, max, actual);
      this.note(this.classify(requested, result.served));
    }

    // DECISION 45 — the raw reply, stored as this stage's `steps` row, keyed by the hash of the
    // request that produced it. Written HERE rather than in each adapter: the gateway is the one
    // place every stage of every engine passes through, so all six adapters get it from one
    // implementation and none of them can forget. A step is evidence, so a failure to store it
    // must not fail the run — the catch is deliberate and the run continues unreplayable.
    try {
      await writeStep(db, itemId, stage, dependencyHash(params), {
        stage,
        request_hash: dependencyHash(params),
        completion: result.completion,
        text: result.text,
        served: result.served,
      }, this.deps.owner ?? 'system');
    } catch { /* replay is a convenience; losing it must never lose the result */ }
    return { text: result.text, completion: result.completion, actualMicrousd: actual };
  }

  /** §6.2 — verified only when the receipt exists AND names the requested target. */
  private classify(requested: { provider: string; model: string }, served: { provider: string; model: string | null } | null): AttributionStatus {
    if (!served) return 'unknown';
    if (served.provider !== requested.provider) return 'invalid';
    if (served.model !== requested.model) return 'invalid';
    return 'verified';
  }
}
