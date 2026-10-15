/**
 * lib/steward/executor.ts — Room Steward part 2: the executor seam.
 *
 * ShadowExecutor records what it WOULD do and does nothing else — it never calls Scribe, never issues a ticket, never sends a message.
 * LiveExecutor implements scribe_start (the Bench start_day path) and scribe_stop (the Bench end_day path, 15 Oct), both re-checked at execution time; every other method throws and the loop records it as shadow.
 * Which executor runs for an action is decided by config.actionMode (kill switch, shadow.global, shadow.actions[action]).
 */
import { REHOME_NOTE_PREFIX } from "@/lib/bench-reaper-core";
import { LISTENER_FRESH_MS } from "@/lib/bench-bus-constants";
import { isNeverLiveRoom, istMidnightOf } from "./config";
import type { Decision } from "./rules";
import { START_IN_FLIGHT_S, START_NO_ACK_FAIL_S, startVerdict } from "./start-schedule";

export type ExecResult = { result: string };

export interface Executor {
  scribeStart(d: Decision): Promise<ExecResult>;
  scribeStop(d: Decision): Promise<ExecResult>;
  scribeRestart(d: Decision): Promise<ExecResult>;
  issueTicket(d: Decision): Promise<ExecResult>;
  message(d: Decision): Promise<ExecResult>;
}

/** Records "shadow: would <action>" and nothing else. */
export class ShadowExecutor implements Executor {
  private rec = (d: Decision): Promise<ExecResult> => Promise.resolve({ result: `shadow: would ${d.action}` });
  scribeStart = (d: Decision) => this.rec(d);
  scribeStop = (d: Decision) => this.rec(d);
  scribeRestart = (d: Decision) => this.rec(d);
  issueTicket = (d: Decision) => this.rec(d);
  message = (d: Decision) => this.rec(d);
}

export const LIVE_EXECUTOR_DISABLED = "live executor not enabled in P0";

// ---------------------------------------------------------------------------
// LiveExecutor — scribe_start ONLY. Every other action still throws and the loop records it as shadow ("blocked").
// ---------------------------------------------------------------------------

/** The slice of lib/bench-commands the live start needs (the same functions scribe_start_recording in lib/mcp/tools/bench.ts is built from). A test seam. */
export type StartDeps = {
  getListener: (roomId: string) => Promise<import("@/lib/bench-commands").ListenerRow | null>;
  findActiveSession: (roomId: string) => Promise<{ id: string; status: string; started_at?: string } | null>;
  /** start_day commands of ANY source in the last hour (Kiosk Bot, the admin route, the MCP tool, us): used for the "already in flight" check */
  getRecentStartAttempts: (roomId: string, now: Date) => Promise<import("@/lib/bench-commands").StartAttempt[]>;
  /** this room's start_day commands with source 'steward' since IST midnight (the 3-per-day cap and the 5/15/45 min backoff) */
  getStewardAttemptsToday: (roomId: string, now: Date) => Promise<import("@/lib/bench-commands").StartAttempt[]>;
  decideStart: typeof import("@/lib/bench-commands").decideStart;
  /** R2: mark this room's steward start_day commands still `pending` and older than `olderThanS` as `expired` (only that room, kind and source); resolves to the expired ids */
  expireStaleStarts?: (roomId: string, olderThanS: number) => Promise<string[]>;
  insertCommand: (input: { roomId: string; kind: "start_day"; args?: unknown; source?: string }) => Promise<string>;
  waitForAck: (id: string, opts: { timeoutMs?: number }) => Promise<{ status: string; error: string | null; result: unknown } | null>;
};


/** Loaded lazily: lib/bench-commands pulls the database client at import, and the shadow path (and its tests) must not need it. */
export async function realStartDeps(): Promise<StartDeps> {
  const b = await import("@/lib/bench-commands");
  const { sql } = await import("@/lib/db");
  return {
    getListener: b.getListener,
    findActiveSession: b.findActiveSession,
    getRecentStartAttempts: b.getRecentStartAttempts,
    getStewardAttemptsToday: async (roomId, now) => {
      const dayStart = new Date(istMidnightOf(now.getTime())).toISOString();
      const rows = (await sql`
        SELECT c.status, c.created_at, c.acked_at,
               EXISTS (SELECT 1 FROM bench_session s WHERE s.room_id = c.room_id AND s.id = c.result ->> 'session_id') AS session_named,
               EXISTS (SELECT 1 FROM bench_session s WHERE s.room_id = c.room_id AND (s.notes IS NULL OR s.notes NOT LIKE ${REHOME_NOTE_PREFIX + "%"}) AND s.started_at >= c.created_at AND c.acked_at IS NOT NULL
                         AND s.started_at <= c.acked_at + (${b.START_ACK_SESSION_GRACE_S}::int * INTERVAL '1 second')) AS session_started
          FROM bench_command c
         WHERE c.room_id = ${roomId} AND c.kind = 'start_day' AND c.source = 'steward' AND c.created_at >= ${dayStart}::timestamptz
         ORDER BY c.created_at ASC
      `) as Array<{ status: string; created_at: string | Date; acked_at: string | Date | null; session_started: boolean; session_named: boolean }>;
      return rows.map((r) => ({ status: r.status, created_at: r.created_at, acked_at: r.acked_at ?? null, session_started: r.session_started === true, session_named: r.session_named === true }));
    },
    decideStart: b.decideStart,
    expireStaleStarts: b.expireStaleStartDay,
    insertCommand: (i) => b.insertCommand(i),
    waitForAck: (id, o) => b.waitForAck(id, o),
  };
}

export const START_SOURCE = "steward";
/** the result of a start that was queued but not acked inside the tick: counts as an attempt (dedupe), never as a failure (backoff); reconciled on a later tick */
export const PENDING_PREFIX = "pending: sent, awaiting ack";
export const DEFAULT_ACK_TIMEOUT_MS = 8000;
/** the ONLY command kind this executor can queue */
export const LIVE_COMMAND_KIND = "start_day" as const;

/**
 * The live start, the same path as the MCP tool scribe_start_recording: read the listener AND the room's open session NOW (execution time, not sense time), run decideStart
 * (kiosk listening? already recording = success, nothing sent? paused?), refuse when ANY start_day (Kiosk Bot, an operator, us) was queued < 4 min ago, apply the daily schedule
 * (3 steward attempts per IST day, 5 / 15 / 45 min after the 1st / 2nd / 3rd failed one, lib/steward/start-schedule.ts), and only then queue ONE start_day command and wait for the
 * kiosk's ack. Results: "ok: ..." (acked), "failed: ..." (the kiosk reported failure / expired) — these two count against the caps; "pending: sent, awaiting ack" (queued, no ack inside the tick) counts as an attempt for dedupe only — and "skipped: <reason>" when NOTHING was sent (already
 * recording, paused, kiosk not listening, in flight, exhausted, backoff, pending, unreadable): a skipped row never counts. Never overrides a consent pause; never forces; can emit start_day and nothing else.
 */
export async function liveScribeStart(
  d: Decision,
  deps: StartDeps,
  opts: { ackTimeoutMs?: number; now?: () => Date; maxAttempts?: number; deferredRecheckMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ExecResult> {
  const roomId = d.room_id;
  if (!roomId) return { result: "skipped: no_room" };
  // F20: the hard never-live list (ORB2, ORB3, Home Office, room_scratch_*): refused here whatever the caller and the data say, before anything is read or sent
  if (isNeverLiveRoom(roomId)) return { result: "skipped: never_live_room" };
  const now = (opts.now ?? (() => new Date()))();
  const [listener, active] = await Promise.all([deps.getListener(roomId), deps.findActiveSession(roomId)]);
  const verdict = deps.decideStart({ listener, activeSession: active, overridePause: false, now });
  if (verdict.action === "reject") return { result: `skipped: ${verdict.error}` };
  if (verdict.action === "already_recording") return { result: `skipped: already_recording session_id=${verdict.session_id}` };
  let recent: Awaited<ReturnType<StartDeps["getRecentStartAttempts"]>>;
  let today: Awaited<ReturnType<StartDeps["getStewardAttemptsToday"]>>;
  try {
    [recent, today] = await Promise.all([deps.getRecentStartAttempts(roomId, now), deps.getStewardAttemptsToday(roomId, now)]);
  } catch {
    return { result: "skipped: start_attempts_unreadable" };
  }
  if (recent.some((a) => now.getTime() - new Date(a.created_at).getTime() < START_IN_FLIGHT_S * 1000)) return { result: "skipped: start_in_flight" };
  const sv = startVerdict(today, now.getTime(), opts.maxAttempts ?? 3);
  if (sv.kind === "exhausted") return { result: `skipped: start_exhausted attempts=${sv.attempts}` };
  if (sv.kind === "pending") return { result: `skipped: start_pending attempts=${sv.attempts}` };
  if (sv.kind === "backoff") return { result: `skipped: start_backoff attempts=${sv.attempts} retry_after_s=${sv.retry_after_s}` };
  if (verdict.action !== "send") return { result: `skipped: ${(verdict as { action: string }).action}` };
  // R2 (F44.1): a retry (an earlier steward start today) must not leave the earlier start_day live on the bus. A command delivered and never acked stays `pending` (the lazy expiry covers
  // only undelivered ones), so the stale one (> START_NO_ACK_FAIL_S) is marked `expired` BEFORE the new one is queued. If that cannot be done, nothing is sent: never two non-terminal start_days.
  if (today.length > 0 && deps.expireStaleStarts) {
    try {
      await deps.expireStaleStarts(roomId, START_NO_ACK_FAIL_S);
    } catch {
      return { result: "skipped: start_expire_failed" };
    }
  }
  const id = await deps.insertCommand({ roomId, kind: LIVE_COMMAND_KIND, args: verdict.args ?? undefined, source: START_SOURCE });
  const row = await deps.waitForAck(id, { timeoutMs: opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS });
  // F44: no ack inside the in-tick wait is NOT a failure. The kiosk acks in ~4-13 s; the command is queued and may still be acked. The loop reconciles it on the next ticks (reconcilePending).
  if (!row) return { result: `${PENDING_PREFIX} command_id=${id}` };
  // ARCH #17 (C2), folded into F44: a DEFERRED ack ({ok:true, deferred:true, session_id:null}: the app accepted the start and is waiting for its input device) is PENDING,
  // exactly like a late ack. ACCEPTED IS NOT STARTED, so it is never "ok" here. reconcilePending (loop.ts) is the one collector: it settles the row when a session opens
  // after the command ("ok ... deferred then recording"), when the app amends the command to failed, or after START_NO_ACK_FAIL_S with no session.
  if (row.status === "acked" && isDeferredAck(row.result)) return { result: `${PENDING_PREFIX} (deferred: the kiosk accepted the start and is waiting for its input device) command_id=${id}` };
  if (row.status === "acked") return { result: `ok: start_day acked command_id=${id}` };
  return { result: `failed: start_day ${row.status}${row.error ? ` (${String(row.error).slice(0, 80)})` : ""} command_id=${id}` };
}

/** the ONLY command kind the live stop can queue: the same end_day verb scribe_stop_recording (lib/mcp/tools/bench.ts) sends */
export const STOP_COMMAND_KIND = "end_day" as const;

/** The slice of lib/bench-commands the live stop needs (the same functions scribe_stop_recording is built from). A test seam. */
export type StopDeps = {
  getListener: StartDeps["getListener"];
  findActiveSession: StartDeps["findActiveSession"];
  /** this room's end_day commands with source 'steward' created at or after `sinceIso` (the open session's start): the one-send-per-session ledger and the backoff */
  getStewardStopAttempts: (roomId: string, sinceIso: string) => Promise<import("@/lib/bench-commands").StartAttempt[]>;
  /** mark this room's steward end_day commands still `pending` and older than `olderThanS` as `expired`: a stale stop must never end a LATER session */
  expireStaleStops?: (roomId: string, olderThanS: number) => Promise<string[]>;
  insertCommand: (input: { roomId: string; kind: "end_day"; args?: unknown; source?: string }) => Promise<string>;
  waitForAck: StartDeps["waitForAck"];
};

export async function realStopDeps(): Promise<StopDeps> {
  const b = await import("@/lib/bench-commands");
  const { sql } = await import("@/lib/db");
  return {
    getListener: b.getListener,
    findActiveSession: b.findActiveSession,
    getStewardStopAttempts: async (roomId, sinceIso) => {
      const rows = (await sql`
        SELECT c.status, c.created_at, c.acked_at
          FROM bench_command c
         WHERE c.room_id = ${roomId} AND c.kind = 'end_day' AND c.source = 'steward' AND c.created_at >= ${sinceIso}::timestamptz
         ORDER BY c.created_at ASC
      `) as Array<{ status: string; created_at: string | Date; acked_at: string | Date | null }>;
      // session_started / session_named are start notions: a stop has no session to name, so an acked stop whose session is STILL open counts as failed after the grace (startVerdict)
      return rows.map((r) => ({ status: r.status, created_at: r.created_at, acked_at: r.acked_at ?? null, session_started: false, session_named: false }));
    },
    expireStaleStops: b.expireStaleEndDay,
    insertCommand: (i) => b.insertCommand(i),
    waitForAck: (id, o) => b.waitForAck(id, o),
  };
}

/**
 * The live stop, the same path as the MCP tool scribe_stop_recording: ONE end_day command from source 'steward', the kiosk flushes, ends its session, then acks. Mirrors liveScribeStart:
 * never-live rooms refused first; R5 the consult state of the DECISION must be false unless it is the late stop (params.late), unknown (null) is not false; the room's open session and
 * the listener are read NOW; no open session = already stopped (success, nothing sent); one send per session (the ledger is the room's steward end_day commands since the session
 * started) with the start backoff (5 / 15 / 45 min after a failed one) and `maxAttempts` (caps.start_retries) in total; stale pending stops are expired before a resend.
 * Results: "ok: end_day acked ..." / "failed: ..." (sent: both count against the caps), "skipped: <reason>" (nothing sent). A stop is never "pending": it is ledgered in bench_command.
 */
export async function liveScribeStop(
  d: Decision,
  deps: StopDeps,
  opts: { ackTimeoutMs?: number; now?: () => Date; maxAttempts?: number } = {},
): Promise<ExecResult> {
  const roomId = d.room_id;
  if (!roomId) return { result: "skipped: no_room" };
  if (isNeverLiveRoom(roomId)) return { result: "skipped: never_live_room" };
  const late = d.params?.late === true;
  // R5 + M2: a non-late stop needs positive evidence of no consult: consult_open false AND the extension ok (false from a room whose extension is missing is "never looked")
  if (!late && d.inputs?.consult_open !== false) return { result: `skipped: ${d.inputs?.consult_open === true ? "consult_open" : "consult_unknown"}` };
  if (!late && d.inputs?.ext_status !== "ok") return { result: "skipped: consult_unknown_ext" };
  const now = (opts.now ?? (() => new Date()))();
  const [listener, active] = await Promise.all([deps.getListener(roomId), deps.findActiveSession(roomId)]);
  if (!active) return { result: "skipped: no_open_session" };
  if (!listener || now.getTime() - new Date(listener.last_poll_at).getTime() > LISTENER_FRESH_MS) return { result: "skipped: kiosk_not_listening" };
  if (!active.started_at) return { result: "skipped: no_session_start" }; // L1: the ledger is keyed by the session start; no midnight fallback
  const sinceIso = active.started_at;
  let tried: Awaited<ReturnType<StopDeps["getStewardStopAttempts"]>>;
  try {
    tried = await deps.getStewardStopAttempts(roomId, sinceIso);
  } catch {
    return { result: "skipped: stop_attempts_unreadable" };
  }
  const sv = startVerdict(tried, now.getTime(), opts.maxAttempts ?? 3);
  if (sv.kind === "exhausted") return { result: `skipped: stop_exhausted attempts=${sv.attempts}` };
  if (sv.kind === "pending") return { result: `skipped: stop_pending attempts=${sv.attempts}` };
  if (sv.kind === "backoff") return { result: `skipped: stop_backoff attempts=${sv.attempts} retry_after_s=${sv.retry_after_s}` };
  if (deps.expireStaleStops) { // L2: before the FIRST send too (an unacked steward stop from an earlier session must not be re-delivered)
    try {
      await deps.expireStaleStops(roomId, START_NO_ACK_FAIL_S);
    } catch {
      return { result: "skipped: stop_expire_failed" };
    }
  }
  const id = await deps.insertCommand({ roomId, kind: STOP_COMMAND_KIND, source: START_SOURCE });
  const row = await deps.waitForAck(id, { timeoutMs: opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS });
  if (!row) return { result: `failed: end_day no ack in the tick command_id=${id}` };
  if (row.status === "acked") return { result: `ok: end_day acked command_id=${id}` };
  return { result: `failed: end_day ${row.status}${row.error ? ` (${String(row.error).slice(0, 80)})` : ""} command_id=${id}` };
}

/** PURE — did the app ack this start as ACCEPTED-BUT-DEFERRED ({ok:true, deferred:true}, no session yet)? */
export function isDeferredAck(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as Record<string, unknown>).deferred === true;
}

/** scribe_start and scribe_stop are live; every other method throws, and the loop treats a throw as "stay in shadow". */
export class LiveExecutor implements Executor {
  constructor(private readonly opts: { ackTimeoutMs?: number; deps?: StartDeps; stopDeps?: StopDeps; now?: () => Date; maxAttempts?: number; deferredRecheckMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {}
  async scribeStart(d: Decision): Promise<ExecResult> {
    return liveScribeStart(d, this.opts.deps ?? (await realStartDeps()), { ackTimeoutMs: this.opts.ackTimeoutMs, now: this.opts.now, maxAttempts: this.opts.maxAttempts });
  }
  async scribeStop(d: Decision): Promise<ExecResult> {
    return liveScribeStop(d, this.opts.stopDeps ?? (await realStopDeps()), { ackTimeoutMs: this.opts.ackTimeoutMs, now: this.opts.now, maxAttempts: this.opts.maxAttempts });
  }
  scribeRestart(_d: Decision): Promise<ExecResult> {
    throw new Error(LIVE_EXECUTOR_DISABLED);
  }
  issueTicket(_d: Decision): Promise<ExecResult> {
    throw new Error(LIVE_EXECUTOR_DISABLED);
  }
  message(_d: Decision): Promise<ExecResult> {
    throw new Error(LIVE_EXECUTOR_DISABLED);
  }
}

/** Route one ACTIONABLE decision to the executor method for its action. none / log_only are not actionable and return null. */
export async function dispatch(ex: Executor, d: Decision): Promise<ExecResult | null> {
  switch (d.action) {
    case "scribe_start":
      return ex.scribeStart(d);
    case "scribe_stop":
      return ex.scribeStop(d);
    case "scribe_restart":
      return ex.scribeRestart(d);
    case "message":
    case "alert":
      return ex.message(d);
    case "log_only":
    case "none":
      return null;
    default:
      return ex.issueTicket(d); // ticket:<name>
  }
}
