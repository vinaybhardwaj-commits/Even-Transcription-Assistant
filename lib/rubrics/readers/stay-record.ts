/**
 * Reader stay_record — S7-3: one surgical STAY from the warehouse (Metabase db 13, READ ONLY, through lib/rubrics/evr/record.ts `warehouse()`), for the ehrc_surgical_outcome rubric.
 *
 * KEY. The stay is kx_ip_admissions.uid; the unit key is "stay:<uid>" (uid validated like record.ts: ^[A-Za-z0-9]{20,40}$, then inlined through uidListLiteral: Metabase takes no bound parameters).
 * JOINS (verified by GATING counts, #10518 / #10543 / #10544 / #10569): OT notes ON o.encounter_id = a.encounter_id; cdmss_discharge_extracts ON c.encounter_id = a.encounter_id; the discharge summary
 * ON d.ipd_no = a.identifier; the patient bridge a.uhid = individuals.kx_uhid -> individuals.uid = "individuals-prescriptions"._parent_doc_id. member_uid is NOT a bridge.
 * PHI RULE (hard): no name, mobile, telecom, address, kin, birth date, policy, payer or MLC column is ever selected. uhid and kx_uhid appear ONLY inside a JOIN condition, never in a SELECT list; the ipd
 * number (a.identifier) is likewise used only to join. No output field carries any of them (a test reads the SQL text and the output).
 * BATCHING. Five SELECTs per batch of at most 40 stays (admissions, theatre, discharge, cdmss, follow-up), never one per stay. withStayBatch(uids, fn) runs them once and lets readStayRecord answer from
 * that batch; a stay outside the batch is fetched as a batch of one.
 * The post-discharge care-manager questions are NOT read (care_manager_completed_tasks.entries is opaque): cm_questions is the constant "not_read".
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { uidListLiteral } from "@/lib/metabase";
import { normaliseRecord, RECORD_TYPE, warehouse } from "../evr/record";
import type { NormRecord } from "../evr/types";
import { refuse, type ReadResult } from "./common";

export const STAY_UID_RE = /^[A-Za-z0-9]{20,40}$/;
export const STAY_BATCH_MAX = 40;
export const FOLLOW_UP_DAYS_MAX = 60;
export const STAY_TEXT_MAX = 8_000;

export type StayRecord = {
  stay_uid: string;
  admission: { admitted_at: string | null; ist_date: string | null; admission_type: string | null; department: string | null; encounter_id: string | null };
  theatre: Array<{ surgery_name: string; template_name: string; created_at: string | null; note: string }>;
  discharge: { discharged_at: string | null; discharge_type: string | null } | null;
  cdmss: { procedure: string; diagnosis: string; indication: string; course_summary: string; disposition: string; follow_up: string; aftercare_instructions: string; aftercare_warning_signs: string } | null;
  follow_up: Array<{ rec_uid: string; uploaded_at: string; record: NormRecord }>;
  /** the care-manager post-discharge questions are not read in this slice */
  cm_questions: "not_read";
};

/** "stay:<uid>" -> the uid, or null. */
export function parseStayKey(key: string): string | null {
  const m = /^stay:([A-Za-z0-9]{20,40})$/.exec(key);
  return m ? m[1]! : null;
}

// ---- the SQL (one per table per batch; uids are validated and inlined) -------------------------------------------------------------------------------------------------------------------

export function admissionsSql(uids: readonly string[]): string {
  return `SELECT a.uid AS stay_uid, a.admission_date_time AS admitted_at, a.admission_type AS admission_type, a.treating_department_name AS department, a.encounter_id AS encounter_id
  FROM kx_ip_admissions a
 WHERE a.uid IN (${uidListLiteral(uids)})`;
}
export function theatreSql(uids: readonly string[]): string {
  return `SELECT a.uid AS stay_uid, o.surgery_name AS surgery_name, o.template_name AS template_name, o.created_at AS created_at, o.note AS note
  FROM kx_ip_admissions a
  JOIN kx_clinical_template_ot_notes o ON o.encounter_id = a.encounter_id
 WHERE a.uid IN (${uidListLiteral(uids)})
 ORDER BY a.uid, o.created_at
 LIMIT 400`;
}
export function dischargeSql(uids: readonly string[]): string {
  return `SELECT a.uid AS stay_uid, d.discharge_date_time AS discharged_at, d.discharge_type AS discharge_type
  FROM kx_ip_admissions a
  JOIN kx_discharge_summary_records d ON d.ipd_no = a.identifier
 WHERE a.uid IN (${uidListLiteral(uids)})
 ORDER BY a.uid, d.discharge_date_time DESC
 LIMIT 200`;
}
export function cdmssSql(uids: readonly string[]): string {
  return `SELECT a.uid AS stay_uid, c.extracted__procedure AS procedure_text, c.extracted__diagnosis AS diagnosis_text, c.extracted__indication AS indication_text, c.extracted__course_summary AS course_summary,
       c.extracted__disposition AS disposition_text, c.extracted__follow_up AS follow_up_text, c.extracted__aftercare__instructions AS aftercare_instructions, c.extracted__aftercare__warning_signs AS aftercare_warning_signs
  FROM kx_ip_admissions a
  JOIN cdmss_discharge_extracts c ON c.encounter_id = a.encounter_id
 WHERE a.uid IN (${uidListLiteral(uids)})
 LIMIT 200`;
}
export function followUpSql(uids: readonly string[]): string {
  return `SELECT a.uid AS stay_uid, p.uid AS rec_uid, p.uploaded_at AS uploaded_at,
       p.general_practitioner_prescription__examination AS exam,
       p.general_practitioner_prescription__presenting_complaints AS complaints,
       p.general_practitioner_prescription__plan_of_management AS plan,
       p.general_practitioner_prescription__ai_field_metadata AS ai_meta,
       p.medications AS meds, p.further_investigation AS investigations, p.refer_to AS refer_to, p.structured_general_advice AS advice,
       p.followup__followup_date AS fu_date, p.followup__followup_type AS fu_type, p.next_follow_up_date AS fu_next, p.followup__follow_up_instructions AS fu_instructions
  FROM kx_ip_admissions a
  JOIN kx_discharge_summary_records d ON d.ipd_no = a.identifier
  JOIN individuals i ON i.kx_uhid = a.uhid
  JOIN "individuals-prescriptions" p ON p._parent_doc_id = i.uid
 WHERE a.uid IN (${uidListLiteral(uids)}) AND p.type = '${RECORD_TYPE}' AND p.is_draft = false
   AND p.uploaded_at > d.discharge_date_time AND p.uploaded_at <= d.discharge_date_time + interval '${FOLLOW_UP_DAYS_MAX} days'
 ORDER BY a.uid, p.uploaded_at
 LIMIT 1000`;
}

// ---- assembling --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const str = (v: unknown, max = STAY_TEXT_MAX): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : v instanceof Date ? v.toISOString() : null);
export const istDateOfInstant = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : v instanceof Date ? v.getTime() : NaN;
  return Number.isFinite(t) ? new Date(t + 19_800_000).toISOString().slice(0, 10) : null;
};

export type StayBatch = Map<string, StayRecord | null>;

/** The five batched SELECTs for up to STAY_BATCH_MAX stays. A uid the warehouse does not know maps to null. A warehouse failure THROWS (the step is retried). */
export async function fetchStayBatch(uids: readonly string[]): Promise<StayBatch> {
  const ids = [...new Set(uids)].filter((u) => STAY_UID_RE.test(u)).slice(0, STAY_BATCH_MAX);
  const out: StayBatch = new Map();
  if (ids.length === 0) return out;
  const q = warehouse();
  const adm = await q(admissionsSql(ids));
  const ot = await q(theatreSql(ids));
  const dis = await q(dischargeSql(ids));
  const cd = await q(cdmssSql(ids));
  const fu = await q(followUpSql(ids));
  const by = (rows: Row[]): Map<string, Row[]> => {
    const m = new Map<string, Row[]>();
    for (const r of rows) { const k = String(r.stay_uid ?? ""); if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    return m;
  };
  const aBy = by(adm), oBy = by(ot), dBy = by(dis), cBy = by(cd), fBy = by(fu);
  for (const id of ids) {
    const a = aBy.get(id)?.[0];
    if (!a) { out.set(id, null); continue; }
    const d = dBy.get(id)?.[0];
    const c = cBy.get(id)?.[0];
    const seen = new Set<string>();
    out.set(id, {
      stay_uid: id,
      admission: { admitted_at: strOrNull(a.admitted_at), ist_date: istDateOfInstant(a.admitted_at), admission_type: strOrNull(a.admission_type), department: strOrNull(a.department), encounter_id: strOrNull(a.encounter_id) },
      theatre: (oBy.get(id) ?? []).map((o) => ({ surgery_name: str(o.surgery_name, 300), template_name: str(o.template_name, 300), created_at: strOrNull(o.created_at), note: str(o.note) })),
      discharge: d ? { discharged_at: strOrNull(d.discharged_at), discharge_type: strOrNull(d.discharge_type) } : null,
      cdmss: c ? { procedure: str(c.procedure_text), diagnosis: str(c.diagnosis_text), indication: str(c.indication_text), course_summary: str(c.course_summary), disposition: str(c.disposition_text), follow_up: str(c.follow_up_text), aftercare_instructions: str(c.aftercare_instructions), aftercare_warning_signs: str(c.aftercare_warning_signs) } : null,
      follow_up: (fBy.get(id) ?? []).filter((r) => { const k = String(r.rec_uid ?? ""); if (!k || seen.has(k)) return false; seen.add(k); return true; })
        .map((r) => ({ rec_uid: String(r.rec_uid), uploaded_at: strOrNull(r.uploaded_at) ?? "", record: normaliseRecord(r) })),
      cm_questions: "not_read",
    });
  }
  return out;
}

const store = new AsyncLocalStorage<StayBatch>();
/** Run fn with one batched read of these stays (at most 40) behind readStayRecord. The read happens once, before fn. */
export async function withStayBatch<T>(uids: readonly string[], fn: () => Promise<T>): Promise<T> {
  const batch = await fetchStayBatch(uids);
  return store.run(batch, fn);
}

export async function readStayRecord(stayKey: string): Promise<ReadResult<StayRecord>> {
  const uid = parseStayKey(stayKey);
  if (!uid) return refuse("bad_unit_key");
  let batch = store.getStore();
  if (!batch || !batch.has(uid)) batch = await fetchStayBatch([uid]);
  const got = batch.get(uid);
  return got ? { ok: true, data: got } : refuse("not_found", "no such stay");
}

/** Admitted stays (IST dates, inclusive) that have a theatre note, oldest first: for a from/to run. One SELECT. */
export function surgicalStaysSql(from: string, to: string, limit: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("bad_date");
  const lim = Math.max(1, Math.min(51, Math.trunc(limit)));
  return `SELECT a.uid AS stay_uid
  FROM kx_ip_admissions a
 WHERE a.admission_date_time >= '${from}T00:00:00+05:30'::timestamptz AND a.admission_date_time < '${to}T00:00:00+05:30'::timestamptz + interval '1 day'
   AND EXISTS (SELECT 1 FROM kx_clinical_template_ot_notes o WHERE o.encounter_id = a.encounter_id)
 ORDER BY a.admission_date_time, a.uid
 LIMIT ${lim}`;
}
export async function listSurgicalStays(from: string, to: string, limit: number): Promise<{ keys: string[]; truncated: boolean }> {
  const rows = await warehouse()(surgicalStaysSql(from, to, limit + 1));
  const uids = rows.map((r) => String(r.stay_uid ?? "")).filter((u) => STAY_UID_RE.test(u));
  return { keys: uids.slice(0, limit).map((u) => `stay:${u}`), truncated: uids.length > limit };
}
