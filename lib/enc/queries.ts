/**
 * lib/enc/queries.ts - ENC-W2 read side: the admin pages' reads of the ENC tables.
 *
 * ASSUMES ENC-W1's schema (migration ENC-1, contract: ENC-MODULE-PRD-12-OCT-2026, "Data contract"):
 * enc_room_day, enc_isolation, steward_run, steward_item, steward_settings. The table and column names
 * are the contract's. If W1 renames anything, this file is the one place to change. Ids, times, counts
 * and flags only - no transcript text lives in these tables. Room display names are NOT read here
 * (the room table is gated to lib/room-access/); the pages join them from listRoomsOverview().
 *
 * Every read fails safe: a missing table or a DB error returns the empty value, so a page renders its
 * empty state instead of a 500 before W1's migration is applied.
 */
import { sql } from "@/lib/db";

export type EncStatus = "ok" | "warn" | "alert" | "nodata";
export type BoundarySource = "pulse" | "pqm" | "hyp" | "refined";
export type IsolationStatus = "cut" | "skipped" | "deferred" | "planned";

export type EncAlert = { code: string; message: string; count: number };

export type EncRoomDay = {
  ist_date: string;
  room_id: string;
  visits: number;
  placed: number;
  isolated: number;
  isolated_pulse: number;
  isolated_pqm: number;
  not_isolated: number;
  lane_sarvam: number;
  lane_nemotron: number;
  lane_role: number;
  lane_parts: number;
  rx_matched: number;
  tape_hours: number | null;
  status: EncStatus;
  alerts: EncAlert[];
  computed_at: string | null;
  source: string | null;
};

export type EncPart = { part: string; t0: number; t1: number; score: number | null };
export type EncRx = { matched: boolean; rx_ref: string | null; mismatch: string[] };

export type EncIsolation = {
  consult_uid: string;
  ist_date: string;
  room_id: string;
  doctor_uid: string | null;
  t_start: string;
  t_end: string;
  boundary_source: BoundarySource;
  room_source: string | null;
  confidence: number | null;
  status: IsolationStatus;
  skip_reason: string | null;
  r2_prefix: string | null;
  lanes: Record<string, boolean>;
  parts: EncPart[] | null;
  rx: EncRx | null;
  pqm_step_uid: string | null;
  updated_at: string | null;
};

export type StewardRun = {
  id: string;
  started_at: string;
  ended_at: string | null;
  mode: "advise" | "act";
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  summary_md: string | null;
  status: string;
};

export type StewardItemState = "open" | "approved" | "rejected" | "done" | "failed";
export type StewardItem = {
  id: string;
  run_id: string;
  kind: "suggestion" | "action" | "question";
  ist_date: string | null;
  room_id: string | null;
  consult_uid: string | null;
  title: string;
  body_md: string;
  proposed_action: { type: string; args?: unknown } | null;
  state: StewardItemState;
  decided_by: string | null;
  decided_at: string | null;
  result: unknown;
  created_at: string;
};

export type StewardSettings = {
  enabled: boolean;
  mode: "advise" | "act";
  daily_cap_usd: number | null;
  model_id: string | null;
};

export type RoomDayDetail = { day: EncRoomDay | null; isolations: EncIsolation[] };

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

type Raw = Record<string, unknown>;

export function mapRoomDay(r: Raw): EncRoomDay {
  return {
    ist_date: String(r.ist_date),
    room_id: String(r.room_id),
    visits: num(r.visits),
    placed: num(r.placed),
    isolated: num(r.isolated),
    isolated_pulse: num(r.isolated_pulse),
    isolated_pqm: num(r.isolated_pqm),
    not_isolated: num(r.not_isolated),
    lane_sarvam: num(r.lane_sarvam),
    lane_nemotron: num(r.lane_nemotron),
    lane_role: num(r.lane_role),
    lane_parts: num(r.lane_parts),
    rx_matched: num(r.rx_matched),
    tape_hours: numOrNull(r.tape_hours),
    status: (r.status as EncStatus) ?? "nodata",
    alerts: arr<EncAlert>(r.alerts),
    computed_at: iso(r.computed_at),
    source: strOrNull(r.source),
  };
}

export function mapIsolation(r: Raw): EncIsolation {
  const lanes = r.lanes && typeof r.lanes === "object" && !Array.isArray(r.lanes) ? (r.lanes as Record<string, boolean>) : {};
  return {
    consult_uid: String(r.consult_uid),
    ist_date: String(r.ist_date),
    room_id: String(r.room_id),
    doctor_uid: strOrNull(r.doctor_uid),
    t_start: String(iso(r.t_start)),
    t_end: String(iso(r.t_end)),
    boundary_source: r.boundary_source as BoundarySource,
    room_source: strOrNull(r.room_source),
    confidence: numOrNull(r.confidence),
    status: r.status as IsolationStatus,
    skip_reason: strOrNull(r.skip_reason),
    r2_prefix: strOrNull(r.r2_prefix),
    lanes,
    parts: Array.isArray(r.parts) ? (r.parts as EncPart[]) : null,
    rx: r.rx && typeof r.rx === "object" ? (r.rx as EncRx) : null,
    pqm_step_uid: strOrNull(r.pqm_step_uid),
    updated_at: iso(r.updated_at),
  };
}

function mapRun(r: Raw): StewardRun {
  return {
    id: String(r.id),
    started_at: String(iso(r.started_at)),
    ended_at: iso(r.ended_at),
    mode: r.mode as "advise" | "act",
    model: strOrNull(r.model),
    tokens_in: numOrNull(r.tokens_in),
    tokens_out: numOrNull(r.tokens_out),
    cost_usd: numOrNull(r.cost_usd),
    summary_md: strOrNull(r.summary_md),
    status: String(r.status),
  };
}

function mapItem(r: Raw): StewardItem {
  return {
    id: String(r.id),
    run_id: String(r.run_id),
    kind: r.kind as StewardItem["kind"],
    ist_date: strOrNull(r.ist_date),
    room_id: strOrNull(r.room_id),
    consult_uid: strOrNull(r.consult_uid),
    title: String(r.title),
    body_md: String(r.body_md ?? ""),
    proposed_action: r.proposed_action && typeof r.proposed_action === "object" ? (r.proposed_action as StewardItem["proposed_action"]) : null,
    state: r.state as StewardItemState,
    decided_by: strOrNull(r.decided_by),
    decided_at: iso(r.decided_at),
    result: r.result ?? null,
    created_at: String(iso(r.created_at)),
  };
}

/** steward_settings rows ({key, value jsonb}) to the typed settings. Pure. Unknown or missing keys fall to the safe default (disabled, advise). */
export function settingsFromRows(rows: ReadonlyArray<{ key: string; value: unknown }>): StewardSettings {
  const m = new Map(rows.map((r) => [r.key, r.value] as const));
  const cap = m.get("daily_cap_usd");
  const model = m.get("model_id");
  return {
    enabled: m.get("enabled") === true,
    mode: m.get("mode") === "act" ? "act" : "advise",
    daily_cap_usd: cap === undefined || cap === null ? null : Number(cap),
    model_id: typeof model === "string" ? model : null,
  };
}

export const DEFAULT_STEWARD_SETTINGS: StewardSettings = { enabled: false, mode: "advise", daily_cap_usd: null, model_id: null };

/** One row per room for a day (the "Daily coverage" tab). Rooms with no row are the caller's to show as no data. */
export async function getRoomDay(date: string): Promise<EncRoomDay[]> {
  try {
    const rows = (await sql`
      SELECT ist_date::text AS ist_date, room_id, visits, placed, isolated, isolated_pulse, isolated_pqm, not_isolated,
             lane_sarvam, lane_nemotron, lane_role, lane_parts, rx_matched, tape_hours, status, alerts, computed_at, source
        FROM enc_room_day
       WHERE ist_date = ${date}::date
       ORDER BY room_id ASC
    `) as Raw[];
    return rows.map(mapRoomDay);
  } catch {
    return [];
  }
}

/** One room, one day: the summary row and every isolation row, in time order. */
export async function getRoomDayDetail(roomId: string, date: string): Promise<RoomDayDetail> {
  try {
    const days = (await sql`
      SELECT ist_date::text AS ist_date, room_id, visits, placed, isolated, isolated_pulse, isolated_pqm, not_isolated,
             lane_sarvam, lane_nemotron, lane_role, lane_parts, rx_matched, tape_hours, status, alerts, computed_at, source
        FROM enc_room_day
       WHERE room_id = ${roomId}::text AND ist_date = ${date}::date
       LIMIT 1
    `) as Raw[];
    const isos = (await sql`
      SELECT consult_uid, ist_date::text AS ist_date, room_id, doctor_uid, t_start, t_end, boundary_source, room_source, confidence,
             status, skip_reason, r2_prefix, lanes, parts, rx, pqm_step_uid, updated_at
        FROM enc_isolation
       WHERE room_id = ${roomId}::text AND ist_date = ${date}::date
       ORDER BY t_start ASC
    `) as Raw[];
    return { day: days[0] ? mapRoomDay(days[0]) : null, isolations: isos.map(mapIsolation) };
  } catch {
    return { day: null, isolations: [] };
  }
}

/** The isolation row of one consult, or null (the encounter page renders nothing for null). */
export async function getIsolation(consultUid: string): Promise<EncIsolation | null> {
  try {
    const rows = (await sql`
      SELECT consult_uid, ist_date::text AS ist_date, room_id, doctor_uid, t_start, t_end, boundary_source, room_source, confidence,
             status, skip_reason, r2_prefix, lanes, parts, rx, pqm_step_uid, updated_at
        FROM enc_isolation
       WHERE consult_uid = ${consultUid}::text
       LIMIT 1
    `) as Raw[];
    return rows[0] ? mapIsolation(rows[0]) : null;
  } catch {
    return null;
  }
}

/** Steward items, newest first. `state` narrows; `limit` is clamped to 1..500. */
export async function getStewardItems(opts: { state?: StewardItemState | null; limit?: number } = {}): Promise<StewardItem[]> {
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)));
  try {
    const rows = (await sql`
      SELECT id, run_id, kind, ist_date::text AS ist_date, room_id, consult_uid, title, body_md, proposed_action, state, decided_by, decided_at, result, created_at
        FROM steward_item
       WHERE (${opts.state ?? null}::text IS NULL OR state = ${opts.state ?? null}::text)
       ORDER BY created_at DESC
       LIMIT ${limit}
    `) as Raw[];
    return rows.map(mapItem);
  } catch {
    return [];
  }
}

/** Steward runs, newest first. */
export async function getStewardRuns(limit = 30): Promise<StewardRun[]> {
  const n = Math.min(200, Math.max(1, Math.floor(limit)));
  try {
    const rows = (await sql`
      SELECT id, started_at, ended_at, mode, model, tokens_in, tokens_out, cost_usd, summary_md, status
        FROM steward_run
       ORDER BY started_at DESC
       LIMIT ${n}
    `) as Raw[];
    return rows.map(mapRun);
  } catch {
    return [];
  }
}

/** Settings, and today's spend (sum of cost_usd over runs started on the current IST calendar day). */
export async function getStewardSettings(): Promise<{ settings: StewardSettings; spend_today_usd: number }> {
  try {
    const rows = (await sql`SELECT key, value FROM steward_settings WHERE key IN ('enabled', 'mode', 'daily_cap_usd', 'model_id')`) as Array<{ key: string; value: unknown }>;
    const spend = (await sql`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spend
        FROM steward_run
       WHERE (started_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
    `) as Array<{ spend: unknown }>;
    return { settings: settingsFromRows(rows), spend_today_usd: num(spend[0]?.spend) };
  } catch {
    return { settings: DEFAULT_STEWARD_SETTINGS, spend_today_usd: 0 };
  }
}

/** The system-map lights: newest enc_room_day.computed_at and the newest steward_run (status, started_at). */
export async function getEncHealth(): Promise<{ last_computed_at: string | null; last_run_status: string | null; last_run_started_at: string | null }> {
  try {
    const a = (await sql`SELECT max(computed_at) AS t FROM enc_room_day`) as Array<{ t: unknown }>;
    const b = (await sql`SELECT status, started_at FROM steward_run ORDER BY started_at DESC LIMIT 1`) as Array<{ status: unknown; started_at: unknown }>;
    return {
      last_computed_at: iso(a[0]?.t),
      last_run_status: b[0] ? String(b[0].status) : null,
      last_run_started_at: b[0] ? iso(b[0].started_at) : null,
    };
  } catch {
    return { last_computed_at: null, last_run_status: null, last_run_started_at: null };
  }
}
