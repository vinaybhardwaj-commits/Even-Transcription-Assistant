/**
 * lib/brain/open-day.ts — D39: the day record opens itself when tape starts.
 *
 * WHY (Build 3 §2.3, backlog P7, D39, ratified 25 August). A room could be started from the desk
 * and record perfectly, yet none of its tape could be turned into words until somebody pressed
 * Mark consult in the room — because a room_day was created ONLY by a cue. On 25 August
 * bs_fudv3gqt recorded 55 minutes and 54 of them were unprocessable for want of a day record. D39
 * supersedes the 22 August rule: a recording with no day record is a bug, and the day opens
 * itself. No key stroke and no mark may stand between recorded tape and processable tape.
 *
 * THE SAME DURABLE PATH MARK CONSULT WRITES THROUGH. Mark consult's cue resolves-or-creates the
 * day with resolveRoomDay (lib/brain/state), an idempotent UNIQUE(room_id, ist_date) upsert taken
 * under Postgres's own conflict handling. This calls exactly that, so the day this opens and the
 * day a mark opens are the same row by the same rule — there is no second way to make a day.
 *
 * KEYED TO THE PIECE'S OWN IST DATE, not the session's start and not the server clock (D39). A
 * session that crosses IST midnight opens the new day's record with its first piece after
 * midnight. The caller passes the date; this function never reads a clock, so it stays honest
 * about which day it was asked to open.
 *
 * IT NEVER THROWS. Both callers run it OFF the request path — the chunk route in an after() hook,
 * the ack route in after() — and a day that failed to open is retried by the very next verified
 * chunk. A failure here must never cost a chunk, an ack, or a 500, so every error is caught and
 * returned as a value. This is also the reason it does not live in the chunk route's own reads
 * (Build 3 §4, "one failed read silences a different alarm"): it is fenced off on its own.
 *
 * THE NO-DAY ALARM STAYS. Under D39 that alarm can now only fire on a genuine bug — a room
 * recording with no day the auto-open failed to make — which is exactly what an alarm is for.
 */
import { findRoomDay, resolveRoomDay } from "@/lib/brain/state";

export type OpenDayResult = {
  ok: boolean;
  created: boolean;
  room_day_id: string | null;
  ist_date: string;
  error?: string;
};

/**
 * Resolve-or-create the room_day for (room, IST date). Idempotent: the second chunk of the day
 * finds the record and creates nothing. Never throws.
 */
export async function ensureRoomDayOpen(roomId: string, istDate: string): Promise<OpenDayResult> {
  try {
    // The read is only to report whether WE created it; resolveRoomDay is idempotent either way,
    // so a race that creates the row between this read and the upsert simply reports created:false
    // and is otherwise harmless.
    const existing = await findRoomDay(roomId, istDate);
    const day = await resolveRoomDay(roomId, istDate);
    return { ok: true, created: existing === null, room_day_id: day.id, ist_date: istDate };
  } catch (e) {
    return { ok: false, created: false, room_day_id: null, ist_date: istDate, error: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}
