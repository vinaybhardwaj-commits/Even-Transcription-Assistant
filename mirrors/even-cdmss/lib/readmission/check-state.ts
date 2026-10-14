/**
 * lib/readmission/check-state.ts — the per-instance state behind POST /api/care/readmissions/check:
 * the 120 s cooldown timestamp (readmission-check-core.withinCooldown) and the last successful check's
 * IST stamp, read back by the list route's freshness line (`lastCheckAt`). Module-level, best-effort —
 * a cold start or a different serverless instance sees null / no cooldown, the same posture as every
 * other per-instance guard in this codebase (e.g. the rates read's in-memory cache).
 */

let lastRunAtMs: number | null = null;
let lastCheckAtIso: string | null = null;

export function getLastRunAtMs(): number | null { return lastRunAtMs; }
export function getLastCheckAt(): string | null { return lastCheckAtIso; }

/** Record a completed (non-cooldown-skipped) check. */
export function recordCheck(nowMs: number, checkedAtIso: string): void {
  lastRunAtMs = nowMs;
  lastCheckAtIso = checkedAtIso;
}

/** Test seam. */
export function _resetCheckState(): void {
  lastRunAtMs = null;
  lastCheckAtIso = null;
}
