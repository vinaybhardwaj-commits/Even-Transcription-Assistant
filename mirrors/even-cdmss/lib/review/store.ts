/**
 * lib/review/store.ts — WM6: the sequential-review store (Neon, WIRED).
 *
 * `cognition_review_sessions` = one review sitting. `cognition_belief_updates` = one row per
 * (session, step, base-or-variant), immutable. Tables created by
 * POST /api/admin/migrate-cognition-review; reference copy in migrations/0054_cognition_review.sql.
 * The pure step model is lib/review/session.ts.
 *
 * ⚠️ THE SUBJECT IS HASHED BEFORE IT GETS HERE. Nothing in this module accepts an individual_uid;
 * `insertSession` takes `individual_uid_hash` and there is no column, parameter or query below that
 * could hold the plain uid.
 *
 * ⚠️ NOBODY IS SCORED. There is no correctness column to write and no query here that compares a
 * belief to anything.
 */
import { sql } from '../db';
import { REVIEW_SCHEMA_VERSION, type ReviewVariantId } from '../cognition/schema';
import type { BeliefKey, ReviewCutStatus, ReviewStatus, ReviewerRole } from './session';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** One cut as stored on the session row: the walk's cut, snapshot and all. */
export interface StoredCut {
  date: string;
  status: ReviewCutStatus;
  snapshot?: unknown;
  foldNotes: string[];
  foldRefused: unknown[];
}

export interface SessionRow {
  id: string;
  created_at: string;
  individual_uid_hash: string;
  microworld: string;
  reviewer_role: ReviewerRole;
  variants: ReviewVariantId[];
  walk_version: string;
  member_state_version: string;
  ipd_fold: string;
  cuts: StoredCut[];
  cut_count: number;
  revealed_index: number;
  status: ReviewStatus;
  completed_at: string | null;
  schema_version: string;
}

export interface SessionInsert {
  individual_uid_hash: string;
  microworld: string;
  reviewer_role: ReviewerRole;
  variants: ReviewVariantId[];
  walk_version: string;
  member_state_version: string;
  ipd_fold: string;
  cuts: StoredCut[];
  cut_count: number;
  status: ReviewStatus;
}

export interface BeliefRow {
  id: string;
  created_at: string;
  session_id: string;
  step_index: number;
  cut_date: string;
  variant_id: ReviewVariantId | null;
  reviewer_role: ReviewerRole;
  provenance: string;
  trigger: string;
  after_cdmss: boolean;
  payload: unknown;
  seconds_spent: number;
  schema_version: string;
}

export interface BeliefInsert {
  session_id: string;
  step_index: number;
  cut_date: string;
  variant_id: ReviewVariantId | null;
  reviewer_role: ReviewerRole;
  payload: unknown;
  seconds_spent: number;
}

const SESSION_COLS = `id::text AS id, created_at, individual_uid_hash, microworld, reviewer_role,
  variants, walk_version, member_state_version, ipd_fold, cuts, cut_count, revealed_index,
  status, completed_at, schema_version`;

const BELIEF_COLS = `id::text AS id, created_at, session_id::text AS session_id, step_index,
  to_char(cut_date,'YYYY-MM-DD') AS cut_date, variant_id, reviewer_role, provenance, trigger,
  after_cdmss, payload, seconds_spent, schema_version`;

const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
const json = (v: unknown) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const bool = (v: unknown) => v === true || v === 'true' || v === 't';

/** `text[]` comes back as a JS array on the wire and as `{a,b}` from a text-typed driver. Both. */
function textArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v ?? '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return [];
  const inner = s.slice(1, -1).trim();
  return inner ? inner.split(',').map((x) => x.replace(/^"|"$/g, '')) : [];
}

function toSession(r: Record<string, unknown>): SessionRow {
  return {
    id: String(r.id), created_at: iso(r.created_at) || '',
    individual_uid_hash: String(r.individual_uid_hash), microworld: String(r.microworld),
    reviewer_role: String(r.reviewer_role) as ReviewerRole,
    variants: textArray(r.variants) as ReviewVariantId[],
    walk_version: String(r.walk_version), member_state_version: String(r.member_state_version),
    ipd_fold: String(r.ipd_fold), cuts: (json(r.cuts) ?? []) as StoredCut[],
    cut_count: Number(r.cut_count), revealed_index: Number(r.revealed_index),
    status: String(r.status) as ReviewStatus, completed_at: iso(r.completed_at),
    schema_version: String(r.schema_version),
  };
}

function toBelief(r: Record<string, unknown>): BeliefRow {
  return {
    id: String(r.id), created_at: iso(r.created_at) || '', session_id: String(r.session_id),
    step_index: Number(r.step_index), cut_date: String(r.cut_date),
    variant_id: r.variant_id == null ? null : (String(r.variant_id) as ReviewVariantId),
    reviewer_role: String(r.reviewer_role) as ReviewerRole, provenance: String(r.provenance),
    trigger: String(r.trigger), after_cdmss: bool(r.after_cdmss), payload: json(r.payload),
    seconds_spent: Number(r.seconds_spent), schema_version: String(r.schema_version),
  };
}

/** Open a session. `cuts` is the walk's array as returned; the plain uid never reaches this call. */
export async function insertSession(row: SessionInsert): Promise<SessionRow> {
  const rows = await run(
    `INSERT INTO cognition_review_sessions
       (individual_uid_hash, microworld, reviewer_role, variants, walk_version,
        member_state_version, ipd_fold, cuts, cut_count, status, schema_version)
     VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8::jsonb,$9,$10,$11)
     RETURNING ${SESSION_COLS}`,
    [row.individual_uid_hash, row.microworld, row.reviewer_role, row.variants, row.walk_version,
      row.member_state_version, row.ipd_fold, JSON.stringify(row.cuts), row.cut_count, row.status,
      REVIEW_SCHEMA_VERSION]);
  return toSession(rows[0]);
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const rows = await run(
    `SELECT ${SESSION_COLS} FROM cognition_review_sessions WHERE id=$1::uuid LIMIT 1`, [sessionId]);
  return rows[0] ? toSession(rows[0]) : null;
}

/** The keys already recorded for a session, in the order they were recorded. */
export async function listBeliefKeys(sessionId: string): Promise<BeliefKey[]> {
  const rows = await run(
    `SELECT step_index, variant_id FROM cognition_belief_updates
      WHERE session_id=$1::uuid ORDER BY step_index ASC, created_at ASC`, [sessionId]);
  return (rows as Record<string, unknown>[]).map((r) => ({
    stepIndex: Number(r.step_index),
    variantId: r.variant_id == null ? null : (String(r.variant_id) as ReviewVariantId),
  }));
}

/** The stored belief for one key, or null. `variant_id IS NOT DISTINCT FROM` so NULL matches NULL. */
export async function getBelief(sessionId: string, stepIndex: number, variantId: string | null): Promise<BeliefRow | null> {
  const rows = await run(
    `SELECT ${BELIEF_COLS} FROM cognition_belief_updates
      WHERE session_id=$1::uuid AND step_index=$2 AND variant_id IS NOT DISTINCT FROM $3 LIMIT 1`,
    [sessionId, stepIndex, variantId]);
  return rows[0] ? toBelief(rows[0]) : null;
}

/**
 * Record one belief. `ON CONFLICT DO NOTHING` on the step index, so a double submit never raises
 * and never overwrites: it returns NULL and the caller re-reads and classifies. provenance, trigger
 * and after_cdmss are fixed by construction — a review belief is always a reported belief, always a
 * retrospective replay, and never after a CDMSS output.
 */
export async function insertBelief(row: BeliefInsert): Promise<BeliefRow | null> {
  const rows = await run(
    `INSERT INTO cognition_belief_updates
       (session_id, step_index, cut_date, variant_id, reviewer_role, provenance, trigger,
        after_cdmss, payload, seconds_spent, schema_version)
     VALUES ($1::uuid,$2,$3::date,$4,$5,'CLINICIAN_REPORTED_BELIEF','retrospective_replay',FALSE,$6::jsonb,$7,$8)
     ON CONFLICT (session_id, step_index, COALESCE(variant_id, 'base')) DO NOTHING
     RETURNING ${BELIEF_COLS}`,
    [row.session_id, row.step_index, row.cut_date, row.variant_id, row.reviewer_role,
      JSON.stringify(row.payload), row.seconds_spent, REVIEW_SCHEMA_VERSION]);
  return rows[0] ? toBelief(rows[0]) : null;
}

/** Move the session's progress. `completed_at` is set when the session ends, either way it ended. */
export async function updateSessionProgress(
  sessionId: string, revealedIndex: number, status: ReviewStatus,
): Promise<void> {
  await run(
    `UPDATE cognition_review_sessions
        SET revealed_index=$2, status=$3,
            completed_at = CASE WHEN $3 IN ('completed','incomplete') THEN now() ELSE completed_at END
      WHERE id=$1::uuid`,
    [sessionId, revealedIndex, status]);
}

export interface BeliefStats { rows: number; meanSeconds: number | null; maxSeconds: number | null }

/** The burden figures for the completion line. Nothing here is about correctness. */
export async function beliefStats(sessionId: string): Promise<BeliefStats> {
  const rows = await run(
    `SELECT count(*)::int AS rows, avg(seconds_spent)::float AS mean_seconds,
            max(seconds_spent)::int AS max_seconds
       FROM cognition_belief_updates WHERE session_id=$1::uuid`, [sessionId]);
  const r = rows[0] ?? {};
  const n = Number(r.rows ?? 0);
  return {
    rows: n,
    meanSeconds: n === 0 || r.mean_seconds == null ? null : Number(r.mean_seconds),
    maxSeconds: n === 0 || r.max_seconds == null ? null : Number(r.max_seconds),
  };
}
