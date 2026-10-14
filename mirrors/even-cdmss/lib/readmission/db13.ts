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
  /** The discharge row's OWN `ipd_no` (VALIDATED key) — the discharged-history fallback hop
   *  id (templates PRD T-3). Read off the row, not echoed from the lookup argument. */
  ipdNo: string | null;
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
      ipdNo: s(r.ipd_no),
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

// ── R2 — KX clinical templates as SOURCE 4 (CDMSS-READMISSIONS-R2-PRD v1.0 §3.1) ────
//
// db13 tables kx_clinical_template_ot_notes / _pac_reports / _progress_reports (confirmed
// live via Metabase 17 Aug 2026). PHI POSTURE (T-6, hard rule): `patient_name` and
// `patient_mobile` are NEVER in any SELECT below — the row type in
// lib/readmission-template-core.ts has no field for them. `note` / `component_json` may
// carry a name inside the text; lib/readmission/assemble.ts scrubs EVERY string.
//
// Fail-safe: any faulting hop → outcome 'fetch_failed' (chip `unknown`, NEVER `absent`);
// rows obtained by a hop that did succeed are still returned so the recon can cite them.
//
// ⚠️ INFERRED SQL throughout (no live db13 in this sandbox). Hop recipe is the templates
// PRD's MEASURED map (§2 / T-3): encounter_id primary; discharged-history fallback
// uhid + ipd_no; PAC additionally on uhid inside [admit − 30d, discharge] because the PAC
// majority is pre-admit OPR / OPVST and PAC is NEVER required to match on encounter alone.
//
//   OT / progress, primary:   SELECT <cols> FROM <table>
//                              WHERE encounter_id = '<enc>' AND status = 'final'
//                              ORDER BY created_at ASC LIMIT <cap>
//   OT / progress, fallback:  SELECT <cols> FROM <table>
//                              WHERE uhid = '<uhid>' AND encounter_id = '<ipd_no>' AND status = 'final'
//                              ORDER BY created_at ASC LIMIT <cap>
//   PAC, hop (a):             SELECT <cols> FROM kx_clinical_template_pac_reports
//                              WHERE encounter_id = '<enc>' AND status = 'final'
//                              ORDER BY created_at ASC LIMIT 5
//   PAC, hop (b):             SELECT <cols> FROM kx_clinical_template_pac_reports
//                              WHERE uhid = '<uhid>' AND created_at BETWEEN '<from>' AND '<to>' AND status = 'final'
//                              ORDER BY created_at ASC LIMIT 5
//   <cols> = uid, encounter_id, uhid, template_name, status, created_at, note, component_json
//            (+ surgery_name on the OT table only — INFERRED that PAC / progress lack the column;
//             selecting it there would fault every fetch, so they map surgery_name = null)

import {
  TEMPLATE_ROW_CAP, dedupTemplateRows, planOtProgressHops, planPacHops,
  type KxTemplateRow, type TemplateHop, type TemplateSource,
} from '../readmission-template-core';

export interface TemplateFetchResult { outcome: 'ok' | 'fetch_failed'; rows: KxTemplateRow[] }

const TEMPLATE_TABLE: Readonly<Record<TemplateSource, string>> = {
  ot_note: 'kx_clinical_template_ot_notes',
  pac_note: 'kx_clinical_template_pac_reports',
  progress_note: 'kx_clinical_template_progress_reports',
};
const isUhid = (u: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(u);
const isIsoTs = (t: string) => /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(t);

function templateCols(source: TemplateSource): string {
  // patient_name / patient_mobile are DELIBERATELY not here and must never be added.
  return `uid, encounter_id, uhid, template_name, status, created_at, note, component_json${source === 'ot_note' ? ', surgery_name' : ''}`;
}

function toTemplateRow(r: Record<string, unknown>): KxTemplateRow {
  const cj = r.component_json;
  return {
    uid: s(r.uid), encounterId: s(r.encounter_id), uhid: s(r.uhid),
    templateName: s(r.template_name), status: s(r.status), createdAt: s(r.created_at),
    surgeryName: s(r.surgery_name),
    note: r.note == null ? null : String(r.note),
    componentJson: cj == null ? null : typeof cj === 'string' ? cj : JSON.stringify(cj),
  };
}

function hopWhere(hop: TemplateHop): string | null {
  switch (hop.kind) {
    case 'encounter':
      return isEncounterId(hop.encounterId) ? `encounter_id = '${esc(hop.encounterId)}'` : null;
    case 'uhid_ipdno':
      return isUhid(hop.uhid) && isEncounterId(hop.ipdNo) ? `uhid = '${esc(hop.uhid)}' AND encounter_id = '${esc(hop.ipdNo)}'` : null;
    case 'uhid_window':
      return isUhid(hop.uhid) && isIsoTs(hop.fromTs) && isIsoTs(hop.toTs)
        ? `uhid = '${esc(hop.uhid)}' AND created_at BETWEEN '${esc(hop.fromTs)}' AND '${esc(hop.toTs)}'` : null;
  }
}

/** One hop. Throws on a query fault (the caller turns that into 'fetch_failed'); an
 *  invalid identifier is not a fault — it is simply a hop that cannot run ([]). */
async function runHop(source: TemplateSource, hop: TemplateHop): Promise<KxTemplateRow[]> {
  const where = hopWhere(hop);
  if (!where) return [];
  const rows = await metabaseQuery(
    `SELECT ${templateCols(source)} FROM ${TEMPLATE_TABLE[source]}
      WHERE ${where} AND status = 'final'
      ORDER BY created_at ASC
      LIMIT ${TEMPLATE_ROW_CAP[source]}`);
  return rows.map(toTemplateRow);
}

/** OT / progress: primary encounter hop; the discharged-history fallback ONLY when the
 *  primary returned nothing (constraint 16). */
async function fetchEncounterTemplates(source: 'ot_note' | 'progress_note', encounterId: string, fallback: { uhid: string | null; ipdNo: string | null } | null): Promise<TemplateFetchResult> {
  const hops = planOtProgressHops({ encounterId, fallback });
  try {
    const primary = await runHop(source, hops[0]);
    if (primary.length || hops.length < 2) return { outcome: 'ok', rows: primary };
    return { outcome: 'ok', rows: await runHop(source, hops[1]) };
  } catch {
    return { outcome: 'fetch_failed', rows: [] };
  }
}

export function fetchOtNotes(encounterId: string, fallback: { uhid: string | null; ipdNo: string | null } | null = null): Promise<TemplateFetchResult> {
  return fetchEncounterTemplates('ot_note', encounterId, fallback);
}
export function fetchProgressNotes(encounterId: string, fallback: { uhid: string | null; ipdNo: string | null } | null = null): Promise<TemplateFetchResult> {
  return fetchEncounterTemplates('progress_note', encounterId, fallback);
}

/**
 * PAC: BOTH hops always run (in parallel), union deduped by uid, capped. Any faulting hop
 * → 'fetch_failed' even when the other hop returned rows (those rows are still returned
 * for the catalog; the chip just cannot claim the look was complete).
 */
export async function fetchPacNotes(encounterId: string, uhid: string | null, window: { fromTs: string; toTs: string } | null): Promise<TemplateFetchResult> {
  const hops = planPacHops({ encounterId, uhid, window });
  const settled = await Promise.allSettled(hops.map((h) => runHop('pac_note', h)));
  const rows = dedupTemplateRows(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))).slice(0, TEMPLATE_ROW_CAP.pac_note);
  const faulted = settled.some((r) => r.status === 'rejected');
  return { outcome: faulted ? 'fetch_failed' : 'ok', rows };
}

// ── R3 — the return-stay HOSPITAL BILL (CDMSS-READMISSIONS-R3-PRD v1.0 §3.1) ──────────
//
// VALIDATED (MEASURED live on db13 via Metabase, 18 Aug 2026 — CDMSS-R3-BILL-MEASUREMENT-
// 18-AUG-2026.md): kx_billing_records.visit_id_admission_id = kx_*.encounter_id, zero
// orphaned IP rows; 98.6% of last-90-day discharges carry a bill; refund lines carry a
// NEGATIVE net_amt so plain SUM(net_amt) is already net of refunds (R3-4 — no status
// filter). `service_type` is the service category; `billing_category` is the BED CLASS and
// is deliberately not read here. The four insurer/claim tables (kx_claim_bills,
// dpipe_services, medical_ipd_claims, ipd_claims_v1) are ruled out by evidence (R3-10).
//
// PHI (R3-9, hard rule; wording per Addendum A2): kx_billing_records carries patient name /
// contact columns. The SELECT lists below name ONLY visit_id_admission_id, net_amt
// (aggregated as SUM) and — in the breakdown query only — service_type. R3-9's allow-list
// also permits amount, discount_amt and status; the queries do not need them and do not
// select them. A source-read test pins the SELECTs. Nothing else may ever be added.
//
// FAIL-SAFE (R3-6): the caller must tell "fault" from "no bill rows" — an empty Map alone
// cannot — so both readers return { ok }. ok:false = the query faulted → every card reads
// `unknown`; ok:true + id absent from the Map = looked, no rows → `bill not finalised`.
// Never a throw into a route, never ₹0 for a null. Fresh per read (R3-2): no store write.
//
//   fetchStayBillTotals (batched, VALIDATED):
//     SELECT visit_id_admission_id, SUM(net_amt) AS net, COUNT(*)::int AS lines
//       FROM kx_billing_records
//      WHERE visit_id_admission_id IN ('<id1>', '<id2>', …)
//      GROUP BY 1
//   fetchStayBillBreakdown (single stay, VALIDATED):
//     SELECT service_type, SUM(net_amt) AS net, COUNT(*)::int AS lines
//       FROM kx_billing_records
//      WHERE visit_id_admission_id = '<id>'
//      GROUP BY 1
//      ORDER BY 2 DESC NULLS LAST

/** IN-list cap — mirrors store.ts SURFACE_LIMIT (500, not exported; the store's read paths
 *  are untouched by R3, PRD §4). The list route never hands more rows than that. */
export const BILL_IDS_CAP = 500;

/** A query runner with metabaseQuery's signature — injectable so the fault path is
 *  unit-tested without a live db13. Production callers never pass it. */
export type Db13Runner = (sql: string) => Promise<Record<string, unknown>[]>;

export interface StayBillTotal { netRs: number; lines: number }
export interface StayBillTotalsResult { ok: boolean; totals: Map<string, StayBillTotal> }
export interface StayBillGroup { serviceType: string; netRs: number; lines: number }
export interface StayBillBreakdown { ok: boolean; groups: StayBillGroup[]; totalRs: number; lines: number }

/** PURE — the IN-list discipline (route.ts:70-76 pattern): dedup, drop anything that is not
 *  an encounter-id shape, cap. Exported so the test pins it. */
export function billIdList(encounterIds: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of encounterIds) {
    if (typeof raw !== 'string' || !isEncounterId(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= BILL_IDS_CAP) break;
  }
  return out;
}

/** PURE — the batched totals SQL, or null when there is nothing to ask (no query is run). */
export function stayBillTotalsSql(ids: readonly string[]): string | null {
  if (!ids.length) return null;
  return `SELECT visit_id_admission_id, SUM(net_amt) AS net, COUNT(*)::int AS lines
       FROM kx_billing_records
      WHERE visit_id_admission_id IN (${ids.map((i) => `'${esc(i)}'`).join(', ')})
      GROUP BY 1`;
}

/** PURE — the single-stay breakdown SQL, or null for an invalid id. */
export function stayBillBreakdownSql(encounterId: string): string | null {
  if (!isEncounterId(encounterId)) return null;
  return `SELECT service_type, SUM(net_amt) AS net, COUNT(*)::int AS lines
       FROM kx_billing_records
      WHERE visit_id_admission_id = '${esc(encounterId)}'
      GROUP BY 1
      ORDER BY 2 DESC NULLS LAST`;
}

const money = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};
const count = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };
/** Sums arrive exact to the paise from Postgres; a JS re-sum can carry float noise
 *  (0.1 + 0.2). Snap to paise — a currency has two decimals; this is not a rounding rule. */
const paise = (n: number): number => Math.round(n * 100) / 100;

/**
 * Batched net bill per stay (the list route). Empty input → { ok: true, empty Map } with NO
 * query. Fault → { ok: false, empty Map }. Rows whose id / sum are unusable are skipped.
 */
export async function fetchStayBillTotals(encounterIds: ReadonlyArray<string | null | undefined>, run: Db13Runner = metabaseQuery): Promise<StayBillTotalsResult> {
  const totals = new Map<string, StayBillTotal>();
  const sql = stayBillTotalsSql(billIdList(encounterIds));
  if (!sql) return { ok: true, totals };
  let rows: Record<string, unknown>[];
  try {
    rows = await run(sql);
  } catch {
    return { ok: false, totals };
  }
  for (const r of rows) {
    const id = s(r.visit_id_admission_id);
    const net = money(r.net);
    if (!id || net == null || totals.has(id)) continue;
    totals.set(id, { netRs: net, lines: count(r.lines) });
  }
  return { ok: true, totals };
}

/**
 * One stay, grouped by service_type, net desc (the case route / brief Part 2). Invalid id →
 * null (nothing to ask). Fault → { ok: false, groups: [], totalRs: 0, lines: 0 } — the
 * caller reads `ok`, never the zero. ok:true with lines 0 = looked, no bill rows yet.
 */
export async function fetchStayBillBreakdown(encounterId: string, run: Db13Runner = metabaseQuery): Promise<StayBillBreakdown | null> {
  const sql = stayBillBreakdownSql(encounterId);
  if (!sql) return null;
  let rows: Record<string, unknown>[];
  try {
    rows = await run(sql);
  } catch {
    return { ok: false, groups: [], totalRs: 0, lines: 0 };
  }
  const groups: StayBillGroup[] = [];
  for (const r of rows) {
    const net = money(r.net);
    if (net == null) continue;
    groups.push({ serviceType: s(r.service_type) ?? 'unclassified', netRs: net, lines: count(r.lines) });
  }
  return {
    ok: true,
    groups,
    totalRs: paise(groups.reduce((a, g) => a + g.netRs, 0)),
    lines: groups.reduce((a, g) => a + g.lines, 0),
  };
}

// ── R4 — the three-hop identity join, hop 2 (CDMSS-READMISSIONS-R4-PRD v1.0 §3; R4-7) ─────
//
// The pre-study (CDMSS-TWIN-PRESTUDY-OPD-READMIT-18-AUG-2026, MEASURED live) validated the path
// audit row → prescription document (`uid` = `_doc_id`, 100% on a 500-note sample) → the
// document's owner → the individual's KX UHID (94% of the readmission cohort, one-to-one).
// R4 walks it in REVERSE from the finding's UHID:
//   hop 3  resolveIndividualUid([uhid, …])  — BOTH live formats (UHID-nnnnnn / AH2526/nnnnnn),
//          exact match on kx_uhid or old_kx_uhids, re-verified in JS (above; unchanged);
//   hop 2  THIS fetch — the individual's prescription documents dated before the readmission;
//   hop 1  lib/readmission/opd-lvc.ts — the app DB's latest audit per note for those uids.
//
// VALIDATED live 18 Aug 2026 (read-only probe, this SHA): `_parent_id` resolves to
// individuals.uid on 500/500 recent prescriptions (as lib/ipd-audit/episode-opd-adapter.ts
// reads it in production); `uid = _doc_id` on 2000/2000; UUID-form legacy uids ≈ 0.14% of recent
// rows (1.7% of the readmitted cohort's notes per the pre-study) and are dropped downstream
// (priorNoteUniverse) because they are structurally unjoinable to audits.
//
//   SELECT uid, _create_time
//     FROM "individuals-prescriptions"
//    WHERE _parent_id = '<individual_uid>'
//      AND _create_time < '<readmit_admit_at>'        -- omitted when the readmit date is unknown
//    ORDER BY _create_time DESC
//    LIMIT 500
//
// PHI: two columns, neither of them identity or clinical text. Fail-safe: fault → { ok:false }
// so the caller can write `join_failed` at THIS hop rather than an empty-as-clean list.

export interface PriorNoteRow { uid: string; createdAt: string | null }
export interface PriorNotesResult { ok: boolean; notes: PriorNoteRow[] }

export function priorPrescriptionsSql(individualUid: string, beforeTs: string | null): string | null {
  if (!individualUid || !/^[A-Za-z0-9_-]{2,64}$/.test(individualUid)) return null;
  const before = beforeTs && isIsoTs(beforeTs) ? `\n      AND _create_time < '${esc(beforeTs)}'` : '';
  return `SELECT uid, _create_time
     FROM "individuals-prescriptions"
    WHERE _parent_id = '${esc(individualUid)}'${before}
    ORDER BY _create_time DESC
    LIMIT 500`;
}

export async function fetchPriorPrescriptionDocs(individualUid: string, beforeTs: string | null, run: Db13Runner = metabaseQuery): Promise<PriorNotesResult> {
  const sql = priorPrescriptionsSql(individualUid, beforeTs);
  if (!sql) return { ok: false, notes: [] };
  try {
    const rows = await run(sql);
    const notes: PriorNoteRow[] = [];
    for (const r of rows) {
      const uid = s(r.uid);
      if (!uid) continue;
      notes.push({ uid, createdAt: s(r._create_time) });
    }
    return { ok: true, notes };
  } catch {
    return { ok: false, notes: [] };
  }
}

// ── R4.1 — the refresh delta detector's EXISTENCE COUNTS (CDMSS-READMISSIONS-R4.1-PRD R41-4) ────
//
// A cheap batched look: how many FINAL template rows exist NOW, per source, for a set of stay
// encounter ids — compared by the pure detector (lib/readmission-refresh-core.ts refreshDelta)
// against the stored templateCoverage. Primary hop only (encounter_id); the R2 fallback hops
// (uhid + ipd_no; PAC uhid-window) are NOT re-walked here — a note reachable only through a
// fallback is missed by the detector, i.e. the detector is CONSERVATIVE (fewer refreshes, never a
// spurious one). Flagged in the R4.1 report.
//
// PHI: encounter_id and a count — nothing else. Fail-safe: any faulting table → { ok:false } and
// the caller reports the detector as unavailable (no finding is marked pending from a fault).
//
//   SELECT encounter_id, count(*)::int AS n FROM kx_clinical_template_ot_notes
//    WHERE encounter_id IN ('<e1>', '<e2>', …) AND status = 'final' GROUP BY 1
//   SELECT encounter_id, count(*)::int AS n FROM kx_clinical_template_pac_reports
//    WHERE encounter_id IN (…) AND status = 'final' GROUP BY 1
//   SELECT encounter_id, count(*)::int AS n FROM kx_clinical_template_progress_reports
//    WHERE encounter_id IN (…) AND status = 'final' GROUP BY 1

export interface TemplateExistence { ok: boolean; byEncounter: Map<string, { ot: number; pac: number; progress: number }> }

export function templateExistenceSql(table: string, ids: readonly string[]): string | null {
  const list = Array.from(new Set(ids.filter(isEncounterId)));
  if (!list.length) return null;
  return `SELECT encounter_id, count(*)::int AS n FROM ${table}
    WHERE encounter_id IN (${list.map((i) => `'${esc(i)}'`).join(', ')}) AND status = 'final'
    GROUP BY 1`;
}

export async function fetchTemplateExistence(encounterIds: ReadonlyArray<string | null | undefined>, run: Db13Runner = metabaseQuery): Promise<TemplateExistence> {
  const byEncounter = new Map<string, { ot: number; pac: number; progress: number }>();
  const ids = Array.from(new Set(encounterIds.filter((i): i is string => typeof i === 'string' && isEncounterId(i)))).slice(0, BILL_IDS_CAP);
  if (!ids.length) return { ok: true, byEncounter };
  const tables: Array<[keyof typeof TEMPLATE_TABLE, 'ot' | 'pac' | 'progress']> = [['ot_note', 'ot'], ['pac_note', 'pac'], ['progress_note', 'progress']];
  try {
    const results = await Promise.all(tables.map(([src]) => run(templateExistenceSql(TEMPLATE_TABLE[src], ids) as string)));
    results.forEach((rows, i) => {
      const key = tables[i][1];
      for (const r of rows) {
        const id = s(r.encounter_id);
        const n = Number(r.n);
        if (!id || !Number.isFinite(n)) continue;
        const cur = byEncounter.get(id) ?? { ot: 0, pac: 0, progress: 0 };
        cur[key] = n;
        byEncounter.set(id, cur);
      }
    });
    return { ok: true, byEncounter };
  } catch {
    return { ok: false, byEncounter: new Map() };
  }
}
