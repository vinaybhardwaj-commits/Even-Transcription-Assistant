/**
 * lib/room-watchdog.ts — the Room Watchdog (bench/device-missing-row-state, 19 Sep 2026).
 *
 * WHY. ORB3, a theatre recorder, lost mains power three times between Friday 14:26 and Saturday
 * 07:22. 16.8 hours of recording lost. The machine behaved perfectly — it powered itself back on
 * every time and refused to write fake silence into the tape — but a room can be dark for nine
 * hours and the only way to find out was for a human to go and look. This module is that look,
 * automated: a cron (GET /api/admin/room-watchdog) reads every enabled room's install row once a
 * minute and says something the moment a room crosses INTO a bad state or back OUT of one.
 *
 * D1 EDGE-TRIGGERED, NOT LEVEL-TRIGGERED. `planWatchdogRun` only ever emits a message on a status
 * CHANGE. A room sitting in `degraded` for six hours produces one message when it enters and one
 * when it genuinely recovers (a clean poll alone is not enough while a session is open; see GENUINE RECOVERY below) — never a repeat in
 * between. `room_alert_state` (migration 0103) is what makes
 * that possible: it is the only place the watchdog's own idea of "what did I last say about this
 * room" is kept.
 *
 * D2 SEED, NEVER ALERT ON HISTORY. A room with no `room_alert_state` row (`prior === null`) has
 * never been evaluated. Its first run records whatever status it is in right now and says nothing
 * — a room that has been `needs_attention` for days before this feature existed must not produce a
 * message the instant the feature ships.
 *
 * D7 WHAT COUNTS AS DEGRADED, AND WHY IT IS NOT A THIRD LIST. `FLAG_REASON` below is a
 * DELIBERATE, NAMED DUPLICATE of `DEGRADED_STATE_FLAGS` in lib/room-install-view.ts (commit
 * 8968b71) — not a second, divergent classification. It cannot be imported: that constant is not
 * exported, and this build's file contract forbids editing lib/room-install-view.ts to export it.
 * FLAGGED: if 8968b71's set ever changes, this one must change with it, and nothing enforces that
 * today. Tape-stalled-while-open and disk-critical are re-derived from the same raw poll fields the
 * fleet card reads, using the fleet card's own `DISK_LOW_BYTES` (imported, not duplicated).
 *
 * NOT_DELIVERING (V's ruling, 19 Sep 2026, on the merge in the build report). `origin/vinay/s1-
 * auto-drain` shipped an INDEPENDENT degradation signal on the very line 8968b71 touches —
 * `notDelivering`, from the ETA-DELIVERY-EVIDENCE PRD: a room's open bench_session whose newest
 * chunk (`isBenchStalled`, lib/bench-reaper-core.ts, imported, never re-derived) is stale even
 * though the Mac's own poll looks fine. The two signals do not overlap and neither subsumes the
 * other — a Mac can poll a perfect `state_flags: []` while its upload path is wedged, and a
 * wedged Mac never gets to report a flag about itself at all — so the watchdog now evaluates
 * BOTH and the degraded message NAMES WHICH ONE FIRED. Silently picking one over the other was the
 * one thing the ruling explicitly forbade: it would delete a signal somebody deliberately shipped,
 * invisibly.
 */
import { sql } from "@/lib/db";
import { DISK_LOW_BYTES, SILENT_PEAK_MAX, SILENT_POLLS, SILENT_ZERO_RATIO, wrongInputCandidate } from "@/lib/bench-bus-constants";
import { isBenchStalled } from "@/lib/bench-reaper-core";
import { START_FAILED_MAX_MS } from "@/lib/bench-bus-constants";
import { listBenchSessions } from "@/lib/bench";
import { parseFlag } from "@/lib/flags";

// ---------------------------------------------------------------------------
// The watchdog's own vocabulary
// ---------------------------------------------------------------------------

export type RoomAlertStatus = "ok" | "offline" | "degraded";

/**
 * D4. A room polls about every 2 seconds, so 5 minutes is roughly 150 missed polls — long enough
 * that it cannot be a blip (a dropped packet, a GC pause) and short enough that "within about a
 * minute" (the goal) still holds once this threshold and the minute-cadence cron are added
 * together.
 */
export const OFFLINE_AFTER_MS = 5 * 60_000;

/** D3. "More than half" — strictly greater, so an exact half-and-half split still names names. */
export const FLEET_OUTAGE_FRACTION = 0.5;

export type OpenBenchSession = { status: string; started_at: string; last_any_chunk_at: string | null };

export type RoomPollFacts = {
  last_seen_at: string | null;
  tape_advancing: boolean | null;
  session_open: boolean | null;
  disk_free_bytes: number | null;
  /** The raw flags array from room_install.state_flags -> 'flags'. */
  state_flags: readonly string[];
  /** This room's currently-open (`status = 'recording'`) bench session, or null if none. */
  open_session: OpenBenchSession | null;
  /** Arch #22: the name of the attached input WRONG_INPUT_SUSPECTED points at, so the alert can name it. Absent/null: none known. */
  wrong_input_candidate?: string | null;
  /**
   * ARCH #17 — the room's NEWEST session is one that died at start (ended within START_FAILED_MAX_MS with no piece of either stream) and ended
   * inside START_DEATH_WINDOW_MS. Optional: absent/false adds nothing, so every caller that predates it is unchanged.
   */
  start_died?: boolean;
};

/**
 * ARCH #17: the app retries a start death (up to 3 attempts, pauses of ~2 s and ~5 s after ~15 s deaths). A death is only FINAL, and only then
 * alerted, once this long has passed with no newer session: a retry that opens one clears it, a kiosk that does not retry is alerted this much later.
 */
export const START_RETRY_GRACE_MS = 90_000;

/** ARCH #17: how long a dead start keeps the room degraded without a newer session to replace it. */
export const START_DEATH_WINDOW_MS = 30 * 60_000;

/**
 * One named reason a room reads `degraded`, so an alert can say WHICH evidence tripped rather than
 * a vague "something is wrong" — the four Tier 1 §2 flags this build classifies as degradation
 * (8968b71), the two raw-field conditions D7 adds, and `not_delivering` (the merge's other signal,
 * see the file header).
 */
export type DegradationReason =
  | "device_missing"
  | "silent_while_recording"
  | "wrong_input_suspected"
  | "clipping"
  | "encoder_stalled"
  | "tape_stalled"
  | "disk_critical"
  | "not_delivering"
  | "start_died";

const FLAG_REASON: Record<string, DegradationReason> = {
  DEVICE_MISSING: "device_missing",
  SILENT_WHILE_RECORDING: "silent_while_recording",
  WRONG_INPUT_SUSPECTED: "wrong_input_suspected",
  CLIPPING: "clipping",
  ENCODER_STALLED: "encoder_stalled",
};

export type RoomStatusResult = { status: RoomAlertStatus; reasons: DegradationReason[] };

/**
 * PURE — D4 (offline) then D7 (degraded), worst first, exactly like the fleet card's own
 * precedence. A room that has not polled recently cannot be said to be "degraded": nothing it last
 * reported is still current enough to judge, and `not_delivering` (a fact about bytes landing in
 * storage, not about the Mac's poll) is not consulted either — offline already says the stronger
 * thing.
 */
export function computeRoomStatus(facts: RoomPollFacts, nowMs: number): RoomStatusResult {
  const lastSeenMs = facts.last_seen_at ? Date.parse(facts.last_seen_at) : NaN;
  if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > OFFLINE_AFTER_MS) {
    return { status: "offline", reasons: [] };
  }

  const reasons: DegradationReason[] = [];
  for (const f of facts.state_flags) {
    const reason = FLAG_REASON[f];
    if (reason) reasons.push(reason);
  }
  // Same condition lib/room-install-view.ts's attention reason 3 uses, re-derived here rather than
  // imported: deriveInstallView folds it into a sentence in `attention`, not a reusable boolean.
  if (facts.tape_advancing === false && facts.session_open === true) reasons.push("tape_stalled");
  if (facts.disk_free_bytes !== null && facts.disk_free_bytes < DISK_LOW_BYTES) reasons.push("disk_critical");
  if (facts.open_session !== null && isBenchStalled(facts.open_session, nowMs)) reasons.push("not_delivering");
  if (facts.start_died === true) reasons.push("start_died");

  return reasons.length > 0 ? { status: "degraded", reasons } : { status: "ok", reasons: [] };
}

// ---------------------------------------------------------------------------
// GENUINE RECOVERY (fleet-attention build, 5 Oct 2026)
// ---------------------------------------------------------------------------

/**
 * WHY. `computeRoomStatus` reads a room `ok` the moment its poll looks clean. A session that CLOSES looks clean — `session_open` goes false, so the
 * `tape_stalled` condition (tape not advancing while a session is open) stops holding — and a Mac that has gone into DarkWake still polls, so on
 * 5 Oct 2026 the watchdog announced `recovered` at 04:36 for rooms whose microphones had been frozen since 01:36. "The poll looks fine" is not "the
 * room is recording": recovery needs EVIDENCE OF AUDIO, which is what this is.
 *
 * GENUINE = a bench chunk newer than the alert (the room's `room_alert_state.since`) AND at least GENUINE_RECOVERY_MIN_DISTINCT distinct
 * (peak, zero_ratio) level values in the last 120 s. A microphone CoreAudio has stopped delivering from repeats ONE identical value for hours
 * (4,220 identical samples on OPD 6 from 01:36:52), so two distinct values is the cheapest honest sign that the signal is moving.
 */
export const GENUINE_RECOVERY_MIN_DISTINCT = 2;
export const RECOVERY_LEVEL_WINDOW_S = 120;
/**
 * RECOVERY DWELL (Arch #14 acceptance add, 6-7 Oct 2026). Alerts 545-575 flipped OPD5 degraded <-> "recovering" on peaks of 0.0001-0.004 while
 * `zero_ratio` sat near 1: two distinct values satisfy GENUINE_RECOVERY_MIN_DISTINCT, and a dead tape produces them.
 *
 * SCOPE (herdr-lead ruling on F3): the dwell applies ONLY to the recovery of an alert that included SILENT_WHILE_RECORDING (`silent_alert`). An
 * offline, DEVICE_MISSING, CLIPPING, disk-low or encoder-stalled alert recovers as it always did: a quiet clinic must not hold those open.
 *
 * WHAT "LIVE" MEANS HERE, AND A DELIBERATE DELTA FROM THE FIRE PATH. A sample is live when `zero_ratio` is well under the digital-silence line
 * (below RECOVERY_LIVE_MAX_ZERO_RATIO) AND its `peak` is at or above RECOVERY_LIVE_MIN_PEAK. The fire path uses SILENT_PEAK_MAX (0.01), calibrated
 * on the checkpoint's TRUE peak (speak-test 0.012-0.026). `bench_level_sample.peak` on the Mac is the checkpoint RMS (RoomEngine.currentLevels sends
 * peak = average = rms), which sits well below the true peak for the same speech, so 0.01 would leave soft speech never live. The recovery floor is
 * 0.005, about the 0.007 noise floor of a healthy C270 (MUTE_PEAK in rooms-live/state.ts documents it) and far above the 0.0001-0.004 ticks of the
 * 545-575 flaps. The fire floor is unchanged.
 *
 * At least RECOVERY_MIN_LIVE_SAMPLES live samples, and at least RECOVERY_MIN_LIVE_SHARE of the window's samples. One tiny tick cannot clear degraded.
 * KNOWN LIMIT: a steady tone or hum with energy above the floor reads as live; there is no spectral data to tell it from speech.
 */
export const RECOVERY_LIVE_MAX_ZERO_RATIO = 0.5;
export const RECOVERY_LIVE_MIN_PEAK = 0.005;
export const RECOVERY_MIN_LIVE_SAMPLES = 20;
export const RECOVERY_MIN_LIVE_SHARE = 0.5;
/** The two wordings of the silent reason in an outbox body: the current one and the one written before Arch #14. */
export const SILENT_ALERT_BODY_MARKERS = ["digital silence on the capture", "silence while recording"] as const;

export type RecoveryEvidence = {
  /** a bench_chunk row (any session of the room) created after the alert began */
  chunk_after_alert: boolean;
  /** distinct (peak, zero_ratio) values among the room's level samples in the last RECOVERY_LEVEL_WINDOW_S */
  distinct_levels: number;
  /** level samples in the same window that are live (see RECOVERY DWELL). Absent: the caller does not read the dwell and only the other two tests apply. */
  live_samples?: number;
  /** all level samples in the same window */
  total_samples?: number;
  /** The alert being recovered included SILENT_WHILE_RECORDING. The dwell is tested only when this is true. */
  silent_alert?: boolean;
};

/** PURE. `null` (evidence could not be read) is NOT genuine: an alert stays open rather than closing on a guess. */
export function isGenuineRecovery(ev: RecoveryEvidence | null | undefined): boolean {
  if (!(ev && ev.chunk_after_alert && ev.distinct_levels >= GENUINE_RECOVERY_MIN_DISTINCT)) return false;
  if (ev.silent_alert !== true || ev.live_samples === undefined || ev.total_samples === undefined) return true;
  return ev.live_samples >= RECOVERY_MIN_LIVE_SAMPLES && ev.live_samples >= ev.total_samples * RECOVERY_MIN_LIVE_SHARE;
}

// ---------------------------------------------------------------------------
// The four message shapes
// ---------------------------------------------------------------------------

/**
 * `kind`, `room_ids`, `room_name`, `status_from` and `status_to` are what the ALERT OUTBOX needs (migration 0119). `planWatchdogRun` always sets
 * them; the four builders below still return just subject and text, so every existing caller of them is unchanged.
 */
export type WatchdogKind = "offline" | "degraded" | "recovered" | "fleet_outage";
export type WatchdogMessage = {
  subject: string;
  text: string;
  kind?: WatchdogKind;
  /** The rooms this alert is about: one for an individual message, every room that crossed into offline for a fleet_outage. */
  room_ids?: string[];
  room_name?: string;
  status_from?: RoomAlertStatus | null;
  status_to?: RoomAlertStatus;
};

function fmtDuration(ms: number): string {
  const totalMins = Math.max(1, Math.round(ms / 60_000));
  if (totalMins < 60) return `${totalMins} min`;
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins === 0 ? `${hrs} h` : `${hrs} h ${mins} min`;
}

/** "a" / "a and b" / "a, b, and c" — English list joining for the degraded message's reasons. */
function andJoin(parts: readonly string[]): string {
  if (parts.length === 0) return "an unnamed condition";
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * The evidence behind each `DegradationReason`, in the order `computeRoomStatus` can produce them
 * (Tier 1 §2 flags in their canonical order, then the two raw-field conditions, then delivery).
 * `not_delivering` is phrased separately from the rest because it is evidence of a DIFFERENT kind
 * — not what the Mac's poll says about itself, but whether its bytes are reaching storage — and
 * V's ruling requires the message to be able to say which one fired.
 */
export const REASON_LABEL: Record<DegradationReason, string> = {
  device_missing: "a missing input device",
  silent_while_recording: "digital silence on the capture (exact zeros, not a quiet room)",
  wrong_input_suspected: "the recorder may be on the wrong input (another input is attached)",
  clipping: "clipping",
  encoder_stalled: "a stalled encoder",
  tape_stalled: "a stalled tape",
  disk_critical: "critically low disk",
  not_delivering: "no audio reaching storage, independent of what the Mac itself reports",
  start_died: "a recording that died at start (the recorder exited within seconds and no audio was captured)",
};

export function offlineMessage(roomName: string, atIso: string): WatchdogMessage {
  return {
    subject: `EvenScribe watchdog: ${roomName} is offline`,
    text: `${roomName} has not polled in over 5 minutes, as of ${atIso}. Nothing is being recorded until it reconnects.`,
  };
}

export function degradedMessage(roomName: string, reasons: readonly DegradationReason[], atIso: string, wrongInputCandidate?: string | null): WatchdogMessage {
  const why = andJoin(reasons.map((r) =>
    r === "wrong_input_suspected" && wrongInputCandidate
      ? `the recorder may be on the wrong input (another input is attached: ${wrongInputCandidate})`
      : REASON_LABEL[r]));
  return {
    subject: `EvenScribe watchdog: ${roomName} capture is degraded`,
    text: `${roomName} is polling but its capture looks degraded — ${why} — as of ${atIso}. Go and look.`,
  };
}

export function recoveryMessage(
  roomName: string,
  previousStatus: RoomAlertStatus,
  downForMs: number,
  atIso: string,
): WatchdogMessage {
  const word = previousStatus === "offline" ? "offline" : "degraded";
  return {
    subject: `EvenScribe watchdog: ${roomName} is back`,
    text: `${roomName} recovered after being ${word} for ${fmtDuration(downForMs)}. It is recording normally again as of ${atIso}.`,
  };
}

/**
 * Arch #20. A room that is polling again with NO session open. There is no tape to prove audio with, so this does not say it is recording
 * normally (recoveryMessage does); it says what is known: the alert is over and the room is back. It exists so a return is never absent from
 * the history (7 Oct: OPD4, OPD5 and Dietary came back after S15/S16 and the watchdog wrote nothing).
 */
export function quietRecoveryMessage(roomName: string, previousStatus: RoomAlertStatus, downForMs: number, atIso: string): WatchdogMessage {
  // A room that was DEGRADED (it was polling the whole time) and now has no open session has not "come back": its session ended or was closed, and the
  // watchdog has nothing to say about whether capture is healthy. Only a room that was OFFLINE can say it is polling normally again.
  if (previousStatus === "degraded") {
    return {
      subject: `EvenScribe watchdog: ${roomName} alert cleared, no session open`,
      text: `${roomName}'s degraded alert was cleared as of ${atIso} after ${fmtDuration(downForMs)}: the session ended or was closed, and no recording session is open now. Capture was not confirmed healthy.`,
    };
  }
  const word = "offline";
  return {
    subject: `EvenScribe watchdog: ${roomName} is back`,
    text: `${roomName} is polling normally again after being ${word} for ${fmtDuration(downForMs)}, as of ${atIso}. No recording session is open, so audio is not yet confirmed.`,
  };
}

/** Arch #20. Several rooms clearing in one run: ONE cluster-cleared message beside the per-room ones. */
/** IST clinic window for the quiet history rows (Arch #20 F2): 07:30 inclusive to 21:30 exclusive. Overnight rooms coming back in the morning write nothing. */
export const CLINIC_WINDOW_START_IST_MIN = 7 * 60 + 30;
export const CLINIC_WINDOW_END_IST_MIN = 21 * 60 + 30;
/** PURE. Was this instant inside the IST clinic window? An unparseable instant is NOT (it writes nothing rather than guess). */
export function inClinicWindow(iso: string): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const minutes = Math.floor((((t + 330 * 60_000) % 86_400_000) + 86_400_000) % 86_400_000 / 60_000);
  return minutes >= CLINIC_WINDOW_START_IST_MIN && minutes < CLINIC_WINDOW_END_IST_MIN;
}

export function clusterClearedMessage(roomNames: readonly string[], atIso: string): WatchdogMessage {
  return {
    subject: `EvenScribe watchdog: ${roomNames.length} rooms are back`,
    text: `${roomNames.length} rooms cleared in the same run, as of ${atIso}: ${andJoin(roomNames)}. Each room has its own recovery row.`,
  };
}

export function fleetOutageMessage(count: number, total: number, atIso: string): WatchdogMessage {
  return {
    subject: `EvenScribe watchdog: ${count} rooms went offline at once`,
    text: `${count} of ${total} enabled rooms went offline in the same run, as of ${atIso}. This looks like a network or platform outage, not ${count} separate room failures. Individual offline alerts are suppressed for this event.`,
  };
}

// ---------------------------------------------------------------------------
// Per-run planning — PURE, no DB, no network. This is what the behaviour tests drive.
// ---------------------------------------------------------------------------

export type RoomRunInput = {
  room_id: string;
  room_name: string;
  facts: RoomPollFacts;
  /** null = no room_alert_state row yet — this room has never been evaluated (D2). */
  prior: { status: RoomAlertStatus; since: string } | null;
  /** now < muted_until, read by the caller. */
  muted: boolean;
  /**
   * Evidence that audio is really flowing again, consulted ONLY when this run would announce a recovery (prior offline/degraded, now ok) and
   * only while a session is open; with no session open the alert closes quietly instead (see planWatchdogRun).
   * `undefined` = the caller did not check (the pure planner's legacy behaviour: the poll alone decides). `null` = the caller tried and could not
   * read it. runWatchdog always supplies it for a room whose prior status is not ok.
   */
  recovery_evidence?: RecoveryEvidence | null;
};

export type RoomWrite = { room_id: string; status: RoomAlertStatus; since: string };

export type WatchdogPlan = {
  messages: WatchdogMessage[];
  writes: RoomWrite[];
};

/**
 * PURE — D1 through D5, D7 combined. Takes this run's facts and each room's prior status, returns
 * the messages to send and the rows to write. Does not touch the database or the network, so every
 * behaviour the order asks for is testable without either.
 */
export function planWatchdogRun(inputs: readonly RoomRunInput[], nowMs: number): WatchdogPlan {
  const nowIso = new Date(nowMs).toISOString();
  const messages: WatchdogMessage[] = [];
  const writes: RoomWrite[] = [];

  const individualOffline: { room_id: string; room_name: string; from: RoomAlertStatus }[] = [];
  const offlineRoomIds: string[] = []; // D3 numerator — every room crossing into offline, muted or not.
  let offlineTransitions = 0;
  const cleared: { room_id: string; room_name: string; alert_in_clinic_window: boolean }[] = []; // Arch #20 — rooms whose alert cleared this run, for the cluster-cleared event.

  for (const input of inputs) {
    const { status: newStatus, reasons } = computeRoomStatus(input.facts, nowMs);

    // D2: never seen before. Record it, say nothing — whatever state it is already in is older
    // than this feature.
    if (input.prior === null) {
      writes.push({ room_id: input.room_id, status: newStatus, since: nowIso });
      continue;
    }

    // D1: no change, no write, no message. This is the whole point of an edge trigger.
    if (newStatus === input.prior.status) continue;

    // RECOVERY, for a caller that supplies evidence (runWatchdog always does).
    //  - A session is OPEN: a clean poll is not proof of audio (see GENUINE_RECOVERY_MIN_DISTINCT). Without a chunk newer than the alert and a moving
    //    level signal the alert stays OPEN: no write (so the room's `since` and status stand) and no `recovered` message.
    //  - NO session is open and the poll is clean: there is no tape to prove anything about, so a room closed for the day must not stay
    //    offline/degraded forever (which would also swallow its NEXT outage, an edge-triggered alert needs the state to return to ok). The state
    //    is CLOSED QUIETLY: the write lands, no message is planned, so no outbox row and no "recovered" text — it was never proven. This needs no new
    //    outbox kind and no new status, so no CHECK change. (An audit row for the quiet close would need a new outbox kind, which is a CHECK change.)
    if (newStatus === "ok" && input.recovery_evidence !== undefined) {
      const sessionOpen = input.facts.open_session !== null || input.facts.session_open === true;
      if (!sessionOpen) {
        writes.push({ room_id: input.room_id, status: "ok", since: nowIso });
        // Arch #20: the state still closes without proof, but the return is no longer absent from the history. A muted room keeps its silence (D9).
        // F2: and only for an alert that was raised inside the clinic window; an overnight room coming back in the morning writes nothing.
        if (!input.muted && inClinicWindow(input.prior.since)) {
          cleared.push({ room_id: input.room_id, room_name: input.room_name, alert_in_clinic_window: true });
          messages.push({
            ...quietRecoveryMessage(input.room_name, input.prior.status, nowMs - Date.parse(input.prior.since), nowIso),
            kind: "recovered", room_ids: [input.room_id], room_name: input.room_name, status_from: input.prior.status, status_to: "ok",
          });
        }
        continue;
      }
      if (!isGenuineRecovery(input.recovery_evidence)) continue;
    }

    writes.push({ room_id: input.room_id, status: newStatus, since: nowIso });

    if (newStatus === "offline") {
      offlineTransitions += 1;
      offlineRoomIds.push(input.room_id);
      // D9: muted rooms still get the write above; they never get a message, individual or
      // fleet-wide, so they are simply left out of the individual-message candidate list here.
      if (!input.muted) individualOffline.push({ room_id: input.room_id, room_name: input.room_name, from: input.prior.status });
      continue;
    }

    if (input.muted) continue; // D9

    if (newStatus === "degraded") {
      // V's ruling: name WHICH signal tripped — the classifier, not_delivering, or both.
      messages.push({
        ...degradedMessage(input.room_name, reasons, nowIso, input.facts.wrong_input_candidate),
        kind: "degraded", room_ids: [input.room_id], room_name: input.room_name, status_from: input.prior.status, status_to: "degraded",
      });
    } else {
      // newStatus === "ok" with a session open (or a legacy caller that supplied no evidence): the recovery is sent, naming how long it was gone.
      // runWatchdog only reaches here for a room whose recovery is GENUINE (see above); an unproven one `continue`d, a closed-for-the-day one closed quietly.
      const downForMs = nowMs - Date.parse(input.prior.since);
      cleared.push({ room_id: input.room_id, room_name: input.room_name, alert_in_clinic_window: inClinicWindow(input.prior.since) });
      messages.push({
        ...recoveryMessage(input.room_name, input.prior.status, downForMs, nowIso),
        kind: "recovered", room_ids: [input.room_id], room_name: input.room_name, status_from: input.prior.status, status_to: "ok",
      });
    }
  }

  // D3: more than half the enabled rooms crossing into offline in one run is the network, not N
  // rooms — one message naming the count, and the individual offline messages are swallowed.
  //
  // `>= 2` GUARDS THE DEGENERATE CASE a pure fraction check misses: on a fleet of one room (or a
  // run where the only room crossing into offline happens to be muted, so it is the only one that
  // "counts"), one offline room is mathematically ">50% of the fleet" but is plainly not a
  // fleet-wide outage — it is one room. Found by this build's own tests, not specified by D3, and
  // flagged in the report.
  const enabledCount = inputs.length;
  if (offlineTransitions >= 2 && offlineTransitions > enabledCount * FLEET_OUTAGE_FRACTION) {
    messages.push({
      ...fleetOutageMessage(offlineTransitions, enabledCount, nowIso),
      kind: "fleet_outage", room_ids: offlineRoomIds, status_from: null, status_to: "offline",
    });
  } else {
    for (const room of individualOffline) {
      messages.push({
        ...offlineMessage(room.room_name, nowIso),
        kind: "offline", room_ids: [room.room_id], room_name: room.room_name, status_from: room.from, status_to: "offline",
      });
    }
  }

  // Arch #20: two or more rooms clearing in one run (the S12/S15/S16 shape) also get one cluster-cleared row naming them all. No new outbox kind:
  // it is a `recovered` row with several room_ids, so no CHECK change (arch #21 is widening that constraint in 0132).
  // Only rooms whose alert was raised inside the clinic window count toward it (F2).
  const clusterRooms = cleared.filter((c) => c.alert_in_clinic_window);
  if (clusterRooms.length >= 2) {
    messages.push({
      ...clusterClearedMessage(clusterRooms.map((c) => c.room_name), nowIso),
      kind: "recovered", room_ids: clusterRooms.map((c) => c.room_id), status_from: null, status_to: "ok",
    });
  }

  return { messages, writes };
}

// ---------------------------------------------------------------------------
// D8 — two channels, independent. Each sender is self-contained: a missing secret or a thrown
// error is caught INSIDE the sender, logged by name, and turned into a result — never a rejection
// that could take the other channel or the cron run down with it.
// ---------------------------------------------------------------------------

export type SendResult = { channel: "email" | "whatsapp"; ok: boolean; detail: string };

export async function sendEmailAlert(msg: WatchdogMessage): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.WATCHDOG_ALERT_EMAIL_TO;
  const missing = [
    !apiKey && "RESEND_API_KEY",
    !from && "RESEND_FROM_EMAIL",
    !to && "WATCHDOG_ALERT_EMAIL_TO",
  ].filter((v): v is string => Boolean(v));
  if (missing.length > 0) {
    console.error(`[room-watchdog] email channel not configured — missing ${missing.join(", ")}`);
    return { channel: "email", ok: false, detail: `not_configured:${missing.join(",")}` };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: msg.subject, text: msg.text }),
      cache: "no-store",
    });
    if (!r.ok) {
      console.error(`[room-watchdog] email send failed: resend_${r.status}`);
      return { channel: "email", ok: false, detail: `resend_${r.status}` };
    }
    return { channel: "email", ok: true, detail: "sent" };
  } catch (e) {
    console.error("[room-watchdog] email send threw:", e instanceof Error ? e.message : String(e));
    return { channel: "email", ok: false, detail: "threw" };
  }
}

export async function sendWhatsAppAlert(msg: WatchdogMessage): Promise<SendResult> {
  const apiKey = process.env.WASENDER_API_KEY;
  const baseUrl = process.env.WASENDER_BASE_URL;
  const to = process.env.WASENDER_ALERT_TO;
  const missing = [
    !apiKey && "WASENDER_API_KEY",
    !baseUrl && "WASENDER_BASE_URL",
    !to && "WASENDER_ALERT_TO",
  ].filter((v): v is string => Boolean(v));
  if (missing.length > 0 || !apiKey || !baseUrl || !to) {
    console.error(`[room-watchdog] whatsapp channel not configured — missing ${missing.join(", ")}`);
    return { channel: "whatsapp", ok: false, detail: `not_configured:${missing.join(",")}` };
  }
  try {
    // INFERRED, UNVERIFIED — WaSender's exact request shape was not available to read. This is
    // the conventional gateway shape (bearer auth, JSON {to, text}); confirm against WaSender's
    // own docs before relying on it, and see the report.
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/send-message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to, text: `${msg.subject}\n\n${msg.text}` }),
      cache: "no-store",
    });
    if (!r.ok) {
      console.error(`[room-watchdog] whatsapp send failed: wasender_${r.status}`);
      return { channel: "whatsapp", ok: false, detail: `wasender_${r.status}` };
    }
    return { channel: "whatsapp", ok: true, detail: "sent" };
  } catch (e) {
    console.error("[room-watchdog] whatsapp send threw:", e instanceof Error ? e.message : String(e));
    return { channel: "whatsapp", ok: false, detail: "threw" };
  }
}

/** D8 — both channels fire independently; neither's outcome affects the other. */
export async function dispatch(msg: WatchdogMessage): Promise<SendResult[]> {
  const [email, whatsapp] = await Promise.allSettled([sendEmailAlert(msg), sendWhatsAppAlert(msg)]);
  return [
    email.status === "fulfilled" ? email.value : { channel: "email", ok: false, detail: "threw_outside_try" },
    whatsapp.status === "fulfilled" ? whatsapp.value : { channel: "whatsapp", ok: false, detail: "threw_outside_try" },
  ];
}

// ---------------------------------------------------------------------------
// The DB-touching orchestrator. Not unit-tested directly (no live database in this sandbox, per
// this repo's CLAUDE.md) — every query below is INFERRED and listed verbatim in the report.
// ---------------------------------------------------------------------------

type FleetRow = {
  room_id: string;
  room_name: string;
  last_seen_at: string | null;
  tape_advancing: boolean | null;
  session_open: boolean | null;
  disk_free_bytes: number | null;
  state_flags: unknown;
  input_device_name?: string | null;
  input_devices?: unknown;
  prior_status: RoomAlertStatus | null;
  prior_since: string | null;
  muted_until: string | null;
};

export type WatchdogRunResult = {
  ok: boolean;
  evaluated: number;
  /** The planner's messages this run. With ROOM_WATCHDOG_PAGE_V off (the default) NONE is emailed or WhatsApped; see alerts_queued. */
  messages_sent: number;
  /** Outbox rows actually inserted by this run (the messages whose rooms really changed in the statement). */
  alerts_queued: number;
  writes: number;
  channel_results: SendResult[];
  error?: string;
};

/**
 * THE V-PAGING CHANNELS (email, WhatsApp) ARE OFF UNLESS ROOM_WATCHDOG_PAGE_V IS ON (Fable ruling 128(a): the alert path is the bus and the
 * conductor board, no V pages). The senders stay in this file, marked not deleted. An unparseable value is OFF and logged: a typo in an env var
 * must never take the watchdog down.
 */
export function pageVEnabled(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return parseFlag("ROOM_WATCHDOG_PAGE_V", env);
  } catch {
    console.error("[room-watchdog] ROOM_WATCHDOG_PAGE_V has an unrecognised value — treating it as OFF");
    return false;
  }
}

/**
 * ONE STATEMENT: the state advance and the alert are the same fact (migration 0119; design rev 3).
 *
 *  - The outbox is fed from the planner's MESSAGES, never from the state writes. They are not one-to-one: a first observation (D2) and a muted
 *    room (D9) are a write with no message, and a fleet outage (D3) is N writes and ONE message. Feeding it from the writes would alert on
 *    history, alert muted rooms and split a fleet outage into N alerts.
 *  - `changed` (RETURNING of the upsert) is ONLY the race gate: an individual message is inserted iff its room really changed in THIS statement,
 *    a fleet_outage iff at least one of its rooms did. `IS DISTINCT FROM` means two overlapping runs cannot both win the same edge.
 *  - Rows are upserted in room_id order, so overlapping runs take their locks in the same order and cannot deadlock.
 *  - If the statement fails, NOTHING advanced and NOTHING was queued: the next minute re-plans the same edges and tries again.
 * Returns the number of outbox rows inserted.
 */
export async function persistPlan(plan: WatchdogPlan): Promise<number> {
  const writes = JSON.stringify(plan.writes);
  const queueable = plan.messages.filter((m) => m.kind && m.room_ids && m.room_ids.length > 0);
  if (queueable.length !== plan.messages.length) {
    // Today the planner drops nothing here (every message carries a kind and its rooms). If that ever changes, an alert would vanish silently
    // through this filter, so say so, with counts only (eta-refuter #422 finding 3).
    console.error(`[room-watchdog] ${plan.messages.length - queueable.length} of ${plan.messages.length} planned messages have no kind or rooms and CANNOT be queued`);
  }
  const messages = JSON.stringify(
    queueable
      .map((m) => ({
        kind: m.kind, room_ids: m.room_ids, room_name: m.room_name ?? null,
        status_from: m.status_from ?? null, status_to: m.status_to ?? null, subject: m.subject, body: m.text,
      })),
  );
  const rows = (await sql`
    WITH w AS (
      SELECT x.room_id, x.status, x.since::timestamptz AS since
        FROM jsonb_to_recordset(${writes}::jsonb) AS x(room_id text, status text, since text)
       ORDER BY x.room_id
    ), changed AS (
      INSERT INTO room_alert_state (room_id, status, since, updated_at)
      SELECT w.room_id, w.status, w.since, now() FROM w ORDER BY w.room_id
      ON CONFLICT (room_id) DO UPDATE
        SET status = EXCLUDED.status, since = EXCLUDED.since, updated_at = now()
        WHERE room_alert_state.status IS DISTINCT FROM EXCLUDED.status
      RETURNING room_id
    )
    INSERT INTO room_alert_outbox (kind, room_ids, room_name, status_from, status_to, subject, body)
    SELECT m.kind, m.room_ids, m.room_name, m.status_from, m.status_to, m.subject, m.body
      FROM jsonb_to_recordset(${messages}::jsonb)
           AS m(kind text, room_ids text[], room_name text, status_from text, status_to text, subject text, body text)
     WHERE EXISTS (SELECT 1 FROM changed c WHERE c.room_id = ANY (m.room_ids))
    RETURNING id
  `) as Array<{ id: unknown }>;
  return rows.length;
}

/**
 * THE WATCHDOG'S OWN PULSE. Written by every run, ok or not, so a stopped cron shows up as an age the read door computes on the database's clock.
 * A failure to write it is logged and swallowed: the pulse must never be the reason a run does not alert.
 */
export async function recordHeartbeat(ok: boolean, evaluated: number, error?: string): Promise<void> {
  try {
    await sql`
      INSERT INTO room_watchdog_heartbeat (id, last_run_at, last_ok, evaluated, last_error)
      VALUES (1, now(), ${ok}, ${evaluated}, ${error ?? null})
      ON CONFLICT (id) DO UPDATE
        SET last_run_at = now(), last_ok = EXCLUDED.last_ok, evaluated = EXCLUDED.evaluated, last_error = EXCLUDED.last_error
    `;
  } catch (e) {
    console.error("[room-watchdog] could not write the heartbeat:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * ONE READ: for every room whose watchdog status is not ok, is there a chunk newer than the alert (`room_alert_state.since`), and how many distinct
 * (peak, zero_ratio) level values did it report in the last RECOVERY_LEVEL_WINDOW_S seconds. Read-only. Both reads are per room
 * (`room_id = ras.room_id`): the level read rides the (room_id, ist_date, sampled_at) index with an ist_date and sampled_at bound; the chunk read
 * goes through the room's sessions (bench_session (room_id, started_at DESC)) that had not ended before the alert, then bench_chunk by session_id.
 */
export async function loadRecoveryEvidence(): Promise<Map<string, RecoveryEvidence>> {
  const rows = (await sql`
    SELECT ras.room_id,
           EXISTS (
             SELECT 1 FROM bench_chunk c JOIN bench_session s ON s.id = c.session_id
              WHERE s.room_id = ras.room_id AND (s.ended_at IS NULL OR s.ended_at > ras.since) AND c.created_at > ras.since
           ) AS chunk_after_alert,
           (
             SELECT count(*)::int FROM (
               SELECT DISTINCT b.peak, b.zero_ratio FROM bench_level_sample b
                WHERE b.room_id = ras.room_id
                  AND b.ist_date >= ((now() - interval '120 seconds') AT TIME ZONE 'Asia/Kolkata')::date
                  AND b.sampled_at > now() - interval '120 seconds'
             ) d
           ) AS distinct_levels,
           (
             SELECT count(*) FILTER (WHERE b.zero_ratio IS NOT NULL AND b.zero_ratio < ${RECOVERY_LIVE_MAX_ZERO_RATIO} AND b.peak >= ${RECOVERY_LIVE_MIN_PEAK})::int
               FROM bench_level_sample b
              WHERE b.room_id = ras.room_id
                AND b.ist_date >= ((now() - interval '120 seconds') AT TIME ZONE 'Asia/Kolkata')::date
                AND b.sampled_at > now() - interval '120 seconds'
           ) AS live_samples,
           (
             SELECT count(*)::int FROM bench_level_sample b
              WHERE b.room_id = ras.room_id
                AND b.ist_date >= ((now() - interval '120 seconds') AT TIME ZONE 'Asia/Kolkata')::date
                AND b.sampled_at > now() - interval '120 seconds'
           ) AS total_samples,
           (COALESCE((
             SELECT o.kind = 'degraded' AND (o.body LIKE '%' || ${SILENT_ALERT_BODY_MARKERS[0]} || '%' OR o.body LIKE '%' || ${SILENT_ALERT_BODY_MARKERS[1]} || '%')
               FROM room_alert_outbox o
              WHERE ras.room_id = ANY(o.room_ids) AND o.kind IN ('offline', 'degraded')
              ORDER BY o.created_at DESC, o.id DESC LIMIT 1
           ), false)
           -- C1 (ARCH-14 refute): the watchdog writes one outbox row per STATUS change, so a room already degraded for another reason that then goes
           -- digital-silent writes no new row. The level log still shows it: a room is held to the dwell too when, since this alert began, it logged
           -- SILENT_POLLS (80, about two minutes) of digital-silence samples (the fire rule's own ratio and peak floor).
           OR (
             SELECT count(*) FROM bench_level_sample s
              WHERE s.room_id = ras.room_id
                AND s.ist_date >= (ras.since AT TIME ZONE 'Asia/Kolkata')::date
                AND s.sampled_at > ras.since
                AND s.zero_ratio >= ${SILENT_ZERO_RATIO} AND s.peak < ${SILENT_PEAK_MAX}
           ) >= ${SILENT_POLLS}) AS silent_alert
      FROM room_alert_state ras
     WHERE ras.status <> 'ok'
  `) as Array<{ room_id: string; chunk_after_alert: boolean; distinct_levels: number | string; live_samples: number | string; total_samples: number | string; silent_alert: boolean }>;
  const m = new Map<string, RecoveryEvidence>();
  for (const r of rows) {
    m.set(r.room_id, {
      chunk_after_alert: Boolean(r.chunk_after_alert),
      distinct_levels: Number(r.distinct_levels) || 0,
      live_samples: Number(r.live_samples) || 0,
      total_samples: Number(r.total_samples) || 0,
      silent_alert: Boolean(r.silent_alert),
    });
  }
  return m;
}

/**
 * FAIL SAFE (the order's own words): "a watchdog that cannot read state must log loudly and send
 * nothing, never send a false alarm." The read is the only step allowed to abort the whole run;
 * once rows are in hand, one room's write failing is logged and skipped, never fatal to the rest.
 */
/** Arch #22. The candidate's name for the alert text, from whatever shape `input_devices` came back in (jsonb array or its text). Null on any doubt. */
function wrongInputCandidateName(selectedName: string | null | undefined, raw: unknown): string | null {
  let devices: unknown = raw;
  if (typeof raw === "string") {
    try { devices = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(devices)) return null;
  return wrongInputCandidate(devices as Parameters<typeof wrongInputCandidate>[0], selectedName)?.name ?? null;
}

export async function runWatchdog(nowMs: number = Date.now()): Promise<WatchdogRunResult> {
  let rows: FleetRow[];
  try {
    rows = (await sql`
      SELECT
        r.id AS room_id,
        r.name AS room_name,
        ri.last_seen_at,
        ri.tape_advancing,
        ri.session_open,
        ri.disk_free_bytes,
        ri.input_device_name,
        ri.input_devices,
        COALESCE(ri.state_flags -> 'flags', '[]'::jsonb) AS state_flags,
        ras.status AS prior_status,
        ras.since AS prior_since,
        ras.muted_until AS muted_until
      FROM room_install ri
      JOIN room r ON r.id = ri.room_id
      LEFT JOIN room_alert_state ras ON ras.room_id = r.id
      WHERE ri.retired_at IS NULL
        AND ri.enrolled_at IS NOT NULL
        AND r.disabled_at IS NULL
    `) as FleetRow[];
  } catch (e) {
    console.error(
      "[room-watchdog] could not read fleet state — sending nothing this run:",
      e instanceof Error ? e.message : String(e),
    );
    await recordHeartbeat(false, 0, "read_failed");
    return { ok: false, evaluated: 0, messages_sent: 0, alerts_queued: 0, writes: 0, channel_results: [], error: "read_failed" };
  }

  // ETA-DELIVERY-EVIDENCE's own join (lib/room-install.ts's readFleet), reused rather than
  // re-derived: one query for every room's currently-open (`status = 'recording'`) session, keyed
  // by room_id. FAIL-SAFE like the fleet read above — a fault here must not take the whole run
  // down, so a room simply reads as having no open session (no not_delivering signal) rather than
  // aborting.
  const openSessions = new Map<string, OpenBenchSession>();
  try {
    for (const s of await listBenchSessions({ status: "recording" })) {
      openSessions.set(s.room_id, {
        status: s.status,
        started_at: new Date(s.started_at).toISOString(),
        last_any_chunk_at: s.last_any_chunk_at ? new Date(s.last_any_chunk_at).toISOString() : null,
      });
    }
  } catch (e) {
    console.error(
      "[room-watchdog] could not read open bench sessions — not_delivering is unavailable this run:",
      e instanceof Error ? e.message : String(e),
    );
  }

  // ARCH #17 — rooms whose NEWEST session died at start, recently. FAIL-SAFE like the read above: a fault here only means this signal is absent this run.
  // The 0-chunk test is on the session itself; "newest" so a successful retry (a newer session) clears it.
  const startDied = new Set<string>();
  try {
    const dead = (await sql`
      SELECT s.room_id
        FROM bench_session s
       WHERE s.status = 'ended'
         AND s.ended_at > now() - (${START_DEATH_WINDOW_MS / 1000}::int * INTERVAL '1 second')
         AND s.ended_at < now() - (${START_RETRY_GRACE_MS / 1000}::int * INTERVAL '1 second')
         AND s.ended_at - s.started_at < (${START_FAILED_MAX_MS / 1000}::int * INTERVAL '1 second')
         AND NOT EXISTS (SELECT 1 FROM bench_chunk c WHERE c.session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM bench_session n WHERE n.room_id = s.room_id AND n.started_at > s.started_at)
    `) as Array<{ room_id: string }>;
    for (const d of dead) startDied.add(d.room_id);
  } catch (e) {
    console.error("[room-watchdog] could not read dead starts — start_died is unavailable this run:", e instanceof Error ? e.message : String(e));
  }

  // Evidence for the rooms whose alert is open. A failed read is logged and leaves every open alert OPEN this run (null evidence is not genuine).
  let evidence: Map<string, RecoveryEvidence> | null = null;
  if (rows.some((r) => r.prior_status && r.prior_status !== "ok")) {
    try {
      evidence = await loadRecoveryEvidence();
    } catch (e) {
      console.error(
        "[room-watchdog] could not read recovery evidence — open alerts stay open this run:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  const inputs: RoomRunInput[] = rows.map((row) => ({
    room_id: row.room_id,
    room_name: row.room_name,
    facts: {
      last_seen_at: row.last_seen_at,
      tape_advancing: row.tape_advancing,
      session_open: row.session_open,
      disk_free_bytes: row.disk_free_bytes,
      state_flags: Array.isArray(row.state_flags) ? (row.state_flags as string[]) : [],
      open_session: openSessions.get(row.room_id) ?? null,
      wrong_input_candidate: wrongInputCandidateName(row.input_device_name, row.input_devices),
      start_died: startDied.has(row.room_id),
    },
    prior: row.prior_status && row.prior_since ? { status: row.prior_status, since: row.prior_since } : null,
    muted: Boolean(row.muted_until && Date.parse(row.muted_until) > nowMs),
    ...(row.prior_status && row.prior_status !== "ok"
      ? { recovery_evidence: evidence?.get(row.room_id) ?? null }
      : {}),
  }));

  const plan = planWatchdogRun(inputs, nowMs);

  // THE STATE AND THE ALERT LAND TOGETHER (persistPlan). Nothing to write means nothing changed: no statement at all (D1).
  let alertsQueued = 0;
  if (plan.writes.length > 0) {
    try {
      alertsQueued = await persistPlan(plan);
    } catch (e) {
      // Nothing advanced and nothing was queued, so the next minute plans the same edges again. Send NOTHING from here: an alert must
      // never go out for a state that did not move.
      console.error(
        "[room-watchdog] could not persist the plan — nothing advanced, nothing queued, will retry next run:",
        e instanceof Error ? e.message : String(e),
      );
      await recordHeartbeat(false, inputs.length, "persist_failed");
      return { ok: false, evaluated: inputs.length, messages_sent: 0, alerts_queued: 0, writes: 0, channel_results: [], error: "persist_failed" };
    }
  }

  // The old email/WhatsApp channels, only when V's pages are explicitly switched on (default OFF; the alert path is the outbox).
  const channelResults: SendResult[] = [];
  if (pageVEnabled()) {
    for (const msg of plan.messages) {
      channelResults.push(...(await dispatch(msg)));
    }
  }

  await recordHeartbeat(true, inputs.length);
  return {
    ok: true,
    evaluated: inputs.length,
    messages_sent: plan.messages.length,
    alerts_queued: alertsQueued,
    writes: plan.writes.length,
    channel_results: channelResults,
  };
}

/** D9 — the mute admin route's write. Never touches status/since on an existing row. */
export async function setRoomMute(roomId: string, mutedUntil: string | null): Promise<void> {
  await sql`
    INSERT INTO room_alert_state (room_id, status, since, muted_until, updated_at)
    VALUES (${roomId}, 'ok', now(), ${mutedUntil}, now())
    ON CONFLICT (room_id) DO UPDATE
      SET muted_until = EXCLUDED.muted_until, updated_at = now()
  `;
}
