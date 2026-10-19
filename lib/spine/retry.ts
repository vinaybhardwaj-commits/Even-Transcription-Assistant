/**
 * lib/spine/retry.ts — the pure half of the spine queue (SPINE-PLAN §4 Retry). No clock and no randomness in here: `now` and `rand01` come in.
 *
 * next = now + min(6 h, 2 min × 3^(attempts-1)) ± 20% jitter. The cap is applied AFTER the jitter, so no delay ever exceeds 6 h.
 */
export const MAX_ATTEMPTS = 6;
export const LEASE_MS = 15 * 60_000;
export const BACKOFF_BASE_MS = 2 * 60_000;
export const BACKOFF_CAP_MS = 6 * 3_600_000;
export const JITTER = 0.2;
export const BREAKER_WINDOW = 20;
export const BREAKER_MIN_SAMPLES = 5;
export const BREAKER_FAIL_RATIO = 0.3;
export const BREAKER_OPEN_MS = 30 * 60_000;

export type ErrorClass = "transient" | "permanent" | "budget";
export type Outcome = "done" | "transient" | "permanent" | "budget" | "shadow" | "release";

/** `attempts` counts the attempt that just failed (1-based). `rand01` is in [0,1). */
export function backoffMs(attempts: number, rand01: number): number {
  const n = Math.max(1, Math.floor(attempts));
  const r = Math.min(Math.max(rand01, 0), 1);
  const base = BACKOFF_BASE_MS * 3 ** (n - 1);
  return Math.min(BACKOFF_CAP_MS, Math.round(base * (1 - JITTER + 2 * JITTER * r)));
}

/** 00:00 IST (UTC+5:30) of the day after `now`. A budget job is held until then. */
export function nextIstDayStart(now: Date): Date {
  const IST = 5.5 * 3_600_000;
  const day = 86_400_000;
  return new Date(Math.floor((now.getTime() + IST) / day) * day + day - IST);
}

export type Resolution = {
  status: "done" | "failed" | "dead" | "queued" | "shadow";
  nextAttemptAt: Date | null;
  attemptsDelta: 0 | -1;
  errorClass: ErrorClass | null;
  doneAt: Date | null;
};

/** What a report does to a row whose current `attempts` (already counting this claim) is given. */
export function resolveOutcome(outcome: Outcome, attempts: number, now: Date, rand01: number): Resolution {
  switch (outcome) {
    case "done": return { status: "done", nextAttemptAt: null, attemptsDelta: 0, errorClass: null, doneAt: now };
    case "permanent": return { status: "failed", nextAttemptAt: null, attemptsDelta: 0, errorClass: "permanent", doneAt: now };
    case "transient":
      if (attempts >= MAX_ATTEMPTS) return { status: "dead", nextAttemptAt: null, attemptsDelta: 0, errorClass: "transient", doneAt: now };
      return { status: "queued", nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, rand01)), attemptsDelta: 0, errorClass: "transient", doneAt: null };
    case "budget": return { status: "queued", nextAttemptAt: nextIstDayStart(now), attemptsDelta: -1, errorClass: "budget", doneAt: null };
    case "shadow": return { status: "shadow", nextAttemptAt: null, attemptsDelta: -1, errorClass: null, doneAt: null };
    case "release": return { status: "queued", nextAttemptAt: null, attemptsDelta: -1, errorClass: null, doneAt: null };
  }
}

export type Finished = { status: string; done_at: Date | string };

/** Open when >= 30% of the last 20 finished jobs failed (failed|dead) AND the latest failure is under 30 min old. Stateless: derived from rows at read time. */
export function breakerOpen(finished: Finished[], now: Date): boolean {
  const last = [...finished].sort((a, b) => new Date(b.done_at).getTime() - new Date(a.done_at).getTime()).slice(0, BREAKER_WINDOW);
  if (last.length < BREAKER_MIN_SAMPLES) return false;
  const failed = last.filter((j) => j.status === "failed" || j.status === "dead");
  if (failed.length / last.length < BREAKER_FAIL_RATIO) return false;
  const latest = Math.max(...failed.map((j) => new Date(j.done_at).getTime()));
  return now.getTime() < latest + BREAKER_OPEN_MS;
}
