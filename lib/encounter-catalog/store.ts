/**
 * lib/encounter-catalog/store.ts — validate and load a batch of encounter-catalog rows (migration 0168).
 *
 * The lab box (C1, consult_ledger) and the prescription join (C3) post here. Validation is structural and refuses any key named
 * text / transcript / note / content (or text_*) at ANY depth (a code, never the value). Writes through the APP connection
 * (@/lib/db), never brain_svc. Field-level upsert: see ingest-sql.ts.
 */
import { sql } from "@/lib/db";
import { INGEST_SQL } from "./ingest-sql";

/** The catalog starts on 9 Sep 2026 (fable gate C2): an earlier ist_date is refused, whoever sends it. */
export const IST_FLOOR = "2026-09-09";
export const MAX_ROWS = 500;
export const MAX_BODY_CHARS = 4_000_000;
const MAX_JSON_FIELD_CHARS = 65_536;
const UID = /^[A-Za-z0-9_.:@-]{4,128}$/;
const DOCTOR = /^[A-Za-z0-9_.:@-]{1,128}$/;
const ROOM = /^[A-Za-z0-9_.\- ]{1,96}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GAP = /^[A-Za-z0-9_:.-]{1,120}$/;
const JSON_FIELDS = ["clip", "layers", "freescript", "stages", "allowance", "prescription"] as const;
/** 0169 (C4): presence (the lab box feed), jev and clef_affect (newcat's upsert job). Strict shapes: ids, tokens, scores and instants only. */
const C4_FIELDS = ["jev", "clef_affect", "presence"] as const;
const TOKEN = /^[A-Za-z0-9_:.-]{1,60}$/;
const SHA = /^[A-Za-z0-9]{6,128}$/;
const MAX_SETS = 50;
const MAX_LANES = 20;
const MAX_SCORES = 64;
const IDENTITY_UIDS = ["individual_uid", "prescription_uid"] as const;
const NAME_FIELDS = ["doctor_name", "patient_name"] as const;
const STATE = /^[A-Za-z0-9_:.-]{1,40}$/;
const KEYS = new Set<string>(["consult_uid", "ist_date", "doctor_uid", "room_id", "t_open", "t_close", "source", "first_gap", "catalog_version", "generated_at", "presc_state", ...IDENTITY_UIDS, ...NAME_FIELDS, ...JSON_FIELDS, ...C4_FIELDS]);
const TEXT_KEY = /^(text|transcript|note|content)(_|s?$)/i;   // text, texts, text_en, transcript, transcript_en, note, notes, content, contents ...

export type CatalogRow = Record<string, unknown>;
export type Validation = { ok: true; rows: CatalogRow[] } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when any key anywhere in the value looks like transcript text. */
export function hasTextKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasTextKey);
  if (!isObj(v)) return false;
  return Object.entries(v).some(([k, val]) => TEXT_KEY.test(k) || hasTextKey(val));
}

/** A real calendar date (YYYY-MM-DD): 2026-02-30 is not one. */
export const realDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const okMs = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 4e12;
/** A strict ISO-8601 instant Postgres will cast: YYYY-MM-DDTHH:MM:SS[.fraction](Z|+HH:MM). Date.parse alone is lenient (it accepts 2026-02-30), so the calendar date is checked too. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const okIso = (v: unknown) => typeof v === "string" && v.length <= 40 && ISO_INSTANT.test(v) && !Number.isNaN(Date.parse(v)) && realDate(v.slice(0, 10));

const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const tokOrNull = (v: unknown) => v === null || (typeof v === "string" && TOKEN.test(v));

/** jev: {sets: [{set_id, set_sha, band, label, model, at}]}. No question text, no reasons: only these keys, each a token (at: an ISO instant). */
export function validJev(v: Record<string, unknown>): boolean {
  if (!onlyKeys(v, ["sets"]) || !Array.isArray(v.sets) || v.sets.length > MAX_SETS) return false;
  return v.sets.every((s) => isObj(s) && onlyKeys(s, ["set_id", "set_sha", "band", "label", "model", "at"]) && typeof s.set_id === "string" && TOKEN.test(s.set_id) && typeof s.set_sha === "string" && SHA.test(s.set_sha)
    && tokOrNull(s.band ?? null) && tokOrNull(s.label ?? null) && typeof s.model === "string" && TOKEN.test(s.model) && okIso(s.at));
}

/** clef_affect: {lanes: [{lane, scores, model_rev, at}]}; scores = an object of token keys to finite numbers. */
export function validClef(v: Record<string, unknown>): boolean {
  if (!onlyKeys(v, ["lanes"]) || !Array.isArray(v.lanes) || v.lanes.length > MAX_LANES) return false;
  return v.lanes.every((l) => isObj(l) && onlyKeys(l, ["lane", "scores", "model_rev", "at"]) && typeof l.lane === "string" && TOKEN.test(l.lane) && isObj(l.scores)
    && Object.keys(l.scores).length <= MAX_SCORES && Object.entries(l.scores).every(([k, n]) => TOKEN.test(k) && typeof n === "number" && Number.isFinite(n))
    && typeof l.model_rev === "string" && TOKEN.test(l.model_rev) && okIso(l.at));
}

/** presence: the consult's Pulse Presence boundaries: UTC ms (or null) and two tokens (or null). No names. */
export function validPresence(v: Record<string, unknown>): boolean {
  return onlyKeys(v, ["encounter_open", "encounter_close", "boundary_source", "close_reason"])
    && (["encounter_open", "encounter_close"] as const).every((k) => v[k] === undefined || v[k] === null || okMs(v[k]))
    && (["boundary_source", "close_reason"] as const).every((k) => v[k] === undefined || tokOrNull(v[k]));
}

const C4_VALID: Record<(typeof C4_FIELDS)[number], (v: Record<string, unknown>) => boolean> = { jev: validJev, clef_affect: validClef, presence: validPresence };

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
    if ("ist_date" in r && r.ist_date !== null && (typeof r.ist_date !== "string" || !realDate(r.ist_date))) return { ok: false, error: "bad_date" };
    if (typeof r.ist_date === "string" && r.ist_date < IST_FLOOR) return { ok: false, error: "before_floor" };
    if ("doctor_uid" in r && r.doctor_uid !== null && (typeof r.doctor_uid !== "string" || !DOCTOR.test(r.doctor_uid))) return { ok: false, error: "bad_doctor_uid" };
    if ("room_id" in r && r.room_id !== null && (typeof r.room_id !== "string" || !ROOM.test(r.room_id))) return { ok: false, error: "bad_room" };
    for (const k of ["t_open", "t_close"]) if (k in r && r[k] !== null && !okMs(r[k]) && !okIso(r[k])) return { ok: false, error: "bad_time" };
    if ("source" in r && r.source !== null && r.source !== "cutter" && r.source !== "caa") return { ok: false, error: "bad_source" };
    if ("first_gap" in r && r.first_gap !== null && (typeof r.first_gap !== "string" || !GAP.test(r.first_gap))) return { ok: false, error: "bad_first_gap" };
    if ("catalog_version" in r && r.catalog_version !== null && !(Number.isInteger(r.catalog_version) && (r.catalog_version as number) >= 1 && (r.catalog_version as number) <= 1000)) return { ok: false, error: "bad_version" };
    // generated_at, when the key is present, must be a valid instant: null is refused (it would clear the column and let an older replay overwrite a newer row); omit the key instead
    if ("generated_at" in r && !okIso(r.generated_at)) return { ok: false, error: "bad_generated_at" };
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
    for (const f of C4_FIELDS) {
      if (!(f in r) || r[f] === null) continue;
      if (!isObj(r[f]) || JSON.stringify(r[f]).length > MAX_JSON_FIELD_CHARS || !C4_VALID[f](r[f] as Record<string, unknown>)) return { ok: false, error: "bad_" + f };
    }
  }
  return { ok: true, rows: rows as CatalogRow[] };
}

export type IngestResult = { updated: number; inserted: number; stale: number; retried?: boolean };

/** Thrown when, after one rerun, some rows were neither updated, inserted nor skipped as stale (two posts raced on a new consult_uid). The route answers 409 so the sender retries. */
export class ConcurrentIngestError extends Error {
  constructor(public readonly missing: number) {
    super("concurrent_insert");
  }
}

export async function ingestCatalogRows(rows: CatalogRow[]): Promise<IngestResult> {
  const q = sql as unknown as (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
  const body = JSON.stringify(rows);
  const run = async (): Promise<IngestResult> => {
    const out = await q(INGEST_SQL, [body]);
    const row = out[0] ?? {};
    return { updated: Number(row.updated ?? 0), inserted: Number(row.inserted ?? 0), stale: Number(row.stale ?? 0) };
  };
  // UPDATE then INSERT ... ON CONFLICT DO NOTHING in one statement: when another post inserts the same NEW consult_uid between the statement's snapshot and its insert, this statement does
  // neither for that row (its UPDATE did not see it, its INSERT lost). A rerun sees the committed row and updates it. Still short after one rerun: refuse (409), never a silent 200.
  let r = await run();
  if (r.updated + r.inserted + r.stale >= rows.length) return r;
  r = { ...(await run()), retried: true };
  if (r.updated + r.inserted + r.stale >= rows.length) return r;
  throw new ConcurrentIngestError(rows.length - r.updated - r.inserted - r.stale);
}
