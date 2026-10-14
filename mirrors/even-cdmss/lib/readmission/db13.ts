/**
 * lib/readmission/db13.ts — read-only db13 access for the readmission agent.
 * Server-only; goes through lib/metabase's metabaseQuery — the SAME connection layer
 * lib/ipd-audit/db13.ts uses. No new credential, no direct pg driver.
 *
 * ⚠️ SQL / SCHEMA HONESTY (kickoff hard requirement): this sandbox has no live db13.
 * Every query below is INFERRED except where marked VALIDATED (facts carried from
 * lib/ipd-audit/doctor-lookup.ts and lib/ccb-fetch-core.ts). Consequences drawn:
 *   · Every fetch is fail-safe — a query error degrades to [] / null, NEVER a 500
 *     and never a wrong finding (the caller then reports "not audited").
 *   · Row-shape mapping is TOLERANT: SELECT * + candidate-column resolution, so a
 *     wrongly-guessed column name costs a field, not the whole read. The candidate
 *     lists are enumerated in the build report for live validation.
 *   · kx_discharged_completed_patients.uid is KNOWN NOT to be the encounter id
 *     (doctor-lookup.ts §2.11) — the encounter-id candidates below deliberately
 *     exclude bare `uid`.
 *
 * PHI POSTURE (§8b): patient_name/dob are read here ONLY for the name+dob
 * duplicate-MRN reconcile and the de-identification scrub. They ride the in-memory
 * KxEncounter, are never persisted to a finding row, and never reach Vertex —
 * lib/readmission/assemble.ts is the single choke point that strips them.
 */

import { metabaseQuery } from '../metabase';
import type { KxEncounter, FormReadmission, MappedAdtCols } from '../readmission-detect-core';
import { ADT_COLUMN_CANDIDATES, resolveMappedCols } from '../readmission-detect-core';
import { canonicalAnalyte, labAbnormal } from '../readmission-reconcile-core';

// Re-exported so the worker/report layer names the mapping facts from one place.
export { ADT_COLUMN_CANDIDATES, resolveMappedCols };
export type { MappedAdtCols };

const esc = (s: string) => s.replace(/'/g, "''");
const isEncounterId = (s: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(s);   // ip_uid shapes: IP-1250, IPNO-229
const isDocId = (s: string) => /^[A-Za-z0-9_-]{6,64}$/.test(s);

// ── tolerant column resolution ──────────────────────────────────────────────────

const pick = (row: Record<string, unknown>, candidates: string[]): unknown => {
  for (const c of candidates) {
    if (c in row && row[c] != null && row[c] !== '') return row[c];
  }
  return null;
};
const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

// ADT_COLUMN_CANDIDATES lives in the PURE core (readmission-detect-core.ts) so the
// candidate priority — the exact thing the 5 Aug zero-lanes defect was — is unit-tested.

function toEncounter(row: Record<string, unknown>): KxEncounter | null {
  const encounterId = s(pick(row, [...ADT_COLUMN_CANDIDATES.encounterId]));
  const uhid = s(pick(row, [...ADT_COLUMN_CANDIDATES.uhid]));
  const admitAt = s(pick(row, [...ADT_COLUMN_CANDIDATES.admitAt]));
  if (!encounterId || !uhid || !admitAt) return null;   // unusable row — dropped, never guessed
  return {
    encounterId, uhid, admitAt,
    encounterType: s(pick(row, [...ADT_COLUMN_CANDIDATES.encounterType])) ?? 'ip_admission',
    dischargeAt: s(pick(row, [...ADT_COLUMN_CANDIDATES.dischargeAt])),
    admissionType: s(pick(row, [...ADT_COLUMN_CANDIDATES.admissionType])),
    department: s(pick(row, [...ADT_COLUMN_CANDIDATES.department])),
    doctor: s(pick(row, [...ADT_COLUMN_CANDIDATES.doctor])),
    payer: s(pick(row, [...ADT_COLUMN_CANDIDATES.payer])),
    patientName: s(pick(row, [...ADT_COLUMN_CANDIDATES.patientName])),
    dob: s(pick(row, [...ADT_COLUMN_CANDIDATES.dob])),
  };
}

// ── ADT fetch (the detector's raw material) ─────────────────────────────────────

const ADT_PAGE = 500;   // Metabase /api/dataset caps unsaved-query results; page well under it
const ADT_MAX_PAGES = 20;

/**
 * INFERRED SQL (paged; encounter_type per the recon: ER shares the ADT table):
 *   SELECT * FROM kx_discharged_completed_patients
 *    WHERE encounter_type IN ('ip_admission','er_admission')
 *    ORDER BY admission_date_time ASC, uhid ASC
 *    LIMIT 500 OFFSET <n>
 * Fail-safe: any page error returns what was fetched so far; a first-page error → [].
 */
export async function fetchAdtEncounters(): Promise<{ encounters: KxEncounter[]; mappedCols: MappedAdtCols }> {
  const out: KxEncounter[] = [];
  let firstPage: Record<string, unknown>[] = [];
  for (let page = 0; page < ADT_MAX_PAGES; page++) {
    let rows: Record<string, unknown>[];
    try {
      rows = await metabaseQuery(
        `SELECT * FROM kx_discharged_completed_patients
         WHERE encounter_type IN ('ip_admission', 'er_admission')
         ORDER BY admission_date_time ASC, uhid ASC
         LIMIT ${ADT_PAGE} OFFSET ${page * ADT_PAGE}`);
    } catch {
      // degrade, never throw into the worker
      return { encounters: page === 0 ? [] : out, mappedCols: resolveMappedCols(firstPage) };
    }
    if (page === 0) firstPage = rows;
    for (const r of rows) {
      const e = toEncounter(r);
      if (e) out.push(e);
    }
    if (rows.length < ADT_PAGE) break;
  }
  return { encounters: out, mappedCols: resolveMappedCols(firstPage) };
}

// ── Discharge summary text ──────────────────────────────────────────────────────

export interface SummaryRecord {
  encounterId: string;
  patientName: string | null;   // PHI — for the de-identification scrub ONLY
  uhid: string | null;          // PHI — for the de-identification scrub ONLY
  admitAt: string | null;
  dischargeAt: string | null;
  department: string | null;
  /** ALL row fields, for the tolerant summary-text assembly in assemble.ts. */
  raw: Record<string, unknown>;
}

/**
 * VALIDATED keys (doctor-lookup.ts §2.11): kx_discharge_summary_records.ipd_no,
 * status ('Final'), discharge_date_time, treating_doctor_speciality. The summary
 * TEXT column is NOT validated — hence SELECT * and tolerant assembly downstream.
 *
 * INFERRED SQL:
 *   SELECT * FROM kx_discharge_summary_records WHERE ipd_no = '<id>'
 *   ORDER BY (status='Final') DESC, discharge_date_time DESC NULLS LAST LIMIT 1
 */
export async function fetchSummaryRecord(encounterId: string): Promise<SummaryRecord | null> {
  if (!isEncounterId(encounterId)) return null;
  try {
    const rows = await metabaseQuery(
      `SELECT * FROM kx_discharge_summary_records WHERE ipd_no = '${esc(encounterId)}'
       ORDER BY (status='Final') DESC, discharge_date_time DESC NULLS LAST LIMIT 1`);
    const r = rows[0];
    if (!r) return null;
    return {
      encounterId,
      patientName: s(r.patient_name),
      uhid: s(r.uhid),
      admitAt: s(r.admission_date_time),
      dischargeAt: s(r.discharge_date_time),
      department: s(r.treating_doctor_speciality),
      raw: r,
    };
  } catch {
    return null;
  }
}

// ── Labs (the disinterested source) ─────────────────────────────────────────────

export interface LabRow {
  id: string;               // stable evidence id seed (row ordinal within the fetch)
  testName: string | null;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  refRange: string | null;
  at: string | null;
  analyte: string | null;
  abnormal: boolean | null;
}

/** Candidate column names — ALL INFERRED except uhid/service_date (ccb-fetch-core). */
export const LAB_COLUMN_CANDIDATES = {
  testName: ['test_name', 'parameter_name', 'parameter', 'lab_test_name', 'test', 'investigation_name', 'service_name'],
  value: ['result_value', 'result', 'value', 'observed_value', 'test_value'],
  unit: ['unit', 'units', 'uom'],
  refRange: ['reference_range', 'normal_range', 'ref_range', 'biological_reference_interval'],
  flag: ['abnormal_flag', 'result_flag', 'flag'],
  at: ['result_date_time', 'reported_date_time', 'sample_collected_at', 'collected_date_time', 'result_date', 'service_date'],
} as const;

/**
 * Lab join key MEASURED clean (PRD §8c.2): kx_lab_reports.visit_id = encounter id.
 * INFERRED SQL:
 *   SELECT * FROM kx_lab_reports WHERE visit_id = '<encounterId>' LIMIT 500
 */
export async function fetchLabsForEncounter(encounterId: string): Promise<LabRow[]> {
  if (!isEncounterId(encounterId)) return [];
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT * FROM kx_lab_reports WHERE visit_id = '${esc(encounterId)}' LIMIT 500`);
  } catch {
    return [];
  }
  return rows.map((r, i) => {
    const testName = s(pick(r, [...LAB_COLUMN_CANDIDATES.testName]));
    const valueText = s(pick(r, [...LAB_COLUMN_CANDIDATES.value]));
    const num = valueText != null ? Number(String(valueText).replace(/[^\d.eE+-]/g, '')) : NaN;
    const value = Number.isFinite(num) ? num : null;
    const refRange = s(pick(r, [...LAB_COLUMN_CANDIDATES.refRange]));
    const flag = s(pick(r, [...LAB_COLUMN_CANDIDATES.flag]));
    return {
      id: `row${i + 1}`,
      testName, value, valueText,
      unit: s(pick(r, [...LAB_COLUMN_CANDIDATES.unit])),
      refRange,
      at: s(pick(r, [...LAB_COLUMN_CANDIDATES.at])),
      analyte: canonicalAnalyte(testName),
      abnormal: labAbnormal(value, flag, refRange),
    };
  }).filter((l) => l.testName != null);
}

// ── Phase 1.5 substrate: encounter → discharge PDF (addendum §1/§6) ─────────────
// The discharge narrative is a PDF in accounts-members-miscellaneous_documents, linked
// to a stay by additional_metadata__booking_id = encounter_id. 191 of 203 pair
// encounters (94%) have one filed. DOCS/CLS are the SAME constants lib/ipd-audit/db13.ts
// uses — restated here rather than imported so this module keeps its own db13 contract.

const DOCS = '"accounts-members-miscellaneous_documents"';
const CLS = `document__classification__types::text ILIKE '%DISCHARGE_SUMMARY%'`;

export interface DischargeDocLink {
  documentId: string;
  ipUid: string | null;
  memberId: string | null;
  pdfUrl: string | null;
}

/**
 * INFERRED SQL (addendum §6; the column names are VALIDATED — lib/ipd-audit/db13.ts
 * reads this table in production today):
 *   SELECT _doc_id, _parent_doc_id, additional_metadata__booking_id AS ip_uid,
 *          document__upload_uri AS pdf_url
 *     FROM "accounts-members-miscellaneous_documents"
 *    WHERE additional_metadata__booking_id = '<encounter_id>'
 *      AND document__classification__types::text ILIKE '%DISCHARGE_SUMMARY%'
 *      AND document__upload_uri ILIKE '%.pdf'
 *    ORDER BY upload_timestamp DESC NULLS LAST LIMIT 1
 *
 * Fail-safe: any fault → null → the caller routes the pair to TIER 3 (not auditable),
 * never to a guess. Newest filed document wins when a stay has more than one.
 */
export async function fetchDischargeDocForEncounter(encounterId: string): Promise<DischargeDocLink | null> {
  if (!isEncounterId(encounterId)) return null;
  try {
    const rows = await metabaseQuery(
      `SELECT _doc_id, _parent_doc_id, additional_metadata__booking_id AS ip_uid,
              document__upload_uri AS pdf_url
         FROM ${DOCS}
        WHERE additional_metadata__booking_id = '${esc(encounterId)}'
          AND ${CLS}
          AND document__upload_uri ILIKE '%.pdf'
        ORDER BY upload_timestamp DESC NULLS LAST
        LIMIT 1`);
    const r = rows[0];
    if (!r || r._doc_id == null) return null;
    return {
      documentId: String(r._doc_id),
      ipUid: s(r.ip_uid),
      memberId: s(r._parent_doc_id),
      pdfUrl: s(r.pdf_url),
    };
  } catch {
    return null;
  }
}

// ── Phase 1.5 substrate: patient → individual → structured labs (§1/§6) ─────────

/**
 * Resolve a KX UHID to the individuals uid that parents the lab rows.
 *
 * INFERRED SQL (the kx_uhid link itself is MEASURED — PRD §3, 46/46 form records
 * resolve through it):
 *   SELECT uid, kx_uhid, old_kx_uhids FROM individuals
 *    WHERE kx_uhid IN ('<u1>', '<u2>')
 *       OR old_kx_uhids::text ~ '(^|[{,"])(<u1>|<u2>)([,}"]|$)'
 *    LIMIT 5
 *
 * The regex is anchored on array delimiters so a UHID cannot substring-match a LONGER
 * one, and the match is then RE-VERIFIED in JS by exact membership — the SQL only
 * narrows, it never decides. A wrong patient here would be the worst failure this agent
 * has, so both sides must agree before a uid is returned.
 */
export async function resolveIndividualUid(uhids: Array<string | null | undefined>): Promise<string | null> {
  const ids = Array.from(new Set(uhids.filter((u): u is string => !!u && /^[A-Za-z0-9/_-]{2,40}$/.test(u))));
  if (!ids.length) return null;
  const list = ids.map((u) => `'${esc(u)}'`).join(', ');
  const alt = ids.map((u) => esc(u).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  try {
    const rows = await metabaseQuery(
      `SELECT uid, kx_uhid, old_kx_uhids FROM individuals
        WHERE kx_uhid IN (${list})
           OR old_kx_uhids::text ~ '(^|[{,"])(${alt})([,}"]|$)'
        LIMIT 5`);
    const wanted = new Set(ids);
    for (const r of rows) {
      const uid = s(r.uid);
      if (!uid) continue;
      const held: string[] = [];
      const kx = s(r.kx_uhid);
      if (kx) held.push(kx);
      const old = r.old_kx_uhids;
      if (Array.isArray(old)) for (const o of old) { const v = s(o); if (v) held.push(v); }
      else if (typeof old === 'string') {
        try { const arr = JSON.parse(old); if (Array.isArray(arr)) for (const o of arr) { const v = s(o); if (v) held.push(v); } }
        catch { for (const o of old.replace(/[{}"]/g, '').split(',')) { const v = o.trim(); if (v) held.push(v); } }
      }
      // EXACT membership, re-checked here: the SQL narrowed, this decides.
      if (held.some((h) => wanted.has(h))) return uid;
    }
    return null;
  } catch {
    return null;
  }
}

/** One structured, LOINC-coded analyte value (addendum §1 — the disinterested source). */
export interface StructuredLabRow {
  id: string;                 // stable evidence-id seed (ordinal within this fetch)
  name: string | null;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  /** data_normal_range_report — a JSON OBJECT, not a string (VALIDATED live 6 Aug 2026):
   *  {"h":17,"l":13,"t":"13.0 - 17.0","s":2}. Passed through RAW and parsed by
   *  parseRefRange; stringifying it here is what produced "[object Object]" and would
   *  have silently disabled every tier-1 numeric flag. */
  refRange: unknown;
  normalised: string | null;  // normalised_data_value — carried, never used to decide abnormality
  /** ⚠️ Effectively ABSENT in db13 (confirmed live, V). Carried because it costs nothing
   *  and is the right key the day it is populated; nothing numeric depends on it. */
  loincId: string | null;
  at: string | null;          // result_date
}

/**
 * Structured labs for one patient inside the index window.
 *
 * INFERRED SQL (addendum §6 — the column list is the addendum's, mined live on db13):
 *   SELECT name, data_value, data_unit, data_normal_range_report,
 *          normalised_data_value, loinc_id, result_date
 *     FROM "individuals-parameter_digital_values__parameters"
 *    WHERE _parent_path = '/individuals/' || '<individual_uid>'
 *      AND result_date BETWEEN '<adm-14d>' AND '<disch+2d>'
 *    ORDER BY result_date ASC
 *    LIMIT 500
 *
 * Fail-safe: any fault → [] → the pair drops to TIER 2 (PDF-only), never to a wrong
 * numeric finding.
 */
export async function fetchStructuredLabs(individualUid: string, fromTs: string, toTs: string): Promise<StructuredLabRow[]> {
  if (!individualUid || !/^[A-Za-z0-9_-]{2,64}$/.test(individualUid)) return [];
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT name, data_value, data_unit, data_normal_range_report,
              normalised_data_value, loinc_id, result_date
         FROM "individuals-parameter_digital_values__parameters"
        WHERE _parent_path = '/individuals/' || '${esc(individualUid)}'
          AND result_date BETWEEN '${esc(fromTs)}' AND '${esc(toTs)}'
        ORDER BY result_date ASC
        LIMIT 500`);
  } catch {
    return [];
  }
  return rows.map((r, i) => {
    const valueText = s(r.data_value);
    const num = valueText != null ? Number(String(valueText).replace(/[^\d.eE+-]/g, '')) : NaN;
    return {
      id: `L${i + 1}`,
      name: s(r.name),
      value: Number.isFinite(num) ? num : null,
      valueText,
      unit: s(r.data_unit),
      refRange: r.data_normal_range_report ?? null,   // RAW — see StructuredLabRow.refRange
      normalised: s(r.normalised_data_value),
      loincId: s(r.loinc_id),
      at: s(r.result_date),
    };
  }).filter((l) => l.name != null || l.loincId != null);
}

/** The thin structured discharge extraction — corroboration only (addendum §1). */
export interface ThinDischargeValues {
  plannedProcedure: boolean | null;
  admitDate: string | null;
  dischargeDate: string | null;
}

/**
 * ⚠️ INFERRED, AND ITS JOIN KEY IS UNSETTLED (flagged in the build report). The
 * addendum names the table and the payload but not how a row reaches an encounter; the
 * document id is the most plausible key for a per-document digital-values table.
 *
 *   SELECT digital_values__discharge_summary_values
 *     FROM all_document_digital_values
 *    WHERE _doc_id = '<document_id>' LIMIT 1
 *
 * This is CORROBORATION ONLY — the primary planned/unplanned rule is the index
 * foreshadow test (PRD §5 rule 2), which does not consult it. A null costs the finding
 * nothing, so a wrong key here degrades to "no corroboration", never to a wrong verdict.
 */
export async function fetchThinDischargeValues(documentId: string): Promise<ThinDischargeValues | null> {
  if (!isDocId(documentId)) return null;
  try {
    const rows = await metabaseQuery(
      `SELECT digital_values__discharge_summary_values
         FROM all_document_digital_values
        WHERE _doc_id = '${esc(documentId)}'
        LIMIT 1`);
    const raw = rows[0]?.digital_values__discharge_summary_values;
    if (raw == null) return null;
    let d: Record<string, unknown> = {};
    if (typeof raw === 'object') d = raw as Record<string, unknown>;
    else if (typeof raw === 'string') { try { d = JSON.parse(raw); } catch { return null; } }
    const bool = (v: unknown): boolean | null =>
      v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;
    return {
      plannedProcedure: bool(d.planned_procedure),
      admitDate: s(d.admission_date) ?? s(d.admit_date),
      dischargeDate: s(d.discharge_date),
    };
  } catch {
    return null;
  }
}

// ── POST_IPD form detector (decision 12) ────────────────────────────────────────

const HF_TABLE = '"individuals-health_forms"';   // quoting per lib/care-tracks-core.ts (validated)

/**
 * INFERRED SQL (the jsonb key's typo `is_readmisstion` is IN the schema — recon §1;
 * tolerant of boolean-vs-string storage):
 *   SELECT * FROM "individuals-health_forms"
 *    WHERE type = 'POST_IPD'
 *      AND lower(coalesce(post_ipd_health__readmission_details->>'is_readmisstion','')) IN ('true','t','1')
 *    LIMIT 500
 * Then: SELECT uid, kx_uhid, old_kx_uhids FROM individuals WHERE uid IN (...)
 * (linkage RESOLVED, decision 12: form._parent_doc_id → individuals.uid →
 *  individuals.kx_uhid ∪ old_kx_uhids → kx_discharged_completed_patients.uhid).
 */
export async function fetchFormReadmissions(): Promise<FormReadmission[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT * FROM ${HF_TABLE}
       WHERE type = 'POST_IPD'
         AND lower(coalesce(post_ipd_health__readmission_details->>'is_readmisstion', '')) IN ('true', 't', '1')
       LIMIT 500`);
  } catch {
    return [];
  }

  const parsed = rows.map((r) => {
    const formUid = s(r._doc_id);
    const memberUid = s(r._parent_doc_id);
    if (!formUid || !memberUid) return null;
    let d: Record<string, unknown> = {};
    const rawDetails = r.post_ipd_health__readmission_details;
    if (rawDetails != null) {
      if (typeof rawDetails === 'object') d = rawDetails as Record<string, unknown>;
      else if (typeof rawDetails === 'string') { try { d = JSON.parse(rawDetails); } catch { d = {}; } }
    }
    const bool = (v: unknown): boolean | null =>
      v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;
    return {
      formUid, memberUid,
      readmissionDate: s(d.readmission_date),
      eventType: s(d.event_type),
      // recon catch 2: is_planned appears only when true — absence is UNKNOWN, not unplanned
      isPlanned: bool(d.is_planned),
      sameCondition: bool(d.is_related_to_same_condition),
      notes: s(d.notes) ?? s(r.notes),
      uhids: [] as string[],
    };
  }).filter((f): f is NonNullable<typeof f> => f != null);

  // Resolve member → KX UHIDs via the individuals master (authoritative; no fuzzy match).
  const memberUids = Array.from(new Set(parsed.map((f) => f.memberUid).filter(isDocId)));
  if (memberUids.length) {
    try {
      const idRows = await metabaseQuery(
        `SELECT uid, kx_uhid, old_kx_uhids FROM individuals
         WHERE uid IN (${memberUids.map((u) => `'${esc(u)}'`).join(', ')})`);
      const byUid = new Map<string, string[]>();
      for (const r of idRows) {
        const uid = s(r.uid);
        if (!uid) continue;
        const uhids: string[] = [];
        const kx = s(r.kx_uhid);
        if (kx) uhids.push(kx);
        const old = r.old_kx_uhids;
        if (Array.isArray(old)) for (const o of old) { const v = s(o); if (v) uhids.push(v); }
        else if (typeof old === 'string') {
          try { const arr = JSON.parse(old); if (Array.isArray(arr)) for (const o of arr) { const v = s(o); if (v) uhids.push(v); } }
          catch { /* pg array literal like {A,B} */ for (const o of old.replace(/[{}"]/g, '').split(',')) { const v = o.trim(); if (v) uhids.push(v); } }
        }
        byUid.set(uid, Array.from(new Set(uhids)));
      }
      for (const f of parsed) f.uhids = byUid.get(f.memberUid) ?? [];
    } catch { /* identity fetch failed → forms stay unlinked → counted noEvenIpStay, not guessed */ }
  }
  return parsed;
}
