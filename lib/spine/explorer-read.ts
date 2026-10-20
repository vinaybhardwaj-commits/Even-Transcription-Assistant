/**
 * lib/spine/explorer-read.ts — Spine S4b: the read side of the Encounter Explorer. SELECT only, spine_* tables only; no identity column exists there (D12) and none is joined.
 *   readExplorerEnabled()      spine_config `explorer`; missing, malformed, off or unreadable means off (the routes answer 404).
 *   dayView / encounterPage / encounterDetail   the three route bodies. Counts are cast to int in SQL (the Neon driver returns bigint as a string).
 * Every value is a bound parameter, each $n used once and in order. Nothing here reads a clock: `now` is passed in.
 */
import { sql } from "@/lib/db";
import { IST_FLOOR, realDate } from "@/lib/encounter-catalog/store";

type Row = Record<string, unknown>;
type Q = (text: string, params: unknown[]) => Promise<Row[]>;
const q = (): Q => sql as unknown as Q;

export const STATUSES = ["candidate", "confirmed", "rejected", "merged"] as const;
export const FLAG_COUNTS = ["ambiguous", "multi_machine", "pulse_overlap"] as const;
export const FLAGS = ["ambiguous", "multi_machine", "pulse_overlap", "clamped", "clamp_failed", "covered_by_pulse", "frozen", "enc_conflict"] as const;
export const PROXIES = ["pulse", "pqm", "acoustic", "timeline", "doctor_activity", "cutter", "caa", "nemotron_window"] as const;
export const JOB_STATUSES = ["queued", "leased", "done", "failed", "dead", "superseded", "shadow"] as const;
export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 200;
const ROOM = /^[A-Za-z0-9_.\- ]{1,96}$/;
const ENC_ID = /^enc_[a-z2-7]{16}$/;
const IST_DAY_OF = "(t_open AT TIME ZONE 'Asia/Kolkata')::date";
const ISO = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const ISO_US = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const num = (v: unknown): number => Number(v ?? 0);

// ---------------------------------------------------------------- gate
/** true, "on", "shadow", {on:true} or {mode:"on"|"shadow"}. Anything else, or no row, is off. */
export function parseExplorerOn(rows: ReadonlyArray<{ key: string; value: unknown }>): boolean {
  const r = rows.find((x) => x.key === "explorer");
  if (!r) return false;
  let v = r.value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* a bare string */ } }
  if (v && typeof v === "object") { const o = v as { on?: unknown; mode?: unknown }; return o.on === true || o.mode === "on" || o.mode === "shadow"; }
  return v === true || v === "on" || v === "shadow";
}

export async function readExplorerEnabled(): Promise<boolean> {
  try { return parseExplorerOn((await q()("SELECT key, value FROM spine_config WHERE key = 'explorer'", [])) as Array<{ key: string; value: unknown }>); } catch { return false; }
}

// ---------------------------------------------------------------- parameters
export function parseDate(v: string | null): { ok: true; date: string } | { ok: false; error: string } {
  if (!v || !realDate(v)) return { ok: false, error: "bad_ist_date" };
  return v < IST_FLOOR ? { ok: false, error: "before_floor" } : { ok: true, date: v };
}

export type DayQuery = { ist_date: string; room_id?: string };
export function parseDay(p: URLSearchParams): { ok: true; q: DayQuery } | { ok: false; error: string } {
  const d = parseDate(p.get("ist_date"));
  if (!d.ok) return d;
  const room = p.get("room_id");
  if (room && !ROOM.test(room)) return { ok: false, error: "bad_room_id" };
  return { ok: true, q: { ist_date: d.date, ...(room ? { room_id: room } : {}) } };
}

export type PageQuery = { ist_date: string; room_id?: string; status?: string; flag?: string; cursor?: [string, string]; limit: number };
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const encodeCursor = (tOpen: string, id: string): string => Buffer.from(JSON.stringify([tOpen, id])).toString("base64url");
function decodeCursor(c: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && TS.test(v[0]) && typeof v[1] === "string" && ENC_ID.test(v[1])) return [v[0], v[1]];
  } catch { /* fall through */ }
  return null;
}

export function parsePage(p: URLSearchParams): { ok: true; q: PageQuery } | { ok: false; error: string } {
  const d = parseDate(p.get("ist_date"));
  if (!d.ok) return d;
  const q: PageQuery = { ist_date: d.date, limit: DEFAULT_PAGE };
  const room = p.get("room_id");
  if (room) { if (!ROOM.test(room)) return { ok: false, error: "bad_room_id" }; q.room_id = room; }
  const status = p.get("status");
  if (status) { if (!(STATUSES as readonly string[]).includes(status)) return { ok: false, error: "bad_status" }; q.status = status; }
  const flag = p.get("flag");
  if (flag) { if (!(FLAGS as readonly string[]).includes(flag)) return { ok: false, error: "bad_flag" }; q.flag = flag; }
  const cur = p.get("cursor");
  if (cur) { const c = decodeCursor(cur); if (!c) return { ok: false, error: "bad_cursor" }; q.cursor = c; }
  const lim = p.get("limit");
  if (lim) { const n = Number(lim); if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) return { ok: false, error: "bad_limit" }; q.limit = n; }
  return { ok: true, q };
}

export const validEncounterId = (s: string): boolean => ENC_ID.test(s);

// ---------------------------------------------------------------- day
const zero = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export type JobStageCounts = Record<(typeof JOB_STATUSES)[number], number> & { oldest_queued_age_s: number | null };
export type RoomDay = {
  room_id: string | null;
  encounters: Record<(typeof STATUSES)[number], number> & { total: number };
  flags: Record<(typeof FLAG_COUNTS)[number], number>;
  signals_by_proxy: Record<(typeof PROXIES)[number], number>;
  jobs_by_stage: Record<string, JobStageCounts>;
};
const emptyRoom = (room_id: string | null): RoomDay => ({ room_id, encounters: { ...zero(STATUSES), total: 0 }, flags: zero(FLAG_COUNTS), signals_by_proxy: zero(PROXIES), jobs_by_stage: {} });

/** Pure: the three result sets -> rooms (sorted by room_id, null last). Zeros everywhere nothing was counted. */
export function foldDay(enc: Row[], sig: Row[], job: Row[], roomFilter?: string): RoomDay[] {
  const rooms = new Map<string | null, RoomDay>();
  const room = (id: unknown): RoomDay => { const k = (id as string | null) ?? null; let r = rooms.get(k); if (!r) { r = emptyRoom(k); rooms.set(k, r); } return r; };
  if (roomFilter) room(roomFilter);
  for (const e of enc) {
    const r = room(e.room_id), n = num(e.n), s = e.status as (typeof STATUSES)[number];
    if ((STATUSES as readonly string[]).includes(s)) r.encounters[s] += n;
    r.encounters.total += n;
    for (const f of FLAG_COUNTS) r.flags[f] += num(e[f]);
  }
  for (const s of sig) { const r = room(s.room_id), p = s.proxy as (typeof PROXIES)[number]; if ((PROXIES as readonly string[]).includes(p)) r.signals_by_proxy[p] += num(s.n); }
  for (const j of job) {
    const r = room(j.room_id), stage = String(j.stage);
    const c = (r.jobs_by_stage[stage] ??= { ...zero(JOB_STATUSES), oldest_queued_age_s: null });
    const st = j.status as (typeof JOB_STATUSES)[number];
    if ((JOB_STATUSES as readonly string[]).includes(st)) c[st] += num(j.n);
    if (st === "queued" && j.oldest_age_s !== null && j.oldest_age_s !== undefined) c.oldest_queued_age_s = Math.max(0, num(j.oldest_age_s));
  }
  return [...rooms.values()].sort((a, b) => (a.room_id === b.room_id ? 0 : a.room_id === null ? 1 : b.room_id === null ? -1 : a.room_id < b.room_id ? -1 : 1));
}

/** Signals count distinct source_key per proxy (a rev is the same signal again); their day is the IST date of t_open. Jobs follow their encounter's day and room. */
export async function dayView(query: DayQuery, now: number): Promise<{ ist_date: string; rooms: RoomDay[] }> {
  const room = (col: string, params: unknown[]) => { if (!query.room_id) return ""; params.push(query.room_id); return ` AND ${col} = $${params.length}`; };

  const pe: unknown[] = [query.ist_date];
  const encSql = `SELECT room_id, status, count(*)::int AS n,
    ${FLAG_COUNTS.map((f) => `(count(*) FILTER (WHERE flags @> ARRAY['${f}']::text[]))::int AS ${f}`).join(", ")}
  FROM spine_encounter WHERE ist_date = $1::date${room("room_id", pe)} GROUP BY room_id, status`;

  const ps: unknown[] = [query.ist_date];
  const sigSql = `SELECT room_id, proxy, count(DISTINCT source_key)::int AS n FROM spine_signal WHERE ${IST_DAY_OF} = $1::date${room("room_id", ps)} GROUP BY room_id, proxy`;

  const pj: unknown[] = [new Date(now).toISOString(), query.ist_date];   // $n in text order: the test drivers number placeholders by position
  const jobSql = `SELECT e.room_id, j.stage, j.status, count(*)::int AS n,
    (floor(extract(epoch FROM ($1::timestamptz - min(j.created_at))))::int) AS oldest_age_s
  FROM spine_job j JOIN spine_encounter e ON e.encounter_id = j.encounter_id
  WHERE e.ist_date = $2::date${room("e.room_id", pj)} GROUP BY e.room_id, j.stage, j.status`;

  const [enc, sig, job] = await Promise.all([q()(encSql, pe), q()(sigSql, ps), q()(jobSql, pj)]);
  return { ist_date: query.ist_date, rooms: foldDay(enc, sig, job, query.room_id) };
}

// ---------------------------------------------------------------- encounters page
const ENC_COLS = `encounter_id, to_char(ist_date, 'YYYY-MM-DD') AS ist_date, room_id, ${ISO("t_open")} AS t_open, ${ISO("t_close")} AS t_close, status, merged_into, anchor_proxy, boundary_rev, merge_version, reason, flags,
  ${ISO("created_at")} AS created_at, ${ISO("updated_at")} AS updated_at`;

export type EncounterPage = { rows: Row[]; next_cursor: string | null };
export async function encounterPage(query: PageQuery): Promise<EncounterPage> {
  const params: unknown[] = [];
  const add = (v: unknown, cast = "") => { params.push(v); return `$${params.length}${cast}`; };
  const where = [`ist_date = ${add(query.ist_date, "::date")}`];
  if (query.room_id) where.push(`room_id = ${add(query.room_id)}`);
  if (query.status) where.push(`status = ${add(query.status)}`);
  if (query.flag) where.push(`flags @> ARRAY[${add(query.flag)}]::text[]`);
  if (query.cursor) where.push(`(t_open, encounter_id) > (${add(query.cursor[0], "::timestamptz")}, ${add(query.cursor[1])})`);
  const text = `SELECT ${ENC_COLS}, ${ISO_US("t_open")} AS cursor_t FROM spine_encounter WHERE ${where.join(" AND ")} ORDER BY t_open, encounter_id LIMIT ${add(query.limit + 1, "::int")}`;
  const got = await q()(text, params);
  const more = got.length > query.limit;
  const page = got.slice(0, query.limit);
  const last = page[page.length - 1];
  const next_cursor = more && last ? encodeCursor(String(last.cursor_t), String(last.encounter_id)) : null;
  if (page.length === 0) return { rows: [], next_cursor: null };

  const ids = page.map((r) => String(r.encounter_id));
  const [prox, jobs, arts] = await Promise.all([
    q()("SELECT encounter_id, array_agg(DISTINCT proxy ORDER BY proxy) AS proxies FROM spine_signal WHERE encounter_id = ANY($1::text[]) GROUP BY encounter_id", [ids]),
    q()("SELECT DISTINCT ON (encounter_id, stage) encounter_id, stage, status FROM spine_job WHERE encounter_id = ANY($1::text[]) ORDER BY encounter_id, stage, (status = 'superseded'), job_id DESC", [ids]),
    q()("SELECT encounter_id, count(*)::int AS n FROM spine_artefact WHERE encounter_id = ANY($1::text[]) GROUP BY encounter_id", [ids]),
  ]);
  const rows = page.map((r) => {
    const id = String(r.encounter_id);
    const { cursor_t: _c, ...enc } = r;
    const p = prox.find((x) => x.encounter_id === id)?.proxies;
    return {
      ...enc,
      flags: arr(r.flags),
      proxies_seen: arr(p),
      jobs: Object.fromEntries(jobs.filter((j) => j.encounter_id === id).map((j) => [String(j.stage), String(j.status)])),
      artefact_count: num(arts.find((a) => a.encounter_id === id)?.n),
    };
  });
  return { rows, next_cursor };
}

/** A text[] as the driver may hand it back: an array, or the literal {a,b}. */
function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") { const s = v.replace(/^\{|\}$/g, ""); return s === "" ? [] : s.split(",").map((x) => x.replace(/^"|"$/g, "")); }
  return [];
}

// ---------------------------------------------------------------- one encounter
export type EncounterDetail = { encounter: Row; links: Row[]; signals: Row[]; jobs: Row[]; artefacts: Row[] };
export async function encounterDetail(id: string): Promise<EncounterDetail | null> {
  const enc = await q()(`SELECT ${ENC_COLS} FROM spine_encounter WHERE encounter_id = $1`, [id]);
  if (enc.length === 0) return null;
  const [links, signals, jobs, artefacts] = await Promise.all([
    q()("SELECT key_kind, value, basis, active FROM spine_link WHERE encounter_id = $1 ORDER BY key_kind, value", [id]),
    q()(`SELECT proxy, source_key, source_rev, ${ISO("t_open")} AS t_open, ${ISO("t_close")} AS t_close, attrs->>'close_reason' AS close_reason FROM spine_signal WHERE encounter_id = $1 ORDER BY t_open, proxy, source_key, source_rev`, [id]),
    q()(`SELECT stage, cut_version, status, attempts, ${ISO("next_attempt_at")} AS next_attempt_at, last_error_class, last_error_code FROM spine_job WHERE encounter_id = $1 ORDER BY stage, job_id`, [id]),
    q()("SELECT stage, engine, version, cut_version, store, bucket, object_key, sha256, status FROM spine_artefact WHERE encounter_id = $1 ORDER BY stage, id", [id]),
  ]);
  return { encounter: { ...enc[0], flags: arr(enc[0]!.flags) }, links, signals, jobs, artefacts };
}
