/**
 * lib/rubrics/evr/record.ts — S7-2: pulse_record(consult_uid). The signed Pulse note for an encounter, read through the warehouse (Metabase db 13) with ONE SELECT, then normalised.
 *
 * READ ONLY. A SELECT, nothing else: this module holds no write statement and calls no Pulse API (a test greps it). It never calls FreeScript's parsePrescription. The uid is validated
 * against ^[A-Za-z0-9]{20,40}$ and inlined through lib/metabase.ts uidListLiteral (Metabase's endpoint takes no bound parameters), so nothing else can reach the statement.
 * Record type: EMR_2_GENERATED, non-draft (measured 9 Oct 2026; HOSPITAL_GP is NOT the type of these encounters). Selection: the record whose uid is the window's warehouse_prescription_uid;
 * else the latest uploaded_at; the number of non-draft records is reported (n_records).
 */
import { metabaseQuery, uidListLiteral } from "@/lib/metabase";
import type { AiFilled, NormRecord, RecDiagnosis, RecMed } from "./types";

export const UID_RE = /^[A-Za-z0-9]{20,40}$/;
export const RECORD_TYPE = "EMR_2_GENERATED";

type QueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;
let queryOverride: QueryFn | null = null;
/** The warehouse query function in force: the test hook, else Metabase (db 13, read only). Shared with the stay_record reader so one hook fakes both. */
export const warehouse = (): QueryFn => queryOverride ?? metabaseQuery;
/** Test hook: a fake warehouse (no network, no key). */
export function setMetabaseForTests(fn: QueryFn | null): void {
  queryOverride = fn;
}

export function recordSql(consultUid: string): string {
  if (!UID_RE.test(consultUid)) throw new Error("bad_consult_uid");
  const u = uidListLiteral([consultUid]);
  return `SELECT p.uid AS rec_uid, p.uploaded_at AS uploaded_at,
       p.general_practitioner_prescription__examination AS exam,
       p.general_practitioner_prescription__presenting_complaints AS complaints,
       p.general_practitioner_prescription__plan_of_management AS plan,
       p.general_practitioner_prescription__ai_field_metadata AS ai_meta,
       p.medications AS meds, p.further_investigation AS investigations, p.refer_to AS refer_to, p.structured_general_advice AS advice,
       p.followup__followup_date AS fu_date, p.followup__followup_type AS fu_type, p.next_follow_up_date AS fu_next, p.followup__follow_up_instructions AS fu_instructions
  FROM "individuals-prescriptions" p
 WHERE p.consult_uid IN (${u}) AND p.type = '${RECORD_TYPE}' AND p.is_draft = false
 ORDER BY p.uploaded_at DESC
 LIMIT 10`;
}

const asJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t || (t[0] !== "[" && t[0] !== "{")) return v;
  try { return JSON.parse(t); } catch { return v; }
};
const arr = (v: unknown): Array<Record<string, unknown>> => {
  const j = asJson(v);
  return Array.isArray(j) ? j.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const aiOf = (meta: unknown, key: string): boolean | null => {
  const m = asJson(meta) as Record<string, unknown> | null;
  const f = m && typeof m === "object" ? (m[key] as Record<string, unknown> | undefined) : undefined;
  return f && typeof f === "object" ? bool(f.ai_filled) : null;
};
function combine(flags: Array<boolean | null>): AiFilled {
  if (flags.length === 0 || flags.every((f) => f === null)) return "unknown";
  if (flags.some((f) => f === true)) return true;
  return flags.every((f) => f === false) ? false : "unknown";
}

/** One warehouse row -> the normalised record. Pure. */
export function normaliseRecord(row: Record<string, unknown>): NormRecord {
  const complaintsRaw = arr(row.complaints);
  const planRaw = arr(row.plan);
  const diagnoses: RecDiagnosis[] = [];
  const diagAi: Array<boolean | null> = [];
  for (const c of complaintsRaw) {
    const symAi = aiOf(c.ai_field_metadata, "symptoms");
    for (const d of arr(c.diagnoses)) {
      const name = str(d.diagnosis_or_impression);
      if (!name) continue;
      diagnoses.push({ name, differential: d.is_differential_diagnosis === true, location_notes: str(d.location_or_notes) });
      diagAi.push(symAi);
    }
  }
  const procedures: Array<{ name: string }> = [];
  const procAi: Array<boolean | null> = [];
  for (const p of planRaw) {
    if (p.requires_surgery_or_procedure === true) {
      const name = str(p.surgery_or_procedure_recommendation);
      if (name) { procedures.push({ name }); procAi.push(aiOf(p.ai_field_metadata, "requires_surgery_or_procedure")); }
    }
  }
  const meds: RecMed[] = arr(row.meds).map((m) => ({
    name: str(m.generic_name) || str(m.brand_name), alt_name: str(m.brand_name) && str(m.generic_name) ? str(m.brand_name) : "",
    dose: [str(m.strength), str(m.dosage)].filter(Boolean).join(" "), freq: str(m.frequency), route: str(m.route_of_administration), duration: str(m.duration), side: "",
  })).filter((m) => m.name);
  return {
    complaints: complaintsRaw.map((c) => str(c.symptoms)).filter(Boolean),
    exam: str(row.exam),
    diagnoses,
    meds,
    investigations: arr(row.investigations).map((i) => str(i.investigation)).filter(Boolean),
    procedures,
    advice: arr(row.advice).map((a) => str(a.general_advice)).filter(Boolean).join("; "),
    followup: [str(row.fu_type), str(row.fu_instructions), str(row.fu_date), str(row.fu_next)].filter(Boolean).join("; "),
    refer_to: arr(row.refer_to).map((r) => str(r.specialist_type)).filter(Boolean),
    ai: { exam: combine([aiOf(row.ai_meta, "examination")]), complaints: combine(complaintsRaw.map((c) => aiOf(c.ai_field_metadata, "symptoms"))), diagnoses: combine(diagAi), procedures: combine(procAi), /* R8: Pulse carries NO ai_field_metadata for medications or investigations (measured 9 Oct 2026), so their provenance is "unknown" and is never invented here; a drug finding is therefore never AI-capped */ meds: "unknown", investigations: "unknown" },
  };
}

export type PulseRecordResult =
  | { ok: true; record: NormRecord; rec_uid: string; n_records: number; chosen: "window_uid" | "latest" }
  | { ok: false; reason: "bad_consult_uid" | "no_record" | "warehouse_unavailable" };

/** Fetch and normalise. A warehouse outage is a THROWN error (the step is retried); a missing record is a typed reason. */
export async function fetchPulseRecord(consultUid: string, preferRecUid: string | null): Promise<PulseRecordResult> {
  if (!UID_RE.test(consultUid)) return { ok: false, reason: "bad_consult_uid" };
  const q = queryOverride ?? metabaseQuery;
  const rows = await q(recordSql(consultUid));
  if (rows.length === 0) return { ok: false, reason: "no_record" };
  const pick = preferRecUid ? rows.find((r) => r.rec_uid === preferRecUid) : undefined;
  const row = pick ?? rows[0]!; // rows are ORDER BY uploaded_at DESC: the first is the latest
  return { ok: true, record: normaliseRecord(row), rec_uid: String(row.rec_uid ?? ""), n_records: rows.length, chosen: pick ? "window_uid" : "latest" };
}

/**
 * S7-1B — the signed record's doctor id for many prescriptions, in ONE read-only SELECT (Metabase db 13). Column p.doctor_uid on "individuals-prescriptions": the same column
 * lib/encounter-windows/warehouse-attribution.ts already reads (NOT inferred). Every uid is validated against UID_RE and inlined through uidListLiteral; EMR_2_GENERATED, non-draft. Returns
 * prescription uid -> doctor uid (opaque ids only; no name is selected). A prescription the warehouse does not return is simply absent from the map.
 */
export const BOARD_MAX_UIDS = 1500;
export function doctorsSql(prescriptionUids: readonly string[]): string {
  if (prescriptionUids.length === 0 || prescriptionUids.length > BOARD_MAX_UIDS) throw new Error("bad_uid_count");
  for (const u of prescriptionUids) if (!UID_RE.test(u)) throw new Error("bad_prescription_uid");
  return `SELECT p.uid AS rec_uid, p.doctor_uid AS doctor_uid
  FROM "individuals-prescriptions" p
 WHERE p.uid IN (${uidListLiteral(prescriptionUids)}) AND p.type = '${RECORD_TYPE}' AND p.is_draft = false`;
}
export async function fetchDoctorsByPrescription(prescriptionUids: readonly string[]): Promise<Map<string, string>> {
  const q = queryOverride ?? metabaseQuery;
  const rows = await q(doctorsSql([...new Set(prescriptionUids)]));
  const out = new Map<string, string>();
  for (const r of rows) if (typeof r.rec_uid === "string" && typeof r.doctor_uid === "string" && r.doctor_uid) out.set(r.rec_uid, r.doctor_uid);
  return out;
}
