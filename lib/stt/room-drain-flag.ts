/**
 * lib/stt/room-drain-flag.ts — ROOM_STT_DRAIN_ENABLED (K4b A1).
 *
 * The switch that lets a room's tape be sent to a paid speech-to-text engine. Monday 24 August
 * is a live OPD recording day, so the property this file exists to make unmissable is the same
 * one FUSE_LIVE_ENABLED makes unmissable: OFF FOR EVERY CLINIC ROOM, and off is the default.
 *
 * This is deliberately a COPY of lib/brain/fuse/live-flag.ts's shape rather than a shared
 * abstraction. The two flags guard different blast radii and will be turned on and off at
 * different times by different people; a shared parser would invite a shared env var, and the
 * one thing neither flag may ever do is switch the other on.
 *
 * ─── WHY IT IS PER-ROOM AND NOT A BOOLEAN ────────────────────────────────────────────────
 * A global `ROOM_STT_DRAIN_ENABLED=1` would mean that switching the drain on to test it in Home
 * Office switches it on for OPD 7 at the same instant, on the same deploy, with no second step.
 * Worse than the fuse's version of that mistake: this flag spends money and ships room audio to
 * a third party. So the flag holds a LIST OF ROOM IDS, and a room not in the list is off.
 *
 * ─── WHY "1", "true" AND "*" ENABLE NOTHING ──────────────────────────────────────────────
 * Those are what a person types when they are thinking of a boolean, and they are exactly the
 * inputs that would silently turn the drain on everywhere. They are REFUSED BY NAME rather than
 * parsed as room ids or treated as wildcards: `isRoomDrainEnabled` returns false for every room
 * and `roomDrainFlagState()` reports the value as a misconfiguration, so the mistake shows up as
 * "nothing happened, and here is why" instead of as a clinic day being sent to Sarvam. There is
 * deliberately NO wildcard. Enabling a room requires naming it.
 *
 * ─── READ AT THE POINT OF USE ────────────────────────────────────────────────────────────
 * process.env is read inside the function on EVERY call — never captured in a module-scope
 * const. A module-scope read is evaluated once per lambda instance, so flipping the flag off in
 * an incident would leave warm instances still draining until they happened to recycle.
 *
 * ─── HAZARD: EVERY CALL SITE THIS FLAG GUARDS ────────────────────────────────────────────
 * VERIFIED BY GREP, not by memory. `git grep -n "isRoomDrainEnabled" -- ':!docs' ':!tests'`
 * must return exactly these, and tests/unit/room-drain-flag.test.ts fails the build if it does
 * not:
 *
 * THREE GUARDS:
 *   1. lib/bench-window.ts, evaluateAndWriteWindows — at the open→closed transition, BEFORE
 *      enqueueSubject is reached. THE ONLY PRODUCTION ENTRY: nothing else enqueues room work.
 *   2. lib/stt/room-drain.ts, drainRoomWindow — checked again on entry, so the runner is safe
 *      to call directly and cannot be reached with the flag off by a future caller.
 *   3. lib/stt/room-drain.ts, drainQueuedRoomWindows — checked per job, so one enabled room's
 *      queue can never carry a disabled room's window through on the same pass.
 *
 * ONE REPORT, which guards nothing and must not be mistaken for a guard:
 *   4. app/api/admin/bench/drain/route.ts, GET — answers "is this room enabled right now" so
 *      F1/F2 can be OBSERVED rather than argued. It gates no work: the POST does not consult it,
 *      because the guard belongs inside drainRoomWindow where no future caller can route around
 *      it. A read here that returned the wrong answer would mislead a report; it could not
 *      transcribe anything.
 *
 * That is the whole list: FOUR call sites plus the definition below. The count is asserted by
 * tests/unit/room-drain-flag.test.ts, not trusted from this paragraph — and it has already
 * earned its keep: this comment said THREE until the admin route was written, and the test
 * failed on the next run. That is exactly what CCB_ENABLED's comment does not do, which is why
 * it claims eight call sites while guarding eleven.
 */

/** The env var. Comma- or space-separated room ids: "room_2qe955hy,room_abc123". */
export const ROOM_DRAIN_ENV = "ROOM_STT_DRAIN_ENABLED";

/**
 * Values that look like a global boolean or a wildcard. Present in the env → the flag is a
 * MISCONFIGURATION and enables nothing at all, for anybody.
 */
const REFUSED_TOKENS = new Set(["1", "0", "true", "false", "yes", "no", "on", "off", "*", "all", "always"]);

export type RoomDrainFlagState = {
  /** the room ids the flag actually enables, after refusals */
  rooms: string[];
  /** tokens that were refused for looking like a global switch */
  refused: string[];
  /** true when the env is set to something that enables nothing — worth surfacing loudly */
  misconfigured: boolean;
  /** whether the variable is present at all */
  set: boolean;
};

/**
 * Parse the flag. Pure over its argument so a test can drive it without touching process.env;
 * the no-argument form reads the environment AT CALL TIME, which is the contract above.
 */
export function parseRoomDrainFlag(raw: string | undefined | null): RoomDrainFlagState {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { rooms: [], refused: [], misconfigured: false, set: false };
  const tokens = value
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const rooms: string[] = [];
  const refused: string[] = [];
  for (const t of tokens) {
    if (REFUSED_TOKENS.has(t.toLowerCase())) refused.push(t);
    else if (!rooms.includes(t)) rooms.push(t);
  }
  return { rooms, refused, misconfigured: rooms.length === 0, set: true };
}

/** The flag as it is RIGHT NOW. Never memoised — see the note above. */
export function roomDrainFlagState(): RoomDrainFlagState {
  return parseRoomDrainFlag(process.env[ROOM_DRAIN_ENV]);
}

/**
 * Is the room STT drain enabled FOR THIS ROOM? The only question any caller should ask.
 *
 * Returns false for: an unset flag, an empty flag, a flag holding only refused tokens, and any
 * room not named in it. There is no argument that makes this return true for an unnamed room.
 */
export function isRoomDrainEnabled(roomId: string): boolean {
  if (!roomId) return false;
  return roomDrainFlagState().rooms.includes(roomId);
}
