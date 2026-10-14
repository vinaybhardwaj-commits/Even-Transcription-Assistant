/**
 * lib/lab-v2/worker.ts — one tick of the queue (LAB-MCP-V2-PRD-v1.0 §5.3, decision 3).
 *
 * Decision 3 puts Slice A's worker on a Vercel cron rather than a long-lived process:
 * the cron hits an idempotent tick route that claims BOUNDED work inside `maxDuration`.
 * Everything below is written to be safe when the function is killed at any instruction,
 * because on Vercel it eventually will be.
 *
 * THE SAFETY ARGUMENT, IN ORDER.
 *   · Work is claimed with a LEASE, not a flag. A killed worker's lease simply expires;
 *     the next tick reaps it. Nothing needs to run on the way down.
 *   · Every write asserts the lease token, so a zombie that wakes up after its item was
 *     reaped and re-claimed writes nothing at all.
 *   · The loop stops at 4 items or 500 s elapsed, well inside `maxDuration = 800`, so the
 *     tick returns a report rather than being killed mid-item as a matter of routine.
 *   · Reservations are written before the network, so money in flight is visible to the
 *     reaper even when the process that spent it is gone.
 */
import type { Db } from './db';
import {
  DATASET_FREEZE_OPERATION, HEARTBEAT_MS, TICK_MAX_ITEMS, TICK_MAX_ELAPSED_MS, WORKER_ID, LabError, hash,
  type AssessmentStatus, type ExecutionStatus, type ItemState,
} from './contracts';
import { Gateway, type StageSpec } from './gateway';
import {
  claim, deriveRunState, finish, getObject, getRun, getWorker, heartbeat, isCancelRequested,
  putObject, reap, recordEvent,
} from './store';
import type { Transport } from './transport';
// Round A3 (decision 37): the multi-engine registry, since §17.3 leaves adapters/opd.ts untouched.
import { ALL_ADAPTERS, type Adapter } from './adapters/types';

/**
 * Slice B round B3 (§17.6, decision 67) — THE WRITING ADAPTERS, and why they are not in
 * `ALL_ADAPTERS`.
 *
 * A repair adapter runs the same engine as its ordinary twin and then calls the engine's OWN store
 * writer, under `exitLabExecution`, to land a new production row. That is a real production write
 * from inside a research platform, so it must be unreachable except through the one door decision
 * 67 opens. Keeping it out of the global registry means an item can only reach it by being claimed
 * from a run whose `operation` is 'reaudit'.
 *
 * Required lazily, as the six are, so the IPD pipeline and the OPD engine are not pulled into the
 * module graph of every importer of this file.
 */
function repairAdapters(): Record<string, Adapter> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { makeIpdEpisodeRepairAdapter } = require('./adapters/ipd-episode') as typeof import('./adapters/ipd-episode');
  const { makeOpdRepairAdapter } = require('./adapters/opd') as typeof import('./adapters/opd');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { ...ALL_ADAPTERS(), ipd_episode: makeIpdEpisodeRepairAdapter(), opd_note_audit: makeOpdRepairAdapter() };
}

/**
 * §17.11 decision 144 — the freeze map. Required lazily like the repair map, and for one more
 * reason: `adapters/dataset-freeze.ts` drags `sources/ipd-discharge.ts`, which drags the whole
 * `lib/doc-audit.ts` module graph that `route-budget-guard.test.ts` reads as source text.
 */
function freezeAdaptersFor(db: Db): Record<string, Adapter> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { freezeAdapters } = require('./adapters/dataset-freeze') as typeof import('./adapters/dataset-freeze');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return freezeAdapters(db);
}

export interface TickOptions {
  db: Db;
  transport: Transport;
  worker?: string;
  maxItems?: number;
  maxElapsedMs?: number;
  /** Injected in tests so a tick is deterministic rather than wall-clock dependent. */
  now?: () => number;
  /** Injection seam for unit tests (repo idiom). Production uses the real ADAPTERS map. */
  adapters?: Record<string, Adapter>;
  /**
   * Decision 45 — when an item carries `replay_from`, its stages are served from that item's
   * stored `steps` instead of a provider. Supplied by `run_replay`; absent on every normal tick,
   * where an item never carries `replay_from` and this is never consulted.
   */
  replayTransportFor?: (itemId: string, sourceItemId: string) => Transport;
}

export interface TickReport {
  claimed: number;
  finished: number;
  reaped: number;
  paused?: boolean;
}

export async function tick(opts: TickOptions): Promise<TickReport> {
  const { db, transport } = opts;
  const workerId = opts.worker ?? WORKER_ID;
  const maxItems = opts.maxItems ?? TICK_MAX_ITEMS;
  const maxElapsed = opts.maxElapsedMs ?? TICK_MAX_ELAPSED_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();

  // 1. Reap first: a lease that expired while we were away frees its item for THIS tick.
  const reaped = await reap(db);

  // 2. A paused worker claims nothing. Running items elsewhere finish on their own.
  const worker = await getWorker(db, workerId);
  if (worker.paused) return { claimed: 0, finished: 0, reaped, paused: true };

  let claimed = 0;
  let finished = 0;

  while (claimed < maxItems && now() - startedAt < maxElapsed) {
    const item = await claim(db, workerId);
    if (!item) break;
    claimed += 1;
    // A replayed item runs on its source's stored replies; everything else on the live transport.
    const replayFrom = (item.payload as { replay_from?: string })?.replay_from;
    const itemTransport = replayFrom && opts.replayTransportFor
      ? opts.replayTransportFor(item.id, String(replayFrom))
      : transport;
    /**
     * DECISION 67 — THE ONLY DOOR TO A PRODUCTION WRITE, and it is deliberately narrow.
     *
     * `runs.operation` is not a caller-supplied field anywhere in this platform: `experiment_run`
     * writes 'experiment_run', `run_replay` writes 'run_replay', `run_retry` writes 'run_retry',
     * and only `reaudit_execute` — production_write, operator only — writes 'reaudit'. So a
     * research key cannot manufacture a run that reaches the writing adapters, whatever it puts in
     * a payload or an arm. The check is on the RUN, not on anything the item carries.
     *
     * An explicitly injected adapter map (tests, `run_replay`) still wins, so this cannot surprise
     * a caller that said what it wanted.
     */
    const run = opts.adapters ? null : await getRun(db, item.run_id);
    const repair = run?.operation === 'reaudit';
    /**
     * §17.11 DECISION 144 — THE SECOND OPERATION-ROUTED MAP, on exactly the precedent above.
     *
     * A `dataset_freeze` item does not run an engine: it freezes ONE case and stores it, and the
     * last item of the run assembles the dataset. It is kept out of `ALL_ADAPTERS` for the same
     * reason the repair adapters are — the only way to reach it is to be claimed from a run whose
     * `operation` is `dataset_freeze`, and that string is written by `dataset_create` and by
     * nothing a caller controls.
     *
     * ⚠️ IT NEEDS THE DB, WHICH AN ENGINE ADAPTER NEVER DOES. The assembly reads its siblings'
     * artifacts and writes the dataset object, so the map is built per tick around this tick's
     * connection rather than cached like the engine registry.
     */
    const isFreeze = run?.operation === DATASET_FREEZE_OPERATION;
    const adapters = opts.adapters
      ?? (repair ? repairAdapters() : isFreeze ? freezeAdaptersFor(db) : ALL_ADAPTERS());
    const ok = await runItem({ db, transport: itemTransport, item, workerId, adapters, replayed: Boolean(replayFrom) });
    if (ok) finished += 1;
    await deriveRunState(db, item.run_id);
  }

  return { claimed, finished, reaped };
}

interface RunItemArgs {
  db: Db;
  transport: Transport;
  item: Awaited<ReturnType<typeof claim>> & object;
  workerId: string;
  adapters: Record<string, Adapter>;
  /** DECISION 65 — this item ran on stored replies, so nothing was served on its behalf today. */
  replayed?: boolean;
}

/**
 * One leased item, start to finish. Always ends by calling `finish` with all three
 * statuses (§9) unless the lease was lost — in which case it deliberately writes nothing.
 */
async function runItem({ db, transport, item, workerId, adapters, replayed }: RunItemArgs): Promise<boolean> {
  const leaseToken = item.lease_token;
  const controller = new AbortController();
  const payload = item.payload as { engine?: string; frozen?: Record<string, unknown>; arm?: Record<string, unknown>; budget_id?: string };
  const events: { kind: string; body: Record<string, unknown> }[] = [];

  // The heartbeat does two jobs: it extends the lease, and it is the ONLY place the
  // adapter learns about cancellation (§5.4) or about having lost its lease. Both abort
  // the same way, because from the adapter's point of view they are the same event: this
  // attempt is no longer the one that owns the item.
  let lost = false;
  const beat = setInterval(() => {
    void (async () => {
      try {
        const held = await heartbeat(db, item.id, leaseToken, workerId);
        if (!held) { lost = true; controller.abort(); return; }
        if (await isCancelRequested(db, item.run_id)) controller.abort();
      } catch { /* a failed heartbeat is not itself fatal; the lease will simply lapse */ }
    })();
  }, HEARTBEAT_MS);

  const stages = (payload.arm?.stages ?? {}) as Record<string, StageSpec>;
  const budgetId = String(payload.budget_id ?? '');
  // Resolved BEFORE the gateway, because decision 22 makes the gateway's default ceiling the
  // adapter's. A missing adapter is still handled below, as an ENGINE_UNSUPPORTED failure.
  const adapter = adapters[String(payload.engine ?? '')];
  const gateway = new Gateway({
    db, itemId: item.id, leaseToken, budgetId, transport, stages,
    signal: controller.signal,
    defaultTimeoutMs: adapter?.perAttemptTimeoutMs,
  });

  let state: ItemState = 'failed';
  let execution: ExecutionStatus = 'failed';
  let assessment: AssessmentStatus = 'not_reached';
  let result: unknown = null;
  let error: Record<string, unknown> | null = null;
  let outcome = 'failed';

  try {
    if (!adapter) throw new LabError('ENGINE_UNSUPPORTED', `no round-1 adapter for engine '${payload.engine}'`);

    const outcomeOfRun = await adapter.run({
      runId: item.run_id,
      itemId: item.id,
      caseKey: item.case_key,
      frozen: payload.frozen ?? {},
      arm: payload.arm ?? {},
      repetition: item.repetition,
      gateway,
      signal: controller.signal,
      event: (kind, body) => { events.push({ kind, body }); },
      checkpoint: async <T,>(name: string, dependencyHash: string, produce: () => Promise<T>): Promise<T> => {
        const value = await produce();
        // Slice A writes steps; Slice B's exact code replay reads them (§4.1).
        const { object } = await putObject(db, item.lease_owner ?? workerId, 'artifact', value as unknown, 'deidentified', null);
        await db.query(
          `INSERT INTO lab_v2.steps (item_id, name, dependency_hash, artifact_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (item_id, name) DO UPDATE SET dependency_hash = EXCLUDED.dependency_hash, artifact_id = EXCLUDED.artifact_id`,
          [item.id, name, dependencyHash, object.id],
        );
        return value;
      },
    });

    result = outcomeOfRun.result;
    execution = outcomeOfRun.execution_status;
    assessment = outcomeOfRun.assessment_status;
    state = execution === 'succeeded' ? 'succeeded' : execution === 'partial' ? 'partial' : 'failed';
    outcome = state === 'succeeded' ? 'succeeded' : 'failed';
    // The summary is what run_result returns inline; the full body becomes an artifact.
    const { object: artifact } = await putObject(db, item.lease_owner ?? workerId, 'artifact', result, 'deidentified', null);
    result = { summary: outcomeOfRun.summary, artifact_id: artifact.id, result_hash: hash(outcomeOfRun.result) };
  } catch (e) {
    const err = e as LabError & { name?: string };
    // A cancelled run whose provider call had already gone out still stores its outcome,
    // and says so (§5.4): the money was spent and the evidence should not be discarded.
    if (controller.signal.aborted && !lost) {
      state = 'cancelled'; execution = 'cancelled'; assessment = 'not_reached'; outcome = 'cancelled';
      result = { late_response: true };
      error = { category: 'cancelled', message: err.message };
    } else {
      error = {
        category: err.code === 'BUDGET_EXHAUSTED' ? 'budget'
          : err.code === 'MODEL_UNSUPPORTED' ? 'model'
          : err.code === 'LAB_IO_FORBIDDEN' ? 'isolation'
          : 'provider',
        code: err.code ?? null,
        message: String(err.message).slice(0, 500),
      };
    }
  } finally {
    clearInterval(beat);
  }

  // A lost lease writes NOTHING further — the item now belongs to another attempt.
  if (lost) {
    await recordEvent(db, 'system', item.id, 'lease_lost', { lease_token: leaseToken });
    return false;
  }

  /**
   * DECISION 65 — `replayed`, and the two ways an item earns it.
   *
   * ONE: it ran on a replay transport (`run_replay`), so its receipts are the SOURCE run's. The
   * gateway would classify those as `verified`, which reads as "this call was attributed" about a
   * call nobody made today.
   * TWO: the adapter declares it, which a frozen IPD case does — it serves the stored checkpoint
   * and judge outputs and never touches the gateway at all.
   *
   * ⚠️ THE GATEWAY STILL WINS WHENEVER IT SAW A CALL. `declared` is consulted only when no call was
   * made (`sawAnyCall` false ⇒ `attributionStatus()` is `unknown`), so an adapter cannot dress a
   * real `invalid` — a model that answered instead of the one the arm named — as a replay.
   *
   * DECISION 115 — the last arm, `not_applicable`. Nothing ran on a replay transport, the adapter
   * declared nothing, and NO CALL WAS DISPATCHED: there was no model call to attribute, and
   * `unknown` claims a failed measurement where none was attempted. Preop with both rails off is
   * the case; a failed item that never reached a call is the same fact and gets the same word.
   *
   * ⚠️ DECISION 121 — IT ASKS THE GATEWAY WHETHER A CALL WENT OUT, AND THAT IS THE WHOLE FIX.
   * D2a shipped this arm on `gatewayVerdict === 'unknown'`, because `sawAnyCall` was private. That
   * value means two things — "no call" and "one call I could not attribute" — so an item whose
   * single call settled with no usage, or whose transport threw, was reported as having made none.
   * Both of those ARE measurements that failed, and `unknown` is the honest word for them; only a
   * dispatch that never happened is `not_applicable`. `sawAnyCall()` (`gateway.ts`) separates the
   * two, and the gateway's own verdict now survives every case where it saw a call.
   */
  const gatewayVerdict = gateway.attributionStatus();
  const declared = (result as { summary?: { attribution_status?: unknown } } | null)?.summary?.attribution_status;
  const attribution = gatewayVerdict !== 'unknown'
    ? gatewayVerdict
    : replayed ? 'replayed'
    : declared === 'replayed' ? 'replayed'
    : !gateway.sawAnyCall() && declared === undefined ? 'not_applicable'
    : gatewayVerdict;

  const wrote = await finish(db, item.id, leaseToken, {
    state,
    result,
    error,
    execution_status: execution,
    assessment_status: assessment,
    attribution_status: attribution,
    outcome,
  });
  if (wrote) {
    for (const ev of events) await recordEvent(db, 'system', item.id, ev.kind, ev.body);
  }
  return wrote && state === 'succeeded';
}

/** Read one stored artifact body back, for the `lab://artifacts/{id}` MCP resource. */
export async function readArtifact(db: Db, id: string): Promise<unknown | null> {
  const obj = await getObject(db, id);
  return obj ? obj.body : null;
}
