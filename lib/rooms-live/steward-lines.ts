/**
 * lib/rooms-live/steward-lines.ts — Rooms Live v1.7 (FLEET spec SPEC-RL-STEWARD-v1): the ONE mapping table from a Steward decision row to a plain sentence, and the status strip.
 * PURE: no I/O, no clock. No raw rule or action name is ever rendered: an unknown rule / action / result falls back to a generic sentence, never to its own name.
 *
 * A row is (rule, action, mode, result, pstate). The sentence is composed from three tables, so every combination is covered by construction:
 *   ACTION      action -> the verb phrase in three forms (past "restarted recording", would "restart recording"; both read "Steward <form> at HH:MM")
 *   REASON      rule   -> why (used after message / alert: "Steward messaged staff at 14:23: the recording stopped")
 *   NOTE        rule   -> the sentence for a row that did nothing (log_only / none): the Steward noticed or is holding
 * and the outcome class of (mode, result): done | pending | failed | skipped | watching.
 * PHI: none. Only the time (IST), the Steward's own words and, never, the params / why text of the row.
 */

export type StewardRowIn = { rule: string; action: string; mode: string; result: string | null; ts: string; /** params->>'state' (session_died: confirming | cleared | message_sent), else null */ pstate?: string | null };

export type Outcome = "done" | "pending" | "failed" | "skipped" | "watching";
export type StewardKind = "action" | "hold" | "note";
export type StewardLine = { text: string; at: string; mode: "live" | "shadow"; outcome: Outcome; kind: StewardKind };

const IST_MS = 19_800_000;
export const istHm = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "--:--";
  const m = Math.floor(((t + IST_MS) % 86_400_000) / 60_000);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** the first word of a result: "failed: no ack after 60 s" -> "failed"; "kill_switch" -> "kill_switch" */
export const resultPrefix = (result: string | null): string => (result ?? "").trim().split(/[:\s]/)[0]!.toLowerCase();

export function outcomeOf(mode: string, result: string | null): Outcome {
  if (mode !== "live") return "watching"; // shadow / kill_switch / blocked: the Steward recorded what it would do and did nothing
  const p = resultPrefix(result);
  if (p === "ok") return "done";
  if (p === "pending" || p === "sending") return "pending";
  if (p === "failed") return "failed";
  if (p === "skipped") return "skipped";
  return "watching"; // a live row with an unrecognised or empty result is NOT claimed as done
}

type Verb = { past: string; infinitive: string };
const ACTION: Record<string, Verb> = {
  scribe_start: { past: "started recording", infinitive: "start recording" },
  scribe_restart: { past: "restarted recording", infinitive: "restart recording" },
  scribe_stop: { past: "stopped recording", infinitive: "stop recording" },
  message: { past: "messaged staff", infinitive: "message staff" },
  alert: { past: "raised an alert", infinitive: "raise an alert" },
  "ticket:wake": { past: "asked the kiosk to wake", infinitive: "ask the kiosk to wake" },
  "ticket:open_pulse": { past: "asked the kiosk to open Pulse", infinitive: "ask the kiosk to open Pulse" },
  "ticket:relaunch_chrome": { past: "asked the kiosk to relaunch Chrome", infinitive: "ask the kiosk to relaunch Chrome" },
  "ticket:policy_cycle": { past: "asked the kiosk to refresh its Chrome settings", infinitive: "ask the kiosk to refresh its Chrome settings" },
  "ticket:restart_recorder_app": { past: "asked the kiosk to restart the recorder app", infinitive: "ask the kiosk to restart the recorder app" },
  "ticket:restart_kiosk_health": { past: "asked the kiosk to restart its health program", infinitive: "ask the kiosk to restart its health program" },
};
const ACTION_UNKNOWN: Verb = { past: "took an action", infinitive: "take an action" };
const verbOf = (action: string): Verb => ACTION[action] ?? (action.startsWith("ticket:") ? { past: "asked the kiosk for help", infinitive: "ask the kiosk for help" } : ACTION_UNKNOWN);

const REASON: Record<string, string> = {
  session_died: "the recording stopped",
  mic_fault: "the mic is missing or silent",
  device_missing: "the mic is missing",
  device_missing_hold: "the mic is missing",
  kiosk_asleep: "the kiosk is asleep",
  kiosk_health_down: "the kiosk health program is down",
  not_recording: "recording has not started",
  start_exhausted: "recording would not start after repeated tries",
  action_failing: "an automatic fix keeps failing",
  fleet_incident: "several rooms have the same fault",
  profile_unloaded: "the browser profile is not loaded",
  extension_missing: "the browser extension is missing",
  end_of_window: "the day's recording window ended",
};
const REASON_UNKNOWN = "something in the room needs a look";

const NOTE: Record<string, string | ((pstate: string | null) => string)> = {
  session_died: (p) =>
    p === "confirming" ? "Steward saw the recording stop and is checking once more before acting"
    : p === "cleared" ? "Steward saw the recording come back"
    : p === "message_sent" ? "Steward is holding: staff were already told the recording stopped"
    : "Steward is waiting for the restart to take effect",
  doctor_away: "Steward noted the doctor is away from the Pulse tab",
  silent_no_consult: "Steward noted the room is silent and no consult is open",
  mic_check_pending: "Steward is checking the mic before saying anything",
  mic_fault: "Steward noted the mic is missing or silent",
  device_missing: "Steward noted the mic is back",
  device_missing_hold: "Steward is holding restarts: the mic is missing",
  not_recording: "Steward is holding the start and will try again later",
  start_exhausted: "Steward has used all of today's start tries",
  kiosk_asleep: "Steward noted the kiosk is asleep",
  kiosk_health_down: "Steward noted the kiosk health program is down",
  sense_degraded: "Steward cannot read some of this room's signals right now",
  no_machine: "Steward has no kiosk linked to this room",
  cap_reached: "Steward is holding an action: the hourly limit is reached",
  fleet_hold: "Steward is holding actions: several rooms have the same fault",
  action_failing: "Steward stopped an automatic fix that keeps failing",
  profile_unloaded: "Steward noted the browser profile is not loaded",
  extension_missing: "Steward noted the browser extension is missing",
  identity_fault: "Steward noted a sign-in mismatch at the kiosk",
  end_of_window: "Steward noted the day's recording window ended",
  closed_day: "Steward noted the room is closed today",
  outside_window: "Steward noted the room is outside recording hours",
};
const NOTE_UNKNOWN = "Steward noted something in this room";

const tail = (o: Outcome, v: Verb, hm: string, result: string | null): string => {
  switch (o) {
    case "pending": return `Steward asked to ${v.infinitive} at ${hm}, waiting for the kiosk to answer`;
    case "failed": return `Steward tried to ${v.infinitive} at ${hm}, ${/no ack/i.test(result ?? "") ? "the kiosk did not answer" : "it did not go through"}`;
    case "skipped": return /^\s*skipped:\s*kiosk not listening/i.test(result ?? "") ? `Steward did not ${v.infinitive} at ${hm}, the kiosk was not ready` : `Steward's request to ${v.infinitive} at ${hm} was not sent`;
    default: return "";
  }
};

/** The sentence for ONE row. Never null; never contains a raw rule / action / result name. */
export function sentenceOf(r: StewardRowIn): string {
  const hm = istHm(r.ts);
  const o = outcomeOf(r.mode, r.result);
  if (r.action === "none" || r.action === "log_only") {
    const n = NOTE[r.rule];
    return typeof n === "function" ? n(r.pstate ?? null) : (n ?? NOTE_UNKNOWN);
  }
  const v = verbOf(r.action);
  const why = r.action === "message" || r.action === "alert" ? `: ${REASON[r.rule] ?? REASON_UNKNOWN}` : "";
  if (o === "watching") return `Steward would have ${v.past} at ${hm}${why} (watching only, not done)`;
  if (o === "done") return `Steward ${v.past} at ${hm}${why}`;
  return `${tail(o, v, hm, r.result)}${why}`;
}

/** The kind of a row: an action Steward did or would do, a hold, or a plain note. */
export const kindOf = (r: Pick<StewardRowIn, "action" | "rule">): StewardKind => (r.action === "none" || r.action === "log_only" ? (/hold|cap_reached|not_recording/.test(r.rule) ? "hold" : "note") : "action");

export const lineOf = (r: StewardRowIn): StewardLine => ({ text: sentenceOf(r), at: r.ts, mode: r.mode === "live" ? "live" : "shadow", outcome: outcomeOf(r.mode, r.result), kind: kindOf(r) });

// ---------------------------------------------------------------------------
// S2: the one line on a room card
// ---------------------------------------------------------------------------
export const CARD_LINE_WINDOW_MS = 60 * 60_000;
const isAct = (r: StewardRowIn) => r.action !== "none" && r.action !== "log_only";

/**
 * The newest row in the last 60 min whose action is not none / log_only; else the newest device_missing_hold row of the last 60 min; else null (nothing is shown).
 * `rows` are this room's rows, any order. A row from the future (> 5 s) is ignored.
 */
export function cardLine(rows: readonly StewardRowIn[], nowMs: number): StewardLine | null {
  const fresh = rows.filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t <= nowMs + 5000 && nowMs - t <= CARD_LINE_WINDOW_MS;
  });
  const newest = (xs: StewardRowIn[]) => xs.reduce<StewardRowIn | null>((b, r) => (b === null || Date.parse(r.ts) > Date.parse(b.ts) ? r : b), null);
  const act = newest(fresh.filter(isAct));
  if (act) return lineOf(act);
  const hold = newest(fresh.filter((r) => r.rule === "device_missing_hold"));
  return hold ? lineOf(hold) : null;
}

/** S3: the rows that go into "Changes today": live actions (not none / log_only), plus every message / alert in any mode. Shadow starts, restarts and tickets are not changes. */
export const isChange = (r: StewardRowIn): boolean => isAct(r) && (r.mode === "live" || r.action === "message" || r.action === "alert");

// ---------------------------------------------------------------------------
// S1: the status strip
// ---------------------------------------------------------------------------
export type StewardStatus =
  | { state: "unavailable" }
  | { state: "off"; last_tick_at: string | null }
  | { state: "on"; last_tick_at: string | null; /** scribe_start executes for real */ starts_live: boolean; /** every other action: "watching" none live | "live" all live | "partly" */ others: "watching" | "live" | "partly" };

export const STRIP_AMBER_MS = 3 * 60_000;
export const STRIP_RED_MS = 10 * 60_000;
export type StripView = { text: string; tone: "ok" | "amber" | "red" | "off" | "unavailable" };

const agoText = (ms: number): string => {
  if (ms < 60_000) return "under 1 min ago";
  const m = Math.floor(ms / 60_000);
  if (m < 120) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
};

export function stripView(s: StewardStatus | null | undefined, nowMs: number): StripView {
  if (!s || s.state === "unavailable") return { text: "Steward status unavailable", tone: "unavailable" };
  if (s.state === "off") return { text: "Steward off", tone: "off" };
  const t = s.last_tick_at ? Date.parse(s.last_tick_at) : NaN;
  const age = Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
  const checked = age === null ? "has not checked yet" : `checked ${agoText(age)}`;
  const tone: StripView["tone"] = age === null || age > STRIP_RED_MS ? "red" : age > STRIP_AMBER_MS ? "amber" : "ok";
  const others = s.others === "live" ? "ON" : s.others === "partly" ? "partly ON" : "watching only";
  return { text: `Steward: ${checked} · starts recording: ${s.starts_live ? "ON" : "watching only"} · restarts and alerts: ${others}`, tone };
}
