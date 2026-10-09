/**
 * lib/rubrics/readers/common.ts — S7-0: what every reader shares. READ-ONLY, bound SQL only (the tagged `sql` binds every ${value}), no write, no Pulse.
 *
 * BLIND ROOM-DAYS (S7-0-R2). The held-out evaluation set: 14 fixed (IST room-day date, room_id) pairs (lib/rubrics/blind-room-days.ts). EVERY reader refuses a pair in the set with the typed
 * reason `blind_room_day` BEFORE it fetches any data of that day; the only lookups made first are metadata ones (which room and date a window or a consult belongs to).
 */
import { sql } from "@/lib/db";
import { isBlindRoomDay } from "../blind-room-days";
import { windowBlindAny } from "@/lib/voice-blind";

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
  // SWEEP (REL2-R3): every row of the key (not one picked by LIMIT 1), and every row of its consult_uid (the uid is NOT unique: one row per machine). If ANY of them is held out, that pair is returned, so the
  // caller's blindRefusal fires whatever order the rows come in.
  const rows = (await sql`
    SELECT room_id, consult_uid, (t_open AT TIME ZONE 'Asia/Kolkata')::date::text AS ist_date FROM eta_encounter_windows WHERE consult_key = ${consultKey}::text
  `) as Array<{ room_id: string | null; consult_uid?: string | null; ist_date: string }>;
  if (rows.length === 0) return refuse("not_found", "no such consult window");
  const held = rows.find((r) => r.room_id && isBlindRoomDay(r.ist_date, r.room_id));
  if (held) return { room_id: held.room_id!, ist_date: held.ist_date };
  for (const uid of new Set(rows.map((r) => r.consult_uid).filter((u): u is string => typeof u === "string" && u !== ""))) {
    const sib = await blindPairOfUid(uid);
    if (sib) return sib;
  }
  const first = rows.find((r) => r.room_id) ?? rows[0]!;
  if (!first.room_id) return refuse("no_data", "the consult window has no room");
  return { room_id: first.room_id, ist_date: first.ist_date };
}

/** consult_uid is NOT unique in eta_encounter_windows (one row per machine): the held-out pair of ANY row that carries this uid, else null. A metadata lookup. */
export async function blindPairOfUid(consultUid: string | null | undefined): Promise<{ room_id: string; ist_date: string } | null> {
  if (!consultUid) return null;
  const rows = (await sql`
    SELECT room_id, (t_open AT TIME ZONE 'Asia/Kolkata')::date::text AS ist_date FROM eta_encounter_windows WHERE consult_uid = ${consultUid}::text AND room_id IS NOT NULL
  `) as Array<{ room_id: string; ist_date: string }>;
  const held = rows.find((r) => r.room_id && r.ist_date && isBlindRoomDay(r.ist_date, r.room_id));
  return held ? { room_id: held.room_id, ist_date: held.ist_date } : null;
}

export const isRefusal = (x: unknown): x is ReadRefusal => typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false;

/** A window id -> refusal when ITS room-day is in the held-out set (a metadata join, before any content fetch). A window with no room-day is not_found. */
export async function blindGuardWindow(windowId: string): Promise<ReadRefusal | null> {
  const pair = await windowPair(windowId);
  if (isRefusal(pair)) return pair;
  const blind = blindRefusal(pair.room_id, pair.ist_date);
  if (blind) return blind;
  // SWEEP (REL2-R3): the window's OTHER placements too (room_diarize_window, and the own room-day of its turn, window-text and emotion rows)
  return (await windowBlindAny(windowId)) ? refuse("blind_room_day", "held-out evaluation room-day") : null;
}
