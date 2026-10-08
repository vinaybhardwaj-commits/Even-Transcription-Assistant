/**
 * Reader audio_state — S7-0. room_audio_state (intervals), room_audio_day (the rollup) and bench_level_sample (mic level heartbeats) for one room and one IST hour.
 * Metadata only: states, minutes, levels. No audio, no text.
 */
import { sql } from "@/lib/db";
import { isBlindRoomDay } from "../blind-room-days";
import { blindRefusal, istHourBounds, isIstDate, isRoomId, refuse, type ReadResult } from "./common";

export type AudioInterval = { state: string; start_ms: number; end_ms: number };
export type AudioHour = {
  room_id: string; ist_date: string; hour: number; window_start_ms: number; window_end_ms: number;
  intervals: AudioInterval[];
  samples: { n: number; zero_ratio_mean: number | null; peak_max: number | null };
  day: { min_present: number; min_gated: number; min_muted: number; min_off: number; min_zero_all_day: number } | null;
};

/** unit_key `<room_id>:<ist_date>:<HH>` -> parts, or null. */
export function parseRoomHourKey(key: string): { room_id: string; ist_date: string; hour: number } | null {
  const m = /^([A-Za-z0-9_-]{1,64}):(\d{4}-\d{2}-\d{2}):(\d{2})$/.exec(key);
  if (!m || !isIstDate(m[2]) || Number(m[3]) > 23) return null;
  return { room_id: m[1]!, ist_date: m[2]!, hour: Number(m[3]) };
}
export const roomHourKey = (room_id: string, ist_date: string, hour: number): string => `${room_id}:${ist_date}:${String(hour).padStart(2, "0")}`;

export async function readAudioHour(roomId: string, istDate: string, hour: number): Promise<ReadResult<AudioHour>> {
  if (!isRoomId(roomId) || !isIstDate(istDate) || !Number.isInteger(hour) || hour < 0 || hour > 23) return refuse("bad_unit_key");
  const blind = blindRefusal(roomId, istDate); // BEFORE any fetch
  if (blind) return blind;
  const { start, end } = istHourBounds(istDate, hour);
  const iv = (await sql`
    SELECT state, ts_start, ts_end FROM room_audio_state
     WHERE room_id = ${roomId}::text AND ts_start < ${end.toISOString()}::timestamptz AND ts_end > ${start.toISOString()}::timestamptz
     ORDER BY ts_start, id
  `) as Array<{ state: string; ts_start: string | Date; ts_end: string | Date }>;
  if (iv.length === 0) return refuse("no_data", "no room_audio_state interval in this hour");
  const smp = (await sql`
    SELECT count(*)::int AS n, avg(zero_ratio)::float8 AS z, max(peak)::float8 AS pk
      FROM bench_level_sample
     WHERE room_id = ${roomId}::text AND sampled_at >= ${start.toISOString()}::timestamptz AND sampled_at < ${end.toISOString()}::timestamptz
  `) as Array<{ n: number; z: number | null; pk: number | null }>;
  const day = (await sql`
    SELECT min_present, min_gated, min_muted, min_off, min_zero_all_day FROM room_audio_day WHERE room_id = ${roomId}::text AND ist_day = ${istDate}::date LIMIT 1
  `) as Array<Record<string, number | string>>;
  return {
    ok: true,
    data: {
      room_id: roomId, ist_date: istDate, hour, window_start_ms: start.getTime(), window_end_ms: end.getTime(),
      intervals: iv.map((r) => ({ state: r.state, start_ms: new Date(r.ts_start).getTime(), end_ms: new Date(r.ts_end).getTime() })),
      samples: { n: Number(smp[0]?.n ?? 0), zero_ratio_mean: smp[0]?.z ?? null, peak_max: smp[0]?.pk ?? null },
      day: day[0] ? { min_present: Number(day[0].min_present), min_gated: Number(day[0].min_gated), min_muted: Number(day[0].min_muted), min_off: Number(day[0].min_off), min_zero_all_day: Number(day[0].min_zero_all_day) } : null,
    },
  };
}

export const AUDIO_ROWS_MAX = 20_000;

/** Every (room, hour) with at least one interval, for the rooms and the IST date range given; at most `limit` (the caller says when it was cut). */
export async function listAudioHours(opts: { rooms?: string[]; from: string; to: string; limit: number }): Promise<{ keys: string[]; truncated: boolean; blind_excluded?: number }> {
  const rooms = (opts.rooms ?? []).filter(isRoomId);
  const fromTs = istHourBounds(opts.from, 0).start.toISOString();
  const toEnd = new Date(istHourBounds(opts.to, 0).start.getTime() + 86_400_000).toISOString();
  const rows = (await sql`
    SELECT room_id, ts_start, ts_end FROM room_audio_state
     WHERE ts_start < ${toEnd}::timestamptz AND ts_end > ${fromTs}::timestamptz
       AND (${rooms.length === 0}::boolean OR room_id = ANY(${rooms}::text[]))
     ORDER BY room_id, ts_start LIMIT ${AUDIO_ROWS_MAX + 1}
  `) as Array<{ room_id: string; ts_start: string | Date; ts_end: string | Date }>;
  // GATING-S2: one row more than the cap was asked for; if it came back, the listing is cut and says so (hours past the cap are not offered, never silently)
  const rowsCut = rows.length > AUDIO_ROWS_MAX;
  if (rowsCut) rows.length = AUDIO_ROWS_MAX;
  const set = new Set<string>();
  const IST = 19_800_000;
  for (const r of rows) {
    const a = Math.max(new Date(r.ts_start).getTime(), new Date(fromTs).getTime());
    const b = Math.min(new Date(r.ts_end).getTime(), new Date(toEnd).getTime());
    for (let t = Math.floor((a + IST) / 3_600_000) * 3_600_000; t - IST < b; t += 3_600_000) {
      const ist = new Date(t);
      set.add(roomHourKey(r.room_id, ist.toISOString().slice(0, 10), ist.getUTCHours()));
    }
  }
  // held-out room-days are never offered as units
  const all = [...set].sort();
  const keys = all.filter((k) => { const p = parseRoomHourKey(k); return !(p && isBlindRoomDay(p.ist_date, p.room_id)); });
  return { keys: keys.slice(0, opts.limit), truncated: rowsCut || keys.length > opts.limit, blind_excluded: all.length - keys.length };
}
