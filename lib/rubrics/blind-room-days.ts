/**
 * lib/rubrics/blind-room-days.ts — S7-0-R2: the BLIND ROOM-DAYS, the held-out evaluation set. Ids and dates only (no names, no labels).
 *
 * SOURCE: e2e-lab ~/eta-data/drtpqma/heldout.py f672c1ef, over the union with sha16 f07171dcb708d080 (copied by fable to blind-room-days.json on 09 Oct 2026).
 * The rule there: is_held_out(day, room_id) is "(day, room_id) in this set", where `day` is the ROOM-DAY DATE as heldout.py uses it (the local calendar date of the room-day: for these
 * Indian rooms the IST date, the same convention as room_day.ist_date, room_audio_day.ist_day and bench_level_sample.ist_date in this database).
 *
 * WHAT IT MEANS HERE. A rubric reader or writer never touches data of a pair in this set: it answers the typed refusal `blind_room_day` BEFORE any fetch, and nothing is written for it.
 * The set is a constant of the repository; changing it is a commit. An earlier heuristic (no present audio in room_audio_day) was a wrong reading of "blind" and is gone.
 */
export const BLIND_ROOM_DAYS_SOURCE = { heldout: "heldout.py f672c1ef", union_sha16: "f07171dcb708d080" } as const;

/** [IST room-day date, room_id] — 14 fixed pairs. */
export const BLIND_ROOM_DAYS: ReadonlyArray<readonly [string, string]> = [
  ["2026-08-23", "room_qyzghzaf"],
  ["2026-09-13", "room_ux92qpws"],
  ["2026-09-14", "room_ux92qpws"],
  ["2026-09-15", "room_qyzghzaf"],
  ["2026-09-16", "room_ux92qpws"],
  ["2026-09-18", "room_qyzghzaf"],
  ["2026-09-19", "room_ux92qpws"],
  ["2026-09-20", "room_ux92qpws"],
  ["2026-09-20", "room_qyzghzaf"],
  ["2026-09-23", "room_4ggnkg5x"],
  ["2026-09-23", "room_qyzghzaf"],
  ["2026-09-26", "room_ux92qpws"],
  ["2026-09-28", "room_ux92qpws"],
  ["2026-09-28", "room_qyzghzaf"],
];

const KEYS: ReadonlySet<string> = new Set(BLIND_ROOM_DAYS.map(([day, room]) => `${day}|${room}`));

/** Is this (IST room-day date, room id) in the held-out set? Pure; false for anything malformed. */
export function isBlindRoomDay(day: string | null | undefined, roomId: string | null | undefined): boolean {
  return typeof day === "string" && typeof roomId === "string" && KEYS.has(`${day.slice(0, 10)}|${roomId}`);
}

/** The typed error a WRITER throws for a pair in the set (a reader returns the refusal object instead). */
export class BlindRoomDayError extends Error {
  readonly reason = "blind_room_day" as const;
  constructor() {
    super("blind_room_day");
    this.name = "BlindRoomDayError";
  }
}
