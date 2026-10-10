/**
 * lib/rubrics/blind-room-days.ts — S7-0-R2: the BLIND ROOM-DAYS, the held-out evaluation set. Ids and dates only (no names, no labels).
 *
 * LIFTED by V, 10 Oct 2026 (first-hand ruling, relayed by gating-lead): the set is EMPTY, so no room-day is refused or excluded. The guard functions and every call site stay and are
 * no-ops on an empty set; restoring the rule is a commit that refills BLIND_ROOM_DAYS. History: the 14 pairs came from e2e-lab ~/eta-data/drtpqma/heldout.py f672c1ef (union sha16 f07171dcb708d080).
 * `day` was the ROOM-DAY DATE as heldout.py uses it (the IST date, the same convention as room_day.ist_date).
 */
export const BLIND_ROOM_DAYS_SOURCE = { lifted: "lifted by V 10 Oct 2026", was: { heldout: "heldout.py f672c1ef", union_sha16: "f07171dcb708d080" } } as const;

/** [IST room-day date, room_id] — EMPTY since 10 Oct 2026 (lifted by V). */
export const BLIND_ROOM_DAYS: ReadonlyArray<readonly [string, string]> = [];

const KEYS: ReadonlySet<string> = new Set(BLIND_ROOM_DAYS.map(([day, room]) => `${day}|${room}`));

/** K3-3: a SCRATCH twin (room_scratch_X, the replay copy of room_X) is the same room for this rule. Literal prefixes, as lib/brain/scratch.ts (SCRATCH_ROOM_PREFIX -> ROOM_PREFIX); a test pins them. */
const SCRATCH_PREFIX = "room_scratch_";
const REAL_PREFIX = "room_";

/** Is this (IST room-day date, room id) in the held-out set? Pure; false for anything malformed. A scratch room id is mapped to its real room first (K3-3). */
export function isBlindRoomDay(day: string | null | undefined, roomId: string | null | undefined): boolean {
  if (typeof day !== "string" || typeof roomId !== "string") return false;
  const real = roomId.startsWith(SCRATCH_PREFIX) ? `${REAL_PREFIX}${roomId.slice(SCRATCH_PREFIX.length)}` : roomId;
  return KEYS.has(`${day.slice(0, 10)}|${real}`) || KEYS.has(`${day.slice(0, 10)}|${roomId}`);
}

/** The typed error a WRITER throws for a pair in the set (a reader returns the refusal object instead). */
export class BlindRoomDayError extends Error {
  readonly reason = "blind_room_day" as const;
  constructor() {
    super("blind_room_day");
    this.name = "BlindRoomDayError";
  }
}
