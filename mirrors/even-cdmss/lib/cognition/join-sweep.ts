/**
 * lib/cognition/join-sweep.ts — WM3: the join's four phases (cognition-join/0.1).
 *
 * For every headache note this build can see, persist what the record held BEFORE the note
 * (`O_before`), the first result that became VISIBLE after it (`Y`), and what the record held once
 * that result had landed (`O_after`). Attach a doctor's reaction when one exists.
 *
 * ── THREE POPULATIONS, THREE LABELS ────────────────────────────────────────────────────────────
 *
 * WM3 fix 3 widened what "can see" means, and every triple now says which widening opened it:
 * `current` (an eligible shadow event), `stale` (a shadow event refused as `stale_era`) and
 * `unaudited` (a raw db13 note under `headache-raw/1`, phase 0, which the audit engine may never
 * have seen). They are counted apart on the readout and never summed into one rate by this module,
 * because the three have different denominators and a reader who cannot tell them apart will
 * believe the wrong one.
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
 * Phase 0 opens triples for raw notes that have none, phase 1 does the same for shadow events (both
 * ON CONFLICT DO NOTHING on the event key), phase 2 resolves Y for pending ones, phase 3 captures
 * O_after for those that have a Y. Re-running any of them over the same backlog writes nothing new.
 * Each has its own cap so a run is a bounded amount of db13, and the phases never run concurrently
 * with each other.
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
import { RAW_MATCH_RULE } from './microworld';
import {
  chooseY, istDay, oAfterAsOf, provenanceFor, snapshotHash, visibleAtFor, yStatusFor,
  type CutStatus, type LabRow, type Provenance,
} from './join-core';
import {
  attachReaction, firstRunAt, insertStabilityRun, insertTriple, joinCounts, listFailedAfter,
  listOpenAfter, listOpenCandidates, listPendingY, listRawNoteCandidatesSql, listStabilitySample,
  matchRate, rawNoteCursor, reactionForEvent, repairFailedSnapshot, tripleExistsForNote,
  updateOAfter, updateY, upsertSnapshot, RAW_NOTE_FLOOR, type TripleRow,
} from './join-store';

/**
 * The floor on the raw-note read. DEFINED in lib/cognition/join-store.ts beside the query that
 * inlines it — one definition, no import cycle — and re-exported here because it is a phase-0
 * constant and belongs on this module's surface.
 */
export { RAW_NOTE_FLOOR };
export { RAW_MATCH_RULE };

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
 * WM3 fix 3 (N8) — the SECOND trigger kind. A triple opened from a RAW db13 note that
 * `headache-raw/1` matched, whether or not the audit engine ever saw it.
 *
 * The pool behind it is large (~13,000 notes since January 2024, measured
 * CDMSS-WM-HEADACHE-POOL-ALL-HISTORY-8-SEP-2026 §2.4) and every one of them costs a full spine
 * reconstruction, so the cron cap is deliberately the smallest of the four: phase 0 must not be
 * able to eat an invocation that the three phases behind it need to finish their own queues. The
 * manual cap is higher because a person watching a backfill can wait, and can stop.
 */
export const RAW_TRIGGER_KIND = 'opd_note_matched';
export const RAW_PHASE_CAP = 40;
export const RAW_MANUAL_CAP = 100;

/** How many triples the stability check re-reconstructs. Small on purpose: each one is a full db13
 *  read pair, and the run is manual and admin-only. */
export const STABILITY_SAMPLE_N = 30;

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
  /** The raw-note read (phase 0). Rows exactly as `listRawNoteCandidatesSql` returns them. */
  rawNotes?: (beforeTs: string | null, limit: number) => Promise<Record<string, unknown>[]>;
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

async function rawNotesReal(beforeTs: string | null, limit: number): Promise<Record<string, unknown>[]> {
  return metabaseQuery(listRawNoteCandidatesSql(beforeTs, limit));
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

/**
 * Phase 0's counts. `error` is NOT in the kickoff's listed shape and is added deliberately: §8
 * requires that a db13 failure END PHASE 0 and let phases 1 to 3 run, and a phase that failed
 * silently would be indistinguishable from a phase that found nothing. `scanned: 0, error: null` is
 * "we looked, and there was nothing left"; `scanned: 0, error: '…'` is "we could not look".
 */
export interface Phase0Result {
  scanned: number; opened: number; skipped_existing: number; skipped_bad_row: number;
  unresolved: number; budgetStopped: boolean; error: string | null;
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
 * Phase 0 — open a triple for every RAW headache note that has none. (WM3 fix 3, N8.)
 *
 * ── WHAT THIS PHASE IS FOR ─────────────────────────────────────────────────────────────────────
 *
 * Phase 1 can only see notes the audit engine audited AND the shadow agent judged. About 13,000
 * headache notes since January 2024 were never audited at all, so no shadow row exists for them and
 * phase 1 is structurally blind to them. This phase reads db13 directly under `headache-raw/1` and
 * opens the ones that no triple covers yet.
 *
 * ── NEWEST FIRST, AND WHY THE CURSOR IS A MINIMUM ──────────────────────────────────────────────
 *
 * The cursor is the OLDEST raw triple's `event_at`, and each run asks db13 for notes strictly older
 * than it, newest first. So run 1 takes the newest 40, run 2 the 40 before those, and the walk
 * marches backwards through the pool without a hardcoded cutoff. That ordering is deliberate: the
 * lab mirror is reliable after June 2026 and thinner before it, so the notes whose Y can actually be
 * found are reached first, and the run that eventually reaches 2024 is a run whose limits are
 * already understood rather than a surprise.
 *
 * The cursor is read to the SECOND (`…T00:00:00Z`), so a run re-reads at most the sub-second
 * remainder of its own boundary — and `tripleExistsForNote` skips those without opening anything.
 *
 * ── ONE TRIPLE PER NOTE ────────────────────────────────────────────────────────────────────────
 *
 * The existence check is on `event_ref` ALONE, across every trigger kind, so a note the shadow
 * agent already opened is skipped here rather than opened a second time under a weaker trigger. The
 * audit-trigger triple wins, always: it is the one whose event was judged by a policy.
 *
 * ── NEVER THROWS ───────────────────────────────────────────────────────────────────────────────
 *
 * A db13 outage ends this phase with `error` set and leaves phases 1 to 3 to run (§8). Nothing here
 * can take down a cron tick, and nothing here is retried inside one run.
 */
export async function runJoinPhase0(limit: number, deps: JoinDeps = {}): Promise<Phase0Result> {
  const rawNotes = deps.rawNotes ?? rawNotesReal;
  const sleep = deps.sleep ?? sleepReal;
  const nowFn = deps.now ?? (() => new Date());
  const ipdFold = ipdFoldLabelFor(deps.flags ?? readWalkFlags());
  const computedAt = nowFn().toISOString();
  const out: Phase0Result = {
    scanned: 0, opened: 0, skipped_existing: 0, skipped_bad_row: 0, unresolved: 0,
    budgetStopped: false, error: null,
  };

  try {
    const cursor = await rawNoteCursor(RAW_TRIGGER_KIND);
    // The builder accepts whole seconds only; truncating rather than rounding keeps the bound at or
    // before the cursor, so no note can be stepped over.
    const beforeTs = cursor == null ? null : `${cursor.slice(0, 19)}Z`;
    const rows = await rawNotes(beforeTs, limit);
    out.scanned = rows.length;

    for (const r of rows) {
      if (out.opened >= limit) break;
      if (outOfBudget(deps)) { out.budgetStopped = true; break; }

      const uid = String(r.uid ?? '');
      const eventAtRaw = String(r.event_at ?? '');
      const eventAt = new Date(eventAtRaw);
      if (!isUid(uid) || !eventAtRaw || Number.isNaN(eventAt.getTime())) { out.skipped_bad_row++; continue; }

      if (await tripleExistsForNote(uid)) { out.skipped_existing++; continue; }

      // The row already carries `_parent_id`, so the identity needs no second db13 round trip. A
      // value that is not a well-formed uid is read as an ABSENCE, exactly as `resolveIndividual`
      // reads its own answer — never fed to the spine, which would return null and be recorded as
      // "there was nothing here" when the truth is "this was not an identity".
      const raw = String(r.individual_uid ?? '');
      const individualUid = isUid(raw) ? raw : null;
      const eventAtIso = eventAt.toISOString();

      if (!individualUid) {
        const inserted = await insertTriple({
          trigger_kind: RAW_TRIGGER_KIND, event_ref: uid, event_at: eventAtIso,
          individual_uid: null, microworld: JOIN_MICROWORLD, provenance: 'reconstructed',
          resolve_status: 'unresolved', o_before_id: null, y_status: 'missing_within_horizon',
          y_horizon_days: Y_HORIZON_DAYS, policy_version: BURDEN_POLICY_VERSION,
          era_status: 'unaudited',
        });
        if (inserted) { out.opened++; out.unresolved++; }
        await sleep(PACING_MS);
        continue;
      }

      const asOf = istDay(eventAt);
      const cap = await capture(individualUid, asOf, computedAt, deps);
      const snapshotId = await persistCapture(individualUid, asOf, 'reconstructed', cap, ipdFold);
      const inserted = await insertTriple({
        trigger_kind: RAW_TRIGGER_KIND, event_ref: uid, event_at: eventAtIso,
        individual_uid: individualUid, microworld: JOIN_MICROWORLD,
        // Every raw triple is RECONSTRUCTED by construction: the note was matched by a query run
        // long after it happened, never captured as it arrived.
        provenance: 'reconstructed', resolve_status: 'resolved', o_before_id: snapshotId,
        y_status: 'pending', y_horizon_days: Y_HORIZON_DAYS,
        policy_version: BURDEN_POLICY_VERSION, era_status: 'unaudited',
      });
      if (inserted) out.opened++;
      await sleep(PACING_MS);
    }
  } catch (e) {
    out.error = String((e as Error).message).slice(0, 300);
  }
  return out;
}

/**
 * Phase 1 — open a triple for every eligible event that has none.
 *
 * `provenance` is decided ONCE per run from the join's first run time, so a run cannot start
 * calling its own newly written rows "captured" halfway through. Before the first triple exists
 * there is no first run time, so the first runs are all `reconstructed` — which is what a backfill
 * is.
 */
export async function runJoinPhase1(
  limit: number, deps: JoinDeps = {}, era: 'current' | 'stale' = 'current',
): Promise<Phase1Result> {
  const resolve = deps.resolveIndividual ?? resolveIndividualReal;
  const sleep = deps.sleep ?? sleepReal;
  const nowFn = deps.now ?? (() => new Date());
  const ipdFold = ipdFoldLabelFor(deps.flags ?? readWalkFlags());
  const computedAt = nowFn().toISOString();

  const first = await firstRunAt();
  const candidates = await listOpenCandidates(BURDEN_POLICY_VERSION, JOIN_TRIGGER_KIND, limit, era);
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
        policy_version: BURDEN_POLICY_VERSION, era_status: era,
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
      y_horizon_days: Y_HORIZON_DAYS, policy_version: BURDEN_POLICY_VERSION, era_status: era,
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
  mode: 'sweep' | 'backfill' | 'retry_failed' | 'raw_notes' | 'stability';
  schemaVersion: string;
  policyVersion: string;
  phase0: Phase0Result | null;
  phase1: Phase1Result | null;
  /** The stale-era pass of phase 1. Null unless `include_stale_era` was asked for — and null is
   *  "we did not look at the stale backlog", never "the stale backlog is empty". */
  phase1_stale: Phase1Result | null;
  phase2: Phase2Result | null;
  phase3: Phase3Result | null;
  /**
   * `false` when the run finished its caps inside the budget; otherwise the phase it stopped in.
   *
   * ONE field carrying both facts the order asks for — that the budget was hit, and where. A
   * consumer that only wants the boolean reads it as truthy; a consumer that wants to know which
   * queue is the bottleneck reads the name. See the report's Fix 2 for the alternative considered.
   */
  budget_stopped: false | 'phase0' | 'phase1' | 'phase1_stale' | 'phase2' | 'phase3';
}

const EMPTY: Omit<JoinSweepResult, 'mode'> = {
  ok: true, error: null, schemaVersion: JOIN_SCHEMA_VERSION, policyVersion: BURDEN_POLICY_VERSION,
  phase0: null, phase1: null, phase1_stale: null, phase2: null, phase3: null, budget_stopped: false,
};

/** What one stability run measured. Its own shape: it has no phases and opens no triples. */
export interface JoinStabilityResult {
  ok: boolean;
  error: string | null;
  mode: 'stability';
  schemaVersion: string;
  sample_n: number;
  matched_n: number;
  failed_n: number;
  /** matched / (sampled − failed). NULL when the denominator is 0 — not measured, not 0%. */
  match_rate: number | null;
  mismatched_ids: string[];
}

/**
 * One bounded run. NEVER THROWS: a failed read is reported as `{ ok:false, error }` so a cron tick
 * reports rather than alerts, exactly as the shadow sweep does. The FOUR phases run in order and
 * never concurrently — phase 2 reads rows phases 0 and 1 may have just written, and interleaving
 * them would make a run's counts unreadable.
 *
 * The cron opens `current` events and raw notes. It NEVER opens the stale-era backlog: that is a
 * finite, bounded set drained by hand through `runJoinBackfill({ include_stale_era: true })`, so a
 * decision to re-open notes the burden policy refused stays a decision somebody made.
 */
export async function runJoinSweep(deps: JoinDeps = {}): Promise<JoinSweepResult> {
  const result: JoinSweepResult = { ...EMPTY, mode: 'sweep' };
  const nowFn = deps.now ?? (() => new Date());
  // One deadline for the whole run, set once, so the three phases share the budget rather than
  // each getting a fresh one.
  const budgeted: JoinDeps = { ...deps, deadlineAt: deps.deadlineAt ?? nowFn().getTime() + SWEEP_BUDGET_MS };
  try {
    // Phase 0 first, and its own db13 failure is NOT this run's failure: it sets its own `error`
    // and the three phases behind it still get their share of the budget.
    result.phase0 = await runJoinPhase0(RAW_PHASE_CAP, budgeted);
    if (result.phase0.budgetStopped) { result.budget_stopped = 'phase0'; return result; }

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

/**
 * Phase 1 only, with the backfill cap. The first runs of the join are backfills.
 *
 * `include_stale_era` runs phase 1 a SECOND time over the events the burden policy refused with
 * `stale_era` — audited headache notes whose engine version was no longer current (about 605 of
 * them on 9 Sep 2026). Each pass gets the full limit, and the two are reported separately, because
 * a `stale` triple and a `current` one are evidence about different populations even though every
 * phase after this one treats them identically.
 *
 * Off by default, and off on the cron: opening the stale backlog is a decision, not a schedule.
 */
export async function runJoinBackfill(
  limit = BACKFILL_CAP, deps: JoinDeps = {}, opts: { include_stale_era?: boolean } = {},
): Promise<JoinSweepResult> {
  const result: JoinSweepResult = { ...EMPTY, mode: 'backfill' };
  try {
    const nowFn = deps.now ?? (() => new Date());
    const budgeted: JoinDeps = { ...deps, deadlineAt: deps.deadlineAt ?? nowFn().getTime() + SWEEP_BUDGET_MS };
    const capped = Math.max(1, Math.min(BACKFILL_CAP, limit));
    result.phase1 = await runJoinPhase1(capped, budgeted, 'current');
    if (result.phase1.budgetStopped) { result.budget_stopped = 'phase1'; return result; }
    if (opts.include_stale_era) {
      result.phase1_stale = await runJoinPhase1(capped, budgeted, 'stale');
      if (result.phase1_stale.budgetStopped) result.budget_stopped = 'phase1_stale';
    }
    return result;
  } catch (e) {
    return { ...result, ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

/** Phase 0 only, on demand, with the higher manual cap. */
export async function runJoinRawNotes(limit = RAW_PHASE_CAP, deps: JoinDeps = {}): Promise<JoinSweepResult> {
  const result: JoinSweepResult = { ...EMPTY, mode: 'raw_notes' };
  try {
    const nowFn = deps.now ?? (() => new Date());
    const budgeted: JoinDeps = { ...deps, deadlineAt: deps.deadlineAt ?? nowFn().getTime() + SWEEP_BUDGET_MS };
    result.phase0 = await runJoinPhase0(Math.max(1, Math.min(RAW_MANUAL_CAP, limit)), budgeted);
    if (result.phase0.budgetStopped) result.budget_stopped = 'phase0';
    return result;
  } catch (e) {
    return { ...result, ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

/**
 * N5 — does `O_before` still reconstruct to what we stored? (Manual, admin-only, never on the cron.)
 *
 * ── WHAT IT MEASURES, AND WHAT IT CANNOT ───────────────────────────────────────────────────────
 *
 * Every O_before in the table was produced by calling the frozen reconstruct at a past as-of. That
 * function reads db13 LIVE, so its answer for an old day can move — a corrected row, a late-arriving
 * document, a flag change. If it moves, the snapshots already written stop being reproducible, and
 * anything computed from them silently becomes a claim about a database that no longer exists. This
 * run re-takes the same reading and counts how many still hash the same.
 *
 * ⚠️ THE ORIGINAL `computedAt` IS REPLAYED, not today's clock. The frozen reconstruct stamps the
 * `computedAt` it is handed onto the snapshot it returns, and the hash covers the whole object, so
 * re-running with a fresh clock would differ in EVERY row and the check would report 0% while
 * measuring only the passage of time. The original value is read back out of the stored snapshot.
 *
 * ⚠️ WRITES NOTHING TO `cognition_snapshots`. It calls `capture`, never `persistCapture`. A drifted
 * reading is evidence to look at, not a correction to apply — overwriting the stored snapshot would
 * destroy the very thing that made the drift visible.
 *
 * A throw counts as `failed` and comes OUT of the denominator. A run we could not take is not
 * evidence that the reconstruct moved.
 */
export async function runJoinStability(deps: JoinDeps = {}): Promise<JoinStabilityResult> {
  const base: JoinStabilityResult = {
    ok: true, error: null, mode: 'stability', schemaVersion: JOIN_SCHEMA_VERSION,
    sample_n: 0, matched_n: 0, failed_n: 0, match_rate: null, mismatched_ids: [],
  };
  try {
    const sleep = deps.sleep ?? sleepReal;
    const nowFn = deps.now ?? (() => new Date());
    const sample = await listStabilitySample(STABILITY_SAMPLE_N);
    const tripleIds: string[] = [];
    const mismatched: string[] = [];
    let matched = 0;
    let failed = 0;

    for (const row of sample) {
      tripleIds.push(row.triple_id);
      const cap = await capture(row.individual_uid, row.as_of, row.computed_at ?? nowFn().toISOString(), deps);
      if (cap.cutStatus === 'context_fetch_failed') failed++;
      else if (cap.hash != null && cap.hash === row.snapshot_hash) matched++;
      else mismatched.push(row.triple_id);
      await sleep(PACING_MS);
    }

    await insertStabilityRun({
      sample_n: sample.length, matched_n: matched, failed_n: failed,
      triple_ids: tripleIds, mismatched_ids: mismatched,
      walk_version: WORLD_MODEL_WALK_VERSION, member_state_version: MEMBER_STATE_VERSION,
    });

    return {
      ...base, sample_n: sample.length, matched_n: matched, failed_n: failed,
      match_rate: matchRate(sample.length, matched, failed), mismatched_ids: mismatched,
    };
  } catch (e) {
    return { ...base, ok: false, error: String((e as Error).message).slice(0, 300) };
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
