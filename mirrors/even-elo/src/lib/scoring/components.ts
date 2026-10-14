import { CaseRow, ComponentResult, Observation, Stream } from "./types";
import { aggregateStream } from "./aggregate";
import { clamp } from "./mapping";

/**
 * Insufficient-data thresholds (PRD D31): a component is scoreable only
 * if at least N of its streams produced a sub-score.
 */
export const OUTCOMES_MIN_STREAMS = 3;
export const ADHERENCE_MIN_STREAMS = 4;

/**
 * Caseload sub-score (PRD §6.2 step 2).
 *
 * `count` = number of completed cases in the current calendar month.
 * Uses the single 'cases_per_month' stream's floor/target (defaults 1 / 8).
 * No decay — Caseload is a flow metric.
 */
export function computeCaseload(
  caseCountThisMonth: number,
  caseloadStream: Stream,
): ComponentResult {
  const f = caseloadStream.floor_value ?? 1;
  const t = caseloadStream.target_value ?? 8;
  let score: number;
  if (caseCountThisMonth <= f) {
    score = 0;
  } else if (caseCountThisMonth >= t) {
    score = 100;
  } else {
    score = clamp((100 * (caseCountThisMonth - f)) / (t - f), 0, 100);
  }
  return {
    score,
    streams: [
      {
        stream_id: caseloadStream.id,
        sub_score: score,
        n_observations: caseCountThisMonth,
        weight_sum: 1,
      },
    ],
    scoreable_stream_count: 1,
  };
}

/**
 * Outcomes / Adherence component composition.
 *
 * For each stream of the given component:
 *   - aggregate its observations into a sub-score
 * Component score = mean of stream sub-scores (excluding null).
 * If fewer than `minStreams` streams produced a sub-score, return null.
 */
export function computeBehaviouralComponent(
  streams: Stream[],
  cases: CaseRow[],
  observations: Observation[],
  asOfDate: Date,
  minStreams: number,
): ComponentResult {
  const streamResults: ComponentResult["streams"] = [];
  const subScores: number[] = [];

  for (const s of streams) {
    const agg = aggregateStream(s, cases, observations, asOfDate);
    if (agg.score !== null) {
      streamResults.push({
        stream_id: s.id,
        sub_score: agg.score,
        n_observations: agg.n,
        weight_sum: agg.weight_sum,
      });
      subScores.push(agg.score);
    } else {
      streamResults.push({
        stream_id: s.id,
        sub_score: 0,
        n_observations: 0,
        weight_sum: 0,
      });
    }
  }

  if (subScores.length < minStreams) {
    return {
      score: null,
      streams: streamResults,
      scoreable_stream_count: subScores.length,
    };
  }

  const mean = subScores.reduce((a, b) => a + b, 0) / subScores.length;
  return {
    score: mean,
    streams: streamResults,
    scoreable_stream_count: subScores.length,
  };
}
