// lib/care-call-store.ts — Care-Call Capture persistence (Neon), pattern-matched to ccb-store.
// Reads SOFT-FAIL to empty (table missing / feature off never sinks a caller). Inserts throw a
// controlled 'not_migrated' the route maps to 503. Every SQL below is INFERRED (no DB in the build
// sandbox) — the orchestrator validates each against live Neon; all are listed verbatim in the report.

import { sql } from './db';
import type { EncounterEvidence } from './member-state/schema';
import { careCallOutcomeToEncounter } from './member-state/care-call-evidence';
import { deriveAssertions, escalationFlag, CARE_CALL_ENGINE, ASK_SET_VERSION, type CareCallOutcome, type AskResponse } from './care-call-core';

// neon's tagged-template return is a wide union; every read below coerces to a plain row array.
type Row = Record<string, unknown>;
const q = async (p: Promise<unknown>): Promise<Row[]> => (await p) as unknown as Row[];

/** Idempotent DDL — mirrors ccb_briefs. The migrate route calls this. */
export async function migrateCareCall(): Promise<Record<string, string>> {
  const steps: Record<string, string> = {};
  await sql`CREATE TABLE IF NOT EXISTS care_call_outcomes (
    id             text PRIMARY KEY,
    presc_uid      text NOT NULL,
    individual_uid text NOT NULL,
    uhid           text,
    note_date      text,
    attempt        int  NOT NULL,
    called_at      timestamptz NOT NULL DEFAULT now(),
    disposition    text NOT NULL,
    engine_version text NOT NULL,
    ask_set_version text NOT NULL,
    payload        jsonb NOT NULL,
    escalation     boolean NOT NULL DEFAULT false,
    cm_ref         text
  )`;
  steps.table = 'ok';
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS ccl_presc_attempt ON care_call_outcomes (presc_uid, attempt)`;
  await sql`CREATE INDEX IF NOT EXISTS ccl_indiv ON care_call_outcomes (individual_uid)`;
  await sql`CREATE INDEX IF NOT EXISTS ccl_called ON care_call_outcomes (called_at)`;
  steps.indexes = 'ok';
  return steps;
}

const rowToOutcome = (r: Record<string, unknown>): CareCallOutcome => {
  const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as CareCallOutcome;
  return p;
};

/** Insert one outcome. Computes derived + escalation + attempt SERVER-SIDE (never trusts the client's).
 *  Idempotent on id; races handled by the unique (presc_uid, attempt) + retry. */
export async function saveOutcome(input: {
  id: string; presc_uid: string; individual_uid: string; uhid?: string | null; note_date?: string | null;
  called_at?: string; disposition: CareCallOutcome['disposition']; responses: AskResponse[]; cm_ref?: string | null;
  // Inquiry K1 (additive): which ask-set generation served the call ('ask-set/0.2' when the
  // inquiry path built it). Default stays ASK_SET_VERSION — existing callers are unchanged.
  ask_set_version?: string;
}): Promise<{ id: string; attempt: number }> {
  // idempotent: an existing id returns as-is.
  const existing = await q(sql`SELECT id, attempt FROM care_call_outcomes WHERE id = ${input.id} LIMIT 1`);
  if (existing.length) return { id: String(existing[0].id), attempt: Number(existing[0].attempt) };

  const derived = deriveAssertions(input.responses);
  const esc = escalationFlag(input.responses);
  const calledAt = input.called_at || new Date().toISOString();   // the STORE stamps call time (not the frozen core)
  const askSetVersion = input.ask_set_version || ASK_SET_VERSION;

  for (let tries = 0; tries < 3; tries++) {
    const cnt = await q(sql`SELECT count(*)::int AS n FROM care_call_outcomes WHERE presc_uid = ${input.presc_uid}`);
    const attempt = Number(cnt[0]?.n ?? 0) + 1 + tries;
    const payload: CareCallOutcome = {
      id: input.id, presc_uid: input.presc_uid, individual_uid: input.individual_uid, uhid: input.uhid ?? null, note_date: input.note_date ?? null,
      attempt, called_at: calledAt, disposition: input.disposition, engine_version: CARE_CALL_ENGINE, ask_set_version: askSetVersion,
      responses: input.responses, derived, flags: { escalation: esc }, cm_ref: input.cm_ref ?? null,
    };
    const ins = await q(sql`INSERT INTO care_call_outcomes (id, presc_uid, individual_uid, uhid, note_date, attempt, called_at, disposition, engine_version, ask_set_version, payload, escalation, cm_ref)
      VALUES (${input.id}, ${input.presc_uid}, ${input.individual_uid}, ${input.uhid ?? null}, ${input.note_date ?? null}, ${attempt}, ${calledAt}, ${input.disposition}, ${CARE_CALL_ENGINE}, ${askSetVersion}, ${JSON.stringify(payload)}, ${!!esc}, ${input.cm_ref ?? null})
      ON CONFLICT (presc_uid, attempt) DO NOTHING RETURNING id, attempt`);
    if (ins.length) return { id: String(ins[0].id), attempt: Number(ins[0].attempt) };
    // lost the (presc_uid, attempt) race — but the id may now exist (a duplicate submit)
    const again = await q(sql`SELECT id, attempt FROM care_call_outcomes WHERE id = ${input.id} LIMIT 1`);
    if (again.length) return { id: String(again[0].id), attempt: Number(again[0].attempt) };
  }
  throw new Error('attempt race unresolved');
}

/** Next attempt number for an episode (count of prior saves + 1). Soft-fails to 1. */
export async function nextAttempt(prescUid: string): Promise<number> {
  try { const r = await q(sql`SELECT count(*)::int AS n FROM care_call_outcomes WHERE presc_uid = ${prescUid}`); return Number(r[0]?.n ?? 0) + 1; } catch { return 1; }
}

/** Prior attempts for the panel header (compact). Soft-fails to []. */
export async function priorAttempts(prescUid: string): Promise<{ attempt: number; called_at: string; disposition: string; escalation: boolean }[]> {
  try {
    const rows = await q(sql`SELECT attempt, called_at, disposition, escalation FROM care_call_outcomes WHERE presc_uid = ${prescUid} ORDER BY attempt ASC`);
    return rows.map((r) => ({ attempt: Number(r.attempt), called_at: String(r.called_at), disposition: String(r.disposition), escalation: !!r.escalation }));
  } catch { return []; }
}

/** Saved outcomes for the dossier/panel (payload included, newest first). Soft-fails to []. */
export async function outcomesForMember(individualUid: string, limit = 20): Promise<CareCallOutcome[]> {
  try {
    const rows = await q(sql`SELECT payload FROM care_call_outcomes WHERE individual_uid = ${individualUid} ORDER BY called_at DESC LIMIT ${limit}`);
    return rows.map(rowToOutcome);
  } catch { return []; }
}
export async function outcomesForPresc(prescUid: string, limit = 20): Promise<CareCallOutcome[]> {
  try {
    const rows = await q(sql`SELECT payload FROM care_call_outcomes WHERE presc_uid = ${prescUid} ORDER BY called_at DESC LIMIT ${limit}`);
    return rows.map(rowToOutcome);
  } catch { return []; }
}

/** Escalations flagged today (IST calendar day). Soft-fails to []. */
export async function escalationsToday(): Promise<{ individual_uid: string; presc_uid: string; note_date: string | null; called_at: string; reason: string }[]> {
  try {
    const rows = await q(sql`SELECT individual_uid, presc_uid, note_date, called_at, payload
      FROM care_call_outcomes
      WHERE escalation = true
        AND (called_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY called_at DESC`);
    return rows.map((r) => {
      const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as CareCallOutcome;
      return { individual_uid: String(r.individual_uid), presc_uid: String(r.presc_uid), note_date: r.note_date ? String(r.note_date) : null, called_at: String(r.called_at), reason: p?.flags?.escalation?.reason ?? 'unknown' };
    });
  } catch { return []; }
}

/** Admin recompute — re-derive `derived` + escalation from the immutable raw `responses`.
 *  NEVER modifies `responses`. Returns the count updated.
 *  K1.1 (Inquiry PRD addendum B1 item 4): each row's ask_set_version is PRESERVED — which
 *  generation SERVED the call is a historical fact, not a mapper property (prefer the row's
 *  column, then the payload's, ASK_SET_VERSION only when both are absent).
 *  `deps.db` is an injection seam for unit tests (repo idiom — mirrors inquiry-store). */
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
export async function recomputeOutcomes(limit = 500, deps: { db?: SqlTag } = {}): Promise<number> {
  const db = deps.db ?? (sql as unknown as SqlTag);
  const rows = await q(db`SELECT id, ask_set_version, payload FROM care_call_outcomes ORDER BY called_at DESC LIMIT ${limit}`);
  let n = 0;
  for (const r of rows) {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as CareCallOutcome;
    const responses = Array.isArray(p?.responses) ? p.responses : [];
    const derived = deriveAssertions(responses);
    const esc = escalationFlag(responses);
    const version = (r.ask_set_version ? String(r.ask_set_version) : '') || p?.ask_set_version || ASK_SET_VERSION;
    const next: CareCallOutcome = { ...p, derived, flags: { escalation: esc }, ask_set_version: version };
    await db`UPDATE care_call_outcomes SET payload = ${JSON.stringify(next)}, escalation = ${!!esc}, ask_set_version = ${version} WHERE id = ${String(r.id)}`;
    n++;
  }
  return n;
}

/** AMENDMENT B — a member's saved outcomes mapped to `care_call` EncounterEvidence, newest-first.
 *  Soft-fails to [] (table missing / feature off) so it never sinks a snapshot build. */
export async function careCallEncountersForMember(individualUid: string): Promise<EncounterEvidence[]> {
  try {
    const outs = await outcomesForMember(individualUid, 200);
    return outs.map(careCallOutcomeToEncounter);
  } catch {
    return [];
  }
}
