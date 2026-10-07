/**
 * lib/steward/start-schedule.ts — the live start_day rate limit, PURE (no I/O, no clock): at most `max` (3) steward start_day attempts per IST day, and after a FAILED attempt a
 * wait of 5 min (after the 1st), 15 min (after the 2nd) and 45 min (after the 3rd — never reached, because a 4th attempt is never issued that day).
 *
 * The attempts are the room's bench_command rows with kind start_day and source 'steward' created since IST midnight (sense.ts reads them; the executor re-reads them when it
 * runs). An attempt is FAILED when its command failed / expired, or it was acked more than 5 min ago and no session appeared (bench-commands isFailedStartAttempt, copied so this
 * file has no imports). A pending or young-acked attempt is unresolved: wait. An attempt whose ack produced a session is a success and does not start a backoff (it still counts).
 */
export const START_BACKOFF_MIN: readonly number[] = [5, 15, 45];
/** lib/bench-commands START_ACK_SESSION_GRACE_S, copied */
export const START_ACK_GRACE_S = 300;
/** a start_day command of ANY source younger than this is still in flight (Kiosk Bot may be starting the same room) */
export const START_IN_FLIGHT_S = 240;

export type StartAttemptLike = {
  status: string;
  created_at: string | Date;
  acked_at: string | Date | null;
  session_started: boolean;
  session_named: boolean;
};

const ms = (x: string | Date): number => new Date(x).getTime();

export function attemptFailed(a: StartAttemptLike, nowMs: number): boolean {
  if (a.status === "failed" || a.status === "expired") return true;
  if (a.status === "acked" && a.acked_at) return nowMs - ms(a.acked_at) > START_ACK_GRACE_S * 1000 && !a.session_started && !a.session_named;
  return false;
}

export type StartVerdict =
  | { kind: "go"; attempts: number }
  | { kind: "exhausted"; attempts: number }
  | { kind: "pending"; attempts: number }
  | { kind: "backoff"; attempts: number; retry_after_s: number };

/** May a start be issued now? `attempts` = this room's steward start_day commands of the current IST day. */
export function startVerdict(attempts: readonly StartAttemptLike[], nowMs: number, max = 3): StartVerdict {
  const n = attempts.length;
  if (n === 0) return { kind: "go", attempts: 0 };
  if (n >= max) return { kind: "exhausted", attempts: n };
  const last = [...attempts].sort((a, b) => ms(a.created_at) - ms(b.created_at))[n - 1]!;
  if (attemptFailed(last, nowMs)) {
    const wait = (START_BACKOFF_MIN[Math.min(n, START_BACKOFF_MIN.length) - 1] ?? 45) * 60_000;
    const left = ms(last.created_at) + wait - nowMs;
    return left > 0 ? { kind: "backoff", attempts: n, retry_after_s: Math.ceil(left / 1000) } : { kind: "go", attempts: n };
  }
  // not failed: either it produced a session (success: a later start is allowed, still capped) or it is unresolved (pending / young ack)
  const resolved = last.status === "acked" && (last.session_started || last.session_named);
  return resolved ? { kind: "go", attempts: n } : { kind: "pending", attempts: n };
}
