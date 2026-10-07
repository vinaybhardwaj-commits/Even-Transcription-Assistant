/**
 * lib/steward/startday.ts — Room Steward: LIVE start_day (V decision 7 Oct 2026, option A: the Steward acts for start_day ONLY).
 *
 * The control loop already decides "would scribe_start" (rules.ts, rule not_recording). This module is what makes that ONE decision real, behind the switch
 * steward_config `start_day_live` ({"on": true|false}, default false) and the existing global kill switch. Nothing else leaves shadow.
 *
 *   shouldArm(cfg)                       start_day_live on AND kill switch off. Anything else = the loop behaves exactly as before (shadow / kill_switch rows).
 *   evaluateStartDay(input)              PURE. Every guard, first failing wins; returns {go} or {skip: reason} (+ an alert for the device case).
 *   readRecorderStreak(sql, ...)         the only extra read: kiosk-health recorder.status rows of the last 30 min, to prove "ready, no session, for >= 5 min".
 *   attemptStart(port, roomId)           the ONE enqueue path: findActiveSession + getListener + decideStart + insertCommand from lib/bench-commands.ts, the same
 *                                        functions the admin route and the MCP scribe_start_recording use (a second implementation of decideStart is how surfaces disagree).
 *
 * GUARDS (all must hold for an attempt):
 *   dev_room                   room flagged dev/test in steward_config.rooms, or one of NEVER_START_DAY_ROOMS (ORB3, Home Office)
 *   outside_start_window       now is not in 07:30-21:30 IST (start inclusive, end exclusive; a closed day is outside)
 *   kiosk_health_stale         no kiosk-health heartbeat for the room's machine within the last 3 min
 *   session_open               the sensed session is open (the loop's own read); the server is asked again at enqueue time (findActiveSession)
 *   recorder_*                 recorder.status must be ready with session_open false, continuously for >= 5 min, newest row <= 7 min old
 *   attempt_cap_reached        >= 3 attempts today (IST). attempt_backoff: 5 / 15 / 45 min after the 1st / 2nd / 3rd attempt
 *   device missing             the room's input device is absent (default input absent, install flag DEVICE_MISSING, or a USB removal with the newest row absent):
 *                              ONE attempt that IST day, then an alert decision naming room + device, and no retry until the device is present again.
 * An attempt counts whatever its result (ok=false, a refused enqueue). A start that finds a session already open (Kiosk Bot, anyone) is success and not an attempt.
 * Never stops, pauses, resumes or restarts anything.
 */
import { createHash } from "node:crypto";
import { machineKeys } from "@/lib/encounter-windows/machine-keys";
import { expandKeys } from "@/lib/kiosk-health-read";
import { istMidnightOf, windowAt, type Config } from "./config";
import type { Decision, RecentAction } from "./rules";
import type { RoomSense } from "./sense";
import { raceTimeout } from "./timeout";
import type { StewardSql } from "./tickets";

export const START_DAY_LIVE_KEY = "start_day_live";
/** rooms that never get a live start whatever the config says (ORB3, Home Office): dev / test rigs */
export const NEVER_START_DAY_ROOMS: readonly string[] = ["room_jwyrr4dc", "room_2qe955hy"];
/** the order's literal start window 07:30-21:30 IST (minutes of the IST day, end exclusive), applied IN ADDITION to the room's configured clinic window and closed days */
export const START_FROM_MIN = 7 * 60 + 30;
export const START_UNTIL_MIN = 21 * 60 + 30;
export const KH_FRESH_MS = 3 * 60_000;
export const READY_MIN_MS = 5 * 60_000;
/** kiosk-health re-emits recorder.status at least every 300 s: a newest row older than this is not evidence of anything */
export const STATUS_MAX_AGE_MS = 7 * 60_000;
export const STREAK_LOOKBACK_MS = 30 * 60_000;
export const MAX_ATTEMPTS_PER_DAY = 3;
/** wait after the 1st, 2nd, 3rd attempt of the day (the 3rd entry only matters if the daily cap is ever raised) */
export const BACKOFF_MIN: readonly number[] = [5, 15, 45];
/** a start_day command created this recently (any source: Kiosk Bot, admin, an earlier tick whose decision row failed to write) means one is in flight */
export const IN_FLIGHT_S = 240;

export const SKIP_RULE = "start_day_skip";
export const ALERT_RULE = "start_day_alert";

/** steward_config.start_day_live armed? (the global kill switch always wins) */
export const shouldArm = (cfg: Config): boolean => cfg.start_day_live === true && cfg.kill_switch === false;

// ---------------------------------------------------------------------------
// recorder streak
// ---------------------------------------------------------------------------

export type RecorderRow = { received_at: string; state: string | null; session_open: string | boolean | null };
export type StreakVerdict = { ok: true; ready_since: string } | { ok: false; reason: "recorder_status_unavailable" | "recorder_status_stale" | "recorder_not_ready" | "recorder_ready_under_5min" };

const isReady = (r: RecorderRow): boolean => typeof r.state === "string" && r.state.trim().toLowerCase() === "ready" && (r.session_open === false || r.session_open === "false");

/** PURE. Rows newest first or in any order; the streak is the run of newest rows that are all ready with no session. */
export function recorderVerdict(rowsIn: readonly RecorderRow[], A: number): StreakVerdict {
  const rows = rowsIn
    .map((r) => ({ ...r, t: Date.parse(r.received_at) }))
    .filter((r) => Number.isFinite(r.t) && r.t <= A)
    .sort((a, b) => b.t - a.t);
  if (rows.length === 0) return { ok: false, reason: "recorder_status_unavailable" };
  if (A - rows[0]!.t > STATUS_MAX_AGE_MS) return { ok: false, reason: "recorder_status_stale" };
  if (!isReady(rows[0]!)) return { ok: false, reason: "recorder_not_ready" };
  let since = rows[0]!.t;
  for (const r of rows) {
    if (!isReady(r)) break;
    since = r.t;
  }
  if (A - since < READY_MIN_MS) return { ok: false, reason: "recorder_ready_under_5min" };
  return { ok: true, ready_since: new Date(since).toISOString() };
}

/** The extra read of a live tick: recorder.status rows of the room's machine, last 30 min. Null on any failure (the guard then refuses). */
export async function readRecorderStreak(sql: StewardSql, machine: string, A: number, timeoutMs: number): Promise<RecorderRow[] | null> {
  const hi = new Date(A).toISOString();
  const keys = expandKeys(machineKeys(machine));
  try {
    const rows = await raceTimeout(
      async () =>
        (await sql`
          SELECT k.received_at, k.payload->>'state' AS state, k.payload->>'session_open' AS session_open
            FROM kiosk_health_events k
           WHERE k.machine = ANY(${keys}::text[]) AND k.kind = 'recorder.status'
             AND k.received_at > ${hi}::timestamptz - make_interval(secs => ${STREAK_LOOKBACK_MS / 1000}::int) AND k.received_at <= ${hi}::timestamptz
           ORDER BY k.received_at DESC
           LIMIT 60
        `) as unknown as Array<{ received_at: unknown; state: unknown; session_open: unknown }>,
      timeoutMs,
    );
    return rows.map((r) => ({
      received_at: new Date(r.received_at as string | number | Date).toISOString(),
      state: typeof r.state === "string" ? r.state : null,
      session_open: typeof r.session_open === "string" || typeof r.session_open === "boolean" ? r.session_open : null,
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the guards
// ---------------------------------------------------------------------------

export const deviceMissing = (s: RoomSense): boolean => s.audio.default_input_present === false || s.audio.usb_removed_recent === true || s.audio.device_missing_flag === true;

export type StartDayInput = {
  sense: RoomSense;
  cfg: Config;
  A: number;
  /** the room's decisions of the last 24 h (steward_decisions, action <> 'none'), any order */
  recent: readonly RecentAction[];
  /** the recorder.status rows (null = the read failed) */
  recorder: readonly RecorderRow[] | null;
  /** room_install.expected_device_name when known (the alert names it) */
  deviceName?: string | null;
};

export type StartDayVerdict =
  | { go: true; device_missing: boolean; facts: Record<string, unknown> }
  | { go: false; reason: string; alert?: { device: string }; facts: Record<string, unknown> };

const isAttempt = (r: RecentAction): boolean => r.action === "scribe_start" && (r.outcome === "ok" || r.outcome === "failed");

/** PURE. The IST-day attempts of the room, oldest first. */
export function attemptsToday(recent: readonly RecentAction[], A: number): RecentAction[] {
  const midnight = istMidnightOf(A);
  return recent
    .filter((r) => isAttempt(r) && Date.parse(r.ts) >= midnight && Date.parse(r.ts) <= A)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

export function evaluateStartDay(inp: StartDayInput): StartDayVerdict {
  const { sense: s, cfg, A, recent } = inp;
  const facts: Record<string, unknown> = {};
  const skip = (reason: string, extra?: Record<string, unknown>): StartDayVerdict => ({ go: false, reason, facts: { ...facts, ...(extra ?? {}) } });

  if (NEVER_START_DAY_ROOMS.includes(s.room_id) || s.flags.some((f) => ["dev", "test"].includes(f.toLowerCase())) || (cfg.rooms[s.room_id]?.flags ?? []).some((f) => ["dev", "test"].includes(f.toLowerCase()))) {
    return skip("dev_room");
  }
  const w = windowAt(cfg, "clinic", A);
  const istMin = Math.floor((A - istMidnightOf(A)) / 60_000);
  if (!w.in_window || istMin < START_FROM_MIN || istMin >= START_UNTIL_MIN) return skip("outside_start_window");

  const kh = s.reachable.kh_heartbeat_at ? Date.parse(s.reachable.kh_heartbeat_at) : NaN;
  facts.kh_heartbeat_age_s = Number.isFinite(kh) ? Math.round((A - kh) / 1000) : null;
  if (!Number.isFinite(kh) || A - kh > KH_FRESH_MS || kh > A + 60_000) return skip("kiosk_health_stale");

  if (s.recording.session_open !== false) return skip(s.recording.session_open === true ? "session_open" : "session_unknown");

  if (inp.recorder === null) return skip("recorder_status_unavailable");
  const rv = recorderVerdict(inp.recorder, A);
  if (!rv.ok) return skip(rv.reason);
  facts.recorder_ready_since = rv.ready_since;

  const today = attemptsToday(recent, A);
  facts.attempts_today = today.length;
  if (today.length >= MAX_ATTEMPTS_PER_DAY) return skip("attempt_cap_reached");
  if (today.length > 0) {
    const last = Date.parse(today[today.length - 1]!.ts);
    const waitMin = BACKOFF_MIN[Math.min(today.length, BACKOFF_MIN.length) - 1]!;
    facts.backoff_min = waitMin;
    if (A - last < waitMin * 60_000) return skip(`attempt_backoff_${waitMin}m`, { retry_after_s: Math.ceil((waitMin * 60_000 - (A - last)) / 1000) });
  }

  const missing = deviceMissing(s);
  facts.device_missing = missing;
  if (missing) {
    const deviceAttempts = today.filter((r) => r.params.device_missing === true);
    if (deviceAttempts.length > 0) {
      const lastAttempt = Date.parse(deviceAttempts[deviceAttempts.length - 1]!.ts);
      const alerted = recent.some((r) => r.rule === ALERT_RULE && Date.parse(r.ts) >= lastAttempt && Date.parse(r.ts) <= A);
      const device = inp.deviceName?.trim() || "input device (name not reported)";
      // the alert is written ONCE per device-missing attempt; after that the room is held until the device is present again
      return alerted ? skip("device_missing_hold") : { go: false, reason: "device_missing_after_attempt", alert: { device }, facts };
    }
  }
  return { go: true, device_missing: missing, facts };
}

// ---------------------------------------------------------------------------
// the enqueue path (reused, not re-implemented)
// ---------------------------------------------------------------------------

/** The functions of lib/bench-commands.ts the admin route and scribe_start_recording use. Injected in tests; the default imports them lazily. */
export interface StartDayPort {
  findActiveSession(roomId: string): Promise<{ id: string; status: string; started_at: string } | null>;
  getListener(roomId: string): Promise<unknown>;
  decideStart(i: { listener: never; activeSession: { id: string; status: string } | null; overridePause: boolean; now?: Date }): { action: "reject"; error: string } | { action: "already_recording"; session_id: string } | { action: "send"; args: Record<string, unknown> | null };
  insertCommand(i: { roomId: string; kind: "start_day"; args?: unknown; source?: string }): Promise<string>;
}

export async function defaultPort(): Promise<StartDayPort> {
  // lazy: lib/bench-commands pulls in the app's global DB client, which the pure parts of the loop (and its tests) must not need
  const m = await import("@/lib/bench-commands");
  return { findActiveSession: m.findActiveSession, getListener: m.getListener, decideStart: m.decideStart as never, insertCommand: m.insertCommand as never };
}

export type AttemptResult = { counted: boolean; result: string };

/** ONE start_day for the room, or the reason there was none. counted = an attempt for the daily cap. Never throws. */
export async function attemptStart(port: StartDayPort, roomId: string, A: number): Promise<AttemptResult> {
  try {
    const [listener, activeSession] = await Promise.all([port.getListener(roomId), port.findActiveSession(roomId)]);
    const d = port.decideStart({ listener: listener as never, activeSession, overridePause: false, now: new Date(A) });
    if (d.action === "already_recording") return { counted: false, result: `skipped: already_recording (session ${d.session_id})` };
    if (d.action === "reject") return { counted: false, result: `skipped: ${d.error}` };
    const id = await port.insertCommand({ roomId, kind: "start_day", args: d.args ?? undefined, source: "steward" });
    return { counted: true, result: `ok: start_day queued ${id}` };
  } catch (e) {
    return { counted: true, result: `failed: ${(e instanceof Error ? e.message : "error").replace(/\s+/g, " ").slice(0, 120)}` };
  }
}

/** A start_day command created in the last IN_FLIGHT_S by anyone (server truth). null = unreadable (the caller refuses). */
export async function startInFlight(sql: StewardSql, roomId: string, A: number): Promise<boolean | null> {
  try {
    const rows = (await sql`
      SELECT 1 AS x FROM bench_command c
       WHERE c.room_id = ${roomId} AND c.kind = 'start_day'
         AND c.created_at > ${new Date(A).toISOString()}::timestamptz - make_interval(secs => ${IN_FLIGHT_S}::int)
       LIMIT 1
    `) as unknown[];
    return rows.length > 0;
  } catch {
    return null;
  }
}

export async function readExpectedDevice(sql: StewardSql, roomId: string): Promise<string | null> {
  try {
    const rows = (await sql`
      SELECT expected_device_name FROM room_install WHERE room_id = ${roomId} AND retired_at IS NULL AND enrolled_at IS NOT NULL LIMIT 1
    `) as Array<{ expected_device_name?: unknown }>;
    const n = rows[0]?.expected_device_name;
    return typeof n === "string" && n.trim() ? n.trim().slice(0, 80) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

const hash = (o: unknown): string => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

function base(d: Decision, rule: string, action: Decision["action"], params: Record<string, unknown>, why: string, why_not: string | null, severity: Decision["severity"], extra: Record<string, unknown>): Decision {
  const inputs = { ...extra, via: "start_day_live" };
  return { room_id: d.room_id, machine: d.machine, window_kind: d.window_kind, rule, action, params, why, why_not, severity, inputs_hash: hash({ rule, action, params, ...extra }), inputs };
}

/** Not attempted. A log_only row whose key is the reason: written when the reason changes (or the 15 min refresh). */
export const skipDecision = (d: Decision, reason: string, facts: Record<string, unknown>): Decision =>
  base(d, SKIP_RULE, "log_only", { reason }, `start_day not attempted: ${reason}`, `scribe_start held: ${reason}`, "info", facts);

/** The ONE alert of a device-missing attempt: names the room and the device. */
export const alertDecision = (d: Decision, room: { room_id: string; room_name: string }, device: string, facts: Record<string, unknown>): Decision =>
  base(d, ALERT_RULE, "log_only", { reason: "device_missing", device }, `start_day ALERT: room ${room.room_name} (${room.room_id}) input device missing: ${device}; one attempt made today, no retry until the device is present again`, null, "error", facts);

/** The attempt itself: the same decision with the device tag when the device was missing. */
export const attemptDecision = (d: Decision, deviceMissingFlag: boolean, facts: Record<string, unknown>): Decision => ({
  ...d,
  params: deviceMissingFlag ? { ...d.params, device_missing: true } : d.params,
  inputs: { ...d.inputs, ...facts, via: "start_day_live" },
  inputs_hash: hash({ rule: d.rule, action: d.action, device_missing: deviceMissingFlag, ...facts }),
});
