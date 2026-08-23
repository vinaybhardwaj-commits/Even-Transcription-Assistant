/**
 * lib/bench-bus-constants.ts — the command bus's normative timing constants, alone in a
 * PURE module (remount-resume addendum 3, S3-2). No imports: this file must be safe to pull
 * into the kiosk bundle — lib/bench-commands.ts carries the database module graph, and a
 * database driver has no business in a browser. bench-commands re-exports these, so every
 * server-side caller keeps its import path unchanged.
 */

export const COMMAND_EXPIRY_SECONDS = 15; // pending > 15 s without a poll → expired (PRD §8.2)
export const LISTENER_FRESH_MS = 10_000; // last_poll_at within 10 s = listening (kickoff)
/**
 * How long a kiosk may be gone before "it might come back" becomes "somebody has to walk there".
 *
 * The SAME measurement as LISTENER_FRESH_MS — age of last_poll_at — read for a different decision.
 * Under 10 minutes the tab may be reloading, the laptop may be waking, the Wi-Fi may be flapping,
 * and the operator waits. Over 10 minutes nothing is coming back on its own and the answer is to
 * open the room page on the Mini. Same number, opposite action, so it gets its own name.
 *
 * NOT STALLED_BADGE_MINUTES, which is about chunk cadence on a tape that is already running and
 * means something else entirely. Two unrelated ten-minute windows; sharing a constant between them
 * would tie a kiosk-presence rule to an audio-freshness rule for ever.
 */
export const LISTENER_OFFLINE_MS = 10 * 60_000;
export const ACK_WAIT_MS = 8_000; // MCP tools wait this long for the kiosk ack (PRD §8.2)
export const ACK_POLL_MS = 400;
// S4-2: the kiosk poll cadence, moved here UNCHANGED from lib/use-command-poll.ts (which
// re-exports them) so the handover probe can be DERIVED from the hidden round instead of a
// number typed twice.
export const POLL_VISIBLE_MS = 1_500;
export const POLL_HIDDEN_MS = 5_000;

// ---------------------------------------------------------------------------
// ENDED DISAGREES — the session row says over, the tape says otherwise
// ---------------------------------------------------------------------------

/**
 * A NAMED DISAGREEMENT, in the same shape as `paused_disagrees` and for the same reason: the
 * kiosk and the tape are two witnesses, and when they disagree the answer is to SAY SO, not to
 * pick one. `paused_disagrees` covers consent. This covers the other one we have actually seen.
 *
 * bs_g3dwud4p, Home Office, 22–23 August. The day-rollover reaper stamped `ended_at` at 19:00:36.
 * The kiosk was never told, and carried on writing chunks into that session until 00:58:46 — six
 * hours later. All 108 of them are present and verified. **No audio was lost.** What was lost was
 * the truth: a three-hour session row holding nine hours of audio, and an operator monitor
 * showing NOT RECORDING while the room was still capturing.
 *
 * K4a fixed the specific cause (the reaper no longer reaps a session that is still receiving
 * chunks). This names the general one — THE ROOM IS NEVER TOLD — so that when it happens again
 * by some route nobody has thought of, it is visible on the screen instead of six hours later in
 * a chunk listing.
 *
 * NOT a seventh room state. The six in `roomState()` below are a precedence chain where the first
 * match wins, and this is ORTHOGONAL to every one of them: a room can be ready, dropped or
 * offline AND be taking chunks into an ended session, and folding it into that chain would hide
 * one fact behind the other. `paused_disagrees` sits beside the states for the same reason.
 */
export const ENDED_DISAGREES = "ended_disagrees";

/**
 * What POST /api/bench/chunks returns ALONGSIDE its normal success when it accepts a chunk into
 * an ended session. The upload succeeded — that is not in question and never is. The SESSION is
 * what is wrong, and this is the field that says so.
 *
 * The chunk upload is the only channel that reaches a tab which is not reloading, and the kiosk
 * is already talking to the server on every chunk. This needs no command bus.
 */
export const CHUNK_DISAGREEMENT_FIELD = "disagreement";

/** What a person standing in that room reads. Said once, here, so the kiosk cannot drift. */
export const ENDED_DISAGREES_KIOSK_TITLE = "This recording was closed by the system";
export const ENDED_DISAGREES_KIOSK_BODY =
  "The audio recorded so far is saved and verified — nothing was lost. Press start to begin a new recording.";

/** What the operator on the monitor reads. Worst-first attention copy: what, then what to do. */
export const ENDED_DISAGREES_TITLE = "chunks are still arriving for a session that is marked ended";
export const ENDED_DISAGREES_HINT =
  "the audio is safe and still being stored — the room page has been told to stop; go to the room and press start to open a fresh recording";

// ---------------------------------------------------------------------------
// The six room states (K2 §1) — operator language, and one precedence order
// ---------------------------------------------------------------------------

/**
 * What the operator can DO about this room, in six words.
 *
 * `page stale · 52h 27m` told them what the database saw, which is not the same thing and not
 * actionable. Each state below answers "and therefore?" — wait, walk over, press start, or nothing.
 */
/** The same four colours the monitor uses. Duplicated as a local union rather than imported:
 *  this module must stay import-free so it is safe in the kiosk and admin browser bundles. */
export type RoomStateLevel = "ok" | "amber" | "red" | "unknown";

export type RoomState = "cant_tell" | "paused" | "recording" | "ready" | "dropped" | "offline";

export type RoomStateView = {
  state: RoomState;
  /** The whole line, already assembled. One source of copy for the page and the MCP. */
  label: string;
  /** What to do about it, when there is something to do. */
  hint: string | null;
  level: RoomStateLevel;
};

const stateMs = (v: string | Date | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Aug", in IST, computed arithmetically so it is identical on the server and in the browser —
 *  a locale-dependent formatter here would hydrate differently and flicker. */
export function fmtDayIst(iso: string | Date | null): string | null {
  const t = stateMs(iso);
  if (t === null) return null;
  const d = new Date(t + 5.5 * 3_600_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Coarse age for a state line: "3m", "2h 14m", "3d". Never seconds — these are not stopwatches. */
export function fmtCoarse(msAgo: number): string {
  if (!Number.isFinite(msAgo) || msAgo < 0) return "—";
  const m = Math.floor(msAgo / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * PURE — the one place the six states are decided, used by BOTH the admin page and
 * scribe_diff_room so the door and the screen cannot disagree about a room.
 *
 * PRECEDENCE IS THE DESIGN, and the first match wins:
 *
 *   1 CAN'T TELL  the listener read FAILED. Not "offline" — we do not know, and saying offline
 *                 would send somebody walking to a room that is fine.
 *   2 PAUSED      consent pause, from either witness. It OUTRANKS recording deliberately: a room
 *                 that is paused-and-recording is a room where consent was withdrawn, and that is
 *                 the fact the operator must act on, not the tape that is still open.
 *   3 RECORDING   a live tape.
 *   4 READY       listening, not recording, not paused — and it claims NOTHING ELSE. It means a
 *                 start will succeed, not that the microphones work: before a session begins there
 *                 are no chunks, so mic health is unknown by construction.
 *   5 DROPPED     gone less than LISTENER_OFFLINE_MS. It may come back; wait.
 *   6 OFFLINE     gone longer, or never seen at all. Nothing is coming back on its own.
 */
export function roomState(input: {
  listenerReadFailed: boolean;
  listener: { last_poll_at: string | Date; paused: boolean } | null;
  pausedSession: boolean;
  recording: boolean;
  recordingSince: string | null;
  nowMs: number;
}): RoomStateView {
  if (input.listenerReadFailed) {
    return { state: "cant_tell", label: "Can't tell — cannot reach the command bus", hint: null, level: "unknown" };
  }
  if (Boolean(input.listener?.paused) || input.pausedSession) {
    return { state: "paused", label: "Paused for consent", hint: null, level: "amber" };
  }
  if (input.recording) {
    const since = stateMs(input.recordingSince);
    return {
      state: "recording",
      label: since === null ? "Recording" : `Recording · ${fmtCoarse(input.nowMs - since)}`,
      hint: null,
      level: "ok",
    };
  }
  const age = input.listener ? input.nowMs - new Date(input.listener.last_poll_at).getTime() : null;
  const listening = age !== null && Number.isFinite(age) && age <= LISTENER_FRESH_MS;
  if (listening) {
    // READY, and nothing more. The mockup's "both mics seen" was not buildable and is not built.
    return { state: "ready", label: "Ready", hint: null, level: "ok" };
  }
  if (age !== null && Number.isFinite(age) && age < LISTENER_OFFLINE_MS) {
    return { state: "dropped", label: `Kiosk dropped ${fmtCoarse(age)} ago`, hint: "it may come back on its own — wait a moment", level: "amber" };
  }
  // OFFLINE says what to DO, because "offline" alone is a symptom and the operator needs the cure.
  const day = input.listener ? fmtDayIst(input.listener.last_poll_at) : null;
  return {
    state: "offline",
    label: day ? `Offline · no kiosk since ${day}` : "Offline · never opened",
    hint: "open the room page on the Mini",
    level: "red",
  };
}
