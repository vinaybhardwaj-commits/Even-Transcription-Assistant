/**
 * Reader consult_span — S7-0. eta_encounter_windows: when a consult was open in a room (t_open..t_close), and the bench windows that overlap it.
 *
 * THE FRAME (S7-0-R3, G56; no longer an assumption): bench_window.start_ms / end_ms are ABSOLUTE epoch milliseconds, the same clock as t_open / t_close, NOT offsets from
 * bench_session.started_at. Measured read-only on production by fable, 9 Oct 2026: 9,707 of 9,707 closed windows have start_ms > 1e12; closed_at lands a median 166 s after end_ms; the
 * median window is 900 s; on the 3 latest closed consults the absolute frame finds 2 / 0 / 0 overlapping windows and the session-relative frame (started_at + ms) found 0 / 0 / 0.
 * So a window overlaps a consult when w.start_ms < t_close and w.end_ms > t_open, compared directly; the session is joined only for its ROOM. (A stt_turn cue's start_ms / end_ms
 * are on the same absolute clock: lib/mcp/tools/bench.ts buildTurns puts `at` = new Date(start_ms).) pg fixtures use absolute values and a test fails if a relative frame comes back.
 * A consult with no t_close (still open) is refused (`no_data`); a consult on a held-out room-day is refused (`blind_room_day`) before its windows are looked up.
 */
import { sql } from "@/lib/db";
import { blindRefusal, refuse, type ReadResult } from "./common";
import { BLIND_ROOM_DAYS } from "../blind-room-days";

export type ConsultSpan = {
  consult_key: string; consult_uid: string | null; room_id: string; t_open_ms: number; t_close_ms: number; ist_date: string; quality: string; attribution: string;
  windows: Array<{ window_id: string; abs_start_ms: number; abs_end_ms: number }>;
};

export async function readConsultSpan(consultKey: string): Promise<ReadResult<ConsultSpan>> {
  if (!/^[A-Za-z0-9_.:@-]{1,120}$/.test(consultKey)) return refuse("bad_unit_key");
  const c = (await sql`
    SELECT consult_key, consult_uid, room_id, t_open, t_close, quality, attribution, (t_open AT TIME ZONE 'Asia/Kolkata')::date::text AS ist_date
      FROM eta_encounter_windows WHERE consult_key = ${consultKey}::text LIMIT 1
  `) as Array<{ consult_key: string; consult_uid?: string | null; room_id: string | null; t_open: string | Date; t_close: string | Date | null; quality: string; attribution: string; ist_date: string }>;
  const r = c[0];
  if (!r) return refuse("not_found", "no such consult window");
  if (!r.room_id) return refuse("no_data", "the consult window has no room");
  const blind = blindRefusal(r.room_id, r.ist_date); // the held-out set, BEFORE the windows are looked up
  if (blind) return blind;
  if (!r.t_close) return refuse("no_data", "the consult window is still open");
  const open = new Date(r.t_open).toISOString(), close = new Date(r.t_close).toISOString();
  const ws = (await sql`
    SELECT w.id AS window_id, w.start_ms AS abs_start, w.end_ms AS abs_end
      FROM bench_window w JOIN bench_session s ON s.id = w.session_id
     WHERE s.room_id = ${r.room_id}::text AND w.start_ms < ${Date.parse(close)}::bigint AND w.end_ms > ${Date.parse(open)}::bigint
     ORDER BY w.start_ms, w.id
  `) as Array<{ window_id: string; abs_start: number | string; abs_end: number | string }>;
  return {
    ok: true,
    data: { consult_key: r.consult_key, consult_uid: typeof r.consult_uid === "string" && r.consult_uid ? r.consult_uid : null, room_id: r.room_id, t_open_ms: Date.parse(open), t_close_ms: Date.parse(close), ist_date: r.ist_date, quality: r.quality, attribution: r.attribution,
      windows: ws.map((x) => ({ window_id: x.window_id, abs_start_ms: Number(x.abs_start), abs_end_ms: Number(x.abs_end) })) },
  };
}

/** Closed consult windows opened in the IST date range (and room, if given), most recent first, at most `limit`. */
export async function listConsultKeys(opts: { room?: string; from: string; to: string; limit: number }): Promise<{ keys: string[]; truncated: boolean; blind_excluded?: number }> {
  const room = opts.room ?? null;
  const days = BLIND_ROOM_DAYS.map(([d]) => d), blindRooms = BLIND_ROOM_DAYS.map(([, r]) => r);
  // GATING-G64: held-out room-days are excluded IN THE QUERY, before the LIMIT (as G52 does for windows), so a run of held-out rows cannot push real ones out or hide a truncation
  const rows = (await sql`
    SELECT consult_key FROM eta_encounter_windows
     WHERE t_close IS NOT NULL AND (t_open AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${opts.from}::date AND ${opts.to}::date
       AND (${room}::text IS NULL OR room_id = ${room}::text)
       AND NOT EXISTS (SELECT 1 FROM unnest(${days}::date[], ${blindRooms}::text[]) AS b(d, r) WHERE b.d = (t_open AT TIME ZONE 'Asia/Kolkata')::date AND b.r = room_id)
     ORDER BY t_open DESC, consult_key LIMIT ${opts.limit + 1}
  `) as Array<{ consult_key: string }>;
  const ex = (await sql`
    SELECT count(*)::int AS n FROM eta_encounter_windows
     WHERE t_close IS NOT NULL AND (t_open AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${opts.from}::date AND ${opts.to}::date
       AND (${room}::text IS NULL OR room_id = ${room}::text)
       AND EXISTS (SELECT 1 FROM unnest(${days}::date[], ${blindRooms}::text[]) AS b(d, r) WHERE b.d = (t_open AT TIME ZONE 'Asia/Kolkata')::date AND b.r = room_id)
  `) as Array<{ n: number }>;
  return { keys: rows.slice(0, opts.limit).map((r) => r.consult_key), truncated: rows.length > opts.limit, blind_excluded: Number(ex[0]?.n ?? 0) };
}
