/**
 * The 14 (IST date, room_id) pairs that were the held-out set until V lifted the rule on 10 Oct 2026.
 * lib/rubrics/blind-room-days.ts is EMPTY now; tests use these as ordinary, formerly-blind days and assert they are SERVED / PROCESSED
 * like any clean day. Test data only: nothing in lib/ or app/ imports this file.
 */
export const FORMER_BLIND_PAIRS: ReadonlyArray<readonly [string, string]> = [
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
