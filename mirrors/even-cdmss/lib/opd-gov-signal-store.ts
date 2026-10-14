/**
 * lib/opd-gov-signal-store.ts — governance audit-signal threads (Neon, WIRED).
 *
 * `opd_gov_signal` = the trackable thread (one per doctor × signal_type × window); minted when a CM
 * routes a triage decision. `opd_gov_signal_event` = its append-only lifecycle log. CDMSS is the
 * system of record for the signal + the doctor's response; EPI owns rulings and POSTs them back.
 * Table created by /api/admin/migrate-opd-gov-signal. Pure lifecycle logic is opd-gov-signal-core.
 */

import { randomUUID } from 'crypto';
import { sql } from './db';
import {
  formatAuditRef, computeSlaDueAt, mintStatus, statusAfterResponse, statusAfterAction,
  type SignalStatus, type NormalizedDoctorResponse, type NormalizedSignalAction, type SignalRow,
} from './opd-gov-signal-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const SLA_DAYS = Math.max(1, Math.min(60, Number(process.env.OPD_AUDIT_SLA_DAYS) || 7));

export async function ensureGovSignalTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS opd_gov_signal (
    signal_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_source        text NOT NULL DEFAULT 'standalone',
    reference         text UNIQUE NOT NULL,
    doctor_uid        text NOT NULL,
    signal_type       text NOT NULL,
    importance        text NOT NULL,
    response_required text NOT NULL,
    status            text NOT NULL DEFAULT 'routed',
    source_triage_ref uuid,
    window_from       date,
    window_to         date,
    sla_due_at        timestamptz,
    latest_response   jsonb,
    ruling            jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS opd_gov_signal_doctor_idx ON opd_gov_signal (doctor_uid, status, created_at DESC)`, []);
  // one live thread per (doctor, signal_type, window) — idempotent re-route
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS opd_gov_signal_key_idx
    ON opd_gov_signal (doctor_uid, signal_type, coalesce(window_from,'0001-01-01'), coalesce(window_to,'0001-01-01'))`, []);
  await run(`CREATE TABLE IF NOT EXISTS opd_gov_signal_event (
    id         bigserial PRIMARY KEY,
    signal_id  uuid NOT NULL,
    event      text NOT NULL,
    actor      text,
    payload    jsonb,
    at         timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS opd_gov_signal_event_idx ON opd_gov_signal_event (signal_id, at)`, []);
}

const SIGNAL_COLS = `signal_id::text AS signal_id, reference, doctor_uid, signal_type, importance,
  response_required, status, source_triage_ref::text AS source_triage_ref,
  to_char(window_from,'YYYY-MM-DD') AS window_from, to_char(window_to,'YYYY-MM-DD') AS window_to,
  sla_due_at, latest_response, ruling, created_at, updated_at`;

export interface StoredSignal {
  signal_id: string; reference: string; doctor_uid: string; signal_type: string;
  importance: string; response_required: string; status: string; source_triage_ref: string | null;
  window_from: string | null; window_to: string | null; sla_due_at: string | null;
  latest_response: unknown; ruling: unknown; created_at: string; updated_at: string;
}
function rowToSignal(r: Record<string, unknown>): StoredSignal {
  const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
  const parse = (v: unknown) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
  return {
    signal_id: String(r.signal_id), reference: String(r.reference), doctor_uid: String(r.doctor_uid),
    signal_type: String(r.signal_type), importance: String(r.importance),
    response_required: String(r.response_required), status: String(r.status),
    source_triage_ref: r.source_triage_ref == null ? null : String(r.source_triage_ref),
    window_from: r.window_from == null ? null : String(r.window_from),
    window_to: r.window_to == null ? null : String(r.window_to),
    sla_due_at: iso(r.sla_due_at), latest_response: parse(r.latest_response), ruling: parse(r.ruling),
    created_at: iso(r.created_at) || '', updated_at: iso(r.updated_at) || '',
  };
}

/** Signal-row shape the pure signalObject() consumes. */
export function toSignalRow(s: StoredSignal, instances?: number | null): SignalRow {
  return {
    reference: s.reference, signal_id: s.signal_id, doctor_uid: s.doctor_uid, signal_type: s.signal_type,
    importance: s.importance, response_required: s.response_required, status: s.status,
    instances: instances ?? null, window_from: s.window_from, window_to: s.window_to,
    routed_at: s.created_at, sla_due_at: s.sla_due_at, latest_response: s.latest_response, ruling: s.ruling,
  };
}

async function appendEvent(signalId: string, event: string, actor: string | null, payload: unknown): Promise<void> {
  await run(`INSERT INTO opd_gov_signal_event (signal_id, event, actor, payload) VALUES ($1,$2,$3,$4::jsonb)`,
    [signalId, event, actor, JSON.stringify(payload ?? {})]);
}

async function nextReference(): Promise<string> {
  const year = new Date().getUTCFullYear();
  const rows = await run(
    `SELECT count(*)::int AS n FROM opd_gov_signal WHERE reference LIKE $1`, [`EHRC-AUD-${year}-%`]);
  const n = Number((rows[0]?.n ?? 0)) + 1;
  return formatAuditRef(year, n);
}

export interface MintInput {
  doctor_uid: string; signal_type: string; importance: string; response_required: string;
  window_from: string | null; window_to: string | null; source_triage_ref?: string | null; cm_user?: string | null;
}

/**
 * Upsert the thread for a routed decision (idempotent per doctor×signal_type×window):
 *  - new → mint EHRC-AUD ref, status routed|escalated, sla, + a routed/escalated event;
 *  - existing open → update importance/response_required + append a re-routed event;
 *  - existing closed/ruled → reopen to routed (a CM re-routing a settled thread) + event.
 * Returns the stored signal.
 */
export async function mintOrUpdateSignal(input: MintInput): Promise<StoredSignal> {
  const actor = input.cm_user ? `cm:${input.cm_user}` : 'cm:unknown';
  const existing = await getByKey(input.doctor_uid, input.signal_type, input.window_from, input.window_to);
  const status: SignalStatus = mintStatus(input.response_required);

  if (existing) {
    const slaDue = computeSlaDueAt(existing.created_at, input.response_required, SLA_DAYS);
    await run(
      `UPDATE opd_gov_signal SET importance=$2, response_required=$3, status=$4, sla_due_at=$5,
         source_triage_ref=coalesce($6, source_triage_ref), updated_at=now() WHERE signal_id=$1`,
      [existing.signal_id, input.importance, input.response_required, status, slaDue, input.source_triage_ref ?? null]);
    await appendEvent(existing.signal_id, status === 'escalated' ? 'escalated' : 'routed', actor,
      { importance: input.importance, response_required: input.response_required, re_routed: true });
    return (await getBySignalId(existing.signal_id))!;
  }

  // new thread — retry once on the (rare) reference race
  for (let attempt = 0; attempt < 2; attempt++) {
    const reference = await nextReference();
    const signalId = randomUUID();
    const createdAt = new Date().toISOString();
    const slaDue = computeSlaDueAt(createdAt, input.response_required, SLA_DAYS);
    try {
      await run(
        `INSERT INTO opd_gov_signal
          (signal_id, app_source, reference, doctor_uid, signal_type, importance, response_required,
           status, source_triage_ref, window_from, window_to, sla_due_at)
         VALUES ($1,'standalone',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [signalId, reference, input.doctor_uid, input.signal_type, input.importance, input.response_required,
          status, input.source_triage_ref ?? null, input.window_from, input.window_to, slaDue]);
      await appendEvent(signalId, status === 'escalated' ? 'escalated' : 'routed', actor,
        { importance: input.importance, response_required: input.response_required, reference });
      return (await getBySignalId(signalId))!;
    } catch (e) {
      // unique-violation on reference OR on the (doctor,signal_type,window) key → re-resolve and retry
      const existingNow = await getByKey(input.doctor_uid, input.signal_type, input.window_from, input.window_to);
      if (existingNow) return existingNow;
      if (attempt === 1) throw e;
    }
  }
  throw new Error('mint failed');
}

/** Close a thread the CM has un-routed (routed=false after having been routed). */
export async function withdrawSignal(doctorUid: string, signalType: string, windowFrom: string | null, windowTo: string | null, cmUser: string | null): Promise<void> {
  const existing = await getByKey(doctorUid, signalType, windowFrom, windowTo);
  if (!existing || existing.status === 'closed') return;
  await run(`UPDATE opd_gov_signal SET status='closed', updated_at=now() WHERE signal_id=$1`, [existing.signal_id]);
  await appendEvent(existing.signal_id, 'closed', cmUser ? `cm:${cmUser}` : 'cm:unknown', { reason: 'un-routed by care manager' });
}

async function getByKey(doctorUid: string, signalType: string, windowFrom: string | null, windowTo: string | null): Promise<StoredSignal | null> {
  const rows = await run(
    `SELECT ${SIGNAL_COLS} FROM opd_gov_signal
     WHERE doctor_uid=$1 AND signal_type=$2
       AND coalesce(window_from,'0001-01-01')=coalesce($3::date,'0001-01-01')
       AND coalesce(window_to,'0001-01-01')=coalesce($4::date,'0001-01-01') LIMIT 1`,
    [doctorUid, signalType, windowFrom, windowTo]);
  return rows[0] ? rowToSignal(rows[0]) : null;
}
export async function getBySignalId(signalId: string): Promise<StoredSignal | null> {
  const rows = await run(`SELECT ${SIGNAL_COLS} FROM opd_gov_signal WHERE signal_id=$1 LIMIT 1`, [signalId]);
  return rows[0] ? rowToSignal(rows[0]) : null;
}
export async function getByReference(reference: string): Promise<StoredSignal | null> {
  const rows = await run(`SELECT ${SIGNAL_COLS} FROM opd_gov_signal WHERE reference=$1 LIMIT 1`, [reference]);
  return rows[0] ? rowToSignal(rows[0]) : null;
}

/** Threads for one doctor. status: 'open' (routed/responded/escalated) | 'all'. */
export async function listSignalsForDoctor(doctorUid: string, status: 'open' | 'all' = 'open'): Promise<StoredSignal[]> {
  const openClause = status === 'open' ? ` AND status IN ('routed','responded','escalated')` : '';
  const rows = await run(
    `SELECT ${SIGNAL_COLS} FROM opd_gov_signal WHERE doctor_uid=$1${openClause} ORDER BY created_at DESC LIMIT 500`,
    [doctorUid]);
  return (rows as Record<string, unknown>[]).map(rowToSignal);
}

export interface RosterFilter { status?: string; importance?: string; response_required?: string; doctorUid?: string }
/** Threads across doctors (governance-wide) or one doctor's, filterable. */
export async function listSignalsRoster(f: RosterFilter): Promise<StoredSignal[]> {
  const clauses: string[] = []; const params: unknown[] = [];
  if (f.doctorUid) { params.push(f.doctorUid); clauses.push(`doctor_uid=$${params.length}`); }
  if (f.status) { params.push(f.status); clauses.push(`status=$${params.length}`); }
  if (f.importance) { params.push(f.importance); clauses.push(`importance=$${params.length}`); }
  if (f.response_required) { params.push(f.response_required); clauses.push(`response_required=$${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await run(`SELECT ${SIGNAL_COLS} FROM opd_gov_signal ${where} ORDER BY created_at DESC LIMIT 1000`, params);
  return (rows as Record<string, unknown>[]).map(rowToSignal);
}

export interface EventRow { event: string; actor: string | null; at: string; payload: unknown }
export async function listEvents(signalId: string): Promise<EventRow[]> {
  const rows = await run(`SELECT event, actor, at, payload FROM opd_gov_signal_event WHERE signal_id=$1 ORDER BY at ASC, id ASC LIMIT 500`, [signalId]);
  return (rows as Record<string, unknown>[]).map((r) => ({
    event: String(r.event), actor: r.actor == null ? null : String(r.actor),
    at: new Date(String(r.at)).toISOString(), payload: r.payload == null ? null : (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload),
  }));
}

/** Record a doctor response (portal). Sets latest_response + status + an event. */
export async function applyDoctorResponse(signal: StoredSignal, resp: NormalizedDoctorResponse): Promise<StoredSignal> {
  const newStatus = statusAfterResponse(resp.type, resp.verdict);
  const payload = { type: resp.type, verdict: resp.verdict, comment: resp.comment, responded_at: new Date().toISOString() };
  await run(`UPDATE opd_gov_signal SET latest_response=$2::jsonb, status=$3, updated_at=now() WHERE signal_id=$1`,
    [signal.signal_id, JSON.stringify(payload), newStatus]);
  await appendEvent(signal.signal_id, 'responded', `doctor:${signal.doctor_uid}`, payload);
  if (newStatus === 'escalated') await appendEvent(signal.signal_id, 'escalated', `doctor:${signal.doctor_uid}`, { reason: 'doctor disagreed' });
  return (await getBySignalId(signal.signal_id))!;
}

/** Record a governance ruling (roster). Sets ruling + status + an event. */
export async function applySignalAction(signal: StoredSignal, action: NormalizedSignalAction): Promise<StoredSignal> {
  const newStatus = statusAfterAction(action.action);
  const payload = { action: action.action, note: action.note, actor: action.actor, gov_intervention_ref: action.gov_intervention_ref, ruled_at: new Date().toISOString() };
  await run(`UPDATE opd_gov_signal SET ruling=$2::jsonb, status=$3, updated_at=now() WHERE signal_id=$1`,
    [signal.signal_id, JSON.stringify(payload), newStatus]);
  await appendEvent(signal.signal_id, newStatus === 'closed' ? 'closed' : 'ruled', action.actor || 'gov:unknown', payload);
  return (await getBySignalId(signal.signal_id))!;
}
