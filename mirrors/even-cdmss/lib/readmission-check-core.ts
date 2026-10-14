/**
 * lib/readmission-check-core.ts — PURE decisions for POST /api/care/readmissions/check
 * (READMIT-RECENT-VIEW-BUILDER-BRIEF-17-SEP-2026, item D). No DB, no clock — `now` is an input.
 *
 * The route runs `runDetectionSweep()` only (never the model audit, never the worker) behind a 120 s
 * per-instance cooldown so a fast double-press of Refresh cannot fire two sweeps back to back.
 */

export const CHECK_COOLDOWN_MS = 120_000;

/** True while a previous check is still inside its cooldown window. `lastRunAtMs` null → never run. */
export function withinCooldown(lastRunAtMs: number | null, nowMs: number, cooldownMs = CHECK_COOLDOWN_MS): boolean {
  return lastRunAtMs != null && nowMs - lastRunAtMs < cooldownMs;
}

/** `newDetected` — the count of rows whose audit_status is 'detected' after the sweep, minus the count
 *  before, both read from `findingCounts().byStatus`. Never negative in practice (detection only adds
 *  rows), but the caller passes raw counts and this stays a plain subtraction. */
export function newDetectedCount(beforeDetected: number, afterDetected: number): number {
  return afterDetected - beforeDetected;
}
