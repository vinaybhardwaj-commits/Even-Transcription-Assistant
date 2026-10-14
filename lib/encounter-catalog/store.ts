/**
 * lib/encounter-catalog/store.ts — validate and load a batch of encounter-catalog rows (migration 0168).
 *
 * The lab box (C1, consult_ledger) and the prescription join (C3) post here. Validation is structural and refuses any key named
 * text / transcript / note / content (or text_*) at ANY depth (a code, never the value). Writes through the APP connection
 * (@/lib/db), never brain_svc. Field-level upsert: see ingest-sql.ts.
 */
import { sql } from "@/lib/db";
import { INGEST_SQL } from "./ingest-sql";

export const MAX_ROWS = 500;
export const MAX_BODY_CHARS = 4_000_000;
const MAX_JSON_FIELD_CHARS = 65_536;
const UID = /^[A-Za-z0-9_.:@-]{4,128}$/;
const DOCTOR = /^[A-Za-z0-9_.:@-]{1,128}$/;
const ROOM = /^[A-Za-z0-9_.\- ]{1,96}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GAP = /^[A-Za-z0-9_:.-]{1,120}$/;
const JSON_FIELDS = ["clip", "layers", "freescript", "stages", "allowance", "prescription"] as const;
const IDENTITY_UIDS = ["individual_uid", "prescription_uid"] as const;
const NAME_FIELDS = ["doctor_name", "patient_name"] as const;
const STATE = /^[A-Za-z0-9_:.-]{1,40}$/;
const KEYS = new Set<string>(["consult_uid", "ist_date", "doctor_uid", "room_id", "t_open", "t_close", "source", "first_gap", "catalog_version", "generated_at", "presc_state", ...IDENTITY_UIDS, ...NAME_FIELDS, ...JSON_FIELDS]);
const TEXT_KEY = /^(text|transcript|note|content)$|^text_/i;

export type CatalogRow = Record<string, unknown>;
export type Validation = { ok: true; rows: CatalogRow[] } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when any key anywhere in the value looks like transcript text. */
export function hasTextKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasTextKey);
  if (!isObj(v)) return false;
  return Object.entries(v).some(([k, val]) => TEXT_KEY.test(k) || hasTextKey(val));
}

const okMs = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 4e12;
const okIso = (v: unknown) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

export function validateBatch(body: unknown): Validation {
  if (!isObj(body) || !Array.isArray(body.rows)) return { ok: false, error: "body_not_rows" };
  const rows = body.rows;
  if (rows.length < 1) return { ok: false, error: "empty_batch" };
  if (rows.length > MAX_ROWS) return { ok: false, error: "batch_too_large" };
  if (hasTextKey(rows)) return { ok: false, error: "text_key" };
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isObj(r)) return { ok: false, error: "row_not_object" };
    for (const k of Object.keys(r)) if (!KEYS.has(k)) return { ok: false, error: "unknown_field" };
    if (typeof r.consult_uid !== "string" || !UID.test(r.consult_uid)) return { ok: false, error: "bad_consult_uid" };
    if (seen.has(r.consult_uid)) return { ok: false, error: "duplicate_consult_uid" };
    seen.add(r.consult_uid);
    if ("ist_date" in r && r.ist_date !== null && (typeof r.ist_date !== "string" || !DATE.test(r.ist_date) || Number.isNaN(Date.parse(r.ist_date)))) return { ok: false, error: "bad_date" };
    if ("doctor_uid" in r && r.doctor_uid !== null && (typeof r.doctor_uid !== "string" || !DOCTOR.test(r.doctor_uid))) return { ok: false, error: "bad_doctor_uid" };
    if ("room_id" in r && r.room_id !== null && (typeof r.room_id !== "string" || !ROOM.test(r.room_id))) return { ok: false, error: "bad_room" };
    for (const k of ["t_open", "t_close"]) if (k in r && r[k] !== null && !okMs(r[k]) && !okIso(r[k])) return { ok: false, error: "bad_time" };
    if ("source" in r && r.source !== null && r.source !== "cutter" && r.source !== "caa") return { ok: false, error: "bad_source" };
    if ("first_gap" in r && r.first_gap !== null && (typeof r.first_gap !== "string" || !GAP.test(r.first_gap))) return { ok: false, error: "bad_first_gap" };
    if ("catalog_version" in r && r.catalog_version !== null && !(Number.isInteger(r.catalog_version) && (r.catalog_version as number) >= 1 && (r.catalog_version as number) <= 1000)) return { ok: false, error: "bad_version" };
    if ("generated_at" in r && r.generated_at !== null && !okIso(r.generated_at)) return { ok: false, error: "bad_generated_at" };
    for (const f of IDENTITY_UIDS) if (f in r && r[f] !== null && (typeof r[f] !== "string" || !DOCTOR.test(r[f] as string))) return { ok: false, error: "bad_" + f };
    if ("presc_state" in r && r.presc_state !== null && (typeof r.presc_state !== "string" || !STATE.test(r.presc_state))) return { ok: false, error: "bad_presc_state" };
    for (const f of NAME_FIELDS) {   // PHI: the value is never echoed, logged or put in an error
      if (!(f in r) || r[f] === null) continue;
      const v = r[f];
      if (typeof v !== "string" || v.trim() === "" || v.length > 200 || /[\u0000-\u001f\u007f]/.test(v)) return { ok: false, error: "bad_" + f };
    }
    for (const f of JSON_FIELDS) {
      if (!(f in r) || r[f] === null) continue;
      if (!isObj(r[f])) return { ok: false, error: "bad_" + f };
      if (JSON.stringify(r[f]).length > MAX_JSON_FIELD_CHARS) return { ok: false, error: f + "_too_large" };
    }
  }
  return { ok: true, rows: rows as CatalogRow[] };
}

export type IngestResult = { updated: number; inserted: number };

export async function ingestCatalogRows(rows: CatalogRow[]): Promise<IngestResult> {
  const q = sql as unknown as (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
  const out = await q(INGEST_SQL, [JSON.stringify(rows)]);
  const row = out[0] ?? {};
  return { updated: Number(row.updated ?? 0), inserted: Number(row.inserted ?? 0) };
}
