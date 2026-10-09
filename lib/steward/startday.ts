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
 *   day_ended_by_operator     a non-steward end_day of the room was acked in this IST day at or after 20:00 IST (V / Kiosk Bot / fable closed the day on purpose): no start_day until the next IST day
 *   late_start_blocked         no start at or after 20:30 IST unless the room has had no session at all this IST day
 *   day_state_unreadable       from 20:00 IST the two guards above need one read; if it fails, no start (fail safe)
 *   kiosk_health_stale         no kiosk-health heartbeat for the room's machine within the last 3 min
 *   session_open               the sensed session is open (the loop's own read); the server is asked again at enqueue time (findActiveSession)
 *   recorder_*                 recorder.status must be ready with session_open false, continuously for >= 5 min, newest row <= 7 min old (streak waived on a mic return)
 *   attempt_cap_reached        >= 3 attempts today (IST). attempt_backoff: 5 / 15 / 45 min after the 1st / 2nd / 3rd attempt
 *   waiting_for_mic            the room's input device is absent (default input absent, install flag DEVICE_MISSING, or a USB removal with the newest row absent):
 *                              NEVER an attempt. Checked right after the session guard, ABOVE the recorder, cap and backoff guards, so it wins over all of them. ONE alert
 *                              decision per IST day (names room + device). The room leaves waiting_for_mic only after 2 consecutive ticks with the mic present; a start
 *                              coming back from waiting skips the 5 min recorder-ready streak (newest recorder.status ready and <= 7 min old is enough). Waiting ticks are
 *                              not attempts, so a returning room keeps its full 3/day.
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
/** from 20:00 IST an operator end_day closes the day for the Steward; from 20:30 IST only a room with no session all day may still be started */
export const OPERATOR_END_FROM_MIN = 20 * 60;
export const LATE_START_FROM_MIN = 20 * 60 + 30;
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
export const WAITING_REASON = "waiting_for_mic";
/** alert reason after a start that came back from waiting_for_mic and then recorded digital zero */
export const MIC_SILENT_REASON = "mic_returned_but_silent";
/** a previous tick's "mic present" marker older than this is not the previous tick (the loop runs every minute) */
export const MIC_TICK_STALE_MS = 3 * 60_000;
export const MIC_RETURN_TICKS = 2;
/** after a mic-return start: this long of digital zero from the first level sample raises mic_returned_but_silent */
export const MIC_SILENT_AFTER_MS = 120_000;
/** shadow-only: kiosk recorder says a session is open, the server has none */
export const PHANTOM_RULE = "phantom_session";
export const PHANTOM_CANDIDATE_RULE = "phantom_session_candidate";

/** steward_config.start_day_live armed? (the global kill switch always wins) */
export const shouldArm = (cfg: Config): boolean => cfg.start_day_live === true && cfg.kill_switch === false;

// ---------------------------------------------------------------------------
// recorder streak
// ---------------------------------------------------------------------------

export type RecorderRow = { received_at: string; state: string | null; session_open: string | boolean | null };
export type StreakVerdict = { ok: true; ready_since: string } | { ok: false; reason: "recorder_status_unavailable" | "recorder_status_stale" | "recorder_not_ready" | "recorder_ready_under_5min" };

const isReady = (r: RecorderRow): boolean => typeof r.state === "string" && r.state.trim().toLowerCase() === "ready" && (r.session_open === false || r.session_open === "false");

/** PURE. Rows newest first or in any order; the streak is the run of newest rows that are all ready with no session. */
export function recorderVerdict(rowsIn: readonly RecorderRow[], A: number, opts: { skipStreak?: boolean } = {}): StreakVerdict {
  const rows = rowsIn
    .map((r) => ({ ...r, t: Date.parse(r.received_at) }))
    .filter((r) => Number.isFinite(r.t) && r.t <= A)
    .sort((a, b) => b.t - a.t);
  if (rows.length === 0) return { ok: false, reason: "recorder_status_unavailable" };
  if (A - rows[0]!.t > STATUS_MAX_AGE_MS) return { ok: false, reason: "recorder_status_stale" };
  if (!isReady(rows[0]!)) return { ok: false, reason: "recorder_not_ready" };
  if (opts.skipStreak) return { ok: true, ready_since: new Date(rows[0]!.t).toISOString() };
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
  /** readDayState() result; needed from 20:00 IST (undefined or null there = unreadable = no start) */
  day?: DayState | null;
};

export type DayState = {
  /** acked_at (ISO) of the newest non-steward end_day acked in this IST day at or after 20:00 IST, else null */
  operator_end_at: string | null;
  /** the room has had at least one bench_session start this IST day */
  session_today: boolean;
};

export type StartDayVerdict =
  | { go: true; mic_return: boolean; facts: Record<string, unknown> }
  | {
      go: false;
      reason: string;
      /** the once-per-IST-day waiting_for_mic alert */
      alert?: { device: string };
      /** extra params of the skip row (waiting_for_mic carries mic_ticks; later guards of a mic return carry mic_return) */
      params?: Record<string, unknown>;
      /** write the row even if the dedupe would drop it (the "mic present, 1 of 2" marker the next tick reads) */
      force?: boolean;
      facts: Record<string, unknown>;
    };

const isAttempt = (r: RecentAction): boolean => r.action === "scribe_start" && (r.outcome === "ok" || r.outcome === "failed");

/** PURE. The IST-day attempts of the room, oldest first. */
export function attemptsToday(recent: readonly RecentAction[], A: number): RecentAction[] {
  const midnight = istMidnightOf(A);
  return recent
    .filter((r) => isAttempt(r) && Date.parse(r.ts) >= midnight && Date.parse(r.ts) <= A)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** PURE. What the room's own decision rows say about a waiting_for_mic episode: rows of this IST day newer than the day's last attempt. */
export function waitState(recent: readonly RecentAction[], A: number): { inEpisode: boolean; confirmed: boolean; alertedToday: boolean } {
  const midnight = istMidnightOf(A);
  const today = recent.filter((r) => Date.parse(r.ts) >= midnight && Date.parse(r.ts) <= A);
  const lastAttempt = attemptsToday(recent, A).at(-1);
  const since = lastAttempt ? Date.parse(lastAttempt.ts) : -Infinity;
  const skips = today.filter((r) => r.rule === SKIP_RULE).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const inEpisode = skips.some((r) => r.params.reason === WAITING_REASON && Date.parse(r.ts) > since);
  const newest = skips[0];
  let confirmed = false;
  if (inEpisode && newest && Date.parse(newest.ts) > since) {
    const age = A - Date.parse(newest.ts);
    if (newest.params.reason === WAITING_REASON) confirmed = Number(newest.params.mic_ticks) >= MIC_RETURN_TICKS - 1 && age <= MIC_TICK_STALE_MS;
    else confirmed = newest.params.mic_return === true;
  }
  const alertedToday = today.some((r) => r.rule === ALERT_RULE && r.params.reason === "device_missing");
  return { inEpisode, confirmed, alertedToday };
}

export function evaluateStartDay(inp: StartDayInput): StartDayVerdict {
  const { sense: s, cfg, A, recent } = inp;
  const facts: Record<string, unknown> = {};
  let micReturn = false;
  const skip = (reason: string, extra?: Record<string, unknown>): StartDayVerdict => ({ go: false, reason, ...(micReturn ? { params: { mic_return: true } } : {}), facts: { ...facts, ...(extra ?? {}) } });

  if (NEVER_START_DAY_ROOMS.includes(s.room_id) || s.flags.some((f) => ["dev", "test"].includes(f.toLowerCase())) || (cfg.rooms[s.room_id]?.flags ?? []).some((f) => ["dev", "test"].includes(f.toLowerCase()))) {
    return skip("dev_room");
  }
  const w = windowAt(cfg, "clinic", A);
  const istMin = Math.floor((A - istMidnightOf(A)) / 60_000);
  if (!w.in_window || istMin < START_FROM_MIN || istMin >= START_UNTIL_MIN) return skip("outside_start_window");

  if (istMin >= OPERATOR_END_FROM_MIN) {
    if (!inp.day) return skip("day_state_unreadable");
    facts.session_today = inp.day.session_today;
    if (inp.day.operator_end_at) return skip("day_ended_by_operator", { operator_end_at: inp.day.operator_end_at });
    if (istMin >= LATE_START_FROM_MIN && inp.day.session_today) return skip("late_start_blocked");
  }

  const kh = s.reachable.kh_heartbeat_at ? Date.parse(s.reachable.kh_heartbeat_at) : NaN;
  facts.kh_heartbeat_age_s = Number.isFinite(kh) ? Math.round((A - kh) / 1000) : null;
  if (!Number.isFinite(kh) || A - kh > KH_FRESH_MS || kh > A + 60_000) return skip("kiosk_health_stale");

  if (s.recording.session_open !== false) return skip(s.recording.session_open === true ? "session_open" : "session_unknown");

  // The microphone, above every attempt guard: a room whose mic is unplugged is never started (V, 9 Oct 2026).
  const missing = deviceMissing(s);
  const present = !missing && s.audio.default_input_present === true;
  const wait = waitState(recent, A);
  facts.device_missing = missing;
  if (missing || (wait.inEpisode && !present)) {
    const device = inp.deviceName?.trim() || "input device (name not reported)";
    return { go: false, reason: WAITING_REASON, params: { mic_ticks: 0 }, ...(wait.alertedToday ? {} : { alert: { device } }), facts };
  }
  if (wait.inEpisode) {
    // mic present again: 2 consecutive ticks, the first one is recorded as mic_ticks 1 (written even when the dedupe would drop it)
    if (!wait.confirmed) return { go: false, reason: WAITING_REASON, params: { mic_ticks: 1 }, force: true, facts: { ...facts, mic_return: "1 of 2 ticks" } };
    micReturn = true;
    facts.mic_return = true;
  }

  if (inp.recorder === null) return skip("recorder_status_unavailable");
  const rv = recorderVerdict(inp.recorder, A, { skipStreak: micReturn });
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
  return { go: true, mic_return: micReturn, facts };
}

/** PURE. After a mic-return start: the room's level samples have been digital zero since the start for >= 2 min -> the existing silent alert with its own reason. null = nothing to say.
 *  Never stops or restarts anything: the caller writes one log_only row. */
export function micReturnSilent(sense: RoomSense, recent: readonly RecentAction[], A: number): { attempt_ts: string; silent_since: string } | null {
  if (sense.recording.session_open !== true) return null;
  const since = sense.audio.silent_while_recording_since;
  if (!since || !Number.isFinite(Date.parse(since))) return null;
  const attempt = attemptsToday(recent, A).filter((r) => r.outcome === "ok" && r.params.mic_return === true).at(-1);
  if (!attempt) return null;
  const t0 = Date.parse(attempt.ts);
  if (A - t0 < MIC_SILENT_AFTER_MS || A - Date.parse(since) < MIC_SILENT_AFTER_MS) return null;
  const done = recent.some((r) => r.rule === ALERT_RULE && r.params.reason === MIC_SILENT_REASON && Date.parse(r.ts) >= t0);
  return done ? null : { attempt_ts: attempt.ts, silent_since: since };
}

/** PURE, shadow only. The kiosk recorder says a session is open, the server has none. Needs 2 consecutive ticks:
 *  "candidate" the first time, "phantom" when a candidate row <= 3 min old exists, "none" otherwise or while a phantom row < 15 min old exists. */
export function phantomCheck(sense: RoomSense, recent: readonly RecentAction[], A: number): "none" | "candidate" | "phantom" {
  const rs = sense.recording.recorder_status;
  if (!rs || rs.session_open !== true || sense.recording.session_open !== false) return "none";
  const fresh = Date.parse(rs.received_at);
  if (!Number.isFinite(fresh) || A - fresh > STATUS_MAX_AGE_MS) return "none";
  if (recent.some((r) => r.rule === PHANTOM_RULE && A - Date.parse(r.ts) < 15 * 60_000)) return "none";
  const cand = recent.some((r) => r.rule === PHANTOM_CANDIDATE_RULE && A - Date.parse(r.ts) <= MIC_TICK_STALE_MS && Date.parse(r.ts) <= A);
  return cand ? "phantom" : "candidate";
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

/** The one extra read of the late-evening guards (only called from 20:00 IST): an operator end_day acked today at or after 20:00 IST, and whether the room had any session today.
 *  null = unreadable. INFERRED columns: bench_command(room_id, kind, source, acked_at), bench_session(room_id, started_at). */
export async function readDayState(sql: StewardSql, roomId: string, A: number): Promise<DayState | null> {
  try {
    const midnight = istMidnightOf(A);
    const from = new Date(midnight + OPERATOR_END_FROM_MIN * 60_000).toISOString();
    const day0 = new Date(midnight).toISOString();
    const hi = new Date(A).toISOString();
    const ends = (await sql`
      SELECT c.acked_at FROM bench_command c
       WHERE c.room_id = ${roomId} AND c.kind = 'end_day' AND c.source <> 'steward'
         AND c.acked_at IS NOT NULL AND c.acked_at >= ${from}::timestamptz AND c.acked_at <= ${hi}::timestamptz
       ORDER BY c.acked_at DESC LIMIT 1
    `) as unknown as { acked_at: string | Date }[];
    const sess = (await sql`
      SELECT 1 AS x FROM bench_session s
       WHERE s.room_id = ${roomId} AND s.started_at >= ${day0}::timestamptz AND s.started_at <= ${hi}::timestamptz
       LIMIT 1
    `) as unknown[];
    const at = ends[0]?.acked_at;
    return { operator_end_at: at ? new Date(at).toISOString() : null, session_today: sess.length > 0 };
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

export function base(d: Decision, rule: string, action: Decision["action"], params: Record<string, unknown>, why: string, why_not: string | null, severity: Decision["severity"], extra: Record<string, unknown>): Decision {
  const inputs = { ...extra, via: "start_day_live" };
  return { room_id: d.room_id, machine: d.machine, window_kind: d.window_kind, rule, action, params, why, why_not, severity, inputs_hash: hash({ rule, action, params, ...extra }), inputs };
}

/** Not attempted. A log_only row whose key is the reason (+ extra params): written when the key changes (or the 15 min refresh). */
export const skipDecision = (d: Decision, reason: string, facts: Record<string, unknown>, extra: Record<string, unknown> = {}): Decision =>
  base(d, SKIP_RULE, "log_only", { reason, ...extra }, `start_day not attempted: ${reason}`, `scribe_start held: ${reason}`, "info", facts);

/** The ONE alert per IST day for a room that is waiting for its microphone: names the room and the device. No start was or will be attempted. */
export const alertDecision = (d: Decision, room: { room_id: string; room_name: string }, device: string, facts: Record<string, unknown>): Decision =>
  base(d, ALERT_RULE, "log_only", { reason: "device_missing", device }, `start_day ALERT: room ${room.room_name} (${room.room_id}) is waiting for its microphone: ${device} is missing; no start will be attempted until it is back`, null, "error", facts);

/** The attempt itself; a start that came back from waiting_for_mic is tagged so the silent check can find it. */
export const attemptDecision = (d: Decision, micReturn: boolean, facts: Record<string, unknown>): Decision => ({
  ...d,
  params: micReturn ? { ...d.params, mic_return: true } : d.params,
  inputs: { ...d.inputs, ...facts, via: "start_day_live" },
  inputs_hash: hash({ rule: d.rule, action: d.action, mic_return: micReturn, ...facts }),
});

/** The existing silent alert, for a mic-return start whose first 2 minutes were digital zero. log_only: nothing is stopped or restarted. */
export const micSilentDecision = (d: Decision, room: { room_id: string; room_name: string }, facts: Record<string, unknown>): Decision =>
  base(d, ALERT_RULE, "log_only", { reason: MIC_SILENT_REASON }, `start_day ALERT: room ${room.room_name} (${room.room_id}) started after its microphone came back, but the tape has been digital zero for 2 minutes; nothing was stopped`, null, "error", facts);

/** Shadow only: a candidate (1 tick) or the phantom_session (2 consecutive ticks). */
export const phantomDecision = (d: Decision, rule: string, facts: Record<string, unknown>): Decision =>
  base(d, rule, "log_only", {}, rule === PHANTOM_RULE ? "kiosk recorder reports an open session the server does not have (2 consecutive ticks); logged only" : "kiosk recorder reports an open session the server does not have (1 tick)", null, "warn", facts);
