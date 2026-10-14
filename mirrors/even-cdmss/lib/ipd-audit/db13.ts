/**
 * lib/ipd-audit/db13.ts — read-only db13 access for the IPD Discharge Audit surface.
 * Server-only; goes through lib/metabase's metabaseQuery (no new credential).
 *
 * PHI POSTURE (the OPD-Audit posture): patient name / UHID / consultant live in db13 and are
 * joined HERE, AT READ TIME, for the access-controlled surface header — they are never stored
 * in ipd_discharge_audits and never sent to an LLM. Everything an LLM or the Neon row sees is
 * the de-identified envelope (ids, speciality, LOS, dates).
 */

import { metabaseQuery } from '../metabase';

const DOCS = '"accounts-members-miscellaneous_documents"';
const CLS = `document__classification__types::text ILIKE '%DISCHARGE_SUMMARY%'`;
const esc = (s: string) => s.replace(/'/g, "''");
const isDocId = (s: string) => /^[A-Za-z0-9_-]{6,64}$/.test(s);
const isIpUid = (s: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(s);

/** One discharge-summary document by db13 doc id — the envelope + the GCS PDF url. */
export interface IpdDoc {
  documentId: string;
  memberId: string | null;
  ipUid: string | null;
  pdfUrl: string | null;
  uploadedAt: string | null;
}

export async function fetchIpdDoc(documentId: string): Promise<IpdDoc | null> {
  if (!isDocId(documentId)) throw new Error('bad document id');
  const rows = await metabaseQuery(
    `SELECT _doc_id, _parent_doc_id, additional_metadata__booking_id AS ip_uid,
            document__upload_uri AS pdf_url, upload_timestamp
     FROM ${DOCS} WHERE _doc_id = '${esc(documentId)}' AND ${CLS} LIMIT 1`);
  const r = rows[0];
  if (!r) return null;
  return {
    documentId: String(r._doc_id),
    memberId: r._parent_doc_id == null ? null : String(r._parent_doc_id),
    ipUid: r.ip_uid == null ? null : String(r.ip_uid),
    pdfUrl: r.pdf_url == null ? null : String(r.pdf_url),
    uploadedAt: r.upload_timestamp == null ? null : String(r.upload_timestamp),
  };
}

/** The admission HEADER for the report page — PHI (name/UHID) read at display time only. */
export interface IpdAdmissionHeader {
  ipUid: string;
  patientName: string | null;   // PHI — render-only, never persisted
  uhid: string | null;          // PHI — render-only, never persisted
  ageGender: string | null;
  speciality: string | null;
  team: string | null;          // treating consultant/team label
  ward: string | null;
  dischargeType: string | null;
  admitDate: string | null;
  dischargeDate: string | null;
  losDays: number | null;
  status: string | null;
}

export async function fetchIpdAdmissionHeader(ipUid: string): Promise<IpdAdmissionHeader | null> {
  if (!isIpUid(ipUid)) return null;
  const rows = await metabaseQuery(
    `SELECT ipd_no, patient_name, uhid, age_gender, treating_doctor_speciality, treating_doctor_team,
            ward, discharge_type, status,
            to_char(admission_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS admit_date,
            to_char(discharge_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS discharge_date,
            greatest(0, (discharge_date_time::date - admission_date_time::date))::int AS los_days
     FROM kx_discharge_summary_records WHERE ipd_no = '${esc(ipUid)}'
     ORDER BY (status='Final') DESC, discharge_date_time DESC NULLS LAST, modified_time DESC NULLS LAST
     LIMIT 1`);
  const r = rows[0];
  if (!r) return null;
  const s = (v: unknown) => (v == null || v === '' ? null : String(v));
  return {
    ipUid: String(r.ipd_no),
    patientName: s(r.patient_name),
    uhid: s(r.uhid),
    ageGender: s(r.age_gender),
    speciality: s(r.treating_doctor_speciality),
    team: s(r.treating_doctor_team),
    ward: s(r.ward),
    dischargeType: s(r.discharge_type),
    admitDate: s(r.admit_date),
    dischargeDate: s(r.discharge_date),
    losDays: r.los_days == null ? null : Number(r.los_days),
    status: s(r.status),
  };
}

/** Search hit: an IP admission (kx) + its discharge doc, for the UHID/name search view. */
export interface IpdSearchHit {
  ipUid: string;
  patientName: string | null;   // PHI — render-only
  uhid: string | null;          // PHI — render-only
  speciality: string | null;
  ward: string | null;
  dischargeType: string | null;
  dischargeDate: string | null;
  losDays: number | null;
  documentId: string | null;    // null = no filed discharge-summary PDF
  pdfUrl: string | null;
}

/** UHID / patient-name / IP-number search over kx admissions, joined to the filed docs. */
export async function searchIpdAdmissions(q: string, limit = 25): Promise<IpdSearchHit[]> {
  const needle = esc(q.trim().slice(0, 60));
  if (needle.length < 2) return [];
  const lim = Math.max(1, Math.min(50, limit));
  const rows = await metabaseQuery(
    `WITH adm AS (
       SELECT DISTINCT ON (ipd_no) ipd_no, patient_name, uhid, treating_doctor_speciality, ward, discharge_type,
              to_char(discharge_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS discharge_date,
              greatest(0, (discharge_date_time::date - admission_date_time::date))::int AS los_days,
              coalesce(discharge_date_time, admission_date_time) AS sort_ts
       FROM kx_discharge_summary_records
       WHERE uhid ILIKE '%${needle}%' OR patient_name ILIKE '%${needle}%' OR ipd_no ILIKE '%${needle}%'
       ORDER BY ipd_no, (status='Final') DESC, discharge_date_time DESC NULLS LAST)
     SELECT a.*, m._doc_id AS document_id, m.document__upload_uri AS pdf_url
     FROM adm a
     LEFT JOIN ${DOCS} m ON m.additional_metadata__booking_id = a.ipd_no AND m.${CLS} AND m.document__upload_uri ILIKE '%.pdf'
     ORDER BY a.sort_ts DESC NULLS LAST LIMIT ${lim}`);
  const s = (v: unknown) => (v == null || v === '' ? null : String(v));
  return rows.map((r) => ({
    ipUid: String(r.ipd_no),
    patientName: s(r.patient_name),
    uhid: s(r.uhid),
    speciality: s(r.treating_doctor_speciality),
    ward: s(r.ward),
    dischargeType: s(r.discharge_type),
    dischargeDate: s(r.discharge_date),
    losDays: r.los_days == null ? null : Number(r.los_days),
    documentId: s(r.document_id),
    pdfUrl: s(r.pdf_url),
  }));
}

/** Calendar density: discharge-summary docs filed per IST day (by kx discharge date when
 *  joined, else upload date) for a month range. */
export async function dischargeDocDensity(fromDay: string, toDay: string): Promise<Record<string, number>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) throw new Error('bad day');
  const rows = await metabaseQuery(
    `SELECT to_char(coalesce(k.discharge_date_time, m.upload_timestamp::timestamptz) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day,
            count(*)::int AS n
     FROM ${DOCS} m
     LEFT JOIN (SELECT DISTINCT ON (ipd_no) ipd_no, discharge_date_time FROM kx_discharge_summary_records
                ORDER BY ipd_no, (status='Final') DESC, discharge_date_time DESC NULLS LAST) k
       ON k.ipd_no = m.additional_metadata__booking_id
     WHERE m.${CLS} AND m.document__upload_uri ILIKE '%.pdf'
       AND coalesce(k.discharge_date_time, m.upload_timestamp::timestamptz) AT TIME ZONE 'Asia/Kolkata'
           BETWEEN '${fromDay}'::timestamp AND '${toDay}'::timestamp + interval '1 day'
     GROUP BY 1`);
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.day)] = Number(r.n);
  return out;
}

/** The discharge-summary docs for ONE IST day (the calendar's day rail).
 *  patientName/uhid are read-time PHI for the access-controlled rail — never persisted. */
export interface IpdDayDoc {
  documentId: string;
  ipUid: string | null;
  patientName: string | null;   // PHI — render-only
  uhid: string | null;          // PHI — render-only
  speciality: string | null;
  dischargeType: string | null;
  losDays: number | null;
}

export async function dischargeDocsForDay(day: string, limit = 60): Promise<IpdDayDoc[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('bad day');
  const rows = await metabaseQuery(
    `SELECT m._doc_id AS document_id, m.additional_metadata__booking_id AS ip_uid,
            k.patient_name, k.uhid,
            k.treating_doctor_speciality AS speciality, k.discharge_type,
            greatest(0, (k.discharge_date_time::date - k.admission_date_time::date))::int AS los_days
     FROM ${DOCS} m
     LEFT JOIN (SELECT DISTINCT ON (ipd_no) * FROM kx_discharge_summary_records
                ORDER BY ipd_no, (status='Final') DESC, discharge_date_time DESC NULLS LAST) k
       ON k.ipd_no = m.additional_metadata__booking_id
     WHERE m.${CLS} AND m.document__upload_uri ILIKE '%.pdf'
       AND to_char(coalesce(k.discharge_date_time, m.upload_timestamp::timestamptz) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') = '${day}'
     ORDER BY m.upload_timestamp::timestamptz DESC LIMIT ${Math.max(1, Math.min(200, limit))}`);
  const s = (v: unknown) => (v == null || v === '' ? null : String(v));
  return rows.map((r) => ({
    documentId: String(r.document_id),
    ipUid: s(r.ip_uid),
    patientName: s(r.patient_name),
    uhid: s(r.uhid),
    speciality: s(r.speciality),
    dischargeType: s(r.discharge_type),
    losDays: r.los_days == null ? null : Number(r.los_days),
  }));
}

// ── intake (S5 worker + S6 backfill) ────────────────────────────────────────────────────────────
// The audit corpus: DISCHARGE_SUMMARY docs with a real .pdf, not yet ingested. "Day" = the IST
// discharge date where the kx admission joins, else the filed (upload) date — the same coalesce
// the calendar renders, so what the worker audits is what the surface shows.
const DAY_EXPR = `to_char(coalesce(k.discharge_date_time, m.upload_timestamp::timestamptz) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')`;
const KX_JOIN = `LEFT JOIN (SELECT DISTINCT ON (ipd_no) ipd_no, discharge_date_time FROM kx_discharge_summary_records
                 ORDER BY ipd_no, (status='Final') DESC, discharge_date_time DESC NULLS LAST) k
                 ON k.ipd_no = m.additional_metadata__booking_id`;
const CORPUS_WHERE = `m.${CLS} AND m.document__upload_uri ILIKE '%.pdf' AND m.document__is_ingested IS NULL`;

export interface IpdIntakeDoc {
  documentId: string;
  ipUid: string | null;
  memberId: string | null;
  pdfUrl: string;
  day: string;
}

const toIntake = (rows: Record<string, unknown>[]): IpdIntakeDoc[] => rows.map((r) => ({
  documentId: String(r.document_id),
  ipUid: r.ip_uid == null || r.ip_uid === '' ? null : String(r.ip_uid),
  memberId: r.member_id == null ? null : String(r.member_id),
  pdfUrl: String(r.pdf_url),
  day: String(r.day),
}));

/** Count discharge summaries filed/discharged on an IST day (the worker's denominator). */
export async function countDischargeDocsForDay(day: string): Promise<number> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('bad day');
  const rows = await metabaseQuery(
    `SELECT count(*)::int AS n FROM ${DOCS} m ${KX_JOIN} WHERE ${CORPUS_WHERE} AND ${DAY_EXPR} = '${day}'`);
  return Number(rows[0]?.n ?? 0);
}

/** Next page of discharge summaries for an IST day, excluding already-audited document_ids. */
export async function fetchDischargeDocsForDay(day: string, excludeDocIds: string[], limit: number): Promise<IpdIntakeDoc[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('bad day');
  const ex = Array.from(new Set(excludeDocIds.filter(isDocId)));
  const notIn = ex.length ? ` AND m._doc_id NOT IN (${ex.map((d) => `'${esc(d)}'`).join(', ')})` : '';
  const lim = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = await metabaseQuery(
    `SELECT m._doc_id AS document_id, m._parent_doc_id AS member_id, m.additional_metadata__booking_id AS ip_uid,
            m.document__upload_uri AS pdf_url, ${DAY_EXPR} AS day
     FROM ${DOCS} m ${KX_JOIN}
     WHERE ${CORPUS_WHERE} AND ${DAY_EXPR} = '${day}'${notIn}
     ORDER BY m.upload_timestamp::timestamptz ASC LIMIT ${lim}`);
  return toIntake(rows);
}

/** The whole audit corpus size (the backfill's denominator). */
export async function countDischargeCorpus(): Promise<number> {
  const rows = await metabaseQuery(`SELECT count(*)::int AS n FROM ${DOCS} m WHERE ${CORPUS_WHERE}`);
  return Number(rows[0]?.n ?? 0);
}

/** OLDEST-FIRST backlog page for the S6 backfill, excluding already-audited document_ids. */
export async function fetchBacklogDocs(excludeDocIds: string[], limit: number): Promise<IpdIntakeDoc[]> {
  const ex = Array.from(new Set(excludeDocIds.filter(isDocId)));
  const notIn = ex.length ? ` AND m._doc_id NOT IN (${ex.map((d) => `'${esc(d)}'`).join(', ')})` : '';
  const lim = Math.max(1, Math.min(20, Math.floor(limit)));
  const rows = await metabaseQuery(
    `SELECT m._doc_id AS document_id, m._parent_doc_id AS member_id, m.additional_metadata__booking_id AS ip_uid,
            m.document__upload_uri AS pdf_url, ${DAY_EXPR} AS day
     FROM ${DOCS} m ${KX_JOIN}
     WHERE ${CORPUS_WHERE}${notIn}
     ORDER BY coalesce(k.discharge_date_time, m.upload_timestamp::timestamptz) ASC LIMIT ${lim}`);
  return toIntake(rows);
}

/** Batched name/UHID resolution for a set of ip_uids (ONE query — the Overview recent-audits
 *  join). Read-time PHI for the access-controlled surface; never persisted. */
export async function namesForIpUids(ipUids: string[]): Promise<Record<string, { patientName: string | null; uhid: string | null }>> {
  const ids = Array.from(new Set(ipUids.filter((u) => u && isIpUid(u))));
  if (!ids.length) return {};
  const list = ids.map((u) => `'${esc(u)}'`).join(', ');
  const rows = await metabaseQuery(
    `SELECT DISTINCT ON (ipd_no) ipd_no, patient_name, uhid FROM kx_discharge_summary_records
     WHERE ipd_no IN (${list})
     ORDER BY ipd_no, (status='Final') DESC, discharge_date_time DESC NULLS LAST`);
  const s = (v: unknown) => (v == null || v === '' ? null : String(v));
  const out: Record<string, { patientName: string | null; uhid: string | null }> = {};
  for (const r of rows) out[String(r.ipd_no)] = { patientName: s(r.patient_name), uhid: s(r.uhid) };
  return out;
}
