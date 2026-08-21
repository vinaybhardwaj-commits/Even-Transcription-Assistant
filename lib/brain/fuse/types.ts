/**
 * lib/brain/fuse/types.ts — the shapes the three arms share (Fuse slice 4).
 *
 * A DraftVisit carries NO id and NO room_day_id. Ids are minted at WRITE time, not by an
 * arm, which is what lets arm A be a pure function whose output can be compared for equality
 * across two runs (§9.1). The runner adds identity when it persists.
 */

/** One cue as the arms see it. Exactly what SQL_CUES_FOR_ROOM_DAY returns, normalised. */
export type FuseCue = {
  id: string;
  type: string;
  /** ISO 8601, the evidence's own clock */
  at: string;
  payload: Record<string, unknown> | null;
  /** the 0046 column: 'replay' | 'warehouse' | null. NOT payload.source. */
  source: string | null;
  source_ref: string | null;
};

/** 0042's CHECK, verbatim. An arm that emits anything else is refused before the write. */
export const VISIT_STATES = ["called", "in_chair", "at_diagnostics", "ended", "unknown"] as const;
export type VisitState = (typeof VISIT_STATES)[number];

/**
 * The states that imply a patient is PRESENT and the visit is still running. These are what
 * day_rollover closes at the end of a fused day.
 *
 * `unknown` is deliberately NOT here (A7): it is not an open visit, it is a visit we never
 * established — a kiosk mark whose window held no warehouse evidence at all. Rolling it to
 * `ended` would claim we knew a consult happened and finished, when the whole point of the row
 * is that we could not tell. The six-hour gap stays a gap.
 */
export const OPEN_STATES: readonly VisitState[] = ["called", "in_chair", "at_diagnostics"];

export const ARMS = ["rules", "hybrid", "flash"] as const;
export type Arm = (typeof ARMS)[number];

export type OpenedByKind = "pstart" | "pqm_called" | "mark";

export type DraftVisit = {
  individual_uid: string | null;
  consult_uid: string | null;
  state: VisitState;
  /** ISO, or null for a visit with no official start (a mark-only or call-only visit) */
  pstart_at: string | null;
  confidence: number;
  /** the opening evidence — 0048's half of the unique key. Never empty. */
  opened_by: string;
  opened_by_kind: OpenedByKind;
  /** why this visit is uncertain, in closed-set order. Empty = confident. Stored in
   *  visit.ambiguity (0049), comma-joined — NEVER in end_reason. */
  reasons: string[];
  /** why this visit ENDED. Set ONLY when state === 'ended' (A6): 'pulse_note' | 'day_rollover'. */
  end_reason: string | null;
};

/** Evidence that bound to nothing. Not a visit, not a failure — a finding. */
export type UnboundEvidence = { cue_id: string; type: string; reason: string };

export type ArmOutput = { visits: DraftVisit[]; unbound: UnboundEvidence[] };
