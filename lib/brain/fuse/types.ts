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
 * The states that imply a patient is PRESENT and the visit is still running.
 *
 * `unknown` is deliberately NOT here: it is not an open visit, it is a visit we never
 * established — a kiosk mark whose window held no warehouse evidence at all. A pulse_note
 * still cannot close one (it matches on individual_uid, which such a visit does not have),
 * and the plain `day_rollover` token still does not apply to it.
 *
 * K2 CHANGES WHAT THIS DOES *NOT* MEAN. Until now "not an open state" also meant "closes by
 * nothing, ever", so a mark-only visit — the unrecorded-care case, the product's headline
 * capability — had no end at all. It can now close, by next_opener, by mark_window_elapsed,
 * or at the boundary as `day_rollover_unknown`. The distinction this list draws is preserved
 * in the END REASON, which says which of those happened, rather than in a row that never ends.
 */
export const OPEN_STATES: readonly VisitState[] = ["called", "in_chair", "at_diagnostics"];

/**
 * The states a visit may be closed FROM. Everything except `ended` — a closed visit is never
 * re-closed, and its end_reason is never rewritten by a later pass.
 */
export const CLOSEABLE_STATES: readonly VisitState[] = ["called", "in_chair", "at_diagnostics", "unknown"];

/**
 * migration 0056's CHECK, verbatim. HOW we came to believe a clinician was in the room.
 *
 *   'roster'    the day's schedule said so      — NO SOURCE SYSTEM YET; unreachable in K2
 *   'voice'     a voiceprint match said so      — slice B; unreachable in K2
 *   'mark'      a kiosk consult_mark carried it
 *   'operator'  a human named them directly
 *   'unknown'   we looked and we do not know
 *
 * 'unknown' is a FIRST-CLASS TERMINAL VALUE, not an error and not a placeholder. A visit
 * attributed to nobody is correctly attributed; a guessed clinician is not. NULL differs from
 * 'unknown': null means nothing ever looked, 'unknown' means something looked and failed.
 */
export const CLINICIAN_SOURCES = ["roster", "voice", "mark", "operator", "unknown"] as const;
export type ClinicianSource = (typeof CLINICIAN_SOURCES)[number];

/**
 * The subset arm A can actually PRODUCE in K2. 'roster' and 'voice' are in the column's CHECK
 * but have no source system in this build, and a value this list does not contain must never
 * appear on a row arm A wrote. Asserted by test, not by hope.
 */
export const K2_DERIVABLE_CLINICIAN_SOURCES: readonly ClinicianSource[] = ["mark", "operator", "unknown"];

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
  /** why this visit ENDED. Set ONLY when state === 'ended' (A6). See END_REASONS in rules.ts. */
  end_reason: string | null;
  /**
   * WHEN it ended, ISO. Set only alongside end_reason. Arm A always knew this instant and
   * used to throw it away — a row that said `pulse_note` could not say when the note landed.
   * Null when the visit is still open, and null when the closer genuinely has no instant to
   * offer (a day_rollover with no boundary supplied to the arm).
   */
  ended_at: string | null;
  /** the bench tape this visit was heard on, or null — see the tape-binding note in rules.ts */
  session_id: string | null;
  /** where the visit begins on that tape, EPOCH MS. Null unless session_id is set. */
  tape_start_ms: number | null;
  /** and where it ends. 0056 CHECKs tape_end_ms > tape_start_ms, so both are set or neither. */
  tape_end_ms: number | null;
  /** WHO was in the room for this visit. Null when nothing said. */
  clinician_id: string | null;
  /** HOW we came to believe that. Always DERIVED, never read from a payload field. */
  clinician_source: ClinicianSource | null;
  /** how strongly. Null is legitimate — unsure is first-class here as it is for `confidence`. */
  clinician_confidence: number | null;
};

/** Evidence that bound to nothing. Not a visit, not a failure — a finding. */
export type UnboundEvidence = { cue_id: string; type: string; reason: string };

export type ArmOutput = { visits: DraftVisit[]; unbound: UnboundEvidence[] };
