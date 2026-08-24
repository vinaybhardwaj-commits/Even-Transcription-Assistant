/**
 * lib/room-facts.ts — ONE PLACE where a fact about a room is decided.
 *
 * WHY THIS FILE EXISTS (Build 1 §3.6). The screen and the door had drifted three times over,
 * always the same way: a rule was written on one side and copied, half-remembered, onto the
 * other. The screen carried the ended-disagrees alarm and the door did not; the door carried the
 * mirror-image `ended_at_lies` check and the screen did not; the doctor clock fell back to the
 * session start on the screen and not in the door, so the two disagreed about the same room by
 * up to a whole recording's length. An automated watcher that cannot say what the screen says is
 * not a watcher, it is a second opinion nobody asked for.
 *
 * So every DECISION lives here and both callers import it. `lib/admin/rooms-live.ts` re-exports
 * the whole surface so no existing import path changed, and `lib/mcp/tools/bench.ts` reaches the
 * same functions by the same names. The shared READS live in lib/admin/room-reads.ts, which is
 * this file's server-side twin.
 *
 * PURE, and it must stay that way: it imports lib/bench-bus-constants and nothing else. This
 * module is pulled into the admin browser bundle, and a Postgres driver has no business there.
 *
 * THE NAMING RULE CARRIES OVER. Nothing here may render "warehouse silent", "no warehouse
 * event", or any phrase implying Pulse is down — the doctor clock cannot detect that and saying
 * so once cost a whole morning. There is a test that reads this file and asserts it.
 */

import { fmtCoarse, NO_DAY_FIX, NO_DAY_LANE_STATE } from "@/lib/bench-bus-constants";

// ---------------------------------------------------------------------------
// Thresholds — settled, and every one of them lives here only
// ---------------------------------------------------------------------------

/**
 * MIC FRESHNESS, measured on bench_chunk.created_at — the UPLOAD clock, not ended_at.
 * A healthy mic therefore cycles from 0 to about five minutes as each chunk is closed and
 * uploaded, which is precisely why amber sits at 7 and not at 5: a mic that has just rotated is
 * not a mic in trouble.
 */
export const MIC_AMBER_MS = 7 * 60_000;
export const MIC_RED_MS = 10 * 60_000;

/**
 * THE DOCTOR CLOCK. Counted ONLY while a session is recording and the room is not paused, and
 * reset by any warehouse-typed cue. Never counted against a paused or ended room: a room that is
 * not recording is not a room anybody is failing to clock in.
 */
export const DOCTOR_CLOCK_AMBER_MS = 15 * 60_000;
export const DOCTOR_CLOCK_RED_MS = 30 * 60_000;

/**
 * THE LABEL, and it is normative. D13. Never "warehouse silent", never "no warehouse event" —
 * those phrases describe a system-wide outage and this vital cannot detect one.
 */
export const DOCTOR_CLOCK_LABEL = "this doctor";
export const DOCTOR_CLOCK_NOTE =
  "no Pulse clock from the labelled doctor. Another doctor may be in this room and seeing patients — the warehouse holds no room, so this cannot tell you the room is empty.";

export type Level = "ok" | "amber" | "red" | "unknown";

/** PURE. Age of the newest chunk on either mic → its level. Null age is unknown, never ok. */
export function micLevel(ageMs: number | null): Level {
  if (ageMs === null || !Number.isFinite(ageMs)) return "unknown";
  if (ageMs >= MIC_RED_MS) return "red";
  if (ageMs >= MIC_AMBER_MS) return "amber";
  return "ok";
}

/** PURE. The doctor clock's gap → its level. Null (not recording, paused, or NO CUE AT ALL) is
 *  not a state to colour: there is nothing to be late for. */
export function doctorClockLevel(silentMs: number | null): Level {
  if (silentMs === null || !Number.isFinite(silentMs)) return "unknown";
  if (silentMs >= DOCTOR_CLOCK_RED_MS) return "red";
  if (silentMs >= DOCTOR_CLOCK_AMBER_MS) return "amber";
  return "ok";
}

/**
 * PURE — the doctor clock's gap, and THE ONE PLACE it is computed. Build 1 §3.1.
 *
 * THERE IS NO FALLBACK, and its absence is the whole point of this function.
 *
 * Nothing in production writes a warehouse clock event: the only writer is a script somebody
 * runs by hand. The screen used to fall back to the time RECORDING STARTED when no cue existed,
 * so what it displayed was the length of the recording wearing the label of a clock gap. Every
 * room in the estate therefore turned amber at fifteen minutes and red at thirty, every day,
 * for ever — one of the four alarms this build exists to remove, and the only one that fired on
 * literally every room. Worse, the door did NOT fall back, so the screen and the door reported
 * different numbers for the same room and neither was checkable against the other.
 *
 * With no cue the answer is NULL — we cannot tell — and null renders as `unknown`, which draws
 * no colour and raises no attention row. The vital is not deleted and its thresholds are not
 * changed: the day something feeds it, it works, unaltered.
 */
export function doctorClockSilentMs(input: {
  lastWarehouseAt: string | number | Date | null | undefined;
  recording: boolean;
  paused: boolean;
  nowMs: number;
}): number | null {
  if (!input.recording || input.paused) return null;
  const v = input.lastWarehouseAt;
  if (v == null || v === "") return null; // NO CUE, NO CLOCK. Never the session's own start.
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, input.nowMs - t);
}

/**
 * PURE — does a room-day carry a genuine warehouse-typed cue? The row on the card renders only
 * when this is true, so a vital nothing feeds does not occupy a line saying nothing.
 */
export function hasDoctorClock(lastWarehouseAt: string | Date | null | undefined): boolean {
  return lastWarehouseAt != null && lastWarehouseAt !== "";
}

/**
 * PURE — the DOOR's own end-time check, moved here so the screen can raise it too (§3.6).
 *
 * A stored `ended_at` LATER than the last piece by more than the stall window: the row claims
 * the session ran on after the tape stopped. The mirror image of ended-disagrees, which is the
 * tape running on after the row stopped. Two different faults, and until this build each surface
 * had exactly one of them.
 */
export function endedAtLies(storedEndMs: number | null, tapeMs: number | null, stallWindowMs: number): boolean {
  if (storedEndMs == null || tapeMs == null) return false;
  return storedEndMs - tapeMs > stallWindowMs;
}

// ---------------------------------------------------------------------------
// The three lanes — Tape, Transcript, Visits (PRD R4)
// ---------------------------------------------------------------------------

/** The four lamp colours the mockup draws: green working, amber acting-needed, red audio at
 *  risk, grey off-or-idle. Its own union rather than `Level` — `Level` has "unknown", which a
 *  lane never is, and lacks "off", which is half of what a lane says. */
export type LaneLevel = "ok" | "amber" | "red" | "off";
export type LaneView = {
  level: LaneLevel;
  state: string;
  enabled: boolean | null;
  /** What to DO about it, when the state is one a person can act on. Rendered under the lane. */
  note?: string;
};

/** Counts behind the Transcript lane, for one room, today. Derived from bench_window state. */
export type TranscriptCounts = {
  done: number;
  /** CLOSED and bound to a room_day — genuinely finished audio nobody has run yet. */
  waiting: number;
  /** CLOSED with NO room_day. NOT waiting: the drain refuses these before it claims anything,
   *  so they never reach `failed` and sit at `closed` for ever. Counted apart because calling
   *  them "waiting" is a reassuring sentence about a stuck state. */
  no_day: number;
  in_progress: number;
  failed: number;
  words_ms: number;
};
export type VisitCounts = { built: number; open: number };

/**
 * NOTHING IS TRYING, so nothing can be told to stop (Build 1 §3.4).
 *
 * The lane used to read "N waiting to be turned into words" and the attention row beneath it
 * offered to turn Transcript off "if you want it to stop trying". There is no scheduled pass
 * anywhere in this system: a person runs each one by hand, from the admin screen. So the queue
 * is not a queue that is being worked through slowly — it is a queue nobody has started, and
 * the copy now says which. Offering to stop something that is not running teaches an operator
 * that the words on this screen are decorative.
 */
export const WAITING_PHRASE = "waiting for someone to run it";

export function tapeLane(r: {
  recording: boolean; paused_session: boolean; stalled: boolean; stalled_age_ms: number | null;
  session_started_at: string | null; primary_chunks: number; nowMs: number;
}): LaneView {
  if (r.stalled) {
    return { level: "red", state: `Says recording, silent ${fmtCoarse(r.stalled_age_ms ?? 0)}`, enabled: null };
  }
  if (r.paused_session) return { level: "amber", state: "Paused for consent", enabled: null };
  if (r.recording) {
    const since = r.session_started_at === null ? null : Date.parse(r.session_started_at);
    const dur = since === null || !Number.isFinite(since) ? null : r.nowMs - since;
    const pieces = `${r.primary_chunks} piece${r.primary_chunks === 1 ? "" : "s"}`;
    return { level: "ok", state: dur === null ? `Recording · ${pieces}` : `Recording · ${fmtCoarse(dur)} · ${pieces}`, enabled: null };
  }
  return { level: "off", state: "Not recording", enabled: null };
}

/**
 * PURE — the Transcript lane, in plain words (PRD §7 and the approved mockup).
 *
 * THE RULE THAT MATTERS IS R6: GREEN MEANS WORKING. A lane that is switched on with nothing to
 * do is GREY and says "On, nothing to do". It is not green. An "on" lamp glowing over a room
 * where nothing is happening is precisely the display that let a nine-hour fault sit unnoticed
 * on Friday night.
 */
export function transcriptLane(enabled: boolean, c: TranscriptCounts, hasRoomDayToday: boolean | null = null): LaneView {
  if (!enabled) return { level: "off", state: "Off", enabled: false };
  // Tolerant of a missing count, like normaliseSessions: an absent number is 0, never NaN. NaN
  // here would silently render a room as healthy — every comparison against it is false.
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const noDay = n(c.no_day);

  // ── THE STUCK STATE, FIRST, because it outranks every count below it ──────────────────────
  //
  // Windows recorded with no room_day cannot be processed at all. They are not queued and they
  // never will be, so they are reported apart from `waiting` and they carry the fix.
  //
  // GUARDED ON THE DAY ACTUALLY BEING ABSENT, and this guard is not optional. A window is
  // created bound to whatever day exists at that moment, so on an ordinary morning the first
  // window of the day is often written before the mark is pressed and binds on the very next
  // evaluation pass. Alarming on `no_day > 0` alone would therefore fire in every room every
  // morning for one chunk cycle, and an alarm that cries wolf daily is one nobody reads by
  // Wednesday. It fires only when there is genuinely NO day — the state that does not clear on
  // its own. `null` (we could not tell) is never treated as "no".
  if (noDay > 0 && hasRoomDayToday === false) {
    return { level: "amber", state: NO_DAY_LANE_STATE(noDay), enabled: true, note: NO_DAY_FIX };
  }

  // Anything still unbound while a day DOES exist is transient — the writer backfills
  // room_day_id on the next pass — so it is counted with the queue rather than alarmed about.
  const waiting = n(c.waiting) + (hasRoomDayToday === false ? 0 : noDay);
  const busy = n(c.done) + waiting + n(c.in_progress) + n(c.failed);
  if (busy === 0) return { level: "off", state: "On, nothing to do", enabled: true };
  const parts: string[] = [`${n(c.done)} done`];
  if (waiting > 0) parts.push(`${waiting} ${WAITING_PHRASE}`);
  if (n(c.in_progress) > 0) parts.push(`${n(c.in_progress)} in progress`);
  if (n(c.failed) > 0) parts.push(`${n(c.failed)} failed`);
  // AMBER when anything is waiting or has given up — those are the two states a person can act
  // on. Green only when the queue is empty and nothing failed, which is what "up to date" means.
  const behind = waiting > 0 || n(c.failed) > 0;
  return {
    level: behind ? "amber" : "ok",
    state: behind ? parts.join(", ") : `${parts.join(", ")} · up to date`,
    enabled: true,
  };
}

export function visitsLane(enabled: boolean, v: VisitCounts): LaneView {
  if (!enabled) return { level: "off", state: "Off", enabled: false };
  if (v.built === 0) return { level: "off", state: "On, nothing to do", enabled: true };
  return { level: "ok", state: `${v.built} today · ${v.open} open`, enabled: true };
}

// ---------------------------------------------------------------------------
// STRANDED AUDIO — minutes that cannot currently be turned into words (D7)
// ---------------------------------------------------------------------------

/**
 * THE NUMBER THAT WAS MISSING. Build 1 §3.3.
 *
 * The page counted PIECES and never said how much TIME could not be turned into words. On
 * 24 August that figure was over eight hours across the estate and it was nowhere on the screen.
 * Worse, the one count it did show was itself misleading: Cardiology's card read "17 waiting",
 * but all seventeen were finished windows with NO JOB ROW AT ALL. Nothing had ever been
 * enqueued, so "waiting" described a queue that did not exist.
 *
 * MEASURED IN WINDOW SPANS, WHICH IS NOT THE SAME MEASURE AS "AUDIO RECORDED". A window is a
 * fifteen-minute grid slot, so its span is fifteen minutes whether it holds fifteen minutes of
 * speech or three. "Audio recorded" sums the pieces themselves. The two numbers are honest and
 * they are NOT comparable, and every surface that shows both says so out loud — see
 * STRANDED_MEASURE_NOTE. Presenting them side by side without that sentence would invite the
 * subtraction nobody should do.
 */
export const STRANDED_MEASURE_NOTE =
  "counted in 15-minute slots — “audio recorded” sums the pieces themselves, so the two are measured differently and do not subtract";

/** The three reasons, in the operator's words. Nothing here says window, drain, job or subject. */
export const STRANDED_WAITING = "waiting for someone to run it";
export const STRANDED_NO_DAY = "cannot be processed — this room has no day record for today";
export const STRANDED_NEVER_CLOSED = "never closed — the recording did not cover the whole slot";

/**
 * The raw buckets the shared read returns, DISJOINT by construction so they can be summed.
 *
 * They are split by whether the slot is bound to a day because the reporting depends on a fact
 * the read cannot see: whether a day exists for this room at all. See strandedAudio.
 */
export type StrandedRaw = {
  /** finished slot, no job row, bound to a day */
  closed_no_job_ms: number;
  closed_no_job_n: number;
  /** finished slot, no job row, NOT bound to a day */
  closed_no_job_no_day_ms: number;
  closed_no_job_no_day_n: number;
  /** still open although its session ended, bound to a day */
  open_after_end_ms: number;
  open_after_end_n: number;
  /** still open although its session ended, NOT bound to a day */
  open_after_end_no_day_ms: number;
  open_after_end_no_day_n: number;
};

export type StrandedReason = { reason: string; ms: number; slots: number };
export type Stranded = {
  total_ms: number;
  waiting_ms: number;
  no_day_ms: number;
  never_closed_ms: number;
  /** Only the non-zero reasons, worst first — the shape both the card and the door render. */
  reasons: StrandedReason[];
};

export const ZERO_STRANDED_RAW: StrandedRaw = {
  closed_no_job_ms: 0, closed_no_job_n: 0,
  closed_no_job_no_day_ms: 0, closed_no_job_no_day_n: 0,
  open_after_end_ms: 0, open_after_end_n: 0,
  open_after_end_no_day_ms: 0, open_after_end_no_day_n: 0,
};

/**
 * PURE — raw buckets → the three reasons an operator can read and act on.
 *
 * THE FALSE-ALARM GUARD IS THE SAME ONE THE LANE USES, and for the same reason. A slot is bound
 * to whatever day exists when it is written, so on an ordinary morning the first slot of the day
 * is often written before Mark consult is pressed and binds on the very next evaluation pass.
 * Reporting "cannot be processed — no day record" on `room_day_id IS NULL` alone would print
 * that sentence in every room every morning for one chunk cycle. It is reported only when there
 * is genuinely NO day for the room today, which is the state that does not clear on its own.
 *
 * `null` — the brain read failed and we cannot tell — is never read as "no". Those minutes are
 * reported under their ordinary reason instead, which understates rather than invents. That is
 * the right direction: this build exists because false alarms buried a true one.
 */
export function strandedAudio(raw: StrandedRaw, hasRoomDayToday: boolean | null): Stranded {
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const genuinelyNoDay = hasRoomDayToday === false;

  const no_day_ms = genuinelyNoDay ? n(raw.closed_no_job_no_day_ms) + n(raw.open_after_end_no_day_ms) : 0;
  const no_day_n = genuinelyNoDay ? n(raw.closed_no_job_no_day_n) + n(raw.open_after_end_no_day_n) : 0;
  const waiting_ms = n(raw.closed_no_job_ms) + (genuinelyNoDay ? 0 : n(raw.closed_no_job_no_day_ms));
  const waiting_n = n(raw.closed_no_job_n) + (genuinelyNoDay ? 0 : n(raw.closed_no_job_no_day_n));
  const never_closed_ms = n(raw.open_after_end_ms) + (genuinelyNoDay ? 0 : n(raw.open_after_end_no_day_ms));
  const never_closed_n = n(raw.open_after_end_n) + (genuinelyNoDay ? 0 : n(raw.open_after_end_no_day_n));

  // Worst first: the one that never clears on its own, then the one a person can run, then the
  // one that is a gap in the tape rather than a gap in the processing.
  const reasons: StrandedReason[] = [
    { reason: STRANDED_NO_DAY, ms: no_day_ms, slots: no_day_n },
    { reason: STRANDED_WAITING, ms: waiting_ms, slots: waiting_n },
    { reason: STRANDED_NEVER_CLOSED, ms: never_closed_ms, slots: never_closed_n },
  ].filter((r) => r.ms > 0 || r.slots > 0);

  return { total_ms: no_day_ms + waiting_ms + never_closed_ms, waiting_ms, no_day_ms, never_closed_ms, reasons };
}

/** Sum of several rooms' stranded audio, for the day card. Reasons are merged, not concatenated. */
export function strandedTotal(all: readonly Stranded[]): Stranded {
  const waiting_ms = all.reduce((a, s) => a + s.waiting_ms, 0);
  const no_day_ms = all.reduce((a, s) => a + s.no_day_ms, 0);
  const never_closed_ms = all.reduce((a, s) => a + s.never_closed_ms, 0);
  const slots = (reason: string) => all.reduce((a, s) => a + (s.reasons.find((r) => r.reason === reason)?.slots ?? 0), 0);
  const reasons: StrandedReason[] = [
    { reason: STRANDED_NO_DAY, ms: no_day_ms, slots: slots(STRANDED_NO_DAY) },
    { reason: STRANDED_WAITING, ms: waiting_ms, slots: slots(STRANDED_WAITING) },
    { reason: STRANDED_NEVER_CLOSED, ms: never_closed_ms, slots: slots(STRANDED_NEVER_CLOSED) },
  ].filter((r) => r.ms > 0 || r.slots > 0);
  return { total_ms: waiting_ms + no_day_ms + never_closed_ms, waiting_ms, no_day_ms, never_closed_ms, reasons };
}
