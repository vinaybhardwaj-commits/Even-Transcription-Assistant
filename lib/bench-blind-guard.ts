/**
 * lib/bench-blind-guard.ts — the held-out room-day check for routes that start from a bench SESSION.
 * The pair is (IST date, room id), the shape lib/rubrics/blind-room-days.ts holds; the IST date is the
 * session's instant + 5:30 (no DST), the derivation lib/admin/rooms-live.ts uses. A session that ends
 * on a later IST day than it started is checked on both days. Pure: no query, no logging.
 */
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";

const IST_OFFSET_MS = 5.5 * 3_600_000;

function istDate(at: string | Date | null | undefined): string | null {
  if (at === null || at === undefined) return null;
  const ms = (at instanceof Date ? at : new Date(at)).getTime();
  return Number.isNaN(ms) ? null : new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** True when the session's (IST date, room) is in the held-out set. */
export function isBlindBenchSession(s: { room_id: string; started_at: string | Date; ended_at?: string | Date | null }): boolean {
  return [istDate(s.started_at), istDate(s.ended_at)].some((d) => d !== null && isBlindRoomDay(d, s.room_id));
}
