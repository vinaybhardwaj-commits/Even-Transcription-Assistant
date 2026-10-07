/**
 * lib/steward/rules.ts — Room Steward part 2: the decision rules. PURE: a RoomSense, the Config, a clock and the room's recent decisions go in; Decisions come
 * out. No I/O, no randomness, no Date.now(). Part 2 only RECORDS what these decisions would do (the executor is a shadow).
 *
 * RULE ORDER (first match wins; the primary decision is element 0, a few rules add a second element):
 *   0  no_machine / sense_degraded     no bound machine; or the session state cannot be read.
 *   OUTSIDE the window (windowAt):
 *   1  end_of_window                   session open -> scribe_stop; consult open -> wait up to late_stop_max_min (30), then scribe_stop + "late stop" message.
 *                                      (evaluated BEFORE closed_day: an OT session that ran past midnight into a closed day is still stopped.)
 *   2  closed_day                      a closed IST day (days.closed) with no session open: nothing.
 *   3  outside_window                  nothing to do.
 *   INSIDE the window:
 *   4  kiosk_asleep                    poller AND kiosk-health heartbeat both stale > 3 min AND no chunk for 10 min AND the room is not recording -> ticket wake;
 *                                      message after 10 min. With neither poller nor kiosk-health data in the last 2 h: sense_degraded (inputs.missing), never asleep —
 *                                      UNLESS kiosk-health carries a sleep marker (R11 derivation; reachable.sleep_at): then ticket wake even after an overnight sleep.
 *   5  not_recording                   no session, reachable -> scribe_start; room_failing backoff, then max start_retries tries, then message + needs_hands.
 *   6  session_died                    no chunk for 10 min AND (recorder.status stale > 3 min OR recorder session_open=false OR kiosk-health absent/stale: then
 *                                      inputs.recorder_stale = "unknown") -> scribe_restart, then
 *                                      ticket restart_recorder_app (only when the recorder says no session is open), then message.
 *   7  kiosk_health_down               no kiosk-health heartbeat for 5 min while the poller is ok -> ticket restart_kiosk_health; message if still down at 10 min.
 *   8  mic_fault                       a consult has been open >= 60 s and the mic is gone (message "mic unplugged/missing — check cable") or silent (message
 *                                      "no sound from the mic — check mute or cable"). NEVER a restart.
 *   9  silent_no_consult               tape arriving but silent with no open consult -> log_only.
 *   10 doctor_away                     the extension is alive but there is no Pulse tab -> nothing.
 *   11 identity_fault                  a stale-cookie / identity problem -> nothing (the row is the log).
 *   12 profile_unloaded                chrome running, the profile in use is not loaded, no ext events for 10 min -> ticket open_pulse.
 *   13 extension_missing               chrome.alert ext_missing:<profile> -> ticket relaunch_chrome, then policy_cycle (max 1 per profile per day), then message.
 *   14 ok                              nothing wrong.
 * Then, over the primary decision: (a) the same action failing >= 3 times in 60 min -> message + needs_hands; (b) actions_per_room_per_hour cap (counts EXECUTED actions only: result ok / failed);
 * (c) a fleet incident (>= 3 rooms with a POSITIVE failure signal of the same class in 5 min, or a hold row < 15 min old) holds the per-room action.
 * POSITIVE SIGNAL (Decision.failing_class): session_died; kiosk_asleep after the machine was awake today; kiosk_health_down after kiosk-health reported today; a start
 * attempted and failed (backoff / retries exhausted); a live mic fault; a Chrome fault. A room that has simply not started yet today, and a consent-paused room, never count.
 * PARAMS ARE STABLE: a decision's params hold no countdown or elapsed number (those live in inputs), so the dedupe key (room, rule, action, params) is stable across minutes.
 * Chrome-touching tickets (open_pulse, relaunch_chrome, policy_cycle) are gated: occupancy nobody AND no pending login AND poller idle >= 600 s AND no consult open.
 * A blocked decision is log_only with the blocking condition in why_not.
 */
import { createHash } from "node:crypto";
import { IST_OFFSET_MS, isNeverLiveRoom, istMidnightOf, windowAt, type Config, type WindowState } from "./config";
import type { RoomSense } from "./sense";
import { paramsValid, type StewardAction } from "./tickets";
import { startVerdict } from "./start-schedule";

export type DecisionAction =
  | "scribe_start"
  | "scribe_stop"
  | "scribe_restart"
  | `ticket:${StewardAction}`
  | "message"
  | "alert"
  | "log_only"
  | "none";

export type Severity = "info" | "warn" | "error";

export type Decision = {
  /** null on a fleet-wide decision */
  room_id: string | null;
  machine: string | null;
  /** 'clinic' | 'ot', or 'fleet' */
  window_kind: string;
  rule: string;
  action: DecisionAction;
  params: Record<string, unknown>;
  why: string;
  /** the first blocking condition for the next-higher rule (what stopped a more drastic action), or null */
  why_not: string | null;
  severity: Severity;
  /** sha256 (16 hex) of the discrete facts this decision rests on */
  inputs_hash: string;
  /** discrete facts (hashed) plus ages in seconds (not hashed); ids, booleans, counts only */
  inputs: Record<string, unknown>;
  /** the fleet-incident class this room is in because of a POSITIVE failure signal (also written to inputs.failing_class), or null/absent */
  failing_class?: string | null;
};

export type RecentAction = {
  ts: string;
  rule: string;
  action: string;
  params: Record<string, unknown>;
  outcome: "ok" | "failed" | "shadow" | null;
  /** inputs.failing_class of the stored row (positive failure signal), or null */
  failing_class?: string | null;
};

export type RecentContext = {
  /** this room's non-'none' decisions of the last 24 h, newest first */
  room: RecentAction[];
  fleet: {
    /** rule -> rooms failing that way now (the loop counts these from a first pass) */
    failing: Record<string, number>;
    /** rule -> a fleet_incident row for it is < 15 min old */
    hold: Record<string, boolean>;
  };
};

export const EMPTY_RECENT: RecentContext = { room: [], fleet: { failing: {}, hold: {} } };

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const MIN = 60_000;
export const ASLEEP_AFTER_MS = 3 * MIN;
export const ASLEEP_MESSAGE_AFTER_MS = 10 * MIN;
export const DIED_NO_CHUNK_MS = 10 * MIN;
export const RECORDER_STALE_MS = 3 * MIN;
export const KH_DOWN_AFTER_MS = 5 * MIN;
export const KH_DOWN_MESSAGE_AFTER_MS = 10 * MIN;
export const MIC_FAULT_AFTER_MS = 60_000;
export const CHROME_TOUCH_IDLE_MIN_S = 600;
export const PROFILE_QUIET_MS = 10 * MIN;
export const ALERT_FRESH_MS = 30 * MIN;
export const LADDER_STEP_MS = 5 * MIN;
export const LADDER_MEMORY_MS = 30 * MIN;
export const START_TRIES_WINDOW_MS = 60 * MIN;
export const FAILING_ACTION_MAX = 3;
export const FLEET_MIN_ROOMS = 3;
export const FLEET_HOLD_MS = 15 * MIN;
/** kiosk_asleep needs the room to have no fresh chunk for this long (a recording room is never asleep). */
export const ASLEEP_NO_CHUNK_MS = 10 * MIN;
/** with neither poller nor kiosk-health data for this long, reachability is unknown: kiosk_asleep is not emitted. */
export const REACHABILITY_DATA_MAX_AGE_MS = 2 * 3_600_000;
/** live-start gate: the kiosk-health heartbeat must be this fresh (kh_heartbeat_s <= 180) */
export const START_GATE_KH_MAX_MS = 180_000;
/** live-start gate: recorder.status must have been ready with no session for this long, derived from the history (recorder_ready_for_s >= 300) */
export const START_GATE_RECORDER_READY_MS = 300_000;
/** the newest recorder.status row must be this young (kiosk-health re-emits at least every 300 s) for the ready streak to count */
export const START_GATE_RECORDER_LATEST_MAX_MS = 420_000;

/** Rules whose decision means "this room is failing", the fleet-incident classes. */
export const FAILING_RULES: readonly string[] = ["not_recording", "session_died", "kiosk_asleep", "kiosk_health_down", "mic_fault", "profile_unloaded", "extension_missing"];

export const CHROME_TOUCHING: readonly StewardAction[] = ["open_pulse", "relaunch_chrome", "policy_cycle"];

const ACTIONABLE = (a: string): boolean => a === "scribe_start" || a === "scribe_stop" || a === "scribe_restart" || a.startsWith("ticket:") || a === "message";
const COUNTED_FOR_CAP = (a: string): boolean => a === "scribe_start" || a === "scribe_stop" || a === "scribe_restart" || a.startsWith("ticket:");
/** a stored row counts toward the caps ONLY when something was actually sent (result ok or failed); kill_switch / shadow / blocked / skipped / cap_reached / fleet_hold / log_only never count. */
const EXECUTED = (r: { outcome: "ok" | "failed" | "shadow" | null }): boolean => r.outcome === "ok" || r.outcome === "failed";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
export const hashFacts = (facts: unknown): string => createHash("sha256").update(JSON.stringify(sortKeys(facts))).digest("hex").slice(0, 16);

type Ctx = {
  s: RoomSense;
  cfg: Config;
  A: number;
  win: WindowState;
  recent: RecentContext;
  /** age in ms of an ISO time, or null when absent / unparseable / in the future by more than 5 s */
  age: (iso: string | null | undefined) => number | null;
};

const mkAge = (A: number) => (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, A - t) : null;
};

const secs = (ms: number | null): number | null => (ms === null ? null : Math.round(ms / 1000));

function facts(c: Ctx): Record<string, unknown> {
  const { s, win } = c;
  return {
    in_window: win.in_window,
    closed_day: win.closed_day,
    session_open: s.recording.session_open,
    session_status: s.recording.session_status,
    consult_open: s.consult_open,
    occupancy: s.occupancy?.state ?? null,
    ext_status: s.ext.status,
    kh_enrolled: s.reachable.kh_enrolled,
    missing: [...s.missing].sort(),
  };
}

/** How long recorder.status has been "ready" with session_open false, from the history: null unless the newest row is <= 7 min old, ready, and the run has >= 2 rows. */
function recorderReadyForMs(c: Ctx): number | null {
  const h = c.s.recording.recorder_history;
  if (!h || !h.ready_since || h.ready_samples < 2) return null;
  const latest = c.age(h.latest_at);
  if (latest === null || latest > START_GATE_RECORDER_LATEST_MAX_MS) return null;
  return c.age(h.ready_since);
}

function ages(c: Ctx): Record<string, unknown> {
  const { s, age } = c;
  return {
    poller_ok_s: secs(age(s.reachable.poller_ok_at)),
    kh_heartbeat_s: secs(age(s.reachable.kh_heartbeat_at)),
    last_chunk_s: secs(age(s.recording.last_chunk_24h_at ?? s.recording.last_chunk_at)),
    recorder_status_s: secs(age(s.recording.recorder_status?.received_at)),
    recorder_ready_for_s: secs(recorderReadyForMs(c)),
    consult_s: secs(age(s.consult_started_at)),
    silent_s: secs(age(s.audio.silent_while_recording_since)),
    idle_s: s.occupancy?.idle_s ?? null,
  };
}

function mk(
  c: Ctx,
  rule: string,
  action: DecisionAction,
  params: Record<string, unknown>,
  why: string,
  why_not: string | null,
  severity: Severity,
  extraFacts: Record<string, unknown> = {},
  /** volatile numbers (countdowns, elapsed minutes, counters): written to inputs, NEVER hashed and NEVER in params */
  extraInputs: Record<string, unknown> = {},
): Decision {
  const f = { ...facts(c), ...extraFacts };
  const ag = ages(c);
  return {
    room_id: c.s.room_id,
    machine: c.s.machine,
    window_kind: c.s.kind,
    rule,
    action,
    params,
    why,
    why_not,
    severity,
    inputs_hash: hashFacts({ rule, action, params, f }),
    // THE one inputs builder (every rule and every guard goes through mk): the reachability evidence actually sensed sits at the top level of every row (not hashed) and, with
    // the other ages, under ages_s. last_chunk_s is the newest chunk of ANY session in the last 24 h (null only when there is none); sleep_marker is a bool (the R11 marker).
    inputs: {
      ...f,
      last_chunk_s: ag.last_chunk_s,
      kh_heartbeat_s: ag.kh_heartbeat_s,
      poller_ok_s: ag.poller_ok_s,
      recorder_ready_for_s: ag.recorder_ready_for_s,
      sleep_marker: c.s.reachable.sleep_at != null,
      ages_s: ag,
      audio_devices_age_s: secs(c.age(c.s.audio.devices_at)),
      ...extraInputs,
    },
  };
}

/** Mark a decision as a POSITIVE failure signal of `cls` (fleet-incident class). Returns the same decision. */
function fc(d: Decision, cls: string): Decision {
  d.failing_class = cls;
  d.inputs.failing_class = cls;
  return d;
}
const fcAll = (ds: Decision[], cls: string): Decision[] => ds.map((d) => fc(d, cls));
/** A replacement decision (cap / action_failing / fleet_hold) keeps the class of the decision it replaced. */
function inherit(d: Decision, from: Decision): Decision {
  return from.failing_class ? fc(d, from.failing_class) : d;
}

/** Earliest instant that counts as "today" for awake_today / reported_today: IST midnight, or the window start when the window began earlier (OT crosses midnight). */
const todayFloor = (c: Ctx): number => Math.min(istMidnightOf(c.A), c.win.start_ms ?? Number.POSITIVE_INFINITY);
const atOrAfter = (iso: string | null | undefined, ms: number): boolean => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= ms;
};

const rowsOf = (c: Ctx, action: string, withinMs: number, profile?: string) =>
  c.recent.room.filter(
    (r) => r.action === action && c.A - Date.parse(r.ts) <= withinMs && c.A >= Date.parse(r.ts) && (profile === undefined || r.params?.profile === profile),
  );

/** First blocking condition for a Chrome-touching ticket, or null when it may go. Order: occupancy, pending login, poller idle, consult. */
export function chromeGate(s: RoomSense): string | null {
  const o = s.occupancy;
  if (!o) return "occupancy unknown";
  if (o.state === "present") return "occupancy: someone is present at the Mac";
  if (o.state === "pending") return "login pending at the Mac";
  if (o.idle_s === null) return "poller idle_s unknown";
  if (o.idle_s < CHROME_TOUCH_IDLE_MIN_S) return `poller idle ${Math.round(o.idle_s)} s < ${CHROME_TOUCH_IDLE_MIN_S} s`;
  if (s.consult_open === true) return "consult open";
  if (s.consult_open === null) return "consult state unknown";
  return null;
}

/** A Chrome-touching ticket decision, or its gated log_only twin. */
function chromeTicket(c: Ctx, rule: string, name: StewardAction, profile: string, why: string, severity: Severity, why_not: string | null): Decision[] {
  const params = { profile };
  if (!paramsValid(name, params)) {
    return [mk(c, rule, "log_only", { wanted: `ticket:${name}` }, `${why} (profile name not usable in a ticket)`, "profile name fails the ticket params schema", "warn")];
  }
  const gate = chromeGate(c.s);
  if (gate) return [mk(c, rule, "log_only", { wanted: `ticket:${name}`, profile }, `${why} (held)`, `chrome-touch blocked: ${gate}`, "warn")];
  return [mk(c, rule, `ticket:${name}`, params, why, why_not, severity)];
}

// ---------------------------------------------------------------------------
// the chain
// ---------------------------------------------------------------------------

function outsideWindow(c: Ctx): Decision[] {
  const { s, win } = c;
  // end_of_window BEFORE closed_day (F10): an OT session that ran past midnight into a closed day is still stopped.
  if (s.recording.session_open === true) {
    const lateMax = c.cfg.schedule[s.kind].late_stop_max_min * MIN;
    const since = win.since_end_ms;
    const sinceTxt = since === null ? "more than 3 days" : `${Math.round(since / MIN)} min`;
    if (s.consult_open !== false) {
      if (since !== null && since < lateMax) {
        return [
          mk(
            c,
            "end_of_window",
            "none",
            {},
            `window ended ${sinceTxt} ago; ${s.consult_open === null ? "consult state unknown" : "a consult is open"}, waiting up to ${c.cfg.schedule[s.kind].late_stop_max_min} min before stopping`,
            s.consult_open === null ? "scribe_stop held: consult state unknown" : "scribe_stop held: consult open",
            "info",
            {},
            { since_end_min: since === null ? null : Math.round(since / MIN) },
          ),
        ];
      }
      const sinceIn = { since_end_min: since === null ? null : Math.round(since / MIN) };
      return [
        mk(c, "end_of_window", "scribe_stop", { late: true }, `window ended ${sinceTxt} ago and the consult is still open: stopping anyway (late stop)`, null, "warn", {}, sinceIn),
        mk(c, "end_of_window", "message", { kind: "late_stop", text: "late stop: session closed after the window ended with a consult still open" }, `late stop notice (window ended ${sinceTxt} ago)`, null, "warn", {}, sinceIn),
      ];
    }
    return [mk(c, "end_of_window", "scribe_stop", {}, `window ended ${sinceTxt} ago and no consult is open`, null, "info", {}, { since_end_min: since === null ? null : Math.round(since / MIN) })];
  }
  if (win.closed_day) return [mk(c, "closed_day", "none", {}, "closed day", null, "info")];
  return [mk(c, "outside_window", "none", {}, "outside the schedule window", null, "info")];
}

function kioskAsleep(c: Ctx): Decision[] | null {
  const { s, age } = c;
  // F4: a room that is recording is never asleep, and a fresh chunk (< 10 min) is proof of life.
  if (s.recording.session_open === true && s.recording.session_status === "recording") return null;
  const chunkAge = age(s.recording.last_chunk_at);
  if (chunkAge !== null && chunkAge < ASLEEP_NO_CHUNK_MS) return null;
  const pAge = age(s.reachable.poller_ok_at);
  const kAge = age(s.reachable.kh_heartbeat_at);
  // A kiosk-health SLEEP marker (bench rule R11: the newest power event is a sleep / darkwake, < 12 h old, no heartbeat since sleep + 180 s) is positive evidence that the
  // Mac is asleep, even when it has been silent for hours (overnight sleep): it overrides the 2 h reachability rule below, provided the poller does not see the Mac.
  const sleepAt = s.reachable.sleep_at ?? null;
  const sleeping = sleepAt !== null && s.reachable.kh_enrolled === true && (pAge === null || pAge > ASLEEP_AFTER_MS);
  // F4: with neither source heard in the last 2 h the room's reachability is unknown (e.g. a room with no poller and no kiosk-health): do not call it asleep.
  if (!sleeping && (pAge === null || pAge > REACHABILITY_DATA_MAX_AGE_MS) && (kAge === null || kAge > REACHABILITY_DATA_MAX_AGE_MS)) {
    return [
      mk(c, "sense_degraded", "log_only", {}, "no presence-poller or kiosk-health data in the last 2 h: reachability cannot be judged", "kiosk_asleep not emitted: no reachability data in 2 h", "warn", {
        missing: [...new Set([...s.missing, "reachability_2h"])].sort(),
      }),
    ];
  }
  const pStale = pAge === null || pAge > ASLEEP_AFTER_MS;
  const kStale = kAge === null || kAge > ASLEEP_AFTER_MS;
  if (!sleeping && !(pStale && kStale)) return null;
  // positive failure signal for the fleet count only when the machine was awake today (it spoke since IST midnight / the window start)
  const floor = todayFloor(c);
  const awakeToday = atOrAfter(s.reachable.poller_ok_at, floor) || atOrAfter(s.reachable.kh_heartbeat_at, floor);
  const out: Decision[] = [mk(c, "kiosk_asleep", "ticket:wake", {}, "poller and kiosk-health heartbeat both stale > 3 min and no fresh chunk: the Mac looks asleep", null, "error", {}, { awake_today: awakeToday, sleep_marker_at: sleepAt })];
  if ((pAge === null || pAge > ASLEEP_MESSAGE_AFTER_MS) && (kAge === null || kAge > ASLEEP_MESSAGE_AFTER_MS)) {
    out.push(mk(c, "kiosk_asleep", "message", { kind: "asleep_10m", needs_hands: true, text: "kiosk unreachable for 10+ min inside the window — needs hands" }, "still unreachable after 10 min", "wake ticket did not bring the Mac back", "error", {}, { awake_today: awakeToday, sleep_marker_at: sleepAt }));
  }
  return awakeToday ? fcAll(out, "kiosk_asleep") : out;
}

/** The input device a missing-device alert names: expected_device_name, else the default input's name, else a plain statement that it was not reported. */
const deviceLabel = (s: RoomSense): string => s.audio.configured_device ?? s.audio.default_input_name ?? "input device (name not reported)";
/** the three signals mic_fault reads: default input absent, the DEVICE_MISSING install flag, or a USB removal with the newest audio row still absent (no usb_added since) */
/**
 * F23: device_missing needs EVIDENCE younger than 6 h: the newest audio.devices row says "no default input" and was received <= 6 h ago, or a USB removal with no usb_added since
 * (sense.usb_removed_recent, already bounded to the last minutes). The DEVICE_MISSING install flag has no timestamp and an old "absent" row is stale: they only annotate inputs.
 */
export const DEVICE_EVIDENCE_MAX_MS = 6 * 3_600_000;
const deviceMissing = (c: Ctx): boolean => {
  const a = c.s.audio;
  const rowAge = c.age(a.devices_at);
  return (a.default_input_present === false && rowAge !== null && rowAge <= DEVICE_EVIDENCE_MAX_MS) || a.usb_removed_recent === true;
};
/** a device signal that is NOT evidence (flag only, or an absent row older than 6 h): recorded in inputs, never acted on */
const deviceAnnotation = (c: Ctx): string | null => {
  if (deviceMissing(c)) return null;
  const a = c.s.audio;
  if (a.default_input_present === false) return "audio_row_older_than_6h";
  if (a.device_missing_flag === true) return "install_flag_only";
  return null;
};

/**
 * The live-start gates of a scribe_start decision, each recorded in inputs.start_gates; start_gate_fail names the FIRST failing one (null = all pass). The window, the dev/test/scratch
 * exclusion (roster) and "no open session" (the rule only runs with session_open false; the executor re-reads it when it runs) are already true here; the other two are read from kiosk-health:
 *   kiosk_health_fresh  kh_heartbeat_s <= 180            recorder_ready  recorder.status ready + session_open false held >= 300 s, from the history (recorder_ready_for_s)
 * A room with no kiosk-health at all (ORB2) can never pass: start_gate_fail = "no_kiosk_health" (the loop records result "shadow: no_kiosk_health").
 */
/** F1 (FLEET refuter): a LIVE start is allowed only inside a literal IST [07:30, 21:30), whatever the room's configured window says (an OT window 06:00-04:00 cannot widen it) */
export const LIVE_CLAMP_LABEL = "ist_0730_2130";
const LIVE_CLAMP_START_MS = (7 * 60 + 30) * 60_000;
const LIVE_CLAMP_END_MS = (21 * 60 + 30) * 60_000;
const inLiveClamp = (A: number): boolean => {
  const msOfDay = (((A + IST_OFFSET_MS) % 86_400_000) + 86_400_000) % 86_400_000;
  return msOfDay >= LIVE_CLAMP_START_MS && msOfDay < LIVE_CLAMP_END_MS;
};

function startGates(c: Ctx): { gates: Record<string, boolean>; fail: string | null } {
  const { s, age } = c;
  const khAge = age(s.reachable.kh_heartbeat_at);
  const readyFor = recorderReadyForMs(c);
  const gates = {
    in_window: c.win.in_window,
    in_live_clamp: inLiveClamp(c.A),
    room_eligible: !isNeverLiveRoom(s.room_id),
    no_open_session: s.recording.session_open === false,
    kiosk_health_fresh: khAge !== null && khAge <= START_GATE_KH_MAX_MS,
    recorder_ready: readyFor !== null && readyFor >= START_GATE_RECORDER_READY_MS,
  };
  let fail: string | null = null;
  if (s.reachable.kh_enrolled !== true || (khAge === null && !s.recording.recorder_history)) fail = "no_kiosk_health";
  else if (!gates.room_eligible) fail = "never_live_room";
  else if (!gates.kiosk_health_fresh) fail = "kh_heartbeat_stale";
  else if (!s.recording.recorder_history) fail = "no_recorder_status";
  else if (!gates.recorder_ready) fail = s.recording.recorder_history.ready_since ? "recorder_ready_under_5m" : "recorder_not_ready";
  else if (!gates.no_open_session) fail = "session_open";
  else if (!gates.in_window) fail = "outside_window";
  else if (!gates.in_live_clamp) fail = "outside_live_clamp";
  return { gates, fail };
}

/** the newest row of rule device_missing in the room's memory is an ALERT = a missing episode is open (a "back" log_only row closes it) */
function deviceEpisodeOpen(c: Ctx): boolean {
  let newest: RecentAction | null = null;
  for (const r of c.recent.room) if (r.rule === "device_missing" && (newest === null || Date.parse(r.ts) > Date.parse(newest.ts))) newest = r;
  return newest !== null && newest.action === "alert";
}
/** the device is SEEN again: the newest audio.devices row says a default input is present and no USB removal is pending */
const deviceSeenAgain = (c: Ctx): boolean => c.s.audio.default_input_present === true && c.s.audio.usb_removed_recent !== true;

function notRecording(c: Ctx): Decision[] {
  const { s, cfg } = c;
  const L = s.listener;
  if (L.paused === true) {
    return [mk(c, "not_recording", "log_only", {}, "inside the window with no session, but the room is paused (consent pause)", "scribe_start held: room paused", "info")];
  }
  if (s.start_attempts === null) {
    return [mk(c, "not_recording", "log_only", {}, "inside the window with no session, but start history is unreadable", "scribe_start held: start_attempts missing", "warn")];
  }
  const v = startVerdict(s.start_attempts, c.A, cfg.caps.start_retries);
  const attempts = v.attempts;
  // a 4th attempt is never issued in an IST day: start_exhausted (log_only) plus a needs-hands message
  if (v.kind === "exhausted") {
    return fcAll(
      [
        mk(c, "start_exhausted", "log_only", {}, `${attempts} start_day attempts today and the room is still not recording: no more starts today`, `scribe_start held: ${cfg.caps.start_retries} attempts used today (IST)`, "error", {}, { attempts }),
        mk(
          c,
          "start_exhausted",
          "message",
          { kind: "start_exhausted", needs_hands: true, text: "recorder will not start after repeated tries — needs hands" },
          `${attempts} start_day attempts today and the room is still not recording`,
          `scribe_start held: ${cfg.caps.start_retries} attempts used today (IST)`,
          "error",
          {},
          { attempts },
        ),
      ],
      "not_recording",
    );
  }
  // device missing: ONE live attempt, then an alert naming the room and the device, and no more attempts until the device is back
  if (deviceMissing(c) && attempts >= 1) {
    const device = deviceLabel(s);
    // F2: ONE alert row per missing episode. An episode opens with the alert and closes when the device is seen again (decideRoom appends the closing row); while it is open, inputs only.
    if (deviceEpisodeOpen(c)) {
      return fcAll(
        [mk(c, "device_missing_hold", "log_only", {}, `room ${s.room_name}: the input device "${device}" is still missing (alert already raised for this episode); no starts until it reappears`, "scribe_start held: input device missing (episode open)", "warn", {}, { attempts, device_missing_episode: "open" })],
        "not_recording",
      );
    }
    return fcAll(
      [
        mk(
          c,
          "device_missing",
          "alert",
          { room_id: s.room_id, room: s.room_name, device },
          `room ${s.room_name} cannot start: the input device "${device}" is missing; one start was tried today and no more are sent until it reappears`,
          "scribe_start held: input device missing after one attempt",
          "error",
          {},
          { attempts },
        ),
      ],
      "not_recording",
    );
  }
  if (v.kind === "pending") {
    return [mk(c, "not_recording", "log_only", {}, "inside the window with no session; the last start_day has not resolved yet", "scribe_start held: previous start_day pending", "info", {}, { attempts })];
  }
  if (v.kind === "backoff") {
    return fcAll(
      [
        mk(c, "not_recording", "log_only", {}, `inside the window with no session; the last start_day failed (attempt ${attempts} today)`, `scribe_start held: backoff after failed attempt ${attempts}, retry in ${v.retry_after_s} s`, "warn", {}, { attempts, retry_after_s: v.retry_after_s }),
      ],
      "not_recording",
    );
  }
  const g = startGates(c);
  return [mk(c, "not_recording", "scribe_start", {}, "inside the window, no session open, kiosk reachable", null, "warn", {}, { attempts, live_clamp: LIVE_CLAMP_LABEL, start_gates: g.gates, start_gate_fail: g.fail, ...(deviceMissing(c) ? { device_missing: true } : {}), ...(deviceAnnotation(c) ? { device_signal_not_evidence: deviceAnnotation(c) } : {}) })];
}

function sessionDied(c: Ctx): Decision[] | null {
  const { s, age } = c;
  if (s.recording.session_open !== true || s.recording.session_status !== "recording") return null;
  const ref = [s.recording.last_chunk_at, s.recording.session_started_at]
    .filter((x): x is string => !!x)
    .sort()
    .pop();
  const chunkAge = age(ref);
  if (chunkAge === null || chunkAge < DIED_NO_CHUNK_MS) return null;
  const rs = s.recording.recorder_status;
  const khAge = age(s.reachable.kh_heartbeat_at);
  const khDown = khAge === null || khAge > KH_DOWN_AFTER_MS || s.reachable.kh_enrolled !== true;
  const rsAge = age(rs?.received_at);
  // F5: with kiosk-health absent/stale/not enrolled a stale recorder.status says nothing about the recorder, but an open session with no chunk for 10 min is still a dead
  // session: fire, and say that the recorder state is unknown (inputs.recorder_stale = "unknown") instead of forcing it to false.
  const recorderStale: boolean | "unknown" = khDown ? "unknown" : rs === null || rsAge === null || rsAge > RECORDER_STALE_MS;
  const recorderClosed = rs?.session_open === false;
  if (recorderStale === false && !recorderClosed) return null;
  const rsFact = { recorder_stale: recorderStale };
  const why = `no chunk for ${Math.round(chunkAge / MIN)} min and ${
    recorderClosed ? "the recorder says no session is open" : recorderStale === "unknown" ? "kiosk-health is absent or stale (recorder state unknown)" : "recorder.status is stale"
  }`;
  const restarts = rowsOf(c, "scribe_restart", LADDER_MEMORY_MS);
  const appRestarts = rowsOf(c, "ticket:restart_recorder_app", LADDER_MEMORY_MS);
  if (restarts.length === 0) return fcAll([mk(c, "session_died", "scribe_restart", {}, why, null, "error", { recorder_closed: recorderClosed, restarts: 0, ...rsFact })], "session_died");
  const lastRestartAge = Math.min(...restarts.map((r) => c.A - Date.parse(r.ts)));
  if (appRestarts.length === 0 && lastRestartAge < LADDER_STEP_MS) {
    return fcAll([mk(c, "session_died", "log_only", {}, `${why}; scribe_restart sent ${Math.round(lastRestartAge / MIN)} min ago, waiting 5 min`, "next step held: waiting for the restart to take effect", "warn", { recorder_closed: recorderClosed, restarts: restarts.length, ...rsFact })], "session_died");
  }
  if (recorderClosed && appRestarts.length === 0) {
    return fcAll([mk(c, "session_died", "ticket:restart_recorder_app", {}, `${why}; scribe_restart did not recover it`, null, "error", { recorder_closed: true, restarts: restarts.length, ...rsFact })], "session_died");
  }
  return fcAll([
    mk(
      c,
      "session_died",
      "message",
      { kind: "recorder_stalled", needs_hands: true, text: "recorder stalled and automatic restarts did not recover it — needs hands" },
      `${why}; restart ladder exhausted`,
      appRestarts.length > 0 ? "restart_recorder_app already tried" : "restart_recorder_app skipped: the recorder has not confirmed that no session is open",
      "error",
      { recorder_closed: recorderClosed, restarts: restarts.length, app_restarts: appRestarts.length, ...rsFact },
    ),
  ], "session_died");
}

function kioskHealthDown(c: Ctx): Decision[] | null {
  const { s, age } = c;
  if (s.reachable.kh_enrolled !== true) return null;
  const pAge = age(s.reachable.poller_ok_at);
  if (pAge === null || pAge > ASLEEP_AFTER_MS) return null; // the poller is not ok: that is the asleep rule's business
  const kAge = age(s.reachable.kh_heartbeat_at);
  if (kAge !== null && kAge <= KH_DOWN_AFTER_MS) return null;
  // positive failure signal for the fleet count only when kiosk-health had reported today (silent AFTER reporting, not never enrolled-and-quiet)
  const reportedToday = atOrAfter(s.reachable.kh_heartbeat_at, todayFloor(c));
  const out: Decision[] = [mk(c, "kiosk_health_down", "ticket:restart_kiosk_health", {}, "no kiosk-health heartbeat for 5 min while the poller is ok", null, "warn", {}, { reported_today: reportedToday })];
  if (kAge === null || kAge >= KH_DOWN_MESSAGE_AFTER_MS) {
    out.push(mk(c, "kiosk_health_down", "message", { kind: "kh_down_10m", needs_hands: true, text: "kiosk-health daemon still down after 10 min — needs hands" }, "still down after 10 min", "restart_kiosk_health did not bring it back", "warn", {}, { reported_today: reportedToday }));
  }
  return reportedToday ? fcAll(out, "kiosk_health_down") : out;
}

function micFault(c: Ctx): Decision[] | null {
  const { s, age } = c;
  if (s.recording.session_status !== "recording" || s.consult_open !== true) return null;
  const cAge = age(s.consult_started_at);
  const silentAge = age(s.audio.silent_while_recording_since);
  const missingMic = s.audio.default_input_present === false || s.audio.usb_removed_recent === true || s.audio.device_missing_flag === true;
  const silent = silentAge !== null && silentAge >= MIC_FAULT_AFTER_MS;
  if (!missingMic && !silent) {
    if (s.audio.silent_while_recording_since && cAge !== null && cAge < MIC_FAULT_AFTER_MS) {
      return [mk(c, "mic_check_pending", "none", {}, "tape is silent but the consult opened under 60 s ago", "mic message held: consult under 60 s old", "info")];
    }
    return null;
  }
  if (cAge !== null && cAge < MIC_FAULT_AFTER_MS) {
    return [mk(c, "mic_check_pending", "none", {}, "mic problem seen but the consult opened under 60 s ago", "mic message held: consult under 60 s old", "info")];
  }
  if (missingMic) {
    return fcAll([mk(c, "mic_fault", "message", { kind: "mic_missing", text: "mic unplugged/missing — check cable" }, "consult open >= 60 s and the default input is missing", "never a restart: the mic is physical", "error")], "mic_fault");
  }
  return fcAll([mk(c, "mic_fault", "message", { kind: "mic_silent", text: "no sound from the mic — check mute or cable" }, "consult open >= 60 s and the tape has been silent >= 60 s", "never a restart: the mic is physical", "error")], "mic_fault");
}

function profileUnloaded(c: Ctx): Decision[] | null {
  const { s, age } = c;
  const ch = s.chrome;
  if (!s.ext.applicable || ch.running !== true || !ch.last_used || !ch.active) return null;
  if (ch.active.includes(ch.last_used)) return null;
  const extAge = age(s.ext.last_event_at);
  if (extAge !== null && extAge < PROFILE_QUIET_MS) return null;
  return fcAll(chromeTicket(c, "profile_unloaded", "open_pulse", ch.last_used, "chrome is running but the profile in use is not loaded and the extension is silent", "warn", null), "profile_unloaded");
}

const EXT_MISSING_PREFIX = "ext_missing:";

function extensionMissing(c: Ctx): Decision[] | null {
  const { s, age } = c;
  const reason = s.chrome.last_alert_reason;
  if (!s.ext.applicable || !reason || !reason.startsWith(EXT_MISSING_PREFIX)) return null;
  const aAge = age(s.chrome.last_alert_at);
  if (aAge === null || aAge > ALERT_FRESH_MS) return null;
  const extAge = age(s.ext.last_event_at);
  if (extAge !== null && extAge < aAge) return null; // the extension spoke after the alert: resolved
  const profile = reason.slice(EXT_MISSING_PREFIX.length);
  if (!profile) return null;
  const relaunches = rowsOf(c, "ticket:relaunch_chrome", LADDER_MEMORY_MS, profile);
  if (relaunches.length === 0) {
    return fcAll(chromeTicket(c, "extension_missing", "relaunch_chrome", profile, "the extension is missing from the profile (chrome.alert)", "error", null), "extension_missing");
  }
  const lastAge = Math.min(...relaunches.map((r) => c.A - Date.parse(r.ts)));
  if (lastAge < 2 * LADDER_STEP_MS) {
    return fcAll([mk(c, "extension_missing", "log_only", { profile }, `relaunch_chrome sent ${Math.round(lastAge / MIN)} min ago; waiting before the policy cycle`, "policy_cycle held: waiting 10 min after relaunch", "warn")], "extension_missing");
  }
  const dayStart = istMidnightOf(c.A);
  const cycles = c.recent.room.filter((r) => r.action === "ticket:policy_cycle" && r.params?.profile === profile && Date.parse(r.ts) >= dayStart).length;
  if (cycles >= c.cfg.caps.policy_cycle_per_profile_per_day) {
    return fcAll([
      mk(
        c,
        "extension_missing",
        "message",
        { kind: "policy_cycle_cap", needs_hands: true, profile, text: "extension still missing after relaunch and the daily policy cycle — needs hands" },
        "relaunch did not restore the extension and the daily policy_cycle is spent",
        `policy_cycle held: ${cycles} of ${c.cfg.caps.policy_cycle_per_profile_per_day} used today for this profile`,
        "error",
      ),
    ], "extension_missing");
  }
  return fcAll(chromeTicket(c, "extension_missing", "policy_cycle", profile, "relaunch_chrome did not restore the extension", "error", "relaunch_chrome already tried"), "extension_missing");
}

function chain(c: Ctx): Decision[] {
  const { s, win } = c;
  if (!s.machine) return [mk(c, "no_machine", "none", {}, "room has no bound machine", null, "info")];
  if (s.recording.session_open === null) {
    return [mk(c, "sense_degraded", "log_only", {}, "cannot tell whether a session is open", "missing: bench_session", "warn")];
  }
  if (!win.in_window) return outsideWindow(c);

  // inside the window
  if (s.missing.includes("presence_poller") || s.missing.includes("kiosk_health")) {
    return [mk(c, "sense_degraded", "log_only", {}, "reachability cannot be judged: a reachability source is unreadable", `missing: ${s.missing.filter((m) => m === "presence_poller" || m === "kiosk_health").join(", ")}`, "warn")];
  }
  const asleep = kioskAsleep(c);
  if (asleep) return asleep;
  if (s.recording.session_open === false) return notRecording(c);
  const died = sessionDied(c);
  if (died) return died;
  const kh = kioskHealthDown(c);
  if (kh) return kh;
  const mic = micFault(c);
  if (mic) return mic;
  if (s.audio.silent_while_recording_since && s.consult_open !== true) {
    return [mk(c, "silent_no_consult", "log_only", {}, "tape is arriving but silent and no consult is open", null, "info")];
  }
  if (s.ext.applicable && s.ext.no_tab === true) return [mk(c, "doctor_away", "none", {}, "the extension is alive but there is no Pulse tab: the doctor is away", null, "info")];
  if (s.occupancy?.identity_fault) return [mk(c, "identity_fault", "none", {}, "identity fault (stale cookie / login mismatch): nothing to repair from here", null, "info")];
  const pu = profileUnloaded(c);
  if (pu) return pu;
  const em = extensionMissing(c);
  if (em) return em;
  return [mk(c, "ok", "none", {}, "recording and healthy", null, "info")];
}

// ---------------------------------------------------------------------------
// guards over the primary decision
// ---------------------------------------------------------------------------

function actionKey(d: Decision): string {
  const p = d.params?.profile;
  return typeof p === "string" ? `${d.action}|${p}` : d.action;
}

function guards(c: Ctx, ds: Decision[]): Decision[] {
  const p = ds[0];
  if (!p) return ds;
  let out = ds;

  // (a) the same action failing >= 3 times in 60 min -> stop, one message, needs_hands
  if ((p.action === "scribe_restart" || p.action === "scribe_stop" || p.action.startsWith("ticket:")) && p.rule !== "action_failing") {
    const key = actionKey(p);
    const failed = c.recent.room.filter((r) => {
      const rk = typeof r.params?.profile === "string" ? `${r.action}|${r.params.profile}` : r.action;
      return rk === key && r.outcome === "failed" && c.A - Date.parse(r.ts) <= START_TRIES_WINDOW_MS;
    }).length;
    if (failed >= FAILING_ACTION_MAX) {
      out = [
        inherit(
          mk(
            c,
            "action_failing",
            "message",
            { kind: "action_failing", needs_hands: true, action: p.action, ...(typeof p.params?.profile === "string" ? { profile: p.params.profile } : {}), text: `${p.action} has failed repeatedly — stopped, needs hands` },
            `${p.action} failed ${failed} times in the last hour`,
            `${p.action} held: failing ${failed} times`,
            "error",
            { failed_action: p.action },
            { failures: failed },
          ),
          p,
        ),
      ];
    }
  }

  // (b) cap on actions per room per hour
  const head = out[0]!;
  if (COUNTED_FOR_CAP(head.action)) {
    const n = c.recent.room.filter((r) => COUNTED_FOR_CAP(r.action) && EXECUTED(r) && c.A - Date.parse(r.ts) <= 60 * MIN && c.A >= Date.parse(r.ts)).length;
    if (n >= c.cfg.caps.actions_per_room_per_hour) {
      out = [
        inherit(
          mk(
            c,
            "cap_reached",
            "log_only",
            { wanted: head.action, ...(typeof head.params?.profile === "string" ? { profile: head.params.profile } : {}) },
            `wanted ${head.action} (${head.rule}) but the hourly action cap is reached`,
            `actions_per_room_per_hour=${c.cfg.caps.actions_per_room_per_hour} reached (${n} in the last hour)`,
            "warn",
            { capped_rule: head.rule },
            { actions_last_hour: n },
          ),
          head,
        ),
      ];
    }
  }

  // (c) fleet incident hold
  const h = out[0]!;
  if (FAILING_RULES.includes(h.rule) && ACTIONABLE(h.action)) {
    const n = c.recent.fleet.failing[h.rule] ?? 0;
    if (c.recent.fleet.hold[h.rule] || n >= FLEET_MIN_ROOMS) {
      out = [
        inherit(
          mk(
            c,
            "fleet_hold",
            "log_only",
            { class: h.rule, wanted: h.action },
            `fleet incident: ${Math.max(n, FLEET_MIN_ROOMS)}+ rooms failing "${h.rule}"; the per-room ${h.action} is held for 15 min`,
            `${h.action} held: fleet incident on ${h.rule}`,
            "warn",
            { class: h.rule },
            { failing_rooms: n },
          ),
          h,
        ),
      ];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

/** The Decisions for ONE room at asOf. Element 0 is the primary decision. Pure. */
export function decideRoom(sense: RoomSense, cfg: Config, asOf: number | string | Date, recent: RecentContext = EMPTY_RECENT): Decision[] {
  const A = new Date(asOf).getTime();
  if (!Number.isFinite(A)) throw new Error("decideRoom: bad asOf");
  const c: Ctx = { s: sense, cfg, A, win: windowAt(cfg, sense.kind, A), recent, age: mkAge(A) };
  const ds = guards(c, chain(c));
  // F2: the device reappeared while an episode is open: one closing row (log_only), so a later disappearance is a NEW episode with a new alert
  if (deviceEpisodeOpen(c) && deviceSeenAgain(c)) {
    ds.push(mk(c, "device_missing", "log_only", { state: "back" }, `room ${sense.room_name}: the input device is back; the missing-device episode is closed`, null, "info", {}, {}));
  }
  return ds;
}

/**
 * The fleet-incident class a room's decisions put it in (S4), or null. A held decision keeps its class, so a room under a hold still counts as failing.
 */
export function failingClass(ds: readonly Decision[]): string | null {
  const p = ds[0];
  if (!p) return null;
  // only a decision that carries a POSITIVE failure signal puts its room in a class; a held / capped decision keeps the class of the decision it replaced
  const cls = p.failing_class;
  return typeof cls === "string" && FAILING_RULES.includes(cls) ? cls : null;
}

/** One fleet decision per class with >= FLEET_MIN_ROOMS failing rooms (room_id null, window_kind 'fleet'). Sorted by class. */
export function fleetDecisions(failingRooms: Record<string, string[]>): Decision[] {
  const out: Decision[] = [];
  for (const cls of Object.keys(failingRooms).sort()) {
    const rooms = [...new Set(failingRooms[cls] ?? [])].sort();
    if (rooms.length < FLEET_MIN_ROOMS) continue;
    const f = { class: cls, rooms: rooms.length };
    out.push({
      room_id: null,
      machine: null,
      window_kind: "fleet",
      rule: "fleet_incident",
      action: "message",
      params: { class: cls, count: rooms.length, rooms, hold_min: FLEET_HOLD_MS / MIN, needs_hands: true, text: `${rooms.length} rooms failing the same way (${cls}) — per-room actions held 15 min` },
      why: `${rooms.length} rooms are failing "${cls}" at the same time`,
      why_not: null,
      severity: "error",
      inputs_hash: hashFacts({ rule: "fleet_incident", f }),
      inputs: { ...f, rooms },
    });
  }
  return out;
}
