/**
 * lib/steward/executor.ts — Room Steward part 2: the executor seam.
 *
 * ShadowExecutor records what it WOULD do and does nothing else — it never calls Scribe, never issues a ticket, never sends a message.
 * LiveExecutor implements scribe_start ONLY (the Bench start_day path, re-checked at execution time); every other method throws and the loop records it as shadow.
 * Which executor runs for an action is decided by config.actionMode (kill switch, shadow.global, shadow.actions[action]).
 */
import type { Decision } from "./rules";

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
  getRecentStartAttempts: (roomId: string, now: Date) => Promise<import("@/lib/bench-commands").StartAttempt[]>;
  decideStart: typeof import("@/lib/bench-commands").decideStart;
  applyStartBackoff: typeof import("@/lib/bench-commands").applyStartBackoff;
  insertCommand: (input: { roomId: string; kind: "start_day"; args?: unknown; source?: string }) => Promise<string>;
  waitForAck: (id: string, opts: { timeoutMs?: number }) => Promise<{ status: string; error: string | null; result: unknown } | null>;
};

/** Loaded lazily: lib/bench-commands pulls the database client at import, and the shadow path (and its tests) must not need it. */
async function realStartDeps(): Promise<StartDeps> {
  const b = await import("@/lib/bench-commands");
  return {
    getListener: b.getListener,
    findActiveSession: b.findActiveSession,
    getRecentStartAttempts: b.getRecentStartAttempts,
    decideStart: b.decideStart,
    applyStartBackoff: b.applyStartBackoff,
    insertCommand: (i) => b.insertCommand(i),
    waitForAck: (id, o) => b.waitForAck(id, o),
  };
}

export const START_SOURCE = "steward";
export const DEFAULT_ACK_TIMEOUT_MS = 8000;

/**
 * The live start, the same path as the MCP tool scribe_start_recording: read the listener AND the room's open session NOW (execution time, not sense time), run decideStart
 * (kiosk listening? already recording? paused?) and applyStartBackoff (2+ failed start_day in 60 min = room_failing, nothing sent), and only then queue ONE start_day command and wait
 * for the kiosk's ack. Results: "ok: ..." (acked), "failed: ..." (queued and not acked / failed) — these two count against the caps and the retry memory — and "skipped: <reason>"
 * when NOTHING was sent (already recording, paused, kiosk not listening, room_failing, attempts unreadable): a skipped row never counts. Never overrides a consent pause; never forces.
 */
export async function liveScribeStart(d: Decision, deps: StartDeps, opts: { ackTimeoutMs?: number; now?: () => Date } = {}): Promise<ExecResult> {
  const roomId = d.room_id;
  if (!roomId) return { result: "skipped: no_room" };
  const now = (opts.now ?? (() => new Date()))();
  const [listener, active] = await Promise.all([deps.getListener(roomId), deps.findActiveSession(roomId)]);
  const verdict = deps.decideStart({ listener, activeSession: active, overridePause: false, now });
  if (verdict.action === "reject") return { result: `skipped: ${verdict.error}` };
  if (verdict.action === "already_recording") return { result: `skipped: already_recording session_id=${verdict.session_id}` };
  // a session opened between the verdict and now cannot be missed: `active` was read in the same Promise.all, and applyStartBackoff never skips a room that has one
  let attempts: Awaited<ReturnType<StartDeps["getRecentStartAttempts"]>>;
  try {
    attempts = await deps.getRecentStartAttempts(roomId, now);
  } catch {
    return { result: "skipped: start_attempts_unreadable" };
  }
  const v = deps.applyStartBackoff(verdict, { attempts, activeSession: active, force: false, now });
  if (v.action === "skipped") return { result: `skipped: room_failing failed_attempts=${v.failed_attempts} retry_after_s=${v.retry_after_s}` };
  if (v.action !== "send") return { result: `skipped: ${v.action}` };
  const id = await deps.insertCommand({ roomId, kind: "start_day", args: v.args ?? undefined, source: START_SOURCE });
  const row = await deps.waitForAck(id, { timeoutMs: opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS });
  if (!row) return { result: `failed: no ack from the kiosk command_id=${id}` };
  if (row.status === "acked") return { result: `ok: start_day acked command_id=${id}` };
  return { result: `failed: start_day ${row.status}${row.error ? ` (${String(row.error).slice(0, 80)})` : ""} command_id=${id}` };
}

/** scribe_start is live; every other method throws, and the loop treats a throw as "stay in shadow". */
export class LiveExecutor implements Executor {
  constructor(private readonly opts: { ackTimeoutMs?: number; deps?: StartDeps; now?: () => Date } = {}) {}
  async scribeStart(d: Decision): Promise<ExecResult> {
    return liveScribeStart(d, this.opts.deps ?? (await realStartDeps()), { ackTimeoutMs: this.opts.ackTimeoutMs, now: this.opts.now });
  }
  scribeStop(_d: Decision): Promise<ExecResult> {
    throw new Error(LIVE_EXECUTOR_DISABLED);
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
      return ex.message(d);
    case "log_only":
    case "none":
      return null;
    default:
      return ex.issueTicket(d); // ticket:<name>
  }
}
