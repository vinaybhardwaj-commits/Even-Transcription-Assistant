/**
 * lib/cognition/join-sweep.ts — WM3: the join's three phases (cognition-join/0.1).
 *
 * For every eligible headache event the shadow agent judged, persist what the record held BEFORE
 * the note (`O_before`), the first result that became VISIBLE after it (`Y`), and what the record
 * held once that result had landed (`O_after`). Attach a doctor's reaction when one exists.
 *
 * ── THE FROZEN SPINE IS CALLED, NEVER CHANGED ──────────────────────────────────────────────────
 *
 * Every capture is `getMemberSnapshotAsOf` — the same frozen function the World Model walk calls
 * for one cut, with the same three-way reading of its answer: a snapshot is `ok`, a null is
 * `no_prior_history`, and a throw is `context_fetch_failed`. NULL AND THROW ARE DIFFERENT ANSWERS
 * and are never collapsed, because a db13 outage recorded as an empty chart would be a lie written
 * into the first table this programme persists. Nothing under lib/member-state/, lib/world-model/
 * or lib/as-of-core.ts is imported for its internals or modified; `applyAsOfCut` is never reached
 * from here.
 *
 * ── EVERY PHASE IS IDEMPOTENT AND BOUNDED ──────────────────────────────────────────────────────
 *
 * Phase 1 opens triples for events that have none (ON CONFLICT DO NOTHING on the event key), phase
 * 2 resolves Y for pending ones, phase 3 captures O_after for those that have a Y. Re-running any
 * of them over the same backlog writes nothing new. Each has its own cap so a run is a bounded
 * amount of db13, and the phases never run concurrently with each other.
 *
 * ── AN OUTAGE DEFERS, IT DOES NOT DECIDE ───────────────────────────────────────────────────────
 *
 * A throw from the identity read leaves the event UNOPENED for a later run. Only a genuine null —
 * db13 answered, and there is no individual behind this note — writes `resolve_status:
 * 'unresolved'`, which closes the row for good. The distinction matters because that close is
 * permanent, and a five-second db13 blip must never be able to make it.
 *
 * ⚠️ INFERRED SQL. This sandbox has no live db13 and no live Neon. Every query is listed verbatim
 * in the ship report for the Orchestrator to validate before the cron is enabled.
 */
import { metabaseQuery } from '../metabase';
import { isUid } from '../ccb-dossier-core';
import { getMemberSnapshotAsOf, individualForPrescSql } from '../member-state/member-state';
import { MEMBER_STATE_VERSION } from '../member-state/schema';
import { WORLD_MODEL_WALK_VERSION, ipdFoldLabelFor, readWalkFlags, type WalkFlags } from '../world-model/walk-o';
import { BURDEN_POLICY_VERSION, JOIN_SCHEMA_VERSION } from './schema';
import {
  chooseY, istDay, oAfterAsOf, provenanceFor, snapshotHash, visibleAtFor, yStatusFor,
  type CutStatus, type LabRow, type Provenance,
} from './join-core';
import {
  attachReaction, firstRunAt, insertTriple, joinCounts, listFailedAfter, listOpenAfter,
  listOpenCandidates, listPendingY, reactionForEvent, repairFailedSnapshot, updateOAfter, updateY,
  upsertSnapshot, type TripleRow,
} from './join-store';

/** The one trigger kind this build reads. `ipd_stay_extracted` writes zero rows here. */
export const JOIN_TRIGGER_KIND = 'opd_note_audited';
/** The one microworld this build joins. */
export const JOIN_MICROWORLD = 'headache';
/** Y is a lab in this build. `ipd_stay` is specified in the paper and not implemented here. */
export const JOIN_Y_KIND = 'lab';
/** How long after the note a result still counts as this note's follow-up. */
export const Y_HORIZON_DAYS = 14;
/** The read bound on the Y query. Wider than the horizon so a horizon change needs no new query. */
export const Y_QUERY_WINDOW_DAYS = 45;

/**
 * The per-phase caps, RE-SIZED 8 Sep 2026 after a manual full run returned HTTP 504.
 *
 * The first sizing (100/200/100) was a guess at a safe batch and was wrong in the way batch sizes
 * usually are: phase 2 spent the whole invocation on its own 200 items and phase 3 never started,
 * so the rows that make a triple COMPLETE were never written, tick after tick. A run that always
 * dies in the same phase does not drain a backlog — it grinds one queue and starves the next.
 * These numbers are sized so all three phases fit inside one invocation with room to spare, and
 * the wall-clock budget below is the guard that holds even when an individual read is slow.
 */
export const PHASE1_CAP = 50;
export const PHASE2_CAP = 60;
export const PHASE3_CAP = 30;
export const BACKFILL_CAP = 50;

/**
 * The wall-clock budget for one run: 240 s inside the route's 300 s `maxDuration`, leaving 60 s of
 * headroom for the response and for a request already in flight when the budget expires.
 *
 * Checked BEFORE each item, never mid-item, so a run stops between two individuals with its work
 * committed rather than being cut off inside one. Everything a phase completed before it stopped is
 * already written — every write in this sweep is its own statement and its own idempotent decision.
 */
export const SWEEP_BUDGET_MS = 240_000;

/** One db13 read at a time from this module, and `getMemberSnapshotAsOf` fires two in parallel —
 *  so at most two are ever in flight. The pause sits between individuals, not between statements. */
export const PACING_MS = 100;

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Y query, on db13.
 *
 * Values are inlined because `metabaseQuery` runs a native statement and this repo's db13 layer
 * binds no parameters — the same reason every other db13 builder in lib/member-state/ inlines.
 * Both inlined values are guarded first: `isUid` for the individual and a strict `YYYY-MM-DD` for
 * the day, so neither can carry SQL.
 */
export function yQuerySql(individualUid: string, fromDayIst: string): string {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  if (!isDay(fromDayIst)) throw new Error('bad day');
  return `SELECT d.booking_id, d.test_result_uid, d.test_date, d._create_time, t.investigation_name
  FROM test_digital_values_view d
  JOIN test_values_view t
    ON t.booking_id = d.booking_id AND t.test_result_uid = d.test_result_uid
 WHERE t._parent_id = '${individualUid}'
   AND d.test_date >= '${fromDayIst} 00:00:00'::timestamp
   AND d.test_date <  '${fromDayIst} 00:00:00'::timestamp + interval '${Y_QUERY_WINDOW_DAYS} days'
 ORDER BY d.test_date ASC
 LIMIT 500`;
}

function toLabRow(r: Record<string, unknown>): LabRow | null {
  const testDate = r.test_date == null ? null : new Date(String(r.test_date));
  if (!testDate || Number.isNaN(testDate.getTime())) return null;   // undated rows cannot be placed
  const create = r._create_time == null ? null : new Date(String(r._create_time));
  return {
    booking_id: String(r.booking_id ?? ''),
    test_result_uid: String(r.test_result_uid ?? ''),
    test_date: testDate,
    create_time: create && !Number.isNaN(create.getTime()) ? create : null,
    // A null investigation_name still counts — the walk's own assembler drops those rows, and a
    // result the spine cannot name is still a result the doctor received.
    investigation_name: r.investigation_name == null ? null : String(r.investigation_name),
  };
}

export interface JoinDeps {
  /** presc uid → individual uid. THROWS on a db13 outage; returns null only for a real absence. */
  resolveIndividual?: (prescUid: string) => Promise<string | null>;
  /** The frozen as-of reconstruct. MUST be `getMemberSnapshotAsOf` in production. */
  reconstruct?: (individualUid: string, asOfDate: string, computedAt: string) => Promise<unknown | null>;
  /** The Y read. */
  labRows?: (individualUid: string, fromDayIst: string) => Promise<LabRow[]>;
  flags?: WalkFlags;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Epoch ms after which a phase stops taking new items. Set by `runJoinSweep`; absent means no
   *  budget, which is what a directly-invoked phase gets. */
  deadlineAt?: number;
}

/**
 * presc uid → individual uid, on db13, with THROW and NULL kept apart.
 *
 * `individualUidForPresc` in lib/member-state/member-state.ts swallows the error and returns null,
 * which is right for an annotation and wrong here: a null closes a triple permanently as
 * `unresolved`. So the SQL string is reused from its single definition (`individualForPrescSql`)
 * and only the error handling differs.
 */
async function resolveIndividualReal(prescUid: string): Promise<string | null> {
  if (!isUid(prescUid)) return null;                      // not a uid: a real absence, not an outage
  const rows = await metabaseQuery(individualForPrescSql(prescUid));   // a throw propagates on purpose
  const u = rows[0]?.individual_uid ? String(rows[0].individual_uid) : '';
  return isUid(u) ? u : null;
}

async function labRowsReal(individualUid: string, fromDayIst: string): Promise<LabRow[]> {
  const rows = await metabaseQuery(yQuerySql(individualUid, fromDayIst));
  return (rows as Record<string, unknown>[]).map(toLabRow).filter((r): r is LabRow => r !== null);
}

interface Capture { cutStatus: CutStatus; json: unknown | null; hash: string | null }

/**
 * One capture, read exactly as the walk reads one cut. Never throws: the outage becomes a status.
 */
async function capture(
  individualUid: string, asOf: string, computedAt: string, deps: JoinDeps,
): Promise<Capture> {
  const reconstruct = deps.reconstruct ?? getMemberSnapshotAsOf;
  try {
    const snap = await reconstruct(individualUid, asOf, computedAt);
    if (!snap) return { cutStatus: 'no_prior_history', json: null, hash: null };
    return { cutStatus: 'ok', json: snap, hash: snapshotHash(snap) };
  } catch {
    // NOT an empty state. We could not read, and the row says so.
    return { cutStatus: 'context_fetch_failed', json: null, hash: null };
  }
}

async function persistCapture(
  individualUid: string, asOf: string, provenance: Provenance, cap: Capture, ipdFold: string,
): Promise<string> {
  const row = await upsertSnapshot({
    individual_uid: individualUid, as_of: asOf, cut_status: cap.cutStatus, provenance,
    walk_version: WORLD_MODEL_WALK_VERSION, member_state_version: MEMBER_STATE_VERSION,
    ipd_fold: ipdFold, snapshot_json: cap.json, snapshot_hash: cap.hash,
  });
  return row.id;
}

/** Attach the doctor's reaction to this event, if one exists and none is attached yet. */
async function maybeAttachReaction(triple: TripleRow): Promise<boolean> {
  if (triple.reaction_ref) return false;
  const reaction = await reactionForEvent(triple.event_ref);
  if (!reaction) return false;
  await attachReaction(triple.id, reaction.id, reaction.after_cdmss);
  return true;
}

export interface Phase1Result { scanned: number; opened: number; unresolved: number; deferred: number; budgetStopped: boolean }
export interface Phase2Result { scanned: number; present: number; missing: number; stillPending: number; deferred: number; reactions: number; budgetStopped: boolean }
export interface Phase3Result { scanned: number; closed: number; failed: number; repaired: number; reactions: number; budgetStopped: boolean }

/** True when the budget is spent. Checked before each item, so a stop is always between two. */
function outOfBudget(deps: JoinDeps): boolean {
  const nowFn = deps.now ?? (() => new Date());
  return deps.deadlineAt != null && nowFn().getTime() >= deps.deadlineAt;
}

/**
 * Phase 1 — open a triple for every eligible event that has none.
 *
 * `provenance` is decided ONCE per run from the join's first run time, so a run cannot start
 * calling its own newly written rows "captured" halfway through. Before the first triple exists
 * there is no first run time, so the first runs are all `reconstructed` — which is what a backfill
 * is.
 */
export async function runJoinPhase1(limit: number, deps: JoinDeps = {}): Promise<Phase1Result> {
  const resolve = deps.resolveIndividual ?? resolveIndividualReal;
  const sleep = deps.sleep ?? sleepReal;
  const nowFn = deps.now ?? (() => new Date());
  const ipdFold = ipdFoldLabelFor(deps.flags ?? readWalkFlags());
  const computedAt = nowFn().toISOString();

  const first = await firstRunAt();
  const candidates = await listOpenCandidates(BURDEN_POLICY_VERSION, JOIN_TRIGGER_KIND, limit);
  const out: Phase1Result = { scanned: candidates.length, opened: 0, unresolved: 0, deferred: 0, budgetStopped: false };

  for (const c of candidates) {
    if (outOfBudget(deps)) { out.budgetStopped = true; break; }
    const provenance = provenanceFor(new Date(c.created_at), first);
    let individualUid: string | null;
    try {
      individualUid = await resolve(c.event_ref);
    } catch {
      out.deferred++;                       // an outage: leave the event for a later run
      await sleep(PACING_MS);
      continue;
    }

    if (!individualUid) {
      // db13 answered and there is nobody behind this note. The row is opened and closed.
      const inserted = await insertTriple({
        trigger_kind: c.trigger_kind, event_ref: c.event_ref, event_at: c.event_at,
        individual_uid: null, microworld: JOIN_MICROWORLD, provenance, resolve_status: 'unresolved',
        o_before_id: null, y_status: 'missing_within_horizon', y_horizon_days: Y_HORIZON_DAYS,
        policy_version: BURDEN_POLICY_VERSION,
      });
      if (inserted) { out.opened++; out.unresolved++; }
      await sleep(PACING_MS);
      continue;
    }

    const asOf = istDay(new Date(c.event_at));
    const cap = await capture(individualUid, asOf, computedAt, deps);
    const snapshotId = await persistCapture(individualUid, asOf, provenance, cap, ipdFold);
    const inserted = await insertTriple({
      trigger_kind: c.trigger_kind, event_ref: c.event_ref, event_at: c.event_at,
      individual_uid: individualUid, microworld: JOIN_MICROWORLD, provenance,
      resolve_status: 'resolved', o_before_id: snapshotId, y_status: 'pending',
      y_horizon_days: Y_HORIZON_DAYS, policy_version: BURDEN_POLICY_VERSION,
    });
    if (inserted) out.opened++;
    await sleep(PACING_MS);
  }
  return out;
}

/** Phase 2 — find Y, or conclude that nothing arrived within the horizon. */
export async function runJoinPhase2(limit: number, deps: JoinDeps = {}): Promise<Phase2Result> {
  const labs = deps.labRows ?? labRowsReal;
  const sleep = deps.sleep ?? sleepReal;
  const nowFn = deps.now ?? (() => new Date());

  const triples = await listPendingY(limit);
  const out: Phase2Result = { scanned: triples.length, present: 0, missing: 0, stillPending: 0, deferred: 0, reactions: 0, budgetStopped: false };

  for (const t of triples) {
    if (outOfBudget(deps)) { out.budgetStopped = true; break; }
    if (await maybeAttachReaction(t)) out.reactions++;
    if (!t.individual_uid) { out.deferred++; continue; }

    const eventAt = new Date(t.event_at);
    const noteDay = istDay(eventAt);
    let rows: LabRow[];
    try {
      rows = await labs(t.individual_uid, noteDay);
    } catch {
      out.deferred++;                        // an outage leaves the triple pending, untouched
      await sleep(PACING_MS);
      continue;
    }

    const y = chooseY(rows, eventAt, noteDay, t.y_horizon_days);
    if (y) {
      const { visibleAt, rule } = visibleAtFor(y.test_date, y.create_time);
      await updateY(t.id, {
        y_kind: JOIN_Y_KIND, y_ref: `${y.booking_id}:${y.test_result_uid}`,
        y_test_date: y.test_date.toISOString(),
        y_create_time: y.create_time ? y.create_time.toISOString() : null,
        y_visible_at: visibleAt.toISOString(), y_visible_rule: rule, y_status: 'present',
      });
      out.present++;
    } else {
      const status = yStatusFor(false, nowFn(), eventAt, t.y_horizon_days);
      await updateY(t.id, {
        y_kind: null, y_ref: null, y_test_date: null, y_create_time: null,
        y_visible_at: null, y_visible_rule: null, y_status: status,
      });
      if (status === 'missing_within_horizon') out.missing++; else out.stillPending++;
    }
    await sleep(PACING_MS);
  }
  return out;
}

/**
 * Phase 3 — capture O_after, as of the IST day after Y became visible.
 *
 * `retryFailed` re-reads the triples whose O_after capture was an outage and fills the placeholder
 * in if the spine answers this time. It is the only path in this ship that mutates a snapshot row,
 * and lib/cognition/join-store.ts guards it on both sides.
 */
export async function runJoinPhase3(limit: number, deps: JoinDeps = {}, retryFailed = false): Promise<Phase3Result> {
  const sleep = deps.sleep ?? sleepReal;
  const nowFn = deps.now ?? (() => new Date());
  const ipdFold = ipdFoldLabelFor(deps.flags ?? readWalkFlags());
  const computedAt = nowFn().toISOString();

  const triples = retryFailed ? await listFailedAfter(limit) : await listOpenAfter(limit);
  const out: Phase3Result = { scanned: triples.length, closed: 0, failed: 0, repaired: 0, reactions: 0, budgetStopped: false };

  for (const t of triples) {
    if (outOfBudget(deps)) { out.budgetStopped = true; break; }
    if (await maybeAttachReaction(t)) out.reactions++;
    if (!t.individual_uid || !t.y_visible_at) continue;

    const asOf = t.o_after_as_of ?? oAfterAsOf(new Date(t.y_visible_at));
    const cap = await capture(t.individual_uid, asOf, computedAt, deps);

    if (retryFailed && t.o_after_id) {
      if (await repairFailedSnapshot(t.o_after_id, cap.cutStatus, cap.json, cap.hash)) out.repaired++;
      else out.failed++;
      await sleep(PACING_MS);
      continue;
    }

    const snapshotId = await persistCapture(t.individual_uid, asOf, t.provenance, cap, ipdFold);
    await updateOAfter(t.id, snapshotId, asOf);
    if (cap.cutStatus === 'context_fetch_failed') out.failed++; else out.closed++;
    await sleep(PACING_MS);
  }
  return out;
}

export interface JoinSweepResult {
  ok: boolean;
  error: string | null;
  mode: 'sweep' | 'backfill' | 'retry_failed';
  schemaVersion: string;
  policyVersion: string;
  phase1: Phase1Result | null;
  phase2: Phase2Result | null;
  phase3: Phase3Result | null;
  /**
   * `false` when the run finished its caps inside the budget; otherwise the phase it stopped in.
   *
   * ONE field carrying both facts the order asks for — that the budget was hit, and where. A
   * consumer that only wants the boolean reads it as truthy; a consumer that wants to know which
   * queue is the bottleneck reads the name. See the report's Fix 2 for the alternative considered.
   */
  budget_stopped: false | 'phase1' | 'phase2' | 'phase3';
}

const EMPTY: Omit<JoinSweepResult, 'mode'> = {
  ok: true, error: null, schemaVersion: JOIN_SCHEMA_VERSION, policyVersion: BURDEN_POLICY_VERSION,
  phase1: null, phase2: null, phase3: null, budget_stopped: false,
};

/**
 * One bounded run. NEVER THROWS: a failed read is reported as `{ ok:false, error }` so a cron tick
 * reports rather than alerts, exactly as the shadow sweep does. The three phases run in order and
 * never concurrently — phase 2 reads rows phase 1 may have just written, and interleaving them
 * would make a run's counts unreadable.
 */
export async function runJoinSweep(deps: JoinDeps = {}): Promise<JoinSweepResult> {
  const result: JoinSweepResult = { ...EMPTY, mode: 'sweep' };
  const nowFn = deps.now ?? (() => new Date());
  // One deadline for the whole run, set once, so the three phases share the budget rather than
  // each getting a fresh one.
  const budgeted: JoinDeps = { ...deps, deadlineAt: deps.deadlineAt ?? nowFn().getTime() + SWEEP_BUDGET_MS };
  try {
    result.phase1 = await runJoinPhase1(PHASE1_CAP, budgeted);
    if (result.phase1.budgetStopped) { result.budget_stopped = 'phase1'; return result; }

    result.phase2 = await runJoinPhase2(PHASE2_CAP, budgeted);
    if (result.phase2.budgetStopped) { result.budget_stopped = 'phase2'; return result; }

    result.phase3 = await runJoinPhase3(PHASE3_CAP, budgeted);
    if (result.phase3.budgetStopped) result.budget_stopped = 'phase3';
    return result;
  } catch (e) {
    return { ...result, ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

/** Phase 1 only, with the backfill cap. The first runs of the join are backfills. */
export async function runJoinBackfill(limit = BACKFILL_CAP, deps: JoinDeps = {}): Promise<JoinSweepResult> {
  const result: JoinSweepResult = { ...EMPTY, mode: 'backfill' };
  try {
    const nowFn = deps.now ?? (() => new Date());
    const budgeted: JoinDeps = { ...deps, deadlineAt: deps.deadlineAt ?? nowFn().getTime() + SWEEP_BUDGET_MS };
    result.phase1 = await runJoinPhase1(Math.max(1, Math.min(BACKFILL_CAP, limit)), budgeted);
    if (result.phase1.budgetStopped) result.budget_stopped = 'phase1';
    return result;
  } catch (e) {
    return { ...result, ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

/** Phase 3 only, over the O_after captures that failed. */
export async function runJoinRetryFailed(limit = PHASE3_CAP, deps: JoinDeps = {}): Promise<JoinSweepResult> {
  const result: JoinSweepResult = { ...EMPTY, mode: 'retry_failed' };
  try {
    const nowFn = deps.now ?? (() => new Date());
    const budgeted: JoinDeps = { ...deps, deadlineAt: deps.deadlineAt ?? nowFn().getTime() + SWEEP_BUDGET_MS };
    result.phase3 = await runJoinPhase3(Math.max(1, Math.min(PHASE3_CAP, limit)), budgeted, true);
    if (result.phase3.budgetStopped) result.budget_stopped = 'phase3';
    return result;
  } catch (e) {
    return { ...result, ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

export { joinCounts };
