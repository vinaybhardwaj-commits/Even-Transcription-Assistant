/**
 * lib/brain/fuse/live-flag.ts — FUSE_LIVE_ENABLED (K2 D1).
 *
 * The switch that lets the fuse write visits on a LIVE clinic day. Monday 24 August is a live
 * OPD recording day, so the only property that matters here is the one this file exists to
 * make unmissable: OFF FOR EVERY CLINIC ROOM, and off is the default.
 *
 * ─── WHY IT IS PER-ROOM AND NOT A BOOLEAN ────────────────────────────────────────────────
 * A global `FUSE_LIVE_ENABLED=1` would mean that switching the fuse on to test it in Home
 * Office switches it on for OPD 7 at the same instant, on the same deploy, with no second
 * step and no way to tell the two apart afterwards. There is no version of that which is safe
 * two days before a recording day, so the flag does not have that shape at all: it holds a
 * LIST OF ROOM IDS, and a room not in the list is off.
 *
 * ─── WHY "1", "true" AND "*" ENABLE NOTHING ──────────────────────────────────────────────
 * Those are what a person types when they are thinking of a boolean, and they are exactly the
 * inputs that would silently turn the fuse on everywhere. They are REFUSED BY NAME rather
 * than parsed as room ids or treated as wildcards: `isFuseLiveEnabled` returns false for every
 * room and `fuseLiveFlagState()` reports the value as a misconfiguration, so the mistake shows
 * up as "nothing happened, and here is why" instead of as a live clinic day being fused.
 * There is deliberately NO wildcard. Enabling a room requires naming it.
 *
 * ─── READ AT THE POINT OF USE ────────────────────────────────────────────────────────────
 * process.env is read inside the function on EVERY call — never captured in a module-scope
 * const. A module-scope read is evaluated once per lambda instance, so flipping the flag off
 * in an incident would leave warm instances still fusing until they happened to recycle. The
 * parse is a split on a short string; it is not worth caching and caching it costs the ability
 * to turn it off.
 *
 * ─── HAZARD: EVERY CALL SITE THIS FLAG GUARDS ────────────────────────────────────────────
 * VERIFIED BY GREP, not by memory. `git grep -n "isFuseLiveEnabled" -- ':!docs' ':!tests'`
 * must return exactly these, and tests/unit/fuse-live.test.ts fails the build if it does not:
 *
 *   1. app/api/brain/cues/route.ts — the live cue path, after the lock is released and the
 *      response body is already decided. THE ONLY PRODUCTION ENTRY.
 *   2. lib/brain/fuse/live.ts, scheduleLiveFuse — checked BEFORE the debounce map is touched,
 *      so a flag-off room leaves no scheduling state behind either.
 *   3. lib/brain/fuse/live.ts, runLiveFuse — checked again on entry, so the runner is safe to
 *      call directly and cannot be reached with the flag off by a future caller.
 *
 * That is the whole list: THREE call sites plus the definition below. It said two when it was
 * first written, and the grep found three — which is the entire reason this paragraph exists,
 * and why the test asserts the count rather than trusting the prose. A hazard comment that
 * under-counts its own call sites is worse than none, because it is trusted.
 */

/** The env var. Comma- or space-separated room ids: "room_2qe955hy,room_abc123". */
export const FUSE_LIVE_ENV = "FUSE_LIVE_ENABLED";

/**
 * Values that look like a global boolean or a wildcard. Present in the env → the flag is a
 * MISCONFIGURATION and enables nothing at all, for anybody.
 */
const REFUSED_TOKENS = new Set(["1", "0", "true", "false", "yes", "no", "on", "off", "*", "all", "always"]);

export type FuseLiveFlagState = {
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
export function parseFuseLiveFlag(raw: string | undefined | null): FuseLiveFlagState {
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
export function fuseLiveFlagState(): FuseLiveFlagState {
  return parseFuseLiveFlag(process.env[FUSE_LIVE_ENV]);
}

/**
 * Is the live fuse enabled FOR THIS ROOM? The only question any caller should ask.
 *
 * Returns false for: an unset flag, an empty flag, a flag holding only refused tokens, and any
 * room not named in it. There is no argument that makes this return true for an unnamed room.
 */
export function isFuseLiveEnabled(roomId: string): boolean {
  if (!roomId) return false;
  return fuseLiveFlagState().rooms.includes(roomId);
}
