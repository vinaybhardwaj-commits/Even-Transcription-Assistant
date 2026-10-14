/**
 * lib/encounter-catalog/search.ts — parameters, SQL and cursor for GET /api/encounter-catalog/search (migration 0168).
 *
 * Admin-only route (see the route): every row carries the identity columns (PHI: doctor_name, patient_name, individual_uid, prescription_uid, presc_state) and the prescription jsonb.
 * Filters: doctor_uid, from / to (ist_date, inclusive, YYYY-MM-DD), room (room_id), has_prescription (true|false), cursor, limit (1..500, default 100).
 * Newest first, keyset paged on (ist_date, consult_uid). Returns the rows as stored (ids, times, keys, states, counts: no text exists).
 */
import { sql } from "@/lib/db";
import { realDate } from "./store";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOCTOR = /^[A-Za-z0-9_.:@-]{1,128}$/;
const ROOM = /^[A-Za-z0-9_.\- ]{1,96}$/;
const UID = /^[A-Za-z0-9_.:@-]{4,128}$/;
const NO_DATE = "0001-01-01";

export type SearchQuery = { prescription_uid?: string; individual_uid?: string; doctor_uid?: string; from?: string; to?: string; room?: string; has_prescription?: boolean; cursor?: [string, string]; limit: number };
export type Parsed = { ok: true; q: SearchQuery } | { ok: false; error: string };

export const encodeCursor = (date: string | null, uid: string): string => Buffer.from(JSON.stringify([date ?? NO_DATE, uid])).toString("base64url");

function decodeCursor(c: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && DATE.test(v[0]) && typeof v[1] === "string" && UID.test(v[1])) return [v[0], v[1]];
  } catch { /* fall through */ }
  return null;
}


export function parseSearch(p: URLSearchParams): Parsed {
  const q: SearchQuery = { limit: DEFAULT_LIMIT };
  const doctor = p.get("doctor_uid");
  if (doctor) { if (!DOCTOR.test(doctor)) return { ok: false, error: "bad_doctor_uid" }; q.doctor_uid = doctor; }
  for (const k of ["from", "to"] as const) {
    const v = p.get(k);
    if (v) { if (!realDate(v)) return { ok: false, error: "bad_" + k }; q[k] = v; }
  }
  for (const k of ["prescription_uid", "individual_uid"] as const) {
    const v = p.get(k);
    if (v) { if (!DOCTOR.test(v)) return { ok: false, error: "bad_" + k }; q[k] = v; }
  }
  const room = p.get("room");
  if (room) { if (!ROOM.test(room)) return { ok: false, error: "bad_room" }; q.room = room; }
  const hp = p.get("has_prescription");
  if (hp !== null && hp !== "") {
    if (hp !== "true" && hp !== "false") return { ok: false, error: "bad_has_prescription" };
    q.has_prescription = hp === "true";
  }
  const cur = p.get("cursor");
  if (cur) { const d = decodeCursor(cur); if (!d) return { ok: false, error: "bad_cursor" }; q.cursor = d; }
  const lim = p.get("limit");
  if (lim) {
    const n = Number(lim);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { ok: false, error: "bad_limit" };
    q.limit = n;
  }
  return { ok: true, q };
}

const ISO = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** -> [sql text, params]; every value is a bound parameter, each $n used once and in order. */
export const IDENTITY_COLUMNS = "doctor_name, patient_name, individual_uid, prescription_uid, presc_state";

export function buildSearch(q: SearchQuery): [string, unknown[]] {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (v: unknown, cast = "") => { params.push(v); return `$${params.length}${cast}`; };
  if (q.doctor_uid) where.push(`doctor_uid = ${add(q.doctor_uid)}`);
  if (q.from) where.push(`ist_date >= ${add(q.from, "::date")}`);
  if (q.to) where.push(`ist_date <= ${add(q.to, "::date")}`);
  if (q.room) where.push(`room_id = ${add(q.room)}`);
  if (q.prescription_uid) where.push(`prescription_uid = ${add(q.prescription_uid)}`);
  if (q.individual_uid) where.push(`individual_uid = ${add(q.individual_uid)}`);
  if (q.has_prescription === true) where.push("(prescription IS NOT NULL OR prescription_uid IS NOT NULL)");
  if (q.has_prescription === false) where.push("(prescription IS NULL AND prescription_uid IS NULL)");
  if (q.cursor) where.push(`(COALESCE(ist_date, DATE '${NO_DATE}'), consult_uid) < (${add(q.cursor[0], "::date")}, ${add(q.cursor[1])})`);
  const limit = add(q.limit + 1, "::integer");
  const text = `SELECT consult_uid, to_char(ist_date, 'YYYY-MM-DD') AS ist_date, doctor_uid, room_id, ${ISO("t_open")} AS t_open, ${ISO("t_close")} AS t_close, source, clip, layers, freescript,
       stages, first_gap, allowance, prescription, ${IDENTITY_COLUMNS}, catalog_version, ${ISO("generated_at")} AS generated_at, ${ISO("updated_at")} AS updated_at
  FROM encounter_catalog${where.length ? "\n WHERE " + where.join(" AND ") : ""}
 ORDER BY COALESCE(ist_date, DATE '${NO_DATE}') DESC, consult_uid DESC
 LIMIT ${limit}`;
  return [text, params];
}

export type SearchResult = { rows: Array<Record<string, unknown>>; next_cursor: string | null };

export async function searchCatalog(q: SearchQuery): Promise<SearchResult> {
  const run = sql as unknown as (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
  const [text, params] = buildSearch(q);
  const got = await run(text, params);
  const more = got.length > q.limit;
  const rows = more ? got.slice(0, q.limit) : got;
  const last = rows[rows.length - 1];
  return { rows, next_cursor: more && last ? encodeCursor((last.ist_date as string | null) ?? null, String(last.consult_uid)) : null };
}
