// lib/member-state-adapters/discharge-evidence.ts — MemberState admission adapter (#5) SL1.
//
// COMPOSE OUTSIDE, NEVER EDIT. The frozen V-ratified spine (member-bank/1.0) ingests exactly two
// sources (OPD prescriptions + labs). Adding an `admissionRows` param to assembleEvidence would
// edit that frozen core — forbidden. Instead this adapter (a) maps a persisted EpisodeState to an
// EncounterEvidence-shaped admission encounter, and (b) composes: it calls the frozen
// assembleEvidence UNCHANGED for OPD+labs, then APPENDS the admission encounter. The frozen
// function and all its aggregate/reconcile logic stay byte-identical; the admission is purely
// additive and reversible.
//
// DIRECTION: this adapter reads the spine's TYPES (type-only) and CALLS the spine's assembleEvidence
// (value — the allowed adapter→spine direction). The reverse — the frozen spine importing this
// adapter — is forbidden by the architecture tripwire (rule 8) and would break the freeze.
//
// BEHIND A FLAG: the admission composition is opt-in (MEMBERSTATE_ADMISSION_ADAPTER=1), default-off
// until SL2's no-regression proof clears it. With the flag off, assembleEvidenceWithAdmission is
// byte-identical to the frozen assembleEvidence.
//
// FACTS-ONLY + PROVENANCE: every asserted fact traces to an EpisodeState fact's provenance
// (preserved, never fabricated). De-identified — link-back keys only; EpisodeState is already
// PHI-free and stays so. No band/CVI/prediction.

import { assembleEvidence } from '../member-state/assemble-core';
import type { EncounterEvidence, MemberEvidence } from '../member-state/schema';
import type { MedicationAssertion, AllergyAssertion, Provenance, ConceptRef } from '../clinical-state/schema';
import type { EpisodeState, EpisodeFact, Provenance as EpisodeProvenance } from '../episode-state/schema';

/** kind: 'admission' is NOT in the frozen EncounterEvidence.kind union — adding it would edit the
 *  frozen schema. So the admission encounter is a widened, compose-outside shape. */
export type AdmissionEncounter = Omit<EncounterEvidence, 'kind'> & { kind: 'admission' };

/** The composed evidence: the frozen MemberEvidence, with the encounters array widened to allow the
 *  appended admission encounter. The frozen MemberEvidence itself is untouched. */
export interface MemberEvidenceWithAdmission extends Omit<MemberEvidence, 'encounters'> {
  encounters: (EncounterEvidence | AdmissionEncounter)[];
}

const djb2 = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

/** Carry an EpisodeState fact's provenance onto the spine's Provenance shape VERBATIM. The two
 *  shapes are structurally identical (episode-state deliberately mirrors clinical-state's
 *  Provenance); this preserves the span + method + confidence, inventing nothing. */
function carryProvenance(p: EpisodeProvenance): Provenance {
  return {
    sourceField: p.sourceField, rawText: p.rawText,
    startOffset: p.startOffset, endOffset: p.endOffset,
    extractionMethod: p.extractionMethod, confidence: p.confidence,
  };
}

function medicationAssertion(f: EpisodeFact): MedicationAssertion {
  const raw = f.value;
  const medicationConcept: ConceptRef = { raw, normalizedConceptId: null };
  return {
    id: `ma-${djb2(`${raw}|prescribed`)}`,
    medicationConcept,
    status: 'prescribed',                     // documented at discharge — the reconciliation payload
    provenance: carryProvenance(f.provenance),
    encounterRef: null,
  };
}

/**
 * Map a persisted EpisodeState to an admission EncounterEvidence (kind: 'admission'). PURE. Maps:
 *   final diagnosis          → problems
 *   discharge / in-stay meds → medicationAssertions  (intra.medications — the v1 reconciliation source)
 *   investigations           → investigations
 *   allergies                → allergyAssertions      (EpisodeState v0.2 carries none → []; a v1.1
 *                                                       EpisodeState enrichment would populate this)
 * Every fact keeps its EpisodeState provenance; nothing is fabricated.
 */
export function dischargeToEncounter(episode: EpisodeState): AdmissionEncounter {
  const intra = episode.intra;
  const date = intra.admission.dischargeDate?.value ?? intra.admission.admitDate?.value ?? '';

  const problems: EncounterEvidence['problems'] = intra.diagnosis
    ? [{ conceptRaw: intra.diagnosis.value, icdCode: null, explicitStatus: null, provenance: carryProvenance(intra.diagnosis.provenance) }]
    : [];

  const medicationAssertions: MedicationAssertion[] = intra.medications.map(medicationAssertion);

  const investigations: EncounterEvidence['investigations'] = intra.investigations.map((f) => ({
    analyteRaw: f.value, value: '', unit: null, abnormal: null, provenance: carryProvenance(f.provenance),
  }));

  const allergyAssertions: AllergyAssertion[] = [];   // no allergy facts in EpisodeState v0.2

  return {
    encounterRef: episode.episodeRef,      // ip_uid link-back key (de-identified, not PHI)
    date,
    kind: 'admission',
    problems,
    medicationAssertions,
    allergyAssertions,
    investigations,
    demographics: { age: episode.demographics.age ?? null, sex: episode.demographics.sex ?? null },
  };
}

/** Default-off flag: the admission composition is opt-in until SL2's no-regression proof clears it. */
export function admissionAdapterEnabled(): boolean {
  return process.env.MEMBERSTATE_ADMISSION_ADAPTER === '1';
}

/**
 * Compose the frozen assembleEvidence output with an admission encounter — WITHOUT editing the
 * frozen core. Calls assembleEvidence unchanged for OPD+labs, then appends the admission encounter.
 * With the flag off (or no episode), returns the frozen output BYTE-IDENTICAL. The OPD+labs
 * encounters are never moved or altered; the admission is strictly additive at the tail.
 */
export function assembleEvidenceWithAdmission(
  input: Parameters<typeof assembleEvidence>[0],
  episode: EpisodeState | null,
): MemberEvidenceWithAdmission {
  const base = assembleEvidence(input);                 // frozen, unchanged
  if (!admissionAdapterEnabled() || !episode) return base;   // default-off ⇒ identical to the frozen path
  return { ...base, encounters: [...base.encounters, dischargeToEncounter(episode)] };
}
