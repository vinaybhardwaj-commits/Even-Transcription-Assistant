/**
 * lib/triage/document-audits-export-read.ts — read-only loads for the document-audit door.
 *
 * SELECT only. No CREATE, no mint, no doctor_uid written onto ipd_discharge_audits.
 * OT route mint stays off until TRIAGE_BOT_WRITE_CLASSES includes ot. This module
 * does not set that flag and does not mint opd_gov_signal.
 * Discharge identity is the read-time treating-doctor hop (fail closed).
 * Progress is queried only after information_schema shows a candidate store.
 */

import { sql } from '@/lib/db';
import { canonicalDistinctOnSql } from '@/lib/audit-canonical';
import { fetchIpdDoctorHop, type IpdDoctorHop } from '@/lib/ipd-doctor-hop';
import { OT_ENGINE_VERSION } from '@/lib/triage/ot-audit-core';
import type { DischargeAuditSource, DischargeHopView } from '@/lib/triage/ds-lander';
import {
  PROGRESS_TABLE_CANDIDATES,
  interpretProgressColumns,
  toStampedFindings,
  type OtExportSource,
  type ProgressAuditSource,
  type ProgressColumnRow,
  type ProgressProbe,
  type RoutedSignalRef,
  type DocumentAuditClass,
} from '@/lib/triage/document-audits-export';
import type { FindingsPdfInput } from '@/lib/triage/document-audits-pdf';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

export interface LoadedExportSources {
  otRows: OtExportSource[];
  dischargeRows: DischargeAuditSource[];
  dischargeHop: DischargeHopView;
  progress: ProgressProbe;
  signals: RoutedSignalRef[];
}

const EMPTY_HOP: DischargeHopView = {
  byIpUid: {},
  coverage: { unavailable: true },
};

export async function loadDocumentAuditSources(query: {
  from: string;
  to: string;
  doctorUid: string | null;
  noteClass: DocumentAuditClass | null;
}): Promise<LoadedExportSources> {
  const want = query.noteClass;
  const [otRows, discharge, signals] = await Promise.all([
    !want || want === 'ot' ? loadOtRows(query.from, query.to, query.doctorUid) : Promise.resolve([]),
    !want || want === 'discharge_summary' ? loadDischarge(query.from, query.to) : Promise.resolve({ rows: [], hop: EMPTY_HOP }),
    loadRoutedSignals(),
  ]);
  const progress = !want || want === 'progress'
    ? await loadProgress(query.from, query.to, query.doctorUid)
    : { status: 'absent' as const };
  return {
    otRows,
    dischargeRows: discharge.rows,
    dischargeHop: discharge.hop,
    progress,
    signals,
  };
}

async function loadOtRows(from: string, to: string, doctorUid: string | null): Promise<OtExportSource[]> {
  const params: unknown[] = [APP, OT_ENGINE_VERSION, from, to];
  let where = `app_source = $1 AND engine_version = $2 AND note_day BETWEEN $3::date AND $4::date`;
  if (doctorUid) {
    params.push(doctorUid);
    where += ` AND doctor_uid = $${params.length}`;
  }
  const rows = await run(
    `SELECT id, hospital_uid, note_day, doctor_uid, map_status, findings
     FROM (${canonicalDistinctOnSql({
       table: 'ot_note_audits',
       identity: 'uid',
       cols: `id::text AS id, hospital_uid, to_char(note_day,'YYYY-MM-DD') AS note_day, doctor_uid, map_status, findings`,
       where,
     })}) canonical
     LIMIT 8000`,
    params,
  );
  return rows.map((r) => ({
    id: String(r.id),
    hospital_uid: r.hospital_uid == null ? null : String(r.hospital_uid),
    note_day: String(r.note_day || ''),
    doctor_uid: r.doctor_uid == null ? null : String(r.doctor_uid),
    map_status: r.map_status == null ? 'unmapped' : String(r.map_status),
    findings: parseJson(r.findings),
  }));
}

async function loadDischarge(from: string, to: string): Promise<{ rows: DischargeAuditSource[]; hop: DischargeHopView }> {
  const where = `app_source = $1 AND engine_version LIKE 'ipd-discharge-audit/%' AND engine_version NOT LIKE '%-mini'
    AND discharged_at IS NOT NULL AND (discharged_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date`;
  const rows = await run(
    `SELECT id, ip_uid, note_date, findings
     FROM (${canonicalDistinctOnSql({
       table: 'ipd_discharge_audits',
       identity: 'document_id',
       cols: `id::text AS id, ip_uid, to_char((discharged_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS note_date, findings`,
       where,
     })}) canonical
     LIMIT 8000`,
    [APP, from, to],
  );
  const sources: DischargeAuditSource[] = rows.map((r) => ({
    id: String(r.id),
    ip_uid: r.ip_uid == null ? null : String(r.ip_uid),
    note_date: String(r.note_date || ''),
    findings: parseJson(r.findings),
  }));
  if (!sources.length) return { rows: [], hop: { byIpUid: {}, coverage: { unavailable: false } } };
  let hop: IpdDoctorHop;
  try {
    hop = await fetchIpdDoctorHop(sources.map((s) => s.ip_uid || ''));
  } catch {
    hop = { byIpUid: {}, coverage: { asked: sources.length, known: 0, resolved: 0, ambiguousPractitioner: 0, ambiguousStay: 0, unmatched: 0, noTreatingId: 0, unavailable: true }, ambiguousIds: [] };
  }
  return { rows: sources, hop: { byIpUid: hop.byIpUid, coverage: { unavailable: hop.coverage.unavailable } } };
}

async function loadRoutedSignals(): Promise<RoutedSignalRef[]> {
  const rows = await run(
    `SELECT reference, doctor_uid, signal_type, note_class,
            to_char(window_from,'YYYY-MM-DD') AS window_from,
            to_char(window_to,'YYYY-MM-DD') AS window_to,
            created_at
     FROM opd_gov_signal
     WHERE note_class IN ('ot', 'discharge_summary')`,
    [],
  );
  return rows.map((r) => ({
    reference: String(r.reference || ''),
    doctor_uid: String(r.doctor_uid || ''),
    signal_type: String(r.signal_type || ''),
    note_class: String(r.note_class || ''),
    window_from: r.window_from == null ? null : String(r.window_from),
    window_to: r.window_to == null ? null : String(r.window_to),
    created_at: r.created_at == null ? '' : String(r.created_at),
  }));
}

async function loadProgress(from: string, to: string, doctorUid: string | null): Promise<ProgressProbe> {
  const cols = await run(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [PROGRESS_TABLE_CANDIDATES],
  );
  const shape = interpretProgressColumns(cols.map((r) => ({
    table_name: String(r.table_name || ''),
    column_name: String(r.column_name || ''),
  })) as ProgressColumnRow[]);
  if (shape.status === 'absent') return { status: 'absent' };
  if (shape.status === 'unreadable') return shape;
  const params: unknown[] = [from, to];
  let doctorSql = '';
  if (doctorUid) {
    params.push(doctorUid);
    doctorSql = ` AND doctor_uid = $${params.length}`;
  }
  const hospitalSql = shape.hospital ? 'hospital_uid' : 'NULL::text AS hospital_uid';
  const mapSql = shape.mapStatus ? ', map_status' : '';
  const table = shape.table;
  const date = shape.date;
  const rows = await run(
    `SELECT id::text AS id, doctor_uid, ${hospitalSql},
            to_char(${date}::date,'YYYY-MM-DD') AS note_date, findings${mapSql}
     FROM ${table}
     WHERE doctor_uid IS NOT NULL AND ${date}::date BETWEEN $1::date AND $2::date${doctorSql}
     LIMIT 2000`,
    params,
  );
  const mapped: ProgressAuditSource[] = rows.map((r) => ({
    id: String(r.id),
    doctor_uid: r.doctor_uid == null ? null : String(r.doctor_uid),
    map_status: shape.mapStatus ? (r.map_status == null ? 'unmapped' : String(r.map_status)) : null,
    note_date: String(r.note_date || ''),
    hospital_uid: r.hospital_uid == null ? null : String(r.hospital_uid),
    findings: parseJson(r.findings),
  }));
  return { status: 'rows', table, rows: mapped };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadFindingsPdf(id: string): Promise<FindingsPdfInput | 'bad-id' | null> {
  const key = decodeURIComponent(id || '').trim();
  if (!key) return 'bad-id';
  if (UUID_RE.test(key)) return loadPdfByAuditId(key);
  const { isAuditRef } = await import('@/lib/opd-gov-signal-core');
  if (!isAuditRef(key)) return 'bad-id';
  return loadPdfBySignalRef(key);
}

async function loadPdfByAuditId(id: string): Promise<FindingsPdfInput | null> {
  const ot = await run(
    `SELECT id::text AS id, to_char(note_day,'YYYY-MM-DD') AS note_date, doctor_uid, findings
     FROM ot_note_audits WHERE id = $1::uuid LIMIT 1`,
    [id],
  ).catch(() => []);
  if (ot[0]) {
    return pdfInput('ot', ot[0], ot[0].doctor_uid == null ? null : String(ot[0].doctor_uid));
  }
  const ds = await run(
    `SELECT id::text AS id, ip_uid,
            to_char((discharged_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS note_date,
            findings
     FROM ipd_discharge_audits WHERE id = $1::uuid LIMIT 1`,
    [id],
  ).catch(() => []);
  if (ds[0]) {
    const doctor = await dischargeDoctor(ds[0].ip_uid == null ? '' : String(ds[0].ip_uid));
    return pdfInput('discharge_summary', ds[0], doctor);
  }
  const progress = await loadProgressPdf(id);
  return progress;
}

async function dischargeDoctor(ipUid: string): Promise<string | null> {
  if (!ipUid) return null;
  try {
    const hop = await fetchIpdDoctorHop([ipUid]);
    const row = hop.byIpUid[ipUid];
    if (!row || row.reason !== 'resolved' || !row.doctorUid) return null;
    return row.doctorUid;
  } catch {
    return null;
  }
}

async function loadProgressPdf(id: string): Promise<FindingsPdfInput | null> {
  const cols = await run(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [PROGRESS_TABLE_CANDIDATES],
  ).catch(() => []);
  const shape = interpretProgressColumns(cols.map((r) => ({
    table_name: String(r.table_name || ''),
    column_name: String(r.column_name || ''),
  })));
  if (shape.status !== 'readable') return null;
  const date = shape.date;
  const rows = await run(
    `SELECT id::text AS id, doctor_uid, to_char(${date}::date,'YYYY-MM-DD') AS note_date, findings
     FROM ${shape.table} WHERE id = $1::uuid LIMIT 1`,
    [id],
  ).catch(() => []);
  if (!rows[0]) return null;
  const uid = rows[0].doctor_uid == null ? '' : String(rows[0].doctor_uid).trim();
  return pdfInput('progress', rows[0], uid || null);
}

async function loadPdfBySignalRef(reference: string): Promise<FindingsPdfInput | null> {
  const signals = await run(
    `SELECT reference, doctor_uid, signal_type, note_class,
            to_char(window_from,'YYYY-MM-DD') AS window_from,
            to_char(window_to,'YYYY-MM-DD') AS window_to
     FROM opd_gov_signal WHERE reference = $1 LIMIT 1`,
    [reference],
  ).catch(() => []);
  const signal = signals[0];
  if (!signal) return null;
  const noteClass = String(signal.note_class || '');
  const doctorUid = String(signal.doctor_uid || '');
  const signalType = String(signal.signal_type || '');
  const from = signal.window_from == null ? '' : String(signal.window_from);
  const to = signal.window_to == null ? '' : String(signal.window_to);
  if (!doctorUid || !signalType || !from || !to) return null;
  if (noteClass === 'ot') {
    const rows = await run(
      `SELECT id::text AS id, to_char(note_day,'YYYY-MM-DD') AS note_date, doctor_uid, findings
       FROM ot_note_audits
       WHERE map_status = 'mapped' AND doctor_uid = $1
         AND note_day BETWEEN $2::date AND $3::date
       ORDER BY note_day DESC
       LIMIT 50`,
      [doctorUid, from, to],
    ).catch(() => []);
    return firstWithSignal(rows, 'ot', doctorUid, signalType);
  }
  if (noteClass === 'discharge_summary') {
    const rows = await run(
      `SELECT id::text AS id, ip_uid,
              to_char((discharged_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS note_date,
              findings
       FROM ipd_discharge_audits
       WHERE discharged_at IS NOT NULL
         AND (discharged_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
       ORDER BY discharged_at DESC
       LIMIT 200`,
      [from, to],
    ).catch(() => []);
    const hop = await fetchIpdDoctorHop(rows.map((r) => String(r.ip_uid || ''))).catch(() => null);
    const matched = rows.filter((r) => {
      const ip = String(r.ip_uid || '');
      const resolved = hop?.byIpUid[ip];
      return resolved?.reason === 'resolved' && resolved.doctorUid === doctorUid;
    });
    return firstWithSignal(matched, 'discharge_summary', doctorUid, signalType);
  }
  return null;
}

function firstWithSignal(
  rows: Record<string, unknown>[],
  noteClass: DocumentAuditClass,
  doctorUid: string,
  signalType: string,
): FindingsPdfInput | null {
  for (const row of rows) {
    const stamped = toStampedFindings(parseJson(row.findings));
    if (!stamped.some((f) => f.signal_type === signalType)) continue;
    return pdfInput(noteClass, row, doctorUid);
  }
  return null;
}

function pdfInput(noteClass: DocumentAuditClass, row: Record<string, unknown>, doctorUid: string | null): FindingsPdfInput {
  const findings = toStampedFindings(parseJson(row.findings)).map((f) => ({
    finding_ref: String(f.finding_ref),
    signal_type: String(f.signal_type),
    subject: f.subject,
    verdict: String(f.verdict),
    rationale: f.rationale,
  }));
  return {
    audit_id: String(row.id),
    note_class: noteClass,
    doctor_uid: doctorUid,
    note_date: String(row.note_date || ''),
    findings,
  };
}
