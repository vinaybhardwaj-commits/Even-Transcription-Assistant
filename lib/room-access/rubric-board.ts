/**
 * lib/rubrics/board.ts — S7-1B: doctor / room BOARDS over stored rubric results. ADMIN ONLY (the scribe_rubric read scope), read only, no migration.
 *
 * A board is COUNTS and distributions of a rubric's closed scores per group (a doctor's opaque id, or a room), never a ranking and never a verdict on anyone: groups are sorted by their opaque id,
 * there is no per-doctor score, and the encounter_vs_record board is labelled "discrepancy report" and only counts the four severities. A group smaller than min_n shows its size only.
 * Rows: rubric_result status ok, the lab flag as asked, the IST date range; held-out (room, date) pairs and held-out room-hour keys are excluded IN SQL (counted apart) and a filter naming one is refused.
 * Doctors (by=doctor, consult units): the consult's warehouse_prescription_uid (eta_encounter_windows, bound SQL) -> p.doctor_uid, ONE read-only warehouse SELECT per board call
 * (lib/rubrics/evr/record.ts doctorsSql); an unresolved consult goes to the "unattributed" bucket, counted, never dropped. No transcript text, no evidence fetch.
 */
import { sql } from "@/lib/db";
import { BLIND_ROOM_DAYS, isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { getRubric, unitsOf } from "@/lib/rubrics/registry";
import { BOARD_MAX_UIDS, fetchDoctorsByPrescription, UID_RE } from "@/lib/rubrics/evr/record";

export const BOARD_MAX_DAYS = 92;
export const BOARD_MAX_ROWS = 5000;
export const MIN_N_DEFAULT = 5;
export const MIN_N_FLOOR = 3;
export const BOARD_NOTE_DRAFT = "not for decisions";
export const UNATTRIBUTED = "unattributed";

type Row = { unit_key: string; unit_kind: string; version: string; room_id: string; ist_date: string; score: Record<string, unknown> | null; findings: string[] };
export type BoardArgs = { rubric_id: string; from: string; to: string; by?: "doctor" | "room"; lab?: boolean; min_n?: number; room?: string | null };
export type BoardResult = { ok: true; board_meta: Record<string, unknown>; groups: Array<Record<string, unknown>> } | { ok: false; error: string; detail?: string };

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00+05:30`));
const SKIP_FIELDS = /(^label$|_key$|^prompt_version$|^attempts$|^n_|_ms$|^evidence)/;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Distributions of one group's rows. Enum / boolean fields: a count per level; arrays of strings: a count per element; numeric fields: n, median, p10, p90; findings: a count per closed code. */
export function distributions(rows: Row[]): Record<string, unknown> {
  const enums: Record<string, Record<string, number>> = {};
  const nums: Record<string, number[]> = {};
  const codes: Record<string, number> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.score ?? {})) {
      if (SKIP_FIELDS.test(k) || v === null || v === undefined) continue;
      if (typeof v === "number" && Number.isFinite(v)) (nums[k] ??= []).push(v);
      else if (typeof v === "string" || typeof v === "boolean") { const e = (enums[k] ??= {}); e[String(v)] = (e[String(v)] ?? 0) + 1; }
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) { const e = (enums[k] ??= {}); for (const x of new Set(v as string[])) e[x] = (e[x] ?? 0) + 1; }
    }
    for (const c of new Set(r.findings ?? [])) codes[c] = (codes[c] ?? 0) + 1;
  }
  const sortKeys = <T,>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const numeric: Record<string, unknown> = {};
  for (const [k, xs] of Object.entries(nums)) { const s = [...xs].sort((a, b) => a - b); numeric[k] = { n: s.length, median: r3(pct(s, 0.5)), p10: r3(pct(s, 0.1)), p90: r3(pct(s, 0.9)) }; }
  return { levels: sortKeys(enums), numeric: sortKeys(numeric), findings: sortKeys(codes) };
}

export async function buildBoard(a: BoardArgs): Promise<BoardResult> {
  const r = getRubric(a.rubric_id);
  if (!r) return { ok: false, error: "unknown_rubric" };
  const lab = a.lab === true;
  // 2. a draft / benched rubric is for the lab only: refused with ZERO queries unless lab:true
  if (r.status !== "production" && !lab) return { ok: false, error: "rubric_not_production", detail: `${r.id}@${r.version} is ${r.status}: pass lab:true (the board is then marked "${BOARD_NOTE_DRAFT}")` };
  if (!isDate(a.from) || !isDate(a.to) || a.from > a.to) return { ok: false, error: "bad_date", detail: "from / to are IST dates YYYY-MM-DD, from <= to" };
  if ((Date.parse(a.to) - Date.parse(a.from)) / 86_400_000 + 1 > BOARD_MAX_DAYS) return { ok: false, error: "range_too_long", detail: `at most ${BOARD_MAX_DAYS} days` };
  const units = unitsOf(r);
  const by = a.by ?? (r.unit === "consult" ? "doctor" : "room");
  if (by !== "doctor" && by !== "room") return { ok: false, error: "bad_args", detail: "by is doctor or room" };
  if (by === "doctor" && !units.includes("consult")) return { ok: false, error: "board_by_doctor_needs_consult" };
  const minN = Math.max(MIN_N_FLOOR, Math.trunc(Number(a.min_n)) || MIN_N_DEFAULT);
  const room = a.room && /^[A-Za-z0-9_-]{1,64}$/.test(a.room) ? a.room : null;
  // 1. a filter that names a held-out (room, date) is refused (a single day, or a one-sided range)
  if (room && a.from === a.to && isBlindRoomDay(a.from, room)) return { ok: false, error: "blind_room_day" };
  const unitKind = by === "doctor" ? "consult" : r.unit;
  const days = BLIND_ROOM_DAYS.map(([d]) => d), blindRooms = BLIND_ROOM_DAYS.map(([, x]) => x);
  const rows = (await sql`
    SELECT unit_key, unit_kind, version, room_id, ist_date::text AS ist_date, score, findings FROM rubric_result
     WHERE rubric_id = ${r.id}::text AND status = 'ok' AND lab = ${lab}::boolean AND unit_kind = ${unitKind}::text
       AND ist_date BETWEEN ${a.from}::date AND ${a.to}::date AND room_id IS NOT NULL AND (${room}::text IS NULL OR room_id = ${room}::text)
       AND NOT EXISTS (SELECT 1 FROM unnest(${days}::date[], ${blindRooms}::text[]) AS b(d, r2)
                        WHERE (b.d = rubric_result.ist_date AND b.r2 = rubric_result.room_id)
                           OR (rubric_result.unit_kind = 'room_hour' AND split_part(rubric_result.unit_key, ':', 1) = b.r2 AND split_part(rubric_result.unit_key, ':', 2) = b.d::text))
     ORDER BY version, unit_key LIMIT ${BOARD_MAX_ROWS + 1}::int
  `) as Row[];
  if (rows.length > BOARD_MAX_ROWS) return { ok: false, error: "board_too_large", detail: `more than ${BOARD_MAX_ROWS} rows: narrow the date range` };
  const blindCount = (await sql`
    SELECT count(*)::int AS n FROM rubric_result
     WHERE rubric_id = ${r.id}::text AND status = 'ok' AND lab = ${lab}::boolean AND unit_kind = ${unitKind}::text
       AND ist_date BETWEEN ${a.from}::date AND ${a.to}::date AND (${room}::text IS NULL OR room_id = ${room}::text)
       AND EXISTS (SELECT 1 FROM unnest(${days}::date[], ${blindRooms}::text[]) AS b(d, r2)
                    WHERE (b.d = rubric_result.ist_date AND b.r2 = rubric_result.room_id)
                       OR (rubric_result.unit_kind = 'room_hour' AND split_part(rubric_result.unit_key, ':', 1) = b.r2 AND split_part(rubric_result.unit_key, ':', 2) = b.d::text))
  `) as Array<{ n: number }>;

  // group key per row
  const groupOf = new Map<string, string>(); // unit_key -> doctor id (by=doctor)
  let nUnattributed = 0;
  if (by === "doctor" && rows.length > 0) {
    const keys = [...new Set(rows.map((x) => x.unit_key))];
    const w = (await sql`SELECT consult_key, warehouse_prescription_uid FROM eta_encounter_windows WHERE consult_key = ANY(${keys}::text[])`) as Array<{ consult_key: string; warehouse_prescription_uid: string | null }>;
    const presc = new Map<string, string>();
    for (const x of w) if (x.warehouse_prescription_uid && UID_RE.test(x.warehouse_prescription_uid)) presc.set(x.consult_key, x.warehouse_prescription_uid);
    const uids = [...new Set(presc.values())];
    if (uids.length > BOARD_MAX_UIDS) return { ok: false, error: "board_too_large", detail: `more than ${BOARD_MAX_UIDS} signed records: narrow the date range` };
    const doctors = uids.length > 0 ? await fetchDoctorsByPrescription(uids) : new Map<string, string>();
    for (const [ck, pu] of presc) { const d = doctors.get(pu); if (d) groupOf.set(ck, d); }
  }
  type G = { group: string; version: string; rows: Row[] };
  const groups = new Map<string, G>();
  for (const row of rows) {
    const g = by === "room" ? row.room_id : (groupOf.get(row.unit_key) ?? UNATTRIBUTED);
    if (by === "doctor" && g === UNATTRIBUTED) nUnattributed += 1;
    const k = `${row.version}\u0000${g}`;
    (groups.get(k) ?? groups.set(k, { group: g, version: row.version, rows: [] }).get(k)!).rows.push(row);
  }
  const ordered = [...groups.values()].sort((x, y) => (x.version < y.version ? -1 : x.version > y.version ? 1 : x.group < y.group ? -1 : x.group > y.group ? 1 : 0));
  const out = ordered.map((g) => {
    const base = { group: g.group, version: g.version, n_units: g.rows.length };
    if (g.group === UNATTRIBUTED) return { ...base, unattributed: true }; // counted, no distributions
    if (g.rows.length < minN) return { ...base, below_min_n: true };
    const d = distributions(g.rows) as { levels: Record<string, Record<string, number>> };
    // encounter_vs_record: the four severities are always listed (zero-filled), in a fixed alphabetical-by-key object, never ordered by severity
    if (r.id === "encounter_vs_record") { const sev = d.levels.severity ?? {}; for (const k of ["none", "minor", "material", "obvious"]) sev[k] ??= 0; d.levels.severity = Object.fromEntries(Object.entries(sev).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))); }
    return { ...base, ...d };
  });
  const isEvr = r.id === "encounter_vs_record";
  return {
    ok: true,
    board_meta: {
      rubric_id: r.id, versions: [...new Set(rows.map((x) => x.version))].sort(), lab, by, from: a.from, to: a.to, min_n: minN, n_rows: rows.length, n_unattributed: nUnattributed,
      n_blind_excluded: Number(blindCount[0]?.n ?? 0), generated_at: new Date().toISOString(),
      ...(r.status !== "production" ? { status: r.status === "benched" ? "benched" : "draft", note: BOARD_NOTE_DRAFT } : {}),
      ...(isEvr ? { label: "discrepancy report", severities: ["none", "minor", "material", "obvious"] } : {}),
    },
    groups: out,
  };
}
