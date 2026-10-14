/**
 * lib/opd-triage-store.ts — Care-Manager OPD Audit Triage: the decision store (Neon, WIRED).
 *
 * `opd_audit_triage` (governance spec v2.0 §3.1) holds append-only CM decisions — type-level batch
 * defaults (doctor_uid, signal_type) + optional instance overrides (audit_id, finding_ref). Latest
 * row wins; nothing is ever updated or deleted (full audit trail). The audit findings themselves
 * live in `opd_note_audits`; this is the state WE own layered over that read (same pattern as
 * care_track_assignments). Table created by /api/admin/migrate-opd-triage.
 */

import { randomUUID } from 'crypto';
import { sql } from './db';
import { validateDecision, type DecisionInput, type NormalizedDecision, type TriageDecisionRow } from './opd-triage-core';
import { mintOrUpdateSignal, withdrawSignal, type StoredSignal } from './opd-gov-signal-store';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function ensureOpdTriageTable(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS opd_audit_triage (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_source         text NOT NULL DEFAULT 'standalone',
    scope              text NOT NULL,
    doctor_uid         text NOT NULL,
    signal_type        text NOT NULL,
    audit_id           uuid,
    finding_ref        text,
    window_from        date,
    window_to          date,
    validity           text NOT NULL,
    bug_type           text,
    importance         text,
    routed             boolean NOT NULL DEFAULT false,
    response_required  text,
    reason             text,
    cm_user            text,
    created_at         timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS opd_audit_triage_type_idx     ON opd_audit_triage (doctor_uid, signal_type, created_at DESC)`, []);
  await run(`CREATE INDEX IF NOT EXISTS opd_audit_triage_instance_idx ON opd_audit_triage (audit_id, finding_ref) WHERE scope = 'instance'`, []);
  await run(`CREATE INDEX IF NOT EXISTS opd_audit_triage_routed_idx   ON opd_audit_triage (routed, response_required, created_at DESC)`, []);
}

function rowToDecision(r: Record<string, unknown>): TriageDecisionRow {
  return {
    scope: (String(r.scope) === 'instance' ? 'instance' : 'type'),
    doctor_uid: String(r.doctor_uid),
    signal_type: String(r.signal_type),
    audit_id: r.audit_id == null ? null : String(r.audit_id),
    finding_ref: r.finding_ref == null ? null : String(r.finding_ref),
    validity: String(r.validity),
    bug_type: r.bug_type == null ? null : String(r.bug_type),
    importance: r.importance == null ? null : String(r.importance),
    routed: r.routed === true || r.routed === 't' || r.routed === 'true',
    response_required: r.response_required == null ? null : String(r.response_required),
    reason: r.reason == null ? null : String(r.reason),
    cm_user: r.cm_user == null ? null : String(r.cm_user),
    created_at: r.created_at == null ? '' : new Date(String(r.created_at)).toISOString(),
  };
}

const SELECT_COLS = `scope, doctor_uid, signal_type, audit_id::text AS audit_id, finding_ref,
  validity, bug_type, importance, routed, response_required, reason, cm_user, created_at`;

/** All triage decisions for a set of doctors (newest first) — for the queue overlay. */
export async function loadTriageDecisions(doctorUids: string[]): Promise<TriageDecisionRow[]> {
  const uids = [...new Set(doctorUids.filter(Boolean))];
  if (uids.length === 0) return [];
  const rows = await run(
    `SELECT ${SELECT_COLS} FROM opd_audit_triage WHERE doctor_uid = ANY($1) ORDER BY created_at DESC LIMIT 5000`,
    [uids],
  );
  return (rows as Record<string, unknown>[]).map(rowToDecision);
}

/** Instance-level overrides for one (doctor, signal_type) — for the drill view. */
export async function loadInstanceOverrides(doctorUid: string, signalType: string): Promise<TriageDecisionRow[]> {
  const rows = await run(
    `SELECT ${SELECT_COLS} FROM opd_audit_triage
     WHERE scope = 'instance' AND doctor_uid = $1 AND signal_type = $2 ORDER BY created_at DESC LIMIT 2000`,
    [doctorUid, signalType],
  );
  return (rows as Record<string, unknown>[]).map(rowToDecision);
}

/** Type-scope decisions for the Tier-0 signal-health view (with doctor_uid + created_at). */
export async function loadTypeDecisions(sinceDays = 90): Promise<{ signal_type: string; doctor_uid: string; validity: string; bug_type: string | null; routed: boolean; reason: string | null; created_at: string }[]> {
  const rows = await run(
    `SELECT signal_type, doctor_uid, validity, bug_type, routed, reason, created_at
     FROM opd_audit_triage WHERE scope='type' AND created_at > now() - ($1 || ' days')::interval
     ORDER BY created_at DESC LIMIT 10000`, [String(Math.max(1, sinceDays))]);
  return (rows as Record<string, unknown>[]).map((r) => ({
    signal_type: String(r.signal_type), doctor_uid: String(r.doctor_uid), validity: String(r.validity),
    bug_type: r.bug_type == null ? null : String(r.bug_type),
    routed: r.routed === true || r.routed === 't' || r.routed === 'true',
    reason: r.reason == null ? null : String(r.reason),
    created_at: r.created_at == null ? '' : new Date(String(r.created_at)).toISOString(),
  }));
}

/** (doctor_uid) whose LATEST type decision for `signalType` is valid_signal — the protected set. */
export async function loadValidLabelDoctors(signalType: string): Promise<string[]> {
  const rows = await run(
    `SELECT doctor_uid, validity FROM (
       SELECT DISTINCT ON (doctor_uid) doctor_uid, validity
       FROM opd_audit_triage WHERE scope='type' AND signal_type=$1
       ORDER BY doctor_uid, created_at DESC
     ) latest WHERE validity='valid_signal'`, [signalType]).catch(() => []);
  return (rows as Record<string, unknown>[]).map((r) => String(r.doctor_uid));
}

/** The engineering bug feed: audit_bug decisions (spec §3.4). */
export async function loadBugFeed(limit = 200): Promise<TriageDecisionRow[]> {
  const rows = await run(
    `SELECT ${SELECT_COLS} FROM opd_audit_triage WHERE validity = 'audit_bug' ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(1000, limit))],
  );
  return (rows as Record<string, unknown>[]).map(rowToDecision);
}

/** Validate + append one decision row, and (for a routed type decision) mint/close its governance
 *  thread. Throws on invalid input (caller maps to 400). Mint failures are surfaced but never lose
 *  the recorded decision (the triage row is the source of truth; the thread is derived). */
export async function insertDecision(input: DecisionInput): Promise<{
  id: string; decision: NormalizedDecision;
  signal?: { reference: string; signal_id: string; status: string } | null; signal_error?: string;
}> {
  const v = validateDecision(input);
  if (!v.ok) throw new Error(v.error);
  const d = v.value;
  const id = randomUUID();
  await run(
    `INSERT INTO opd_audit_triage
      (id, app_source, scope, doctor_uid, signal_type, audit_id, finding_ref, window_from, window_to,
       validity, bug_type, importance, routed, response_required, reason, cm_user)
     VALUES ($1,'standalone',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id, d.scope, d.doctor_uid, d.signal_type, d.audit_id, d.finding_ref, d.window_from, d.window_to,
      d.validity, d.bug_type, d.importance, d.routed, d.response_required, d.reason, d.cm_user,
    ],
  );

  // Governance thread: minted only for a TYPE-level, valid_signal decision (threads are type-level).
  let signal: { reference: string; signal_id: string; status: string } | null = null;
  let signal_error: string | undefined;
  if (d.scope === 'type' && d.validity === 'valid_signal') {
    try {
      if (d.routed) {
        const s: StoredSignal = await mintOrUpdateSignal({
          doctor_uid: d.doctor_uid, signal_type: d.signal_type, importance: d.importance || 'med',
          response_required: d.response_required || 'none', window_from: d.window_from, window_to: d.window_to,
          source_triage_ref: id, cm_user: d.cm_user,
        });
        signal = { reference: s.reference, signal_id: s.signal_id, status: s.status };
      } else {
        // un-routed a previously-routed type → close its thread if one exists
        await withdrawSignal(d.doctor_uid, d.signal_type, d.window_from, d.window_to, d.cm_user);
      }
    } catch (e) { signal_error = String((e as Error).message); }
  }

  return { id, decision: d, signal, signal_error };
}
