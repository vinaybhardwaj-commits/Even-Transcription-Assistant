/**
 * lib/steward/rules.ts — Room Steward part 2: the decision rules. PURE: a RoomSense, the Config, a clock and the room's recent decisions go in; Decisions come
 * out. No I/O, no randomness, no Date.now(). Part 2 only RECORDS what these decisions would do (the executor is a shadow).
 *
 * RULE ORDER (first match wins; the primary decision is element 0, a few rules add a second element):
 *   0  no_machine / sense_degraded     no bound machine; or the session state cannot be read.
 *   OUTSIDE the window (windowAt):
 *   1  closed_day                      a closed IST day (days.closed): a session is left alone.
 *   2  end_of_window                   session open -> scribe_stop; consult open -> wait up to late_stop_max_min (30), then scribe_stop + "late stop" message.
 *   3  outside_window                  nothing to do.
 *   INSIDE the window:
 *   4  kiosk_asleep                    poller AND kiosk-health heartbeat both stale > 3 min -> ticket wake; message after 10 min.
 *   5  not_recording                   no session, reachable -> scribe_start; room_failing backoff, then max start_retries tries, then message + needs_hands.
 *   6  session_died                    no chunk for 10 min AND (recorder.status stale > 3 min OR recorder session_open=false) -> scribe_restart, then
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
 * Then, over the primary decision: (a) the same action failing >= 3 times in 60 min -> message + needs_hands; (b) actions_per_room_per_hour cap;
 * (c) a fleet incident (>= 3 rooms failing the same rule, or a hold row < 15 min old) holds the per-room action.
 * Chrome-touching tickets (open_pulse, relaunch_chrome, policy_cycle) are gated: occupancy nobody AND no pending login AND poller idle >= 600 s AND no consult open.
 * A blocked decision is log_only with the blocking condition in why_not.
 */
import { createHash } from "node:crypto";
import { istMidnightOf, windowAt, type Config, type WindowState } from "./config";
import type { RoomSense } from "./sense";
import { paramsValid, type StewardAction } from "./tickets";

export type DecisionAction =
  | "scribe_start"
  | "scribe_stop"
  | "scribe_restart"
  | `ticket:${StewardAction}`
  | "message"
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
};

export type RecentAction = {
  ts: string;
  rule: string;
  action: string;
  params: Record<string, unknown>;
  outcome: "ok" | "failed" | "shadow" | null;
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
/** lib/bench-commands START_BACKOFF_MAX_FAILED, copied so this file stays free of the bench module. */
export const START_BACKOFF_MAX_FAILED = 2;

/** Rules whose decision means "this room is failing", the fleet-incident classes. */
export const FAILING_RULES: readonly string[] = ["not_recording", "session_died", "kiosk_asleep", "kiosk_health_down", "mic_fault", "profile_unloaded", "extension_missing"];

export const CHROME_TOUCHING: readonly StewardAction[] = ["open_pulse", "relaunch_chrome", "policy_cycle"];

const ACTIONABLE = (a: string): boolean => a === "scribe_start" || a === "scribe_stop" || a === "scribe_restart" || a.startsWith("ticket:") || a === "message";
const COUNTED_FOR_CAP = (a: string): boolean => a === "scribe_start" || a === "scribe_stop" || a === "scribe_restart" || a.startsWith("ticket:");

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

function ages(c: Ctx): Record<string, unknown> {
  const { s, age } = c;
  return {
    poller_ok_s: secs(age(s.reachable.poller_ok_at)),
    kh_heartbeat_s: secs(age(s.reachable.kh_heartbeat_at)),
    last_chunk_s: secs(age(s.recording.last_chunk_at)),
    recorder_status_s: secs(age(s.recording.recorder_status?.received_at)),
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
): Decision {
  const f = { ...facts(c), ...extraFacts };
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
    inputs: { ...f, ages_s: ages(c) },
  };
}

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
  if (win.closed_day) {
    return [mk(c, "closed_day", "none", {}, s.recording.session_open ? "closed day: a session is open and is left alone" : "closed day", null, "info")];
  }
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
          ),
        ];
      }
      return [
        mk(c, "end_of_window", "scribe_stop", { late: true }, `window ended ${sinceTxt} ago and the consult is still open: stopping anyway (late stop)`, null, "warn"),
        mk(c, "end_of_window", "message", { kind: "late_stop", text: `late stop: session closed ${sinceTxt} after the window ended with a consult still open` }, "late stop notice", null, "warn"),
      ];
    }
    return [mk(c, "end_of_window", "scribe_stop", {}, `window ended ${sinceTxt} ago and no consult is open`, null, "info")];
  }
  return [mk(c, "outside_window", "none", {}, "outside the schedule window", null, "info")];
}

function kioskAsleep(c: Ctx): Decision[] | null {
  const { s, age } = c;
  const pAge = age(s.reachable.poller_ok_at);
  const kAge = age(s.reachable.kh_heartbeat_at);
  const pStale = pAge === null || pAge > ASLEEP_AFTER_MS;
  const kStale = kAge === null || kAge > ASLEEP_AFTER_MS;
  if (!(pStale && kStale)) return null;
  const out: Decision[] = [mk(c, "kiosk_asleep", "ticket:wake", {}, "poller and kiosk-health heartbeat both stale > 3 min: the Mac looks asleep", null, "error")];
  if ((pAge === null || pAge > ASLEEP_MESSAGE_AFTER_MS) && (kAge === null || kAge > ASLEEP_MESSAGE_AFTER_MS)) {
    out.push(mk(c, "kiosk_asleep", "message", { kind: "asleep_10m", needs_hands: true, text: "kiosk unreachable for 10+ min inside the window — needs hands" }, "still unreachable after 10 min", "wake ticket did not bring the Mac back", "error"));
  }
  return out;
}

function notRecording(c: Ctx): Decision[] {
  const { s, cfg } = c;
  const L = s.listener;
  if (L.paused === true) {
    return [mk(c, "not_recording", "log_only", {}, "inside the window with no session, but the room is paused (consent pause)", "scribe_start held: room paused", "info")];
  }
  const tries = rowsOf(c, "scribe_start", START_TRIES_WINDOW_MS).filter((r) => r.outcome !== "ok").length;
  if (tries >= cfg.caps.start_retries) {
    return [
      mk(
        c,
        "not_recording",
        "message",
        { kind: "start_exhausted", needs_hands: true, tries, text: `recorder will not start after ${tries} tries — needs hands` },
        `scribe_start tried ${tries} times in the last hour and the room is still not recording`,
        `scribe_start held: ${cfg.caps.start_retries} tries used`,
        "error",
      ),
    ];
  }
  if (s.start_backoff === null) {
    return [mk(c, "not_recording", "log_only", {}, "inside the window with no session, but start history is unreadable", "scribe_start held: start_attempts missing", "warn")];
  }
  if (s.start_backoff.failed_attempts >= START_BACKOFF_MAX_FAILED) {
    return [
      mk(
        c,
        "not_recording",
        "log_only",
        { retry_after_s: s.start_backoff.retry_after_s },
        `inside the window with no session; the room is failing (${s.start_backoff.failed_attempts} failed starts in the last hour)`,
        `scribe_start held: room_failing backoff, retry in ${s.start_backoff.retry_after_s} s`,
        "warn",
      ),
    ];
  }
  return [mk(c, "not_recording", "scribe_start", {}, "inside the window, no session open, kiosk reachable", null, "warn", { tries })];
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
  const khDown = khAge === null || khAge > KH_DOWN_AFTER_MS;
  const rsAge = age(rs?.received_at);
  // With kiosk-health itself down, a stale recorder.status says nothing about the recorder.
  const recorderStale = !khDown && (rs === null || rsAge === null || rsAge > RECORDER_STALE_MS);
  const recorderClosed = rs?.session_open === false;
  if (!(recorderStale || recorderClosed)) return null;
  const why = `no chunk for ${Math.round(chunkAge / MIN)} min and ${recorderClosed ? "the recorder says no session is open" : "recorder.status is stale"}`;
  const restarts = rowsOf(c, "scribe_restart", LADDER_MEMORY_MS);
  const appRestarts = rowsOf(c, "ticket:restart_recorder_app", LADDER_MEMORY_MS);
  if (restarts.length === 0) return [mk(c, "session_died", "scribe_restart", {}, why, null, "error", { recorder_closed: recorderClosed, restarts: 0 })];
  const lastRestartAge = Math.min(...restarts.map((r) => c.A - Date.parse(r.ts)));
  if (appRestarts.length === 0 && lastRestartAge < LADDER_STEP_MS) {
    return [mk(c, "session_died", "log_only", {}, `${why}; scribe_restart sent ${Math.round(lastRestartAge / MIN)} min ago, waiting 5 min`, "next step held: waiting for the restart to take effect", "warn", { recorder_closed: recorderClosed, restarts: restarts.length })];
  }
  if (recorderClosed && appRestarts.length === 0) {
    return [mk(c, "session_died", "ticket:restart_recorder_app", {}, `${why}; scribe_restart did not recover it`, null, "error", { recorder_closed: true, restarts: restarts.length })];
  }
  return [
    mk(
      c,
      "session_died",
      "message",
      { kind: "recorder_stalled", needs_hands: true, text: "recorder stalled and automatic restarts did not recover it — needs hands" },
      `${why}; restart ladder exhausted`,
      appRestarts.length > 0 ? "restart_recorder_app already tried" : "restart_recorder_app skipped: the recorder has not confirmed that no session is open",
      "error",
      { recorder_closed: recorderClosed, restarts: restarts.length, app_restarts: appRestarts.length },
    ),
  ];
}

function kioskHealthDown(c: Ctx): Decision[] | null {
  const { s, age } = c;
  if (s.reachable.kh_enrolled !== true) return null;
  const pAge = age(s.reachable.poller_ok_at);
  if (pAge === null || pAge > ASLEEP_AFTER_MS) return null; // the poller is not ok: that is the asleep rule's business
  const kAge = age(s.reachable.kh_heartbeat_at);
  if (kAge !== null && kAge <= KH_DOWN_AFTER_MS) return null;
  const out: Decision[] = [mk(c, "kiosk_health_down", "ticket:restart_kiosk_health", {}, "no kiosk-health heartbeat for 5 min while the poller is ok", null, "warn")];
  if (kAge === null || kAge >= KH_DOWN_MESSAGE_AFTER_MS) {
    out.push(mk(c, "kiosk_health_down", "message", { kind: "kh_down_10m", needs_hands: true, text: "kiosk-health daemon still down after 10 min — needs hands" }, "still down after 10 min", "restart_kiosk_health did not bring it back", "warn"));
  }
  return out;
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
    return [mk(c, "mic_fault", "message", { kind: "mic_missing", text: "mic unplugged/missing — check cable" }, "consult open >= 60 s and the default input is missing", "never a restart: the mic is physical", "error")];
  }
  return [mk(c, "mic_fault", "message", { kind: "mic_silent", text: "no sound from the mic — check mute or cable" }, "consult open >= 60 s and the tape has been silent >= 60 s", "never a restart: the mic is physical", "error")];
}

function profileUnloaded(c: Ctx): Decision[] | null {
  const { s, age } = c;
  const ch = s.chrome;
  if (!s.ext.applicable || ch.running !== true || !ch.last_used || !ch.active) return null;
  if (ch.active.includes(ch.last_used)) return null;
  const extAge = age(s.ext.last_event_at);
  if (extAge !== null && extAge < PROFILE_QUIET_MS) return null;
  return chromeTicket(c, "profile_unloaded", "open_pulse", ch.last_used, "chrome is running but the profile in use is not loaded and the extension is silent", "warn", null);
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
    return chromeTicket(c, "extension_missing", "relaunch_chrome", profile, "the extension is missing from the profile (chrome.alert)", "error", null);
  }
  const lastAge = Math.min(...relaunches.map((r) => c.A - Date.parse(r.ts)));
  if (lastAge < 2 * LADDER_STEP_MS) {
    return [mk(c, "extension_missing", "log_only", { profile }, `relaunch_chrome sent ${Math.round(lastAge / MIN)} min ago; waiting before the policy cycle`, "policy_cycle held: waiting 10 min after relaunch", "warn")];
  }
  const dayStart = istMidnightOf(c.A);
  const cycles = c.recent.room.filter((r) => r.action === "ticket:policy_cycle" && r.params?.profile === profile && Date.parse(r.ts) >= dayStart).length;
  if (cycles >= c.cfg.caps.policy_cycle_per_profile_per_day) {
    return [
      mk(
        c,
        "extension_missing",
        "message",
        { kind: "policy_cycle_cap", needs_hands: true, profile, text: "extension still missing after relaunch and the daily policy cycle — needs hands" },
        "relaunch did not restore the extension and the daily policy_cycle is spent",
        `policy_cycle held: ${cycles} of ${c.cfg.caps.policy_cycle_per_profile_per_day} used today for this profile`,
        "error",
      ),
    ];
  }
  return chromeTicket(c, "extension_missing", "policy_cycle", profile, "relaunch_chrome did not restore the extension", "error", "relaunch_chrome already tried");
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
        mk(
          c,
          "action_failing",
          "message",
          { kind: "action_failing", needs_hands: true, action: p.action, ...(typeof p.params?.profile === "string" ? { profile: p.params.profile } : {}), failures: failed, text: `${p.action} has failed ${failed} times — stopped, needs hands` },
          `${p.action} failed ${failed} times in the last hour`,
          `${p.action} held: failing ${failed} times`,
          "error",
          { failed_action: p.action, failures: failed },
        ),
      ];
    }
  }

  // (b) cap on actions per room per hour
  const head = out[0]!;
  if (COUNTED_FOR_CAP(head.action)) {
    const n = c.recent.room.filter((r) => COUNTED_FOR_CAP(r.action) && c.A - Date.parse(r.ts) <= 60 * MIN && c.A >= Date.parse(r.ts)).length;
    if (n >= c.cfg.caps.actions_per_room_per_hour) {
      out = [
        mk(
          c,
          "cap_reached",
          "log_only",
          { wanted: head.action, ...(typeof head.params?.profile === "string" ? { profile: head.params.profile } : {}) },
          `wanted ${head.action} (${head.rule}) but the hourly action cap is reached`,
          `actions_per_room_per_hour=${c.cfg.caps.actions_per_room_per_hour} reached (${n} in the last hour)`,
          "warn",
          { capped_rule: head.rule },
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
        mk(
          c,
          "fleet_hold",
          "log_only",
          { class: h.rule, wanted: h.action },
          `fleet incident: ${Math.max(n, FLEET_MIN_ROOMS)}+ rooms failing "${h.rule}"; the per-room ${h.action} is held for 15 min`,
          `${h.action} held: fleet incident on ${h.rule}`,
          "warn",
          { class: h.rule },
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
  return guards(c, chain(c));
}

/**
 * The fleet-incident class a room's decisions put it in (S4), or null. A held decision keeps its class, so a room under a hold still counts as failing.
 */
export function failingClass(ds: readonly Decision[]): string | null {
  const p = ds[0];
  if (!p) return null;
  if (p.rule === "fleet_hold") return typeof p.params.class === "string" ? p.params.class : null;
  if (p.rule === "action_failing" || p.rule === "cap_reached") {
    const w = p.inputs.capped_rule;
    return typeof w === "string" && FAILING_RULES.includes(w) ? w : null;
  }
  return FAILING_RULES.includes(p.rule) ? p.rule : null;
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
