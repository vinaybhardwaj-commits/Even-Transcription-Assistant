/**
 * lib/cognition/reactions-store.ts — WM2 v1: the reaction store (Neon, WIRED).
 *
 * `cognition_reactions` = one row per (signal, physician): what a doctor pressed on a Findings
 * card. Immutable, replay-safe, and it notifies nobody. Table created by
 * POST /api/admin/migrate-cognition-reactions; reference copy in
 * migrations/0053_cognition_reactions.sql. Pure vocabulary and the replay guard are in
 * lib/cognition/reactions.ts.
 *
 * ⚠️ NO PHI. Every column here is an identifier or a controlled-vocabulary token. There is no
 * free-text column to write patient text into, and nothing below reads note text or a comment.
 *
 * ⚠️ NO READ FILTERS ON app_source. The unique index is (signal_id, physician_id) and does not
 * include app_source, so a read that filtered on it could return NULL for a row the index would
 * still refuse to write — and the route would then try to insert a duplicate. Identity is global
 * here; app_source is recorded as provenance only. This is a deliberate divergence from the
 * cognition_shadow_events reads, whose unique key includes no cross-deployment ambiguity.
 */
import { sql } from '../db';
import { REACTION_SCHEMA_VERSION, type ReactionVerb } from './schema';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

export interface ReactionRow {
  id: string;
  created_at: string;
  signal_id: string;
  reference: string;
  clinical_state_ref: string | null;
  cdmss_doctor_uid: string;
  physician_id: string;
  reaction: string;
  provenance: string;
  after_cdmss: boolean;
  surface: string;
  schema_version: string;
}

export interface ReactionInsert {
  signal_id: string;
  reference: string;
  clinical_state_ref: string | null;
  cdmss_doctor_uid: string;
  physician_id: string;
  reaction: ReactionVerb;
}

const COLS = `id::text AS id, created_at, signal_id::text AS signal_id, reference, clinical_state_ref,
  cdmss_doctor_uid, physician_id, reaction, provenance, after_cdmss, surface, schema_version`;

function toRow(r: Record<string, unknown>): ReactionRow {
  const bool = (v: unknown) => v === true || v === 'true' || v === 't';
  return {
    id: String(r.id), created_at: new Date(String(r.created_at)).toISOString(),
    signal_id: String(r.signal_id), reference: String(r.reference),
    clinical_state_ref: r.clinical_state_ref == null ? null : String(r.clinical_state_ref),
    cdmss_doctor_uid: String(r.cdmss_doctor_uid), physician_id: String(r.physician_id),
    reaction: String(r.reaction), provenance: String(r.provenance),
    after_cdmss: bool(r.after_cdmss), surface: String(r.surface), schema_version: String(r.schema_version),
  };
}

/** The stored reaction for one (signal, physician) — the exact unique-index key. Null when none. */
export async function getReaction(signalId: string, physicianId: string): Promise<ReactionRow | null> {
  const rows = await run(
    `SELECT ${COLS} FROM cognition_reactions WHERE signal_id=$1::uuid AND physician_id=$2 LIMIT 1`,
    [signalId, physicianId]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Write one reaction. `ON CONFLICT DO NOTHING` on the identity index, so a second request for the
 * same (signal, physician) never raises and never overwrites: it returns NULL, and the caller
 * re-reads and classifies. provenance, after_cdmss and surface are fixed by construction — a
 * reaction recorded through this route is always a reported belief, always after the clinician saw
 * the card, always from the portal Findings surface.
 */
export async function insertReaction(row: ReactionInsert): Promise<ReactionRow | null> {
  const rows = await run(
    `INSERT INTO cognition_reactions
       (app_source, signal_id, reference, clinical_state_ref, cdmss_doctor_uid, physician_id,
        reaction, provenance, after_cdmss, surface, schema_version)
     VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,'CLINICIAN_REPORTED_BELIEF',TRUE,'portal_findings',$8)
     ON CONFLICT (signal_id, physician_id) DO NOTHING
     RETURNING ${COLS}`,
    [APP, row.signal_id, row.reference, row.clinical_state_ref, row.cdmss_doctor_uid,
      row.physician_id, row.reaction, REACTION_SCHEMA_VERSION]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** One physician's reactions to one doctor's signals, newest first. Both columns filter. */
export async function listReactionsFor(doctorUid: string, physicianId: string): Promise<ReactionRow[]> {
  const rows = await run(
    `SELECT ${COLS} FROM cognition_reactions
      WHERE cdmss_doctor_uid=$1 AND physician_id=$2 ORDER BY created_at DESC LIMIT 500`,
    [doctorUid, physicianId]);
  return (rows as Record<string, unknown>[]).map(toRow);
}

export interface ReactionCounts {
  byVerb: { reaction: string; n: number }[];
  physicians: number;
  last7d: number;
}

/**
 * The admin readout: how many of each verb, how many distinct physicians have pressed anything,
 * and how many rows landed in the last seven days. Throws on a read failure rather than returning
 * zeros — the caller renders "could not read", which is not the same claim as "none yet".
 */
export async function reactionCounts(): Promise<ReactionCounts> {
  const byVerbRows = await run(
    `SELECT reaction, count(*)::int AS n FROM cognition_reactions GROUP BY 1 ORDER BY n DESC`, []);
  const totalRows = await run(
    `SELECT count(DISTINCT physician_id)::int AS physicians,
            count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS last7d
       FROM cognition_reactions`, []);
  return {
    byVerb: (byVerbRows as Record<string, unknown>[]).map((r) => ({ reaction: String(r.reaction), n: Number(r.n) })),
    physicians: Number(totalRows[0]?.physicians ?? 0),
    last7d: Number(totalRows[0]?.last7d ?? 0),
  };
}
