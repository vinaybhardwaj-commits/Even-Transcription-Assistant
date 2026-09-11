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

/**
 * D38 — HOW OFTEN AN IDLE ROOM REPORTS ITSELF, and why it has its own number.
 *
 * THE FAULT THIS ADDRESSES (§3.8, the most serious item in Slice 0). An operator can stop a room
 * from the Bench screen and cannot start it again, because STOPPING IS WHAT MAKES IT STOP
 * LISTENING. Measured 24 August on three rooms out of three: both clinic rooms were ended remotely
 * at 16:16 and went quiet within seconds; at 16:33 one was listening only because V had walked
 * downstairs and reloaded it by hand, and the other had been unreachable for sixteen minutes.
 * There is no counter-example. A control that can be used but not undone from the same place is
 * worse than no control at all, because it looks safe.
 *
 * So the page reports itself WHENEVER IT IS OPEN, whatever the session is doing, and an idle room
 * that is open stops being indistinguishable from a room whose page has died.
 *
 * THREE SECONDS, NOT 1.5. Idle costs nothing to be slightly slower about — nobody is waiting on a
 * command in a room that is not recording — and halving the request rate on a machine that may sit
 * open all night is worth more than a second and a half of latency. It is still THREE CHANCES to
 * be heard inside the ten-second freshness window, which is the property that actually matters:
 * two polls may fail and the room is still not called gone.
 *
 * THE FRESHNESS WINDOW IS UNCHANGED at LISTENER_FRESH_MS, and so is the recording cadence. This
 * adds a slower beat where there was previously NO beat at all; it does not slow an existing one.
 */
export const POLL_IDLE_MS = 3_000;

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
 * NOT A ROOM STATE AT ALL. The states in `roomState()` below are a precedence chain where the
 * first match wins, and this is ORTHOGONAL to every one of them: a room can be ready, dropped or
 * offline AND be taking chunks into an ended session, and folding it into that chain would hide
 * one fact behind the other. `paused_disagrees` sits beside the states for the same reason.
 */
export const ENDED_DISAGREES = "ended_disagrees";

/**
 * THE DISCRIMINATOR, and getting it wrong makes this alarm worthless.
 *
 * "A chunk arrived for a session whose row says ended" is NOT the fault. It is what happens on
 * EVERY normal end of day, and it took a live run on OPD Test to see it: the kiosk PATCHes the
 * session to ended as soon as the recorder stops, and only then does the flush finish uploading.
 * Every session in that room's history shows it —
 *
 *     session bs_jmh9jxmx   ended_at   05:24:09.817
 *     chunk   bc_744vkbng   started_at 05:23:51.705   ended_at 05:24:09.571
 *
 * — a chunk row written after the end, holding audio captured entirely before it. An alarm that
 * fires on that fires every evening in every room, and is unread by Wednesday.
 *
 * What separates the two is the CAPTURE clock, not the upload clock. A flush contains at most the
 * chunk that was in progress when the session ended, so its `started_at` is BEFORE `ended_at` by
 * construction. A rogue chunk — the kiosk that was never told — is audio that began after we said
 * we had stopped. bs_g3dwud4p's kept beginning for six hours.
 *
 * NOTE THIS IS THE OPPOSITE CLOCK from the monitor's mic vitals, which use `created_at` because
 * they ask "is audio still ARRIVING". This asks "was this audio RECORDED after we said we
 * stopped", and only the capture stamp can answer that.
 */
export const ENDED_DISAGREES_CLOCK = "capture";

/**
 * Clock skew only — NOT a rotation window.
 *
 * `started_at` is stamped by the kiosk's browser and `ended_at` by the server, so the comparison
 * above straddles two clocks. On a normal end the margin can be small: an operator who presses
 * End day two seconds after a rotation leaves a flush chunk whose start is two seconds before the
 * end, and a browser clock a few seconds fast would flip it. Sixty seconds is far more skew than
 * anything else in this system tolerates.
 *
 * It costs nothing in detection: a genuinely rogue chunk is a WHOLE ROTATION late at minimum
 * (five minutes), because that is when the next chunk begins. So this widens the safe margin
 * without widening the window in which the room goes untold.
 */
export const ENDED_DISAGREES_SKEW_GRACE_MS = 60_000;

/** PURE. Was this chunk RECORDED after the session was declared over? */
export function chunkDisagreesWithEnd(input: {
  status: string;
  sessionEndedAt: string | Date | null | undefined;
  chunkStartedAtMs: number;
}): boolean {
  if (input.status !== "ended") return false;
  const v = input.sessionEndedAt;
  if (v == null || v === "") return false; // ended with no ended_at: nothing to compare against
  const endedMs = v instanceof Date ? v.getTime() : Date.parse(String(v));
  if (!Number.isFinite(endedMs)) return false;
  return input.chunkStartedAtMs > endedMs + ENDED_DISAGREES_SKEW_GRACE_MS;
}

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
// NO DAY RECORD — recorded, and unable to be transcribed
// ---------------------------------------------------------------------------

/**
 * A window that is CLOSED with no room_day cannot be processed at all, and the drain says so
 * before it claims anything: `no_room_day` returns ahead of the claim, so the window never
 * reaches `failed` and sits at `closed` for ever.
 *
 * THE LANE USED TO COUNT THAT AS "WAITING". A stuck state was rendered as normal progress —
 * "N pieces of audio waiting to be turned into words… can be processed later" — which is a
 * reassuring sentence about something that will never happen on its own. In a clinic, at a
 * glance, that is worse than saying nothing.
 *
 * Only ONE production path creates a room_day: a cue. Recording creates none — a session writes
 * bench_session, bench_chunk, bench_window and bench_event and touches room_day in none of them.
 * So a room that records all day with nobody pressing Mark consult has no day, and every window
 * it records is in this state.
 *
 * THE COPY NAMES THE FIX, because the fix is one press and the operator is the only one who can
 * do it. It is also honest about scope: a mark at ANY point in the day is enough, since the
 * window writer backfills room_day_id on every evaluation pass and evaluation runs on every
 * chunk — so a mark at 11am retro-binds everything recorded since 9am.
 */
export const NO_DAY_TITLE = "no day record yet — nothing can be transcribed";
export const NO_DAY_FIX =
  "Press Mark consult once in the room and everything recorded today will be picked up.";
/** The lane's own words. Deliberately NOT the word "waiting" — these are not queued. */
export const NO_DAY_LANE_STATE = (n: number): string =>
  `${n} piece${n === 1 ? "" : "s"} recorded, no day record yet`;

// ---------------------------------------------------------------------------
// The seven room states (K2 §1, plus D30) — operator language, and one precedence order
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

export type RoomState = "cant_tell" | "paused" | "recording" | "finished" | "ready" | "dropped" | "offline";

/**
 * FINISHED FOR TODAY (D30) — the seventh state, and the reason it exists.
 *
 * On 24 August both clinic rooms were ended deliberately at 16:16 and nine minutes later the
 * monitor read "Kiosk dropped 9m ago — it may come back on its own", in amber, telling an
 * operator to go and reopen a page over a day that was simply over. There was no state for a
 * finished day, so the chain fell through to the one that describes a kiosk that vanished by
 * accident — which is exactly what ending a day looks like from the bus's point of view.
 *
 * It sits AFTER paused and recording (a live tape is never "finished") and BEFORE ready,
 * dropped and offline (a deliberate end outranks every explanation of why the page went away).
 * It is never amber: nothing here needs anybody to do anything.
 */
export const FINISHED_HINT = "Press start to record again";

export type RoomStateView = {
  state: RoomState;
  /** The whole line, already assembled. One source of copy for the page and the MCP. */
  label: string;
  /** What to do about it, when there is something to do. */
  hint: string | null;
  level: RoomStateLevel;
  /**
   * Would a start succeed right now? A SEPARATE QUESTION from the state, since D30.
   *
   * Until the seventh state arrived, "start is offered" and "state is ready" were the same
   * sentence. They are not any more: `finished` outranks `ready`, so a room whose day was ended
   * while its kiosk is still open would have had its start button greyed out by the very state
   * whose hint tells the operator to press start. This answers the button's question directly —
   * READY, or FINISHED with a kiosk still listening — so the chain can stay about what happened
   * while the control stays about what is possible.
   */
  start_available: boolean;
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
 *   4 FINISHED    the most recent session today is ENDED and nothing is recording (D30). It
 *                 outranks the three below because a day ended on purpose explains the quiet
 *                 kiosk, and each of them would call that quiet an accident.
 *   5 READY       listening, not recording, not paused — and it claims NOTHING ELSE. It means a
 *                 start will succeed, not that the microphones work: before a session begins there
 *                 are no chunks, so mic health is unknown by construction.
 *   6 DROPPED     gone less than LISTENER_OFFLINE_MS. It may come back; wait.
 *   7 OFFLINE     gone longer, or never seen at all. Nothing is coming back on its own.
 */
export function roomState(input: {
  listenerReadFailed: boolean;
  listener: { last_poll_at: string | Date; paused: boolean } | null;
  pausedSession: boolean;
  recording: boolean;
  recordingSince: string | null;
  nowMs: number;
  /** D30 — the room's MOST RECENT session today is `ended`. Absent is false, so every caller
   *  that has not been taught about the seventh state keeps exactly the chain it had. */
  lastSessionEnded?: boolean;
  /** Audio recorded in this room today, summed from the PIECES themselves. Null or zero simply
   *  drops the duration from the label; it never suppresses the state. */
  recordedMsToday?: number | null;
}): RoomStateView {
  if (input.listenerReadFailed) {
    return { state: "cant_tell", label: "Can't tell — cannot reach the command bus", hint: null, level: "unknown", start_available: false };
  }
  if (Boolean(input.listener?.paused) || input.pausedSession) {
    return { state: "paused", label: "Paused for consent", hint: null, level: "amber", start_available: false };
  }
  if (input.recording) {
    const since = stateMs(input.recordingSince);
    return {
      state: "recording",
      label: since === null ? "Recording" : `Recording · ${fmtCoarse(input.nowMs - since)}`,
      hint: null,
      level: "ok",
      start_available: false,
    };
  }
  const age = input.listener ? input.nowMs - new Date(input.listener.last_poll_at).getTime() : null;
  const listening = age !== null && Number.isFinite(age) && age <= LISTENER_FRESH_MS;
  // 4 FINISHED FOR TODAY (D30). Ahead of ready, dropped and offline, because a day that was
  // ended on purpose ALREADY EXPLAINS the quiet kiosk and each of those three would describe it
  // as an accident. Never amber: nothing here needs anybody to do anything.
  if (input.lastSessionEnded) {
    const rec = Number(input.recordedMsToday);
    const dur = Number.isFinite(rec) && rec > 0 ? ` · ${fmtCoarse(rec)} recorded` : "";
    return {
      state: "finished",
      label: `Finished for today${dur}`,
      hint: FINISHED_HINT,
      level: "ok",
      // The hint says press start, so the button must actually be there — but only where a kiosk
      // is listening for it. Where none is, the button stays off and the card's own
      // start-is-off sentence names the reason. The STATE does not change for it: once a day has
      // been ended deliberately, why the page is quiet is no longer the operator's question.
      start_available: listening,
    };
  }
  if (listening) {
    // READY, and nothing more. The mockup's "both mics seen" was not buildable and is not built.
    return { state: "ready", label: "Ready", hint: null, level: "ok", start_available: true };
  }
  if (age !== null && Number.isFinite(age) && age < LISTENER_OFFLINE_MS) {
    return { state: "dropped", label: `Kiosk dropped ${fmtCoarse(age)} ago`, hint: "it may come back on its own — wait a moment", level: "amber", start_available: false };
  }
  // OFFLINE says what to DO, because "offline" alone is a symptom and the operator needs the cure.
  const day = input.listener ? fmtDayIst(input.listener.last_poll_at) : null;
  return {
    state: "offline",
    label: day ? `Offline · no kiosk since ${day}` : "Offline · never opened",
    hint: "open the room page on the Mini",
    level: "red",
    start_available: false,
  };
}

// ---------------------------------------------------------------------------
// TIER 1 §2 — NAMED INSTALL STATES, evaluated on every native poll
// ---------------------------------------------------------------------------

/**
 * WHAT THESE ARE, AND WHAT THEY ARE NOT.
 *
 * On 11 September OPD 3 and OPD 7 recorded bit-exact silence for days from two dead TONOR TM20s, and
 * the fleet card showed it only to someone who knew to read `zero_ratio 1` as a dead microphone. Every
 * fact needed to say "this room is recording silence" was already on the install row. These are those
 * facts, named: seven COARSE ALARMS over fields the app already sends, evaluated per poll and stored
 * on `room_install.state_flags` (0081).
 *
 * NOT A ROOM STATE IN THE SENSE OF `roomState()` ABOVE. That is a precedence chain where the first
 * match wins, about what the operator can do. These are ORTHOGONAL and several can hold at once — a
 * room can be clipping on the wrong device with a filling disk — so they are a set, never a chain.
 *
 * NOT CALIBRATED. The 9 September finding is that rooms differ in their noise floor; per-room floors
 * are R2.5. Until then these thresholds are deliberately coarse: each one is a condition no working
 * room meets, so a flag means "go and look", never "this is the diagnosis".
 */
export type InstallStateFlag =
  | "SILENT_WHILE_RECORDING"
  | "CLIPPING"
  | "DEVICE_MISSING"
  | "DEVICE_CHANGED"
  | "ENCODER_STALLED"
  | "DISK_LOW"
  | "CHANNEL_DRIFT";

/** The one order flags are listed in, everywhere. The spec's table order. */
export const INSTALL_STATE_FLAGS: readonly InstallStateFlag[] = [
  "SILENT_WHILE_RECORDING",
  "CLIPPING",
  "DEVICE_MISSING",
  "DEVICE_CHANGED",
  "ENCODER_STALLED",
  "DISK_LOW",
  "CHANNEL_DRIFT",
];

/**
 * The poll ring's length (§2: "the last 10 polls"). CLIPPING's window, and long enough to hold
 * ENCODER_STALLED's four. NOT long enough for SILENT_WHILE_RECORDING's eighty, which is why silence
 * is carried as a COUNT on the ring's head rather than read off the ring — see `silent_polls`.
 */
export const POLL_RING_SIZE = 10;

/**
 * SILENT_WHILE_RECORDING — eighty consecutive polls, about two minutes at the recording cadence.
 *
 * `zero_ratio` is BIT-EXACT zeros (B2-D7), not quiet: a quiet room still has a noise floor and reads
 * near zero here, while a dead input reads 1. 0.98 rather than 1 so a device that emits the odd
 * non-zero glitch is still called dead. Two minutes so a room is not called silent for the length of
 * a pause between patients — the tape runs through those.
 */
export const SILENT_POLLS = 80;
export const SILENT_ZERO_RATIO = 0.98;
/**
 * The same two minutes, measured by the app itself (0.1.22 `silence_ms`): time since the last sample
 * above −55 dBFS. DERIVED from the poll count and the recording cadence, so the two paths name the
 * same duration and cannot drift.
 */
export const SILENT_MS = SILENT_POLLS * POLL_VISIBLE_MS;

/**
 * CLIPPING — a peak at or above 0.99 of full scale in at least three of the last ten recording polls.
 * Three, not one: a single slammed door is not a gain problem. Where the app reports `clip_count`
 * (0.1.22) a poll counts when it saw ANY full-scale sample, and `peak` is not consulted for that poll.
 */
export const CLIP_PEAK = 0.99;
export const CLIP_POLLS_MIN = 3;

/**
 * ENCODER_STALLED — recording, and the durable tape index has not grown for four polls in a row.
 * The first poll of every session reports `tape_advancing` false by construction (nothing has been
 * shown to advance yet), and a checkpoint (1.25 s) can land just after a poll (1.5 s): one false is
 * normal. Four is six seconds of a tape that is not moving while a patient is in the room.
 */
export const STALLED_POLLS = 4;

/**
 * DISK_LOW — under 2 GiB free on the captures volume. BINARY GiB, unlike the card's decimal-GB disk
 * colours (B2-D6: amber 20 GB, red 5 GB), which stay as they are: those are headroom warnings, this
 * is "the next hours of tape may not fit".
 */
export const DISK_LOW_BYTES = 2 * 1024 ** 3;

/**
 * CHANNEL_DRIFT — an admin assigned a channel and the Mac has reported a different one for more than
 * thirty minutes. A Mac that obeys moves on its next poll, so a short gap is the move in flight; half
 * an hour is a Mac that will not (an older app, a locked channel, a config write that keeps failing).
 */
export const CHANNEL_DRIFT_MS = 30 * 60_000;

/** What a person reads on the card and in the MCP. Short: they sit in a chip. */
export const INSTALL_STATE_LABEL: Record<InstallStateFlag, string> = {
  SILENT_WHILE_RECORDING: "silent while recording",
  CLIPPING: "clipping",
  DEVICE_MISSING: "device missing",
  DEVICE_CHANGED: "device changed",
  ENCODER_STALLED: "encoder stalled",
  DISK_LOW: "disk low",
  CHANNEL_DRIFT: "channel drift",
};

/**
 * One poll, as the ring stores it. Newest first. Raw readings only — the rules are applied when the
 * ring is READ, so a threshold can change without rewriting stored history.
 *
 * `rec` is this poll's own answer to "recording": a session id reported AND not paused. PAUSED IS
 * NOT RECORDING here, deliberately — a room paused for consent is silent because it was asked to be,
 * and SILENT_WHILE_RECORDING on it would be an alarm about the consent working.
 *
 * `silent_polls` is the consecutive-silent count INCLUDING this poll, carried from the previous head
 * in SQL (`applyInstallPoll`): the ring holds ten polls and silence needs eighty.
 */
export type PollRingEntry = {
  at: string;
  peak: number | null;
  zero_ratio: number | null;
  tape_advancing: boolean | null;
  rec: boolean;
  silent_polls: number;
  /** 0.1.22 heartbeat; absent on every earlier app. */
  clip_count?: number | null;
  silence_ms?: number | null;
};

/** What `state_flags` holds. `drift_since` is CHANNEL_DRIFT's clock: when the mismatch began. */
export type InstallStateRecord = { flags: InstallStateFlag[]; drift_since: string | null };

export const EMPTY_INSTALL_STATE: InstallStateRecord = { flags: [], drift_since: null };

const finiteOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * PURE — `state_flags` as stored, or anything else, as a record. A value this build cannot read is the
 * empty state: an unreadable column must never raise a flag, and it is rewritten on the next change.
 */
export function parseInstallState(raw: unknown): InstallStateRecord {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { ...EMPTY_INSTALL_STATE };
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...EMPTY_INSTALL_STATE };
  const o = v as Record<string, unknown>;
  const flags = Array.isArray(o.flags) ? INSTALL_STATE_FLAGS.filter((f) => (o.flags as unknown[]).includes(f)) : [];
  const since = typeof o.drift_since === "string" && Number.isFinite(Date.parse(o.drift_since)) ? o.drift_since : null;
  return { flags, drift_since: since };
}

/** PURE — the stored ring, newest first, or []. Entries this build cannot read are dropped. */
export function parsePollRing(raw: unknown): PollRingEntry[] {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: PollRingEntry[] = [];
  for (const e of v.slice(0, POLL_RING_SIZE)) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    out.push({
      at: typeof o.at === "string" ? o.at : "",
      peak: finiteOrNull(o.peak),
      zero_ratio: finiteOrNull(o.zero_ratio),
      tape_advancing: typeof o.tape_advancing === "boolean" ? o.tape_advancing : null,
      rec: o.rec === true,
      silent_polls: Math.max(0, Math.trunc(finiteOrNull(o.silent_polls) ?? 0)),
      ...(o.clip_count !== undefined ? { clip_count: finiteOrNull(o.clip_count) } : {}),
      ...(o.silence_ms !== undefined ? { silence_ms: finiteOrNull(o.silence_ms) } : {}),
    });
  }
  return out;
}

/**
 * PURE — is THIS poll a silent one, for the carried count? Only this poll's own readings: the history
 * is the count the SQL carries, and a poll that did not report `zero_ratio` breaks the run (it made
 * no claim, and "two minutes of silence" must be two minutes of MEASURED silence).
 */
export function pollIsSilent(p: { rec: boolean; tape_advancing: boolean | null; zero_ratio: number | null }): boolean {
  return p.rec && p.tape_advancing === true && p.zero_ratio !== null && p.zero_ratio >= SILENT_ZERO_RATIO;
}

/** PURE — did this ring entry see clipping? `clip_count` when the app sent one, else `peak`. */
export function pollClipped(e: PollRingEntry): boolean {
  if (typeof e.clip_count === "number") return e.clip_count > 0;
  return e.peak !== null && e.peak >= CLIP_PEAK;
}

/**
 * PURE — the seven rules of §2, over one install's state AFTER this poll's write.
 *
 * `ring` is the post-write ring (this poll at [0]). The row fields are the post-COALESCE values the
 * UPDATE returned, so a poll that omitted a field is judged on the last value the row holds — the same
 * value the card shows. `recording` and `tapeAdvancing` are THIS poll's.
 *
 * `silenceMs` is the 0.1.22 heartbeat. PRESENT, it decides SILENT_WHILE_RECORDING on its own; ABSENT
 * (every 0.1.21 app), the carried `zero_ratio` count decides. The fallback is the spec's, not a guess.
 *
 * Returns the new record. The caller writes it only when it differs from `prev`.
 */
export function evaluateInstallStates(input: {
  ring: readonly PollRingEntry[];
  recording: boolean;
  tapeAdvancing: boolean | null;
  inputDeviceName: string | null;
  inputDevices: ReadonlyArray<{ name: string }> | null;
  expectedDeviceName: string | null;
  diskFreeBytes: number | null;
  updateChannel: string | null;
  assignedChannel: string | null;
  silenceMs?: number | null;
  prev: InstallStateRecord;
  nowMs: number;
}): InstallStateRecord {
  const flags = new Set<InstallStateFlag>();
  const head = input.ring[0];

  if (input.recording && input.tapeAdvancing === true) {
    const ms = typeof input.silenceMs === "number" && Number.isFinite(input.silenceMs) ? input.silenceMs : null;
    if (ms !== null ? ms >= SILENT_MS : (head?.silent_polls ?? 0) >= SILENT_POLLS) {
      flags.add("SILENT_WHILE_RECORDING");
    }
  }

  if (input.recording && input.ring.filter((e) => e.rec && pollClipped(e)).length >= CLIP_POLLS_MIN) {
    flags.add("CLIPPING");
  }

  // Both halves must be MEASURED. No device list (an app below 0.1.20) says nothing about presence,
  // and no name says nothing about which device to look for.
  if (
    input.inputDeviceName &&
    Array.isArray(input.inputDevices) &&
    !input.inputDevices.some((d) => d && d.name === input.inputDeviceName)
  ) {
    flags.add("DEVICE_MISSING");
  }

  if (input.expectedDeviceName && input.inputDeviceName && input.expectedDeviceName !== input.inputDeviceName) {
    flags.add("DEVICE_CHANGED");
  }

  if (
    input.recording &&
    input.ring.length >= STALLED_POLLS &&
    input.ring.slice(0, STALLED_POLLS).every((e) => e.rec && e.tape_advancing === false)
  ) {
    flags.add("ENCODER_STALLED");
  }

  if (input.diskFreeBytes !== null && Number.isFinite(input.diskFreeBytes) && input.diskFreeBytes > 0 && input.diskFreeBytes < DISK_LOW_BYTES) {
    flags.add("DISK_LOW");
  }

  // A Mac that does not report its channel (below 0.1.8) cannot be said to disagree with anything.
  const drifting =
    input.assignedChannel !== null && input.updateChannel !== null && input.updateChannel !== input.assignedChannel;
  const driftSince = drifting ? (input.prev.drift_since ?? new Date(input.nowMs).toISOString()) : null;
  if (drifting && driftSince !== null && input.nowMs - Date.parse(driftSince) > CHANNEL_DRIFT_MS) {
    flags.add("CHANNEL_DRIFT");
  }

  return { flags: INSTALL_STATE_FLAGS.filter((f) => flags.has(f)), drift_since: driftSince };
}

/** PURE — two records the same? Flags compare as sets in the canonical order. */
export function sameInstallState(a: InstallStateRecord, b: InstallStateRecord): boolean {
  return a.drift_since === b.drift_since && a.flags.length === b.flags.length && a.flags.every((f, k) => b.flags[k] === f);
}

/** PURE — did the SET of flags change? What moves `state_changed_at`; `drift_since` alone does not. */
export function installFlagsChanged(a: InstallStateRecord, b: InstallStateRecord): boolean {
  return a.flags.length !== b.flags.length || a.flags.some((f, k) => b.flags[k] !== f);
}

/** PURE — the flags array a reader shows, from whatever `state_flags` holds. */
export function installStateFlags(raw: unknown): InstallStateFlag[] {
  return parseInstallState(raw).flags;
}
