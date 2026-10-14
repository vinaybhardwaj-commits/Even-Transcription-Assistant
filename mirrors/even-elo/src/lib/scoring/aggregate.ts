import { CaseRow, Observation, Stream } from "./types";
import { decayWeight, daysBetween } from "./decay";
import { mapToZeroHundred } from "./mapping";

/**
 * Aggregate a single stream's effective observations into a 0–100 sub-score
 * using decay-weighted averaging.
 *
 * Effective observation set depends on stream.default_rule:
 * - `no_event`: every completed case in the window contributes a default
 *   "no event" observation unless an explicit observation overrides it.
 *   For binary streams, the default value is "false" (= no event happened).
 * - `unknown`: only explicit observations contribute.
 * - `excluded`: only explicit observations contribute (numeric streams).
 * - `derived`: not handled here — caseload is computed elsewhere.
 *
 * Returns: `{ score, n, weight_sum }`. If the stream has no effective
 * observations, returns `{ score: null, n: 0, weight_sum: 0 }`.
 */

export interface StreamAggregate {
  score: number | null;
  n: number;
  weight_sum: number;
}

export function aggregateStream(
  stream: Stream,
  cases: CaseRow[],
  observations: Observation[],
  asOfDate: Date,
): StreamAggregate {
  // Index explicit observations by case_id for this stream.
  const explicit = new Map<string, Observation>();
  for (const obs of observations) {
    if (obs.stream_id === stream.id) {
      explicit.set(obs.case_id, obs);
    }
  }

  let weightedSum = 0;
  let weightSum = 0;
  let n = 0;

  for (const c of cases) {
    if (c.case_status !== "completed") continue;
    const days = daysBetween(c.surgery_date, asOfDate);
    const w = decayWeight(days);
    if (w <= 0) continue;

    const obs = explicit.get(c.id);

    if (obs) {
      const sub = mapToZeroHundred(obs.value, stream);
      if (sub === null) continue;
      weightedSum += w * sub;
      weightSum += w;
      n++;
      continue;
    }

    // No explicit observation — apply default rule.
    if (stream.default_rule === "no_event") {
      // Synthesize a "no event" binary=false observation. Map it.
      const sub = mapToZeroHundred({ kind: "binary", val: false }, stream);
      if (sub === null) continue;
      weightedSum += w * sub;
      weightSum += w;
      n++;
    }
    // For `unknown` / `excluded`: skip — case doesn't contribute to this stream's score.
  }

  if (weightSum === 0 || n === 0) {
    return { score: null, n: 0, weight_sum: 0 };
  }
  return {
    score: weightedSum / weightSum,
    n,
    weight_sum: weightSum,
  };
}
