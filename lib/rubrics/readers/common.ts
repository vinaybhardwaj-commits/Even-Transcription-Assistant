/**
 * lib/rubrics/readers/common.ts — S7-0: what every reader shares. READ-ONLY, bound SQL only (the tagged `sql` binds every ${value}), no write, no Pulse.
 *
 * BLIND ROOM-DAYS (S7-0-R2). The held-out evaluation set: 14 fixed (IST room-day date, room_id) pairs (lib/rubrics/blind-room-days.ts). EVERY reader refuses a pair in the set with the typed
 * reason `blind_room_day` BEFORE it fetches any data of that day; the only lookups made first are metadata ones (which room and date a window or a consult belongs to).
 */
import { sql } from "@/lib/db";
import { isBlindRoomDay } from "../blind-room-days";

export type ReadRefusal = { ok: false; reason: "blind_room_day" | "not_found" | "not_implemented" | "no_data" | "bad_unit_key"; detail?: string };
export type ReadOk<T> = { ok: true; data: T };
export type ReadResult<T> = ReadOk<T> | ReadRefusal;

export const refuse = (reason: ReadRefusal["reason"], detail?: string): ReadRefusal => ({ ok: false, reason, ...(detail ? { detail } : {}) });

/** IST (UTC+5:30, no DST) wall-clock bounds of an hour as instants. */
export function istHourBounds(istDate: string, hour: number): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${istDate}T${String(hour).padStart(2, "0")}:00:00+05:30`));
  return { start, end: new Date(start.getTime() + 3_600_000) };
}
export const isIstDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00+05:30`));
export const isRoomId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

/** The pair check every reader makes first. */
export const blindRefusal = (roomId: string, istDate: string): ReadRefusal | null =>
  isBlindRoomDay(istDate, roomId) ? refuse("blind_room_day", "held-out evaluation room-day") : null;

/** The room and IST date a room-day id stands for, or null. */
export async function roomDayOf(roomDayId: string): Promise<{ room_id: string; ist_date: string } | null> {
  const rows = (await sql`SELECT room_id, ist_date::text AS ist_date FROM room_day WHERE id = ${roomDayId}::text LIMIT 1`) as Array<{ room_id: string; ist_date: string }>;
  return rows[0] ?? null;
}

/** A room-day id -> refusal when its (date, room) is in the held-out set, else null. Unknown room-days are not_found. A metadata lookup only. */
export async function blindGuard(roomDayId: string | null): Promise<ReadRefusal | null> {
  if (!roomDayId) return refuse("not_found", "no room-day for this unit");
  const d = await roomDayOf(roomDayId);
  if (!d) return refuse("not_found", "room-day not found");
  return blindRefusal(d.room_id, d.ist_date);
}

/** The (room, IST date) a window belongs to, or the refusal why that cannot be said. A METADATA join; a failing query THROWS (never turned into a refusal). */
export async function windowPair(windowId: string): Promise<{ room_id: string; ist_date: string } | ReadRefusal> {
  const rows = (await sql`
    SELECT rd.room_id, rd.ist_date::text AS ist_date FROM bench_window w LEFT JOIN room_day rd ON rd.id = w.room_day_id WHERE w.id = ${windowId}::text LIMIT 1
  `) as Array<{ room_id: string | null; ist_date: string | null }>;
  if (!rows[0]) return refuse("not_found", "no such window");
  if (!rows[0].room_id || !rows[0].ist_date) return refuse("not_found", "the window has no room-day");
  return { room_id: rows[0].room_id, ist_date: rows[0].ist_date };
}

/** The (room, IST date of t_open) a consult window belongs to, or the refusal why that cannot be said. A metadata lookup; a failing query throws. */
export async function consultPair(consultKey: string): Promise<{ room_id: string; ist_date: string } | ReadRefusal> {
  const rows = (await sql`
    SELECT room_id, (t_open AT TIME ZONE 'Asia/Kolkata')::date::text AS ist_date FROM eta_encounter_windows WHERE consult_key = ${consultKey}::text LIMIT 1
  `) as Array<{ room_id: string | null; ist_date: string }>;
  if (!rows[0]) return refuse("not_found", "no such consult window");
  if (!rows[0].room_id) return refuse("no_data", "the consult window has no room");
  return { room_id: rows[0].room_id, ist_date: rows[0].ist_date };
}

export const isRefusal = (x: unknown): x is ReadRefusal => typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false;

/** A window id -> refusal when ITS room-day is in the held-out set (a metadata join, before any content fetch). A window with no room-day is not_found. */
export async function blindGuardWindow(windowId: string): Promise<ReadRefusal | null> {
  const pair = await windowPair(windowId);
  return isRefusal(pair) ? pair : blindRefusal(pair.room_id, pair.ist_date);
}
