/**
 * lib/cognition/join-store.ts — WM3: the join's two tables (Neon, WIRED).
 *
 * `cognition_snapshots` = one persisted spine reconstruction. `cognition_triples` = one eligible
 * note's (O_before, Y, O_after). Tables created by POST /api/admin/migrate-cognition-join;
 * reference copy in migrations/0055_cognition_join.sql. The arithmetic is lib/cognition/join-core.ts
 * and the phases are lib/cognition/join-sweep.ts.
 *
 * ⚠️ BOTH TABLES CARRY PHI — a plain individual_uid and a whole member-state snapshot. Nothing here
 * is readable by the Lab research scope and nothing here is written to the Lab store.
 *
 * ⚠️ EVERY WRITE IS IDEMPOTENT. Snapshots insert ON CONFLICT DO NOTHING on their identity index and
 * are then read back, so a re-run reuses the row it already wrote rather than making a second one.
 * Triples do the same on (trigger_kind, event_ref, schema_version). Re-running any phase over the
 * same backlog writes nothing new.
 */
import { sql } from '../db';
import { JOIN_SCHEMA_VERSION } from './schema';
import type { EraStatus } from './schema';
import { HEADACHE_RAW_PATTERN } from './microworld';
import type { CutStatus, Provenance, ResolveStatus, YStatus, YVisibleRule } from './join-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// ── shapes ────────────────────────────────────────────────────────────────────

export interface SnapshotRow {
  id: string;
  individual_uid: string;
  as_of: string;
  cut_status: CutStatus;
  provenance: Provenance;
  walk_version: string;
  member_state_version: string;
  ipd_fold: string;
  snapshot_json: unknown;
  snapshot_hash: string | null;
}

export interface SnapshotInsert {
  individual_uid: string;
  as_of: string;
  cut_status: CutStatus;
  provenance: Provenance;
  walk_version: string;
  member_state_version: string;
  ipd_fold: string;
  snapshot_json: unknown;
  snapshot_hash: string | null;
}

export interface TripleRow {
  id: string;
  created_at: string;
  trigger_kind: string;
  event_ref: string;
  event_at: string;
  individual_uid: string | null;
  microworld: string;
  provenance: Provenance;
  resolve_status: ResolveStatus;
  o_before_id: string | null;
  y_kind: string | null;
  y_ref: string | null;
  y_test_date: string | null;
  y_create_time: string | null;
  y_visible_at: string | null;
  y_visible_rule: YVisibleRule | null;
  y_status: YStatus;
  y_horizon_days: number;
  o_after_id: string | null;
  o_after_as_of: string | null;
  reaction_ref: string | null;
  reaction_after_cdmss: boolean | null;
  policy_version: string;
}

export interface TripleInsert {
  trigger_kind: string;
  event_ref: string;
  event_at: string;
  individual_uid: string | null;
  microworld: string;
  provenance: Provenance;
  resolve_status: ResolveStatus;
  o_before_id: string | null;
  y_status: YStatus;
  y_horizon_days: number;
  policy_version: string;
  /** WM3 fix 3 — which backlog this triple came out of. REQUIRED at every call site on purpose:
   *  the column has a default so old ROWS stay valid, but new CODE must state which it is. */
  era_status: EraStatus;
}

/** One eligible shadow event waiting for a triple. */
export interface OpenCandidate {
  trigger_kind: string;
  event_ref: string;
  event_at: string;
  created_at: string;
}

const SNAPSHOT_COLS = `id::text AS id, individual_uid, to_char(as_of,'YYYY-MM-DD') AS as_of, cut_status,
  provenance, walk_version, member_state_version, ipd_fold, snapshot_json, snapshot_hash`;

const TRIPLE_COLS = `id::text AS id, created_at, trigger_kind, event_ref, event_at, individual_uid,
  microworld, provenance, resolve_status, o_before_id::text AS o_before_id, y_kind, y_ref,
  y_test_date, y_create_time, y_visible_at, y_visible_rule, y_status, y_horizon_days,
  o_after_id::text AS o_after_id, to_char(o_after_as_of,'YYYY-MM-DD') AS o_after_as_of,
  reaction_ref::text AS reaction_ref, reaction_after_cdmss, policy_version`;

const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
const json = (v: unknown) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const bool = (v: unknown) => (v == null ? null : v === true || v === 'true' || v === 't');
const str = (v: unknown) => (v == null ? null : String(v));

function toSnapshot(r: Record<string, unknown>): SnapshotRow {
  return {
    id: String(r.id), individual_uid: String(r.individual_uid), as_of: String(r.as_of),
    cut_status: String(r.cut_status) as CutStatus, provenance: String(r.provenance) as Provenance,
    walk_version: String(r.walk_version), member_state_version: String(r.member_state_version),
    ipd_fold: String(r.ipd_fold), snapshot_json: json(r.snapshot_json), snapshot_hash: str(r.snapshot_hash),
  };
}

function toTriple(r: Record<string, unknown>): TripleRow {
  return {
    id: String(r.id), created_at: iso(r.created_at) || '', trigger_kind: String(r.trigger_kind),
    event_ref: String(r.event_ref), event_at: iso(r.event_at) || '',
    individual_uid: str(r.individual_uid), microworld: String(r.microworld),
    provenance: String(r.provenance) as Provenance, resolve_status: String(r.resolve_status) as ResolveStatus,
    o_before_id: str(r.o_before_id), y_kind: str(r.y_kind), y_ref: str(r.y_ref),
    y_test_date: iso(r.y_test_date), y_create_time: iso(r.y_create_time), y_visible_at: iso(r.y_visible_at),
    y_visible_rule: str(r.y_visible_rule) as YVisibleRule | null,
    y_status: String(r.y_status) as YStatus, y_horizon_days: Number(r.y_horizon_days),
    o_after_id: str(r.o_after_id), o_after_as_of: str(r.o_after_as_of),
    reaction_ref: str(r.reaction_ref), reaction_after_cdmss: bool(r.reaction_after_cdmss),
    policy_version: String(r.policy_version),
  };
}

// ── snapshots ─────────────────────────────────────────────────────────────────

/**
 * Persist one capture and return the row that now holds that identity — the one just written, or
 * the one that was already there. Never two rows for one (individual, day, versions, fold,
 * provenance).
 */
export async function upsertSnapshot(row: SnapshotInsert): Promise<SnapshotRow> {
  await run(
    `INSERT INTO cognition_snapshots
       (individual_uid, as_of, cut_status, provenance, walk_version, member_state_version,
        ipd_fold, snapshot_json, snapshot_hash, schema_version)
     VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     ON CONFLICT (individual_uid, as_of, walk_version, member_state_version, ipd_fold, provenance)
     DO NOTHING`,
    [row.individual_uid, row.as_of, row.cut_status, row.provenance, row.walk_version,
      row.member_state_version, row.ipd_fold,
      row.snapshot_json == null ? null : JSON.stringify(row.snapshot_json), row.snapshot_hash,
      JOIN_SCHEMA_VERSION]);
  const rows = await run(
    `SELECT ${SNAPSHOT_COLS} FROM cognition_snapshots
      WHERE individual_uid=$1 AND as_of=$2::date AND walk_version=$3
        AND member_state_version=$4 AND ipd_fold=$5 AND provenance=$6 LIMIT 1`,
    [row.individual_uid, row.as_of, row.walk_version, row.member_state_version, row.ipd_fold, row.provenance]);
  return toSnapshot(rows[0]);
}

export async function getSnapshot(id: string): Promise<SnapshotRow | null> {
  const rows = await run(`SELECT ${SNAPSHOT_COLS} FROM cognition_snapshots WHERE id=$1::uuid LIMIT 1`, [id]);
  return rows[0] ? toSnapshot(rows[0]) : null;
}

/**
 * Fill in a capture that previously failed. The ONLY mutation of a snapshot row in this ship, and
 * it is guarded twice: the row must currently be `context_fetch_failed`, and the incoming capture
 * must not be. An outage row is a placeholder for a reading we could not take; replacing it with
 * the reading is the point of `?retry_failed=1`. A successful capture is never overwritten.
 */
export async function repairFailedSnapshot(id: string, cutStatus: CutStatus, snapshotJson: unknown, hash: string | null): Promise<boolean> {
  if (cutStatus === 'context_fetch_failed') return false;
  const rows = await run(
    `UPDATE cognition_snapshots
        SET cut_status=$2, snapshot_json=$3::jsonb, snapshot_hash=$4
      WHERE id=$1::uuid AND cut_status='context_fetch_failed'
      RETURNING id::text AS id`,
    [id, cutStatus, snapshotJson == null ? null : JSON.stringify(snapshotJson), hash]);
  return rows.length > 0;
}

// ── triples ───────────────────────────────────────────────────────────────────

/** The earliest triple's created_at — the join's first run time. Null before the first run. */
export async function firstRunAt(): Promise<Date | null> {
  const rows = await run(`SELECT min(created_at) AS t FROM cognition_triples`, []);
  const t = rows[0]?.t;
  return t == null ? null : new Date(String(t));
}

/**
 * Shadow events with no triple yet, oldest first. The NOT EXISTS is keyed on the join's schema
 * version, so bumping it re-opens the backlog rather than leaving old rows to be read as current
 * ones.
 *
 * ⚠️ TWO ERAS, ONE QUERY, AND THE PREDICATE IS THE ONLY DIFFERENCE.
 *   · `current` — `eligible = TRUE`. Unchanged from the first ship, byte for byte.
 *   · `stale`   — the events the burden policy REFUSED with `stale_era`: audited notes whose engine
 *                 version was not the current era when the shadow judged them. `eligible = FALSE`
 *                 alone would also sweep up `not_microworld` and `no_doctor`, which are refusals
 *                 about the note itself and not about the era, so the reason and the microworld are
 *                 both pinned. (`microworld = 'headache'` is redundant given the reason — the
 *                 eligibility ladder checks the microworld first — and is stated anyway, because a
 *                 later reordering of that ladder must not silently widen this query.)
 *
 * The stale backlog is FINITE (~605 headache events on 9 Sep 2026) and is drained by hand, never by
 * the cron: see `runJoinBackfill`.
 */
export async function listOpenCandidates(
  policyVersion: string, triggerKind: string, limit: number, era: 'current' | 'stale' = 'current',
): Promise<OpenCandidate[]> {
  const eraPredicate = era === 'stale'
    ? `e.eligible = FALSE AND e.reason = 'stale_era' AND e.microworld = 'headache'`
    : `e.eligible = TRUE`;
  const rows = await run(
    `SELECT e.trigger_kind, e.event_ref, e.event_at, e.created_at
       FROM cognition_shadow_events e
      WHERE ${eraPredicate} AND e.policy_version = $1 AND e.trigger_kind = $2
        AND NOT EXISTS (
          SELECT 1 FROM cognition_triples t
           WHERE t.trigger_kind = e.trigger_kind AND t.event_ref = e.event_ref
             AND t.schema_version = $3)
      ORDER BY e.created_at ASC
      LIMIT $4`,
    [policyVersion, triggerKind, JOIN_SCHEMA_VERSION, limit]);
  return (rows as Record<string, unknown>[]).map((r) => ({
    trigger_kind: String(r.trigger_kind), event_ref: String(r.event_ref),
    event_at: iso(r.event_at) || '', created_at: iso(r.created_at) || '',
  }));
}

/** Open one triple. Returns false when a triple for this event already existed. */
export async function insertTriple(row: TripleInsert): Promise<boolean> {
  const rows = await run(
    `INSERT INTO cognition_triples
       (trigger_kind, event_ref, event_at, individual_uid, microworld, provenance, resolve_status,
        o_before_id, y_status, y_horizon_days, policy_version, schema_version, era_status)
     VALUES ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8::uuid,$9,$10,$11,$12,$13)
     ON CONFLICT (trigger_kind, event_ref, schema_version) DO NOTHING
     RETURNING id::text AS id`,
    [row.trigger_kind, row.event_ref, row.event_at, row.individual_uid, row.microworld,
      row.provenance, row.resolve_status, row.o_before_id, row.y_status, row.y_horizon_days,
      row.policy_version, JOIN_SCHEMA_VERSION, row.era_status]);
  return rows.length > 0;
}

/**
 * Does ANY triple already exist for this note, under any trigger kind?
 *
 * ⚠️ ONE TRIPLE PER NOTE, AND THE AUDIT TRIGGER WINS. A note that the shadow agent judged and the
 * raw rule also matches must not become two triples — the pair would be counted twice in every rate
 * on the readout, and the second would carry a WEAKER provenance for the same event. The identity
 * index cannot prevent it (it is keyed on `trigger_kind` too, so the same `event_ref` under two
 * kinds is two legal rows), so phase 0 asks this question before every insert.
 */
export async function tripleExistsForNote(eventRef: string): Promise<boolean> {
  const rows = await run(
    `SELECT 1 FROM cognition_triples WHERE event_ref = $1 AND schema_version = $2 LIMIT 1`,
    [eventRef, JOIN_SCHEMA_VERSION]);
  return rows.length > 0;
}

/**
 * The OLDEST raw-trigger triple's event time — phase 0's cursor. Null before the first raw run.
 *
 * `min`, not `max`, because phase 0 walks NEWEST FIRST: each run takes the newest notes it has not
 * reached yet, so the cursor is the oldest point already covered and the next run asks for notes
 * strictly older than it. See `runJoinPhase0`.
 */
export async function rawNoteCursor(triggerKind: string): Promise<string | null> {
  const rows = await run(
    `SELECT min(event_at) AS t FROM cognition_triples WHERE trigger_kind = $1 AND schema_version = $2`,
    [triggerKind, JOIN_SCHEMA_VERSION]);
  const t = rows[0]?.t;
  return t == null ? null : new Date(String(t)).toISOString();
}

// ── the raw-note candidate read (db13, NOT Neon) ──────────────────────────────
//
// ⚠️ THE ONE db13 STRING IN THIS FILE, and it is here rather than in join-sweep.ts because this
// module is where the join's SQL is read and reviewed. It is run through `metabaseQuery`, which
// binds NO parameters, so both inlined values are validated before they are inlined and neither can
// carry SQL: the timestamp against a strict ISO pattern, the limit through Math.

/**
 * The earliest note the raw trigger will ever open. January 2024 is the floor the headache pool was
 * measured from (CDMSS-WM-HEADACHE-POOL-ALL-HISTORY-8-SEP-2026 §2.4); older notes are outside the
 * measured pool, so opening them would add rows to a denominator nobody has counted.
 */
export const RAW_NOTE_FLOOR = '2024-01-01';

/** `2026-09-09T04:30:00Z` and nothing looser. A value that fails this is never inlined. */
const isIsoSecond = (t: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(t);

/**
 * Raw OPD notes matching `headache-raw/1`, newest first, older than the cursor.
 *
 * ⚠️ THE SEVEN COLUMNS ARE THE RULE. This is the exact seven-field concatenation measured in
 * CDMSS-WM-HEADACHE-POOL-ALL-HISTORY-8-SEP-2026 §2.4. Adding a column would widen the pool past
 * what was counted; dropping one would narrow it; adding a doctor or note-type filter would make
 * the rule string `headache-raw/1` name something other than what it names. None of the three is a
 * tuning knob — each needs a new rule string.
 *
 * ⚠️ INFERRED. This sandbox has no live db13; the string is listed verbatim in the ship report and
 * is validated against production before the cron sees it.
 *
 * Over-fetches 3× the limit because an unknown share of the newest rows already have a triple (the
 * audit trigger reached them first) and are skipped without being opened.
 */
export function listRawNoteCandidatesSql(beforeTs: string | null, limit: number): string {
  const lim = Math.max(1, Math.min(3000, Math.floor(limit) * 3));
  if (beforeTs != null && !isIsoSecond(beforeTs)) throw new Error('bad beforeTs');
  const before = beforeTs == null ? '' : `\n   AND p.timestamp < '${beforeTs}'`;
  return `SELECT p.uid, p._parent_id AS individual_uid, p.doctor_uid,
       to_char(p.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS event_at
  FROM "individuals-prescriptions" p
 WHERE p.is_draft = false
   AND p.timestamp >= '${RAW_NOTE_FLOOR}'${before}
   AND (
         coalesce(p.presenting_complaints::text, '') || ' ' ||
         coalesce(p.general_practitioner_prescription__presenting_complaints::text, '') || ' ' ||
         coalesce(p.assessments::text, '') || ' ' ||
         coalesce(p.reason_for_consultation, '') || ' ' ||
         coalesce(p.visit_notes::text, '') || ' ' ||
         coalesce(p.relevant_medical_history::text, '') || ' ' ||
         coalesce(p.free_text, '')
       ) ~* '${HEADACHE_RAW_PATTERN}'
 ORDER BY p.timestamp DESC
 LIMIT ${lim}`;
}

/** Triples waiting for a Y, oldest-touched first. */
export async function listPendingY(limit: number): Promise<TripleRow[]> {
  const rows = await run(
    `SELECT ${TRIPLE_COLS} FROM cognition_triples
      WHERE y_status = 'pending' AND resolve_status = 'resolved' AND schema_version = $1
      ORDER BY updated_at ASC LIMIT $2`,
    [JOIN_SCHEMA_VERSION, limit]);
  return (rows as Record<string, unknown>[]).map(toTriple);
}

/** Triples with a Y and no O_after yet, oldest-touched first. */
export async function listOpenAfter(limit: number): Promise<TripleRow[]> {
  const rows = await run(
    `SELECT ${TRIPLE_COLS} FROM cognition_triples
      WHERE y_status = 'present' AND o_after_id IS NULL AND schema_version = $1
      ORDER BY updated_at ASC LIMIT $2`,
    [JOIN_SCHEMA_VERSION, limit]);
  return (rows as Record<string, unknown>[]).map(toTriple);
}

/** Triples whose O_after capture failed, for a manual `?retry_failed=1` run. */
export async function listFailedAfter(limit: number): Promise<TripleRow[]> {
  const rows = await run(
    `SELECT ${TRIPLE_COLS} FROM cognition_triples t
      WHERE t.y_status = 'present' AND t.schema_version = $1 AND t.o_after_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM cognition_snapshots s
                     WHERE s.id = t.o_after_id AND s.cut_status = 'context_fetch_failed')
      ORDER BY t.updated_at ASC LIMIT $2`,
    [JOIN_SCHEMA_VERSION, limit]);
  return (rows as Record<string, unknown>[]).map(toTriple);
}

export interface YUpdate {
  y_kind: string | null;
  y_ref: string | null;
  y_test_date: string | null;
  y_create_time: string | null;
  y_visible_at: string | null;
  y_visible_rule: YVisibleRule | null;
  y_status: YStatus;
}

/** Record the Y decision. `updated_at` moves so the phase queues stay fair. */
export async function updateY(id: string, y: YUpdate): Promise<void> {
  await run(
    `UPDATE cognition_triples
        SET y_kind=$2, y_ref=$3, y_test_date=$4::timestamp, y_create_time=$5::timestamptz,
            y_visible_at=$6::timestamptz, y_visible_rule=$7, y_status=$8, updated_at=now()
      WHERE id=$1::uuid`,
    [id, y.y_kind, y.y_ref, y.y_test_date, y.y_create_time, y.y_visible_at, y.y_visible_rule, y.y_status]);
}

/** Close the triple with its O_after. */
export async function updateOAfter(id: string, oAfterId: string, oAfterAsOf: string): Promise<void> {
  await run(
    `UPDATE cognition_triples
        SET o_after_id=$2::uuid, o_after_as_of=$3::date, updated_at=now()
      WHERE id=$1::uuid`,
    [id, oAfterId, oAfterAsOf]);
}

/** Attach a doctor reaction. Never overwrites one that is already attached. */
export async function attachReaction(id: string, reactionRef: string, afterCdmss: boolean): Promise<void> {
  await run(
    `UPDATE cognition_triples
        SET reaction_ref=$2::uuid, reaction_after_cdmss=$3, updated_at=now()
      WHERE id=$1::uuid AND reaction_ref IS NULL`,
    [id, reactionRef, afterCdmss]);
}

/**
 * The reaction for one event, if a doctor pressed one.
 *
 * ⚠️ THE TWO IDENTIFIERS ARE NOT THE SAME ONE, AND THE JOIN IS WHAT BRIDGES THEM. B2a fills
 * `cognition_reactions.clinical_state_ref` with `resolveInstances(...).representative.audit_id` —
 * an `opd_note_audits.id`, a uuid rendered as text. A triple's `event_ref` is the shadow event's
 * `opd_note_audits.uid`, the db13 prescription uid. Matching one against the other directly (WM3
 * flag 4, measured in production on 8 Sep 2026: the one live reaction row carries the id, not the
 * uid) matches nothing, silently — no error, just a count that never leaves zero. So the two are
 * joined through the audit row that holds both. `opd_note_audits.id` is UUID in this repo's DDL
 * (migrations/0007_opd_note_audits.sql), so `::text` is the cast that meets a TEXT column.
 */
export async function reactionForEvent(eventRef: string): Promise<{ id: string; after_cdmss: boolean } | null> {
  const rows = await run(
    `SELECT r.id, r.after_cdmss
  FROM cognition_reactions r
  JOIN opd_note_audits a ON a.id::text = r.clinical_state_ref
 WHERE a.uid = $1
 ORDER BY r.created_at ASC
 LIMIT 1`, [eventRef]);
  return rows[0] ? { id: String(rows[0].id), after_cdmss: bool(rows[0].after_cdmss) === true } : null;
}

/** Every triple for one individual, newest event first. The readout's uid lookup. */
export async function listTriplesForIndividual(individualUid: string, limit = 50): Promise<TripleRow[]> {
  const rows = await run(
    `SELECT ${TRIPLE_COLS} FROM cognition_triples
      WHERE individual_uid = $1 AND schema_version = $2 ORDER BY event_at DESC LIMIT $3`,
    [individualUid, JOIN_SCHEMA_VERSION, limit]);
  return (rows as Record<string, unknown>[]).map(toTriple);
}

// ── the stability check (N5) ──────────────────────────────────────────────────

/** One triple in the stability sample, with the stored capture it will be compared against. */
export interface StabilitySampleRow {
  triple_id: string;
  individual_uid: string;
  as_of: string;
  snapshot_hash: string | null;
  /** The `computedAt` the ORIGINAL capture was taken with, read back out of the stored snapshot. */
  computed_at: string | null;
}

export interface StabilityInsert {
  sample_n: number;
  matched_n: number;
  failed_n: number;
  triple_ids: string[];
  mismatched_ids: string[];
  walk_version: string;
  member_state_version: string;
}

export interface StabilityRow {
  run_at: string;
  sample_n: number;
  matched_n: number;
  failed_n: number;
  match_rate: number | null;
}

/**
 * The stability sample: the OLDEST resolved triples whose O_before is an `ok` capture.
 *
 * Oldest-first and unfiltered by anything that moves, so the sample is DETERMINISTIC — a re-run
 * re-reads the same rows and the two match rates are comparable. A random sample would make every
 * run its own experiment.
 *
 * `computed_at` is pulled out of the stored snapshot because the frozen reconstruct stamps the
 * `computedAt` it is handed onto the snapshot it returns, and `snapshotHash` hashes the whole
 * object. Re-reconstructing with today's clock would therefore differ from the stored hash in every
 * single row, and the check would report 0% while measuring nothing but the clock.
 */
export async function listStabilitySample(limit: number): Promise<StabilitySampleRow[]> {
  const rows = await run(
    `SELECT t.id::text AS triple_id, t.individual_uid,
            to_char(s.as_of,'YYYY-MM-DD') AS as_of, s.snapshot_hash,
            s.snapshot_json->>'computedAt' AS computed_at
       FROM cognition_triples t
       JOIN cognition_snapshots s ON s.id = t.o_before_id
      WHERE t.schema_version = $1 AND t.resolve_status = 'resolved' AND t.o_before_id IS NOT NULL
        AND s.cut_status = 'ok' AND s.schema_version = $1
      ORDER BY t.created_at ASC
      LIMIT $2`,
    [JOIN_SCHEMA_VERSION, limit]);
  return (rows as Record<string, unknown>[]).map((r) => ({
    triple_id: String(r.triple_id), individual_uid: String(r.individual_uid),
    as_of: String(r.as_of), snapshot_hash: str(r.snapshot_hash), computed_at: str(r.computed_at),
  }));
}

/** Record one stability run. Append-only: a run is a measurement, and measurements accumulate. */
export async function insertStabilityRun(row: StabilityInsert): Promise<void> {
  await run(
    `INSERT INTO cognition_join_stability
       (sample_n, matched_n, failed_n, triple_ids, mismatched_ids, walk_version,
        member_state_version, schema_version)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
    [row.sample_n, row.matched_n, row.failed_n, JSON.stringify(row.triple_ids),
      JSON.stringify(row.mismatched_ids), row.walk_version, row.member_state_version,
      JOIN_SCHEMA_VERSION]);
}

/** The most recent stability run, for the readout. Null before the check has ever been run. */
export async function latestStabilityRun(): Promise<StabilityRow | null> {
  const rows = await run(
    `SELECT run_at, sample_n, matched_n, failed_n FROM cognition_join_stability
      WHERE schema_version = $1 ORDER BY run_at DESC LIMIT 1`,
    [JOIN_SCHEMA_VERSION]);
  const r = rows[0];
  if (!r) return null;
  const sample = Number(r.sample_n); const matched = Number(r.matched_n); const failed = Number(r.failed_n);
  return {
    run_at: iso(r.run_at) || '', sample_n: sample, matched_n: matched, failed_n: failed,
    match_rate: matchRate(sample, matched, failed),
  };
}

/**
 * matched / (sampled − failed), and NULL when the denominator is zero.
 *
 * The failures come out of the denominator rather than counting as mismatches: a run we could not
 * take is not evidence that the reconstruct moved. Zero over zero is not 0% — it is "we have not
 * measured", and the readout says so.
 */
export function matchRate(sampleN: number, matchedN: number, failedN: number): number | null {
  const denom = sampleN - failedN;
  return denom > 0 ? matchedN / denom : null;
}

// ── the readout's counts ──────────────────────────────────────────────────────

export interface JoinCounts {
  triplesByYStatus: { k: string; n: number }[];
  triplesByProvenance: { k: string; n: number }[];
  triplesByResolveStatus: { k: string; n: number }[];
  /** WM3 fix 3 — current / stale / unaudited. Three denominators, never one. */
  triplesByEraStatus: { k: string; n: number }[];
  /** WM3 fix 3 — opd_note_audited / opd_note_matched. */
  triplesByTriggerKind: { k: string; n: number }[];
  snapshotsByCutStatus: { k: string; n: number }[];
  /** The last O_before stability run, or null when the check has never been run. */
  stability: StabilityRow | null;
  presentWithOAfterOk: number;
  reactionsAttached: number;
  lag: { visibleMedianH: number | null; visibleP90H: number | null; testMedianH: number | null; testP90H: number | null };
}

const kn = (rows: Record<string, unknown>[]) => rows.map((r) => ({ k: String(r.k), n: Number(r.n) }));

/** Every number on the readout. Throws on a read failure; the page renders "could not read". */
export async function joinCounts(): Promise<JoinCounts> {
  const [byY, byProv, byResolve, byEra, byTrigger, bySnap, ok, reacted, lag, stability] = await Promise.all([
    run(`SELECT y_status AS k, count(*)::int AS n FROM cognition_triples WHERE schema_version=$1 GROUP BY 1 ORDER BY n DESC`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT provenance AS k, count(*)::int AS n FROM cognition_triples WHERE schema_version=$1 GROUP BY 1 ORDER BY n DESC`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT resolve_status AS k, count(*)::int AS n FROM cognition_triples WHERE schema_version=$1 GROUP BY 1 ORDER BY n DESC`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT era_status AS k, count(*)::int AS n FROM cognition_triples WHERE schema_version=$1 GROUP BY 1 ORDER BY n DESC`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT trigger_kind AS k, count(*)::int AS n FROM cognition_triples WHERE schema_version=$1 GROUP BY 1 ORDER BY n DESC`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT cut_status AS k, count(*)::int AS n FROM cognition_snapshots WHERE schema_version=$1 GROUP BY 1 ORDER BY n DESC`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT count(*)::int AS n FROM cognition_triples t
           JOIN cognition_snapshots s ON s.id = t.o_after_id
          WHERE t.schema_version=$1 AND t.y_status='present' AND s.cut_status='ok'`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT count(*)::int AS n FROM cognition_triples WHERE schema_version=$1 AND reaction_ref IS NOT NULL`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (y_visible_at - event_at))/3600.0) AS visible_median_h,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (y_visible_at - event_at))/3600.0) AS visible_p90_h,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (y_test_date - event_at))/3600.0) AS test_median_h,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (y_test_date - event_at))/3600.0) AS test_p90_h
         FROM cognition_triples
        WHERE schema_version=$1 AND y_status='present' AND y_visible_at IS NOT NULL`, [JOIN_SCHEMA_VERSION]),
    latestStabilityRun(),
  ]);
  const l = lag[0] ?? {};
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    triplesByYStatus: kn(byY as Record<string, unknown>[]),
    triplesByProvenance: kn(byProv as Record<string, unknown>[]),
    triplesByResolveStatus: kn(byResolve as Record<string, unknown>[]),
    triplesByEraStatus: kn(byEra as Record<string, unknown>[]),
    triplesByTriggerKind: kn(byTrigger as Record<string, unknown>[]),
    snapshotsByCutStatus: kn(bySnap as Record<string, unknown>[]),
    stability: stability as StabilityRow | null,
    presentWithOAfterOk: Number(ok[0]?.n ?? 0),
    reactionsAttached: Number(reacted[0]?.n ?? 0),
    lag: {
      visibleMedianH: num(l.visible_median_h), visibleP90H: num(l.visible_p90_h),
      testMedianH: num(l.test_median_h), testP90H: num(l.test_p90_h),
    },
  };
}
