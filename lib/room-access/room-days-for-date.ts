/**
 * lib/room-access/room-days-for-date.ts — SPINE-P1: the room-days that exist for one IST date, in a stable order (room_id). Read only; no content column.
 */
import { query } from "@/lib/brain/db";

export type RoomDayRef = { id: string; room_id: string; ist_date: string };

export async function listRoomDaysForDate(istDate: string): Promise<RoomDayRef[]> {
  const r = await query<RoomDayRef>("SELECT id, room_id, ist_date::text AS ist_date FROM room_day WHERE ist_date = $1::date ORDER BY room_id, id", [istDate]);
  return r.rows;
}
