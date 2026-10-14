/**
 * Scoring engine type definitions.
 *
 * These mirror the rows that come back from the DB but are decoupled
 * from the @neondatabase/serverless types so the engine stays pure
 * and unit-testable without a live connection.
 */

export type Component = "caseload" | "outcomes" | "adherence";
export type DataType = "binary" | "numeric" | "derived";
export type DefaultRule = "no_event" | "unknown" | "excluded" | "derived";
export type Direction = "higher_better" | "lower_better";

export type Tier =
  | "distinguished"
  | "standard"
  | "watch"
  | "pip"
  | "suspension_review"
  | "no_recent_activity";

export interface Stream {
  id: string;
  component: Component;
  label: string;
  team_owner: string;
  data_type: DataType;
  default_rule: DefaultRule;
  direction: Direction;
  floor_value: number | null;
  target_value: number | null;
}

export interface ObservationValue {
  kind: "binary" | "numeric";
  val: boolean | number;
  reason?: string | null;
}

export interface Observation {
  case_id: string;
  stream_id: string;
  value: ObservationValue;
  /** ISO date or `Date`. The engine reads `surgery_date` from the case. */
}

export interface CaseRow {
  id: string;
  vc_id: string;
  surgery_date: string; // YYYY-MM-DD
  case_status: "completed" | "cancelled" | "voided";
}

export interface Weights {
  caseload_pct: number;
  outcomes_pct: number;
  adherence_pct: number;
}

export interface ComponentResult {
  /** 0–100 score, or null if insufficient data. */
  score: number | null;
  /** Per-stream breakdown for transparency. */
  streams: Array<{
    stream_id: string;
    sub_score: number;
    n_observations: number;
    weight_sum: number;
  }>;
  /** Number of streams that produced a sub-score (>= threshold to be scoreable). */
  scoreable_stream_count: number;
}

export interface ComputeResult {
  caseload: ComponentResult;
  outcomes: ComponentResult;
  adherence: ComponentResult;
  composite: number;
  tier: Tier;
  low_confidence: boolean;
  total_observations: number;
  case_count_window: number;
}
