import { ComponentResult, Tier, Weights } from "./types";

/**
 * Low-confidence threshold (PRD D32).
 */
export const LOW_CONFIDENCE_OBS_THRESHOLD = 30;

/**
 * Compose the three component scores into a single composite (PRD §6.2 step 5).
 *
 * Weights are the current `weight_versions` row. If any component is null
 * (insufficient data), drop its weight from both numerator and denominator —
 * effectively renormalizing across the scoreable components only.
 *
 * Special case: if ALL components are null, return 0 — caller will tier
 * this as `no_recent_activity` separately.
 */
export function composeScore(
  caseload: ComponentResult,
  outcomes: ComponentResult,
  adherence: ComponentResult,
  weights: Weights,
): number {
  let num = 0;
  let den = 0;

  if (caseload.score !== null) {
    num += caseload.score * weights.caseload_pct;
    den += weights.caseload_pct;
  }
  if (outcomes.score !== null) {
    num += outcomes.score * weights.outcomes_pct;
    den += weights.outcomes_pct;
  }
  if (adherence.score !== null) {
    num += adherence.score * weights.adherence_pct;
    den += weights.adherence_pct;
  }

  if (den === 0) return 0;
  return num / den;
}

/**
 * Tier classification (PRD §6.3).
 *
 *  ≥ 75      → distinguished
 *  60 – 74.99 → standard
 *  45 – 59.99 → watch
 *  30 – 44.99 → pip
 *  < 30      → suspension_review
 *
 * Strictness at boundaries: 74.99 → standard, 75 → distinguished. Same at
 * other boundaries (locked decision PRD §6 + ELO.3a).
 */
export function classifyTier(composite: number, hasAnyCaseInWindow: boolean): Tier {
  if (!hasAnyCaseInWindow) return "no_recent_activity";
  if (composite >= 75) return "distinguished";
  if (composite >= 60) return "standard";
  if (composite >= 45) return "watch";
  if (composite >= 30) return "pip";
  return "suspension_review";
}

/**
 * Low-confidence flag (PRD §6.2 step 7) — total observations across
 * all streams in the 6-month window < 30.
 */
export function lowConfidenceFlag(totalObservations: number): boolean {
  return totalObservations < LOW_CONFIDENCE_OBS_THRESHOLD;
}
