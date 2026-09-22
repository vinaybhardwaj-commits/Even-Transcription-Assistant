/**
 * lib/overnight-translate/diarize-guard.ts — the decision the diarize-leak guard makes every StartInterval
 * (currently 300 s), extracted so it is testable (this codebase has no shell-test harness; gate.ts is the
 * model — PURE decision functions, real I/O kept in thin wrappers exercised by the runner, not by tests).
 *
 * REPLACES THE "no connection for 60 s" TEST (Fable's order, 22 Sep 2026 07:25). It never fired: the bench
 * worker keeps 2 ESTABLISHED keep-alive sockets to :8001 even while the overnight driver sits in gate_hold
 * with nothing in flight, so "over threshold but a connection is open" was true almost always and the guard
 * went eleven minutes past its own threshold sighting before Fable restarted diarize by hand. The replacement
 * asks a truer question: does the OVERNIGHT DRIVER — the thing that actually calls diarize on this box right
 * now — have a room_window job it is still waiting on? `driverInFlight` answers that from the driver's own
 * log, which already carries a job_id on every window_submitted/window_done/window_failed line.
 *
 * THE HARD CEILING. The order's DO item states it two ways that do not reconcile at the interval Fable set:
 * "Keep a 30-minute hard ceiling" (the header) against "over threshold for 2 consecutive checks → restart
 * regardless" (the literal rule) — 2 checks at a 300 s interval is 10 minutes, not 30. Rather than pick one,
 * this implements BOTH: `HARD_CEILING_STREAK` consecutive over-threshold checks, OR `HARD_CEILING_MS` elapsed
 * since the first over-threshold sighting, either one forces a restart regardless of in-flight. Whichever
 * fires first fires first; neither can make the guard LESS aggressive than the other reading intended.
 */

export const HARD_CEILING_STREAK = 2;
export const HARD_CEILING_MS = 30 * 60_000;

export type GuardState = { overStreak: number; firstOverAtMs: number | null };
export const EMPTY_STATE: GuardState = { overStreak: 0, firstOverAtMs: null };

/** PURE — parse the tail data line of `top -l 1 -pid PID -stats mem` into GB. Accepts a trailing G/M/K unit
 *  and the +/- trend marker top sometimes appends; whitespace-tolerant. Null for anything it cannot read —
 *  never a silent 0, which would read as "under threshold" and hide a leak. */
export function parseTopMemGb(topOutput: string): number | null {
  const lines = topOutput.trim().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = /^([\d.]+)\s*([GMK])[+-]?$/.exec(last.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  if (m[2] === "G") return n;
  if (m[2] === "M") return n / 1024;
  return n / 1024 / 1024; // K
}

/** One line of the overnight driver's own JSON log; only the two fields this module reads. */
export type DriverLogEvent = { event: unknown; job_id?: unknown };

/**
 * PURE — true iff some `window_submitted` job_id has no later `window_done` or `window_failed` for the SAME
 * job_id, reading `events` in file order (oldest first). Tracks every open job_id, not just the most recent
 * one, so it stays correct if concurrency is ever raised again — a "last event was window_submitted" check
 * would wrongly call a second, still-running job "idle" the moment a first one finishes.
 */
export function driverInFlight(events: readonly DriverLogEvent[]): boolean {
  const open = new Set<string>();
  for (const e of events) {
    if (e.event === "window_submitted" && typeof e.job_id === "string") open.add(e.job_id);
    else if ((e.event === "window_done" || e.event === "window_failed") && typeof e.job_id === "string") open.delete(e.job_id);
  }
  return open.size > 0;
}

export type GuardAction = "restart" | "skip";
export type GuardReason = "under_threshold" | "in_flight_over_threshold" | "idle_over_threshold" | "hard_ceiling_streak" | "hard_ceiling_elapsed";
export type GuardDecision = { action: GuardAction; reason: GuardReason; nextState: GuardState };

/**
 * PURE — the guard's whole call. `state` is the previous run's `nextState`, persisted by the runner between
 * launchd invocations (a fresh process every interval has no memory of its own). Under threshold, or after a
 * restart, the streak resets to EMPTY_STATE — a leak that regrows must be seen again from zero, not inherit
 * an old streak from a DIFFERENT episode.
 */
export function guardDecision(input: { nowMs: number; rssGb: number; thresholdGb: number; inFlight: boolean; state: GuardState }): GuardDecision {
  const { nowMs, rssGb, thresholdGb, inFlight, state } = input;
  if (rssGb < thresholdGb) return { action: "skip", reason: "under_threshold", nextState: EMPTY_STATE };

  const overStreak = state.overStreak + 1;
  const firstOverAtMs = state.firstOverAtMs ?? nowMs;
  if (overStreak >= HARD_CEILING_STREAK) return { action: "restart", reason: "hard_ceiling_streak", nextState: EMPTY_STATE };
  if (nowMs - firstOverAtMs >= HARD_CEILING_MS) return { action: "restart", reason: "hard_ceiling_elapsed", nextState: EMPTY_STATE };
  if (!inFlight) return { action: "restart", reason: "idle_over_threshold", nextState: EMPTY_STATE };
  return { action: "skip", reason: "in_flight_over_threshold", nextState: { overStreak, firstOverAtMs } };
}
