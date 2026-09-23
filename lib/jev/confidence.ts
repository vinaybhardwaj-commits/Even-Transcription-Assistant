/**
 * lib/jev/confidence.ts — J-CORE-1: the confidence-band helper (PLAN-v3.md §1 principle 4).
 *
 * "Confidence bands, tuned per use: >= 0.9 act; 0.5-0.9 act cautiously or queue for review;
 * < 0.5 route to a human or another signal." PURE — every use reads its own answer's confidence
 * through this, rather than each hand-rolling its own threshold comparison, so a use that needs
 * a stricter or looser band (still passing the plan's own wording: "tuned per use") does so by
 * passing `thresholds`, never by re-deriving the three-way split itself.
 */

export type ConfidenceBand = "act" | "caution" | "review";

export type ConfidenceThresholds = { act: number; caution: number };

/** The plan's own defaults (principle 4), verbatim. */
export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = { act: 0.9, caution: 0.5 };

/**
 * `confidence` is expected in [0, 1]; anything outside that range still bands correctly (a value
 * at or above `act` bands "act" regardless), because a caller passing a malformed number should
 * fail toward caution/review, never toward silently acting on a value that was never validated.
 */
export function confidenceBand(confidence: number, thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS): ConfidenceBand {
  if (!Number.isFinite(confidence)) return "review";
  if (confidence >= thresholds.act) return "act";
  if (confidence >= thresholds.caution) return "caution";
  return "review";
}

/**
 * A "noul" answer (lib/jev/types.ts) is a single probability that the criterion is TRUE, not a
 * confidence in a decided direction — 0.15 and 0.85 are equally decisive, just on opposite sides.
 * This turns that probability into the confidence of whichever side it favours, so the SAME
 * confidenceBand above applies uniformly to noul, choice and score answers alike.
 */
export function noulConfidence(noul: number): number {
  if (!Number.isFinite(noul)) return 0;
  return Math.max(noul, 1 - noul);
}
