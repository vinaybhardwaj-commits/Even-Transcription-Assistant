import { CaseRow, ComputeResult, Observation, Stream, Weights } from "./types";
import {
  computeCaseload,
  computeBehaviouralComponent,
  ADHERENCE_MIN_STREAMS,
  OUTCOMES_MIN_STREAMS,
} from "./components";
import { classifyTier, composeScore, lowConfidenceFlag } from "./compose";

/**
 * End-to-end pure pipeline. Given a snapshot of the world (cases,
 * observations, streams, weights), compute everything ELO.3b will
 * persist as a `score_snapshots` row.
 *
 * No DB access. No clock — caller supplies `asOfDate`.
 *
 * ELO.3b will wrap this with a DB read + snapshot-write helper.
 */
export function computeScore(input: {
  cases: CaseRow[];
  observations: Observation[];
  streams: Stream[];
  weights: Weights;
  asOfDate?: Date;
}): ComputeResult {
  const asOf = input.asOfDate ?? new Date();

  // Filter cases to the 6-month window + completed status.
  const windowStart = new Date(asOf.getTime() - 180 * 24 * 60 * 60 * 1000);
  const casesInWindow = input.cases.filter(
    (c) => c.case_status === "completed" && new Date(c.surgery_date) >= windowStart,
  );

  // Caseload — count cases this calendar month.
  const monthPrefix = `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`;
  const caseCountThisMonth = casesInWindow.filter(
    (c) => c.surgery_date.substring(0, 7) === monthPrefix,
  ).length;

  const caseloadStream = input.streams.find((s) => s.id === "cases_per_month");
  const caseload = caseloadStream
    ? computeCaseload(caseCountThisMonth, caseloadStream)
    : { score: null, streams: [], scoreable_stream_count: 0 };

  const outcomesStreams = input.streams.filter((s) => s.component === "outcomes");
  const adherenceStreams = input.streams.filter((s) => s.component === "adherence");

  const outcomes = computeBehaviouralComponent(
    outcomesStreams,
    casesInWindow,
    input.observations,
    asOf,
    OUTCOMES_MIN_STREAMS,
  );
  const adherence = computeBehaviouralComponent(
    adherenceStreams,
    casesInWindow,
    input.observations,
    asOf,
    ADHERENCE_MIN_STREAMS,
  );

  const composite = composeScore(caseload, outcomes, adherence, input.weights);

  // Total observations across the window (current).
  const totalObs = input.observations.filter((obs) =>
    casesInWindow.some((c) => c.id === obs.case_id),
  ).length;

  const tier = classifyTier(composite, casesInWindow.length > 0);
  const low_confidence = lowConfidenceFlag(totalObs);

  return {
    caseload,
    outcomes,
    adherence,
    composite,
    tier,
    low_confidence,
    total_observations: totalObs,
    case_count_window: casesInWindow.length,
  };
}

export * from "./types";
export { decayWeight, daysBetween, WINDOW_DAYS } from "./decay";
export { mapToZeroHundred, clamp } from "./mapping";
export { aggregateStream } from "./aggregate";
export {
  computeCaseload,
  computeBehaviouralComponent,
  OUTCOMES_MIN_STREAMS,
  ADHERENCE_MIN_STREAMS,
} from "./components";
export { composeScore, classifyTier, lowConfidenceFlag, LOW_CONFIDENCE_OBS_THRESHOLD } from "./compose";
