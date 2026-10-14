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
 * Eligible shadow events with no triple yet, oldest first. The NOT EXISTS is keyed on the join's
 * schema version, so bumping it re-opens the backlog rather than leaving old rows to be read as
 * current ones.
 */
export async function listOpenCandidates(policyVersion: string, triggerKind: string, limit: number): Promise<OpenCandidate[]> {
  const rows = await run(
    `SELECT e.trigger_kind, e.event_ref, e.event_at, e.created_at
       FROM cognition_shadow_events e
      WHERE e.eligible = TRUE AND e.policy_version = $1 AND e.trigger_kind = $2
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
        o_before_id, y_status, y_horizon_days, policy_version, schema_version)
     VALUES ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8::uuid,$9,$10,$11,$12)
     ON CONFLICT (trigger_kind, event_ref, schema_version) DO NOTHING
     RETURNING id::text AS id`,
    [row.trigger_kind, row.event_ref, row.event_at, row.individual_uid, row.microworld,
      row.provenance, row.resolve_status, row.o_before_id, row.y_status, row.y_horizon_days,
      row.policy_version, JOIN_SCHEMA_VERSION]);
  return rows.length > 0;
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

// ── the readout's counts ──────────────────────────────────────────────────────

export interface JoinCounts {
  triplesByYStatus: { k: string; n: number }[];
  triplesByProvenance: { k: string; n: number }[];
  triplesByResolveStatus: { k: string; n: number }[];
  snapshotsByCutStatus: { k: string; n: number }[];
  presentWithOAfterOk: number;
  reactionsAttached: number;
  lag: { visibleMedianH: number | null; visibleP90H: number | null; testMedianH: number | null; testP90H: number | null };
}

const kn = (rows: Record<string, unknown>[]) => rows.map((r) => ({ k: String(r.k), n: Number(r.n) }));

/** Every number on the readout. Throws on a read failure; the page renders "could not read". */
export async function joinCounts(): Promise<JoinCounts> {
  const [byY, byProv, byResolve, bySnap, ok, reacted, lag] = await Promise.all([
    run(`SELECT y_status AS k, count(*)::int AS n FROM cognition_triples WHERE schema_version=$1 GROUP BY 1 ORDER BY n DESC`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT provenance AS k, count(*)::int AS n FROM cognition_triples WHERE schema_version=$1 GROUP BY 1 ORDER BY n DESC`, [JOIN_SCHEMA_VERSION]),
    run(`SELECT resolve_status AS k, count(*)::int AS n FROM cognition_triples WHERE schema_version=$1 GROUP BY 1 ORDER BY n DESC`, [JOIN_SCHEMA_VERSION]),
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
  ]);
  const l = lag[0] ?? {};
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    triplesByYStatus: kn(byY as Record<string, unknown>[]),
    triplesByProvenance: kn(byProv as Record<string, unknown>[]),
    triplesByResolveStatus: kn(byResolve as Record<string, unknown>[]),
    snapshotsByCutStatus: kn(bySnap as Record<string, unknown>[]),
    presentWithOAfterOk: Number(ok[0]?.n ?? 0),
    reactionsAttached: Number(reacted[0]?.n ?? 0),
    lag: {
      visibleMedianH: num(l.visible_median_h), visibleP90H: num(l.visible_p90_h),
      testMedianH: num(l.test_median_h), testP90H: num(l.test_p90_h),
    },
  };
}
