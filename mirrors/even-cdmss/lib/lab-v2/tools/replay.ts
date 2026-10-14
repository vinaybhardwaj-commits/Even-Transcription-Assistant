/**
 * lib/lab-v2/tools/replay.ts — `run_replay`, exact mode (§10, decision 45).
 *
 * WHAT EXACT REPLAY IS FOR. A stored result is only evidence if you can show what produced it.
 * Exact replay re-runs an item against the SAME frozen inputs and the SAME stored model replies,
 * and asserts the result hash is unchanged. If it is, every deterministic step between the model's
 * words and the stored finding is reproducible; if it is not, something in that path moved, and
 * the run that reported it is no longer evidence for anything. This is the mechanism B2's golden
 * A/B uses to prove the IPD extraction changed nothing.
 *
 * ⚠️ ZERO MODEL CALLS, AND ZERO MODEL COST. The replay transport never reaches a provider: it
 * answers from `lab_v2.steps`. It reports zero usage, so every stage settles at zero and the
 * budget moves by nothing. A replay that could silently spend would be useless for the one job it
 * has, which is to be run often and cheaply.
 *
 * ⚠️ DECISION 65 — EVERY REPLAYED ITEM IS `attribution_status: 'replayed'`. The stored receipt is
 * replayed with the reply, so the gateway would have classified it `verified` — a word about a
 * call that was attributed, said of a call nobody made today. `replayed` is the fourth value, and
 * `worker.ts` sets it from the fact that the item ran on a replay transport, not from anything an
 * adapter claims.
 *
 * ⚠️ AND IT REFUSES RATHER THAN IMPROVISES. A stage whose request hash is not among the stored
 * steps is `REPLAY_DIVERGED`, not a live call and not a skipped stage. The question a replay
 * answers is "is this still the same run", so an unmatched request is the answer, not an obstacle.
 */
import { z } from 'zod';
import { LabError } from '../contracts';
import { dependencyHash } from '../gateway';
import { getObject, getRun, itemsOf, stepsOf, submitRun } from '../store';
import { tick } from '../worker';
import type { Transport } from '../transport';
import type { Db } from '../db';

export const REPLAY_SCHEMAS = {
  run_replay: {
    input: z.object({
      run_id: z.string().uuid(),
      mode: z.literal('exact').default('exact'),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      source_run_id: z.string().uuid(),
      replay_run_id: z.string().uuid(),
      mode: z.literal('exact'),
      deduplicated: z.boolean(),
      items: z.number().int(),
      equal: z.number().int(),
      not_equal: z.number().int(),
      diverged: z.number().int(),
      /** Always 0: the live transport is wired to throw, so a model call cannot happen. */
      model_calls: z.number().int(),
      /** How many stored stages were served from `steps` — the work a replay actually did. */
      replayed_stages: z.number().int(),
      per_item: z.array(z.object({
        case_key: z.string(),
        source_item_id: z.string().uuid(),
        replay_item_id: z.string().uuid(),
        source_result_hash: z.string().nullable(),
        replay_result_hash: z.string().nullable(),
        equal: z.boolean(),
        state: z.string(),
        error: z.string().nullable(),
        /** DECISION 65 — nothing was served on this item's behalf today; the receipt is the source's. */
        attribution_status: z.string().nullable(),
      })),
    }),
  },
} as const;

/**
 * The transport a replayed item runs on. It is bound to ONE source item, and it matches on the
 * request hash alone — not the stage name — because the hash IS the identity of the request
 * (decision 45). A stage renamed between runs still replays; a stage whose prompt changed does not,
 * which is the correct way round.
 */
export function replayTransport(db: Db, sourceItemId: string, onCall?: () => void): Transport {
  return async (req) => {
    onCall?.();
    const steps = await stepsOf(db, sourceItemId);
    const want = dependencyHash(req.params);
    const match = [...steps.values()].find((s) => s.dependency_hash === want);
    if (!match) {
      throw new LabError(
        'REPLAY_DIVERGED',
        `no stored step for this request on item ${sourceItemId}: the request hash ${want.slice(0, 12)}… is not among ${steps.size} stored step(s)`,
      );
    }
    const artifact = await getObject(db, match.artifact_id);
    const body = (artifact?.body ?? {}) as { completion?: unknown; text?: string; served?: unknown };
    return {
      completion: body.completion ?? null,
      // The served receipt is replayed too, so attribution on a replay reports what ACTUALLY
      // served the original — not the replay's own (absent) provider.
      served: (body.served ?? null) as never,
      // Zero usage ⇒ zero cost. A replay must be free to be worth running.
      usage: { input_tokens: 0, output_tokens: 0 },
      text: body.text ?? '',
    };
  };
}

export interface ReplayDeps { db: Db; principal: string }

export async function runReplay(deps: ReplayDeps, args: { run_id: string; mode: 'exact'; idempotency_key: string }) {
  const { db, principal } = deps;
  const source = await getRun(db, args.run_id);
  if (!source) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
  if (source.owner !== principal) throw new LabError('OWNER_ONLY', 'a run may only be replayed by its owner');

  const sourceItems = await itemsOf(db, source.id, 1000, 0);
  if (!sourceItems.length) throw new LabError('INVALID_INPUT', `run ${source.id} has no items to replay`);

  // The replayed items carry their source's payload unchanged plus a pointer back, so the engine
  // sees the same frozen inputs and the same arm — only the transport differs.
  const items = sourceItems.map((i) => ({
    case_key: i.case_key,
    arm_hash: i.arm_hash,
    repetition: i.repetition,
    payload: { ...(i.payload as Record<string, unknown>), replay_from: i.id },
  }));

  const { run, deduplicated } = await submitRun(
    db, principal, 'run_replay', source.experiment_id, source.budget_id,
    args.idempotency_key, `replay:${source.id}`, 24 * 60 * 60 * 1000, items,
  );

  // Drive it here rather than waiting for the cron: a replay makes no model call, so it costs
  // nothing to finish now, and the tool's whole value is reporting equality per item immediately.
  let calls = 0;
  const countCall = () => { calls += 1; };
  if (!deduplicated) {
    for (let pass = 0; pass < 60; pass += 1) {
      const report = await tick({
        db,
        transport: (async () => { throw new LabError('REPLAY_DIVERGED', 'the live transport must never be reached on a replay'); }) as never,
        maxItems: 10,
        replayTransportFor: (itemId: string, sourceId: string) => replayTransport(db, sourceId, countCall),
      });
      if (report.claimed === 0) break;
    }
  }

  const replayItems = await itemsOf(db, run.id, 1000, 0);
  const bySource = new Map(sourceItems.map((i) => [i.id, i]));
  const hashOf = (v: unknown): string | null =>
    ((v as { result_hash?: string } | null)?.result_hash ?? null);

  const per_item = replayItems.map((r) => {
    const src = bySource.get(String((r.payload as { replay_from?: string }).replay_from ?? ''));
    const sourceHash = hashOf(src?.result);
    const replayHash = hashOf(r.result);
    return {
      case_key: r.case_key,
      source_item_id: src?.id ?? r.id,
      replay_item_id: r.id,
      source_result_hash: sourceHash,
      replay_result_hash: replayHash,
      equal: sourceHash != null && sourceHash === replayHash,
      state: r.state,
      // DECISION 65. Written by worker.ts, which knows the item ran on a replay transport. Reported
      // here so a reader of a replay never has to infer from `model_calls: 0` that the `verified`
      // beside it is about a call the source run made, not this one.
      attribution_status: r.attribution_status ?? null,
      error: r.error ? String((r.error as { message?: string }).message ?? JSON.stringify(r.error)).slice(0, 300) : null,
    };
  });

  return {
    source_run_id: source.id,
    replay_run_id: run.id,
    mode: 'exact' as const,
    deduplicated,
    items: per_item.length,
    equal: per_item.filter((p) => p.equal).length,
    not_equal: per_item.filter((p) => !p.equal && p.state === 'succeeded').length,
    diverged: per_item.filter((p) => (p.error ?? '').includes('REPLAY_DIVERGED')).length,
    // Structurally zero, not merely observed to be: the live transport passed to tick() throws on
    // contact, so a stage that did not match a stored step fails the item rather than calling out.
    model_calls: 0,
    replayed_stages: calls,
    per_item,
  };
}
