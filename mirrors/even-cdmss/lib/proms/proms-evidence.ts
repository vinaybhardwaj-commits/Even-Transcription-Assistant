// lib/proms/proms-evidence.ts — PROMs → MemberEvidence fold (Decision E; mirrors the Care-Call loop).
// PURE mapper: a set of scored PROM administrations FROM ONE administration (same day) → one immutable
// `care_call` EncounterEvidence whose investigations[] carry the deterministic scores as a dated point
// on the member's series. The FROZEN buildMemberState then trends them as LongitudinalInvestigation.
//
// Frozen core UNTOUCHED — this only produces input. Deterministic (no Date.now); never throws.
// Scores ride the EXISTING investigation series (analyte = prom:<instrumentId>); pre-op baseline is the
// appropriateness signal. Identifier-free: only the instrument id + numeric score + a provenance stamp.

import type { EncounterEvidence } from '../member-state/schema';
import type { Provenance } from '../clinical-state/schema';

export interface PromScore {
  instrumentId: string;
  window: string;
  administeredAt: string;          // ISO (day-precision sufficient)
  score: number | null;            // null = incomplete/unscored (dropped from the fold)
  scale: string;
  escalations: string[];
  adhocSetRef?: string | null;     // Tier-3 (0.2b-2): keys the folded series by the patient-series-unique
                                   // adhoc set → valid within-patient trend, structurally never pooled.
}

const promProvenance = (instrumentId: string): Provenance => ({
  sourceField: 'prom',
  rawText: `${instrumentId} score (patient-reported via care manager)`,
  extractionMethod: 'reported',
  confidence: 1,
  reporter: 'patient_via_care_manager',
  trust: 'patient_reported',
});

/** One administration's scored instruments → one `care_call` EncounterEvidence. Only scored
 *  instruments (score != null) land as investigation points; the encounter is dated at the
 *  administration day. Empty/all-unscored → an empty (dateless) encounter the fold filters out. */
export function promResponsesToEncounter(scored: PromScore[]): EncounterEvidence {
  const withScore = (scored || []).filter((s) => s && s.score !== null && Number.isFinite(s.score) && !!s.administeredAt);
  // all members of a group share the administration day; use the latest as the encounter date.
  const date = withScore.map((s) => String(s.administeredAt).slice(0, 10)).sort().pop() ?? '';
  const ref = withScore.length ? `prom:${withScore.map((s) => s.instrumentId).join('+')}:${date}` : `prom:${date}`;
  return {
    encounterRef: ref,
    date,
    kind: 'care_call',
    problems: [],
    medicationAssertions: [],
    allergyAssertions: [],
    investigations: withScore.map((s) => ({
      // Tier-3 adhoc administrations key by their patient-series-unique ref (never cross-patient); every
      // other instrument keys by its shared catalog id (trends across patients on the same instrument).
      analyteRaw: s.adhocSetRef ? `prom:adhoc:${s.adhocSetRef}` : `prom:${s.instrumentId}`,
      value: String(s.score),
      unit: s.scale || null,
      abnormal: null,
      provenance: promProvenance(s.instrumentId),
    })),
  };
}
