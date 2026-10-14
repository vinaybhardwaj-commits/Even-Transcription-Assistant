// lib/member-state/validation/gold-seed.ts — MemberState Stage 1 gold seed. The ~20 de-identified
// synthetic strata (contract Part B's 14 + 6 patient-reported/trust) encoded VERBATIM with FIXED
// ISO dates so course thresholds are deterministic. Each case = MemberEvidence + an ExpectedLabel
// (class invariant|accuracy). FROZEN: every case ratified:true (V-ratified 11 Jul 2026 — member-bank/1.0).
// PURE (type-only cross-imports; no db/io/llm). The frozen core is untouched.
//
// GROUNDED ENCODING NOTES (flagged in the build report):
//  • The frozen buildMemberState DERIVES asOf = max encounter date; it is NOT settable, so the
//    PRD's "asOf = 2026-07-01" is not used — each case's expected label matches the core's actual
//    asOf (= its last encounter). Status labels are encoded against that.
//  • A patient complaint links to a documented problem ONLY when they share a normalized key; the
//    seed dictionary has no ICD↔text mapping, so stratum 15 documents the problem as TEXT
//    ('hypertension') rather than an ICD code, so the patient complaint reconciles onto it.

import type { MemberEvidence, EncounterEvidence } from '../schema';
import type { Provenance, MedicationAssertion, AllergyAssertion, ComplaintStatusAssertion, FollowUpAssertion, MedicationStatus, AllergyStatus, ComplaintStatus, FollowUpAction } from '../../clinical-state/schema';
import type { ExpectedLabel } from './score-core';

export const MEMBER_BANK_VERSION = 'member-bank/1.0' as const;   // FROZEN (Phase 2, V-ratified 11 Jul 2026)

// ── de-identified synthetic builders ──
const dbProv = (sf = 'individuals-prescriptions.diagnosis_icd_codes'): Provenance => ({ sourceField: sf, rawText: 'x', extractionMethod: 'reported', confidence: 0.9, trust: 'structured_db' });
const patientProv = (): Provenance => ({ sourceField: 'care_call', rawText: 'x', extractionMethod: 'reported', confidence: 0.7, reporter: 'patient_via_care_manager', trust: 'patient_reported' });

function enc(encounterRef: string, date: string, over: Partial<EncounterEvidence> = {}): EncounterEvidence {
  return { encounterRef, date, kind: 'opd', problems: [], medicationAssertions: [], allergyAssertions: [], investigations: [], ...over };
}
const problem = (conceptRaw: string, explicitStatus: 'active' | 'resolved' | null = null) => ({ conceptRaw, icdCode: null, explicitStatus, provenance: dbProv() });
const med = (raw: string, status: MedicationStatus, patient = false, stopReason: MedicationAssertion['stopReason'] = null): MedicationAssertion =>
  ({ id: `m-${raw}-${status}`, medicationConcept: { raw, generic: raw }, status, stopReason, provenance: patient ? patientProv() : dbProv('individuals-prescriptions.medications') });
const allergy = (raw: string, status: AllergyStatus, patient = false): AllergyAssertion =>
  ({ id: `a-${raw}-${status}`, substance: { raw, normalized: null }, status, reaction: null, provenance: patient ? patientProv() : dbProv('individuals-prescriptions.patient_details__allergies') });
const complaint = (raw: string, status: ComplaintStatus): ComplaintStatusAssertion => ({ id: `c-${raw}-${status}`, concept: { raw }, status, provenance: patientProv() });
const followUp = (id: string, action: FollowUpAction, targetDate: string | null): FollowUpAssertion => ({ id, subject: 'repeat test', action, targetDate, provenance: patientProv() });
const inv = (analyteRaw: string, value: string, unit: string | null, abnormal: string | null = null) => ({ analyteRaw, value, unit, abnormal, provenance: dbProv('test_values_view') });
const member = (id: string, encounters: EncounterEvidence[]): MemberEvidence => ({ memberRef: id, encounters, sourceWatermarks: { db13: '2026-07-01' }, generatedAt: '2026-07-01T00:00:00.000Z' });

export interface GoldCase { evidence: MemberEvidence; expected: ExpectedLabel }

export const GOLD_SEED: GoldCase[] = [
  // 1 — persistent chronic across years (R1: chronic re-documented ≥2× ⇒ persistent regardless of gaps)
  { evidence: member('S1', [enc('s1e1', '2023-02-01', { problems: [problem('E11')] }), enc('s1e2', '2024-05-01', { problems: [problem('E11')] }), enc('s1e3', '2025-06-01', { problems: [problem('E11')] })]),
    expected: { caseId: 'S1', stratum: 1, class: 'invariant', problems: [{ concept: 'E11', count: 1, status: 'documented_active', course: 'persistent' }], distinctProblemConcepts: 1, ratified: true } },

  // 2 — recurrent (present → >180d gap → present)
  { evidence: member('S2', [enc('s2e1', '2024-01-10', { problems: [problem('J06.9')] }), enc('s2e2', '2025-09-01', { problems: [problem('J06.9')] })]),
    expected: { caseId: 'S2', stratum: 2, class: 'accuracy', problems: [{ concept: 'J06.9', count: 1, course: 'recurrent' }], ratified: true } },

  // 3 — explicit resolution → documented_resolved
  { evidence: member('S3', [enc('s3e1', '2025-01-01', { problems: [problem('N39.0', 'active')] }), enc('s3e2', '2025-04-01', { problems: [problem('N39.0', 'resolved')] })]),
    expected: { caseId: 'S3', stratum: 3, class: 'invariant', problems: [{ concept: 'N39.0', count: 1, status: 'documented_resolved' }], ratified: true } },

  // 4 — omitted at later encounters → uncertain, never resolved (invariant 1)
  { evidence: member('S4', [enc('s4e1', '2024-11-01', { problems: [problem('I10')] }), enc('s4e2', '2025-03-01', { problems: [problem('E78.5')] }), enc('s4e3', '2025-06-01', { problems: [problem('E78.5')] })]),
    expected: { caseId: 'S4', stratum: 4, class: 'invariant', problems: [{ concept: 'I10', count: 1, status: 'uncertain_current_status' }], ratified: true } },

  // 5 — contradictory allergy → reported_allergy + safety_critical conflict
  { evidence: member('S5', [enc('s5e1', '2024-02-01', { allergyAssertions: [allergy('penicillin', 'reported_allergy')] }), enc('s5e2', '2025-01-01', { allergyAssertions: [allergy('penicillin', 'denied')] })]),
    expected: { caseId: 'S5', stratum: 5, class: 'invariant', allergies: [{ substance: 'penicillin', status: 'reported_allergy' }], conflicts: [{ domain: 'allergy', type: 'status_conflict', severity: 'safety_critical' }], ratified: true } },

  // 6 — prescribed, no taking evidence → status prescribed (never reported_taking)
  { evidence: member('S6', [enc('s6e1', '2025-05-01', { medicationAssertions: [med('metformin', 'prescribed')] })]),
    expected: { caseId: 'S6', stratum: 6, class: 'invariant', medications: [{ concept: 'metformin', status: 'prescribed' }], ratified: true } },

  // 7 — explicit stopped → status reflects stopped (scored)
  { evidence: member('S7', [enc('s7e1', '2024-01-01', { medicationAssertions: [med('atorvastatin', 'prescribed')] }), enc('s7e2', '2025-02-01', { medicationAssertions: [med('atorvastatin', 'stopped')] })]),
    expected: { caseId: 'S7', stratum: 7, class: 'accuracy', medications: [{ concept: 'atorvastatin', status: 'stopped' }], ratified: true } },

  // 8 — broader/narrower NEVER merged → 2 distinct problems
  { evidence: member('S8', [enc('s8e1', '2024-06-01', { problems: [problem('diabetes mellitus')] }), enc('s8e2', '2025-06-01', { problems: [problem('type 2 diabetes mellitus')] })]),
    expected: { caseId: 'S8', stratum: 8, class: 'invariant', problems: [{ concept: 'diabetes mellitus', count: 1 }, { concept: 'type 2 diabetes mellitus', count: 1 }], distinctProblemConcepts: 2, ratified: true } },

  // 9 — same analyte, mixed units → 1 series unit:null + value_conflict
  { evidence: member('S9', [enc('s9e1', '2024-06-01', { investigations: [inv('HbA1c', '6.9', '%')] }), enc('s9e2', '2025-06-01', { investigations: [inv('HbA1c', '52', 'mmol/mol')] })]),
    expected: { caseId: 'S9', stratum: 9, class: 'invariant', investigations: [{ analyte: 'HbA1c', points: 2, unitMixed: true }], conflicts: [{ domain: 'investigation', type: 'value_conflict', severity: 'review' }], ratified: true } },

  // 10 — abnormal→normal series, date-ordered (scored)
  { evidence: member('S10', [enc('s10e1', '2024-06-01', { investigations: [inv('creatinine', '2.1', 'mg/dL', 'true')] }), enc('s10e2', '2025-06-01', { investigations: [inv('creatinine', '1.0', 'mg/dL', 'false')] })]),
    expected: { caseId: 'S10', stratum: 10, class: 'accuracy', investigations: [{ analyte: 'creatinine', points: 2 }], ratified: true } },

  // 11 — abnormal never repeated → recorded as one series point (no open-loop in Stage 0)
  { evidence: member('S11', [enc('s11e1', '2024-06-01', { investigations: [inv('LDL', '190', 'mg/dL', 'true')] })]),
    expected: { caseId: 'S11', stratum: 11, class: 'invariant', investigations: [{ analyte: 'LDL', points: 1 }], ratified: true } },

  // 12 — two simultaneous conditions → 2 parallel problems
  { evidence: member('S12', [enc('s12e1', '2025-05-01', { problems: [problem('I10'), problem('E78.5')] })]),
    expected: { caseId: 'S12', stratum: 12, class: 'invariant', problems: [{ concept: 'I10', count: 1 }, { concept: 'E78.5', count: 1 }], distinctProblemConcepts: 2, ratified: true } },

  // 13 — evidence immutability + recompute (asserted in the test)
  { evidence: member('S13', [enc('s13e1', '2025-01-01', { problems: [problem('I10')] })]),
    expected: { caseId: 'S13', stratum: 13, class: 'invariant', problems: [{ concept: 'I10', count: 1 }], distinctProblemConcepts: 1, ratified: true } },

  // 14 — "rule out PE" NEVER merged with confirmed PE (invariant 3)
  { evidence: member('S14', [enc('s14e1', '2025-03-01', { problems: [problem('rule out pulmonary embolism')] }), enc('s14e2', '2025-04-01', { problems: [problem('pulmonary embolism')] })]),
    expected: { caseId: 'S14', stratum: 14, class: 'invariant', distinctProblemConcepts: 2, ratified: true } },

  // 15 — patient complaint 'resolved' → documented_resolved occurrence (1.2 rule 1; explicit, not silence)
  { evidence: member('S15', [enc('s15e1', '2025-01-01', { problems: [problem('hypertension')] }), enc('s15cc', '2025-05-01', { kind: 'care_call', complaintStatuses: [complaint('hypertension', 'resolved')] })]),
    expected: { caseId: 'S15', stratum: 15, class: 'invariant', problems: [{ concept: 'hypertension', count: 1, status: 'documented_resolved' }], ratified: true } },

  // 16 — patient-reported stopped overrides prescription (1.2 rule 2; scored)
  { evidence: member('S16', [enc('s16e1', '2025-01-01', { medicationAssertions: [med('amlodipine', 'prescribed')] }), enc('s16cc', '2025-05-01', { kind: 'care_call', medicationAssertions: [med('amlodipine', 'stopped', true)] })]),
    expected: { caseId: 'S16', stratum: 16, class: 'accuracy', medications: [{ concept: 'amlodipine', status: 'stopped' }], ratified: true } },

  // 17 — allergy trust-conflict (structured reported vs patient denied) → reported + safety_critical, both trusts
  { evidence: member('S17', [enc('s17e1', '2025-01-01', { allergyAssertions: [allergy('sulfa', 'reported_allergy')] }), enc('s17cc', '2025-05-01', { kind: 'care_call', allergyAssertions: [allergy('sulfa', 'denied', true)] })]),
    expected: { caseId: 'S17', stratum: 17, class: 'invariant', allergies: [{ substance: 'sulfa', status: 'reported_allergy' }], conflicts: [{ domain: 'allergy', type: 'status_conflict', severity: 'safety_critical' }], ratified: true } },

  // 18 — follow-ups carried + deduped by id (1.2 rule 4; no overlay)
  { evidence: member('S18', [enc('s18cc1', '2025-04-01', { kind: 'care_call', followUps: [followUp('f1', 'committed', '2025-07-01'), followUp('f2', 'declined', null)] }), enc('s18cc2', '2025-05-01', { kind: 'care_call', followUps: [followUp('f1', 'committed', '2025-07-01')] })]),
    expected: { caseId: 'S18', stratum: 18, class: 'invariant', followUpsCount: 2, ratified: true } },

  // 19 — RATIFIED (R2): patient-reported stop then a fresh prescription → status stays 'stopped'
  //   AND a medication/temporal_conflict/review surfaces the re-prescription (never a silent taking).
  { evidence: member('S19', [enc('s19cc', '2025-05-01', { kind: 'care_call', medicationAssertions: [med('amlodipine', 'stopped', true)] }), enc('s19e2', '2025-06-01', { medicationAssertions: [med('amlodipine', 'prescribed')] })]),
    expected: { caseId: 'S19', stratum: 19, class: 'accuracy', medications: [{ concept: 'amlodipine', status: 'stopped' }], conflicts: [{ domain: 'medication', type: 'temporal_conflict', severity: 'review' }], ratified: true } },

  // 20 — neutrality: zero patient-reported evidence → 1.0 behaviour + empty followUps
  { evidence: member('S20', [enc('s20e1', '2025-05-01', { problems: [problem('I10')], medicationAssertions: [med('metformin', 'prescribed')], allergyAssertions: [allergy('penicillin', 'reported_allergy')] })]),
    expected: { caseId: 'S20', stratum: 20, class: 'invariant', problems: [{ concept: 'I10', count: 1, status: 'documented_active' }], medications: [{ concept: 'metformin', status: 'prescribed' }], allergies: [{ substance: 'penicillin', status: 'reported_allergy' }], followUpsCount: 0, ratified: true } },
];
