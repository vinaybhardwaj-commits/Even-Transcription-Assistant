// lib/member-state/validation/baseline.ts — MemberState Stage 1 FROZEN fidelity baseline
// (member-state-baseline/1.0, V-ratified 11 Jul 2026, decision R4). PURE: type-only imports.
//
// This is the frozen floor the seed must clear — the DDx-evaluator discipline applied to the
// patient record: define the test + thresholds, freeze, and no consumer moves until it holds.
// Pins the core it was ratified against: member-state/1.1 · member-reconcile/0.3 · member-eval/0.1
// · member-bank/1.0. The harness --baseline mode exits 1 on any breach.
//
// Metric asymmetry (deliberate, per the validation contract): false-merge + conflict-recall are the
// GATED safety metrics; false-split + latency are reported-but-tolerated. Accuracy floors are ≥0.90.

import type { PartCMetrics } from './score-core';

export const MEMBER_STATE_BASELINE = 'member-state-baseline/1.0' as const;

export interface MemberStateBaseline {
  version: typeof MEMBER_STATE_BASELINE;
  ratifiedBy: string;
  ratifiedOn: string;              // ISO date (passed in / literal; no Date.now)
  frozenPins: { memberState: string; reconcile: string; eval: string; bank: string };
  hard: {                          // must hold exactly (=)
    sourceEventRetention: number;  // 1.0
    provenanceRetention: number;   // 1.0
    trustProvenanceRetention: number; // 1.0
    incorrectResolutions: number;  // 0
    invariantViolations: number;   // 0
  };
  gated: {                         // safety — must hold exactly
    falseMerges: number;           // 0 (seed)
    conflictRecall: number;        // 1.0 (incl. the allergy trust-conflict + the R2 temporal_conflict)
  };
  floored: {                       // accuracy — must be ≥ the floor
    problemStatusAccuracy: number; // ≥0.90
    problemCourseAccuracy: number; // ≥0.90 (post-R1)
    medCurrentnessAccuracy: number;// ≥0.90
  };
  reported: string[];              // measured + reported, NOT gated
}

export const BASELINE: MemberStateBaseline = {
  version: MEMBER_STATE_BASELINE,
  ratifiedBy: 'V',
  ratifiedOn: '2026-07-11',
  frozenPins: { memberState: 'member-state/1.1', reconcile: 'member-reconcile/0.3', eval: 'member-eval/0.1', bank: 'member-bank/1.0' },
  hard: { sourceEventRetention: 1.0, provenanceRetention: 1.0, trustProvenanceRetention: 1.0, incorrectResolutions: 0, invariantViolations: 0 },
  gated: { falseMerges: 0, conflictRecall: 1.0 },
  floored: { problemStatusAccuracy: 0.90, problemCourseAccuracy: 0.90, medCurrentnessAccuracy: 0.90 },
  reported: ['falseSplits', 'compute latency (p50/p90)', 'clinician-correction burden'],
};

/** Check an aggregate Part-C run against the frozen baseline. Returns the breaches (empty = pass).
 *  Pure + deterministic; the harness --baseline mode exits 1 when this is non-empty. */
export function checkBaseline(m: PartCMetrics): string[] {
  const b = BASELINE;
  const breaches: string[] = [];
  const eq = (label: string, actual: number, want: number) => { if (actual !== want) breaches.push(`${label} ${actual} ≠ ${want}`); };
  const floor = (label: string, actual: number | null, min: number) => { if (actual == null || actual < min) breaches.push(`${label} ${actual == null ? 'n/a' : actual.toFixed(3)} < ${min}`); };
  eq('HARD source-event-retention', m.sourceEventRetention, b.hard.sourceEventRetention);
  eq('HARD provenance-retention', m.provenanceRetention, b.hard.provenanceRetention);
  eq('HARD trust-provenance-retention', m.trustProvenanceRetention, b.hard.trustProvenanceRetention);
  eq('HARD incorrect-resolutions', m.incorrectResolutions, b.hard.incorrectResolutions);
  eq('HARD invariant-violations', m.invariantViolations, b.hard.invariantViolations);
  eq('GATED false-merges', m.falseMerges, b.gated.falseMerges);
  floor('GATED conflict-recall', m.conflictRecall, b.gated.conflictRecall);   // gate = 1.0 (floor semantics: must equal)
  floor('FLOOR problem-status-acc', m.problemStatusAccuracy, b.floored.problemStatusAccuracy);
  floor('FLOOR problem-course-acc', m.problemCourseAccuracy, b.floored.problemCourseAccuracy);
  floor('FLOOR med-currentness-acc', m.medCurrentnessAccuracy, b.floored.medCurrentnessAccuracy);
  return breaches;
}
