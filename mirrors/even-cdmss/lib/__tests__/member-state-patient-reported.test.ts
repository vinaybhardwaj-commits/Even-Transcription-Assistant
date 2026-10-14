import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberState } from '../member-state/aggregate-core';
import type { MemberEvidence, EncounterEvidence } from '../member-state/schema';
import type { Provenance, MedicationAssertion, MedicationStatus, ComplaintStatus, ComplaintStatusAssertion, FollowUpAssertion, Trust } from '../clinical-state/schema';

const COMPUTED = '2026-07-11T00:00:00.000Z';
function prov(trust?: Trust): Provenance {
  return { sourceField: 'care_call', rawText: 'x', extractionMethod: 'reported', confidence: 0.7, ...(trust ? { reporter: 'patient_via_care_manager', trust } : {}) };
}
function enc(encounterRef: string, date: string, over: Partial<EncounterEvidence> = {}): EncounterEvidence {
  return { encounterRef, date, kind: 'opd', problems: [], medicationAssertions: [], allergyAssertions: [], investigations: [], ...over };
}
function problem(conceptRaw: string) { return { conceptRaw, icdCode: null, explicitStatus: null as null, provenance: { sourceField: 'dx', rawText: 'x', extractionMethod: 'reported' as const, confidence: 0.9 } }; }
function complaint(raw: string, status: ComplaintStatus): ComplaintStatusAssertion {
  return { id: `c-${raw}-${status}`, concept: { raw }, status, provenance: prov('patient_reported') };
}
function med(raw: string, status: MedicationStatus, trust?: Trust): MedicationAssertion {
  return { id: `m-${raw}-${status}`, medicationConcept: { raw, generic: raw }, status, provenance: prov(trust) };
}
function member(encounters: EncounterEvidence[]): MemberEvidence {
  return { memberRef: 'M1', encounters, sourceWatermarks: { db13: '2026-07-11' }, generatedAt: '2026-07-11' };
}
const findP = (s: ReturnType<typeof buildMemberState>, id: string) => s.problems.find((p) => p.normalizedConcept.normalizedConceptId === id);

// ── Rule 1 — complaint status → explicit resolution/activity ──
test('complaint resolved → problem documented_resolved (explicit signal)', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { problems: [problem('hypertension')] }),
    enc('cc1', '2026-03-01', { kind: 'care_call', complaintStatuses: [complaint('hypertension', 'resolved')] }),
  ]), COMPUTED);
  assert.equal(findP(s, 'local:hypertension')!.latestDocumentedStatus, 'documented_resolved');
});

test('complaint worse → active (never resolved)', () => {
  const s = buildMemberState(member([
    enc('cc1', '2026-03-01', { kind: 'care_call', complaintStatuses: [complaint('hypertension', 'worse')] }),
  ]), COMPUTED);
  const htn = findP(s, 'local:hypertension')!;
  assert.equal(htn.latestDocumentedStatus, 'documented_active');
  assert.notEqual(htn.latestDocumentedStatus, 'documented_resolved');
});

test('resolved-then-silent stays resolved (a later unrelated encounter does not re-open it)', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { problems: [problem('cough')] }),
    enc('cc1', '2026-02-01', { kind: 'care_call', complaintStatuses: [complaint('cough', 'resolved')] }),
    enc('e3', '2026-05-01', { problems: [problem('hypertension')] }),   // asOf; cough silent here
  ]), COMPUTED);
  const cough = s.problems.find((p) => p.normalizedConcept.raw === 'cough')!;
  assert.equal(cough.latestDocumentedStatus, 'documented_resolved');
});

test('a complaint whose concept matches no documented problem still forms its own problem', () => {
  const s = buildMemberState(member([enc('cc1', '2026-03-01', { kind: 'care_call', complaintStatuses: [complaint('back pain', 'improving')] })]), COMPUTED);
  const bp = s.problems.find((p) => p.normalizedConcept.raw === 'back pain')!;
  assert.ok(bp);
  assert.equal(bp.latestDocumentedStatus, 'documented_active');
});

// ── Rule 2 — trust-weighted medication currentness ──
test('patient-reported stopped overrides a prescription prescribed', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { medicationAssertions: [med('atorvastatin', 'prescribed')] }),
    enc('cc1', '2026-03-01', { kind: 'care_call', medicationAssertions: [med('atorvastatin', 'stopped', 'patient_reported')] }),
  ]), COMPUTED);
  assert.equal(s.medications[0].status, 'stopped');
});

test('patient-reported reported_taking sets taking; currentness not synthesized otherwise', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { medicationAssertions: [med('metformin', 'prescribed')] }),
    enc('cc1', '2026-03-01', { kind: 'care_call', medicationAssertions: [med('metformin', 'reported_taking', 'patient_reported')] }),
  ]), COMPUTED);
  assert.equal(s.medications[0].status, 'reported_taking');
});

test('most-recent patient-reported wins over an older patient-reported', () => {
  const s = buildMemberState(member([
    enc('cc1', '2026-02-01', { kind: 'care_call', medicationAssertions: [med('metformin', 'stopped', 'patient_reported')] }),
    enc('cc2', '2026-05-01', { kind: 'care_call', medicationAssertions: [med('metformin', 'reported_taking', 'patient_reported')] }),
  ]), COMPUTED);
  assert.equal(s.medications[0].status, 'reported_taking');   // the later report
});

test('stopReason is carried on the occurrence', () => {
  const m = med('atorvastatin', 'stopped', 'patient_reported'); m.stopReason = 'side_effect';
  const s = buildMemberState(member([enc('cc1', '2026-03-01', { kind: 'care_call', medicationAssertions: [m] })]), COMPUTED);
  assert.equal(s.medications[0].occurrences[0].stopReason, 'side_effect');
});

// ── Rule 3 — allergy trust conflict ──
test('patient_reported denied + structured_db reported_allergy → reported_allergy + safety_critical conflict recording both trusts', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { allergyAssertions: [{ id: 'a1', substance: { raw: 'penicillin', normalized: null }, status: 'reported_allergy', reaction: null, provenance: { sourceField: 'db', rawText: 'x', extractionMethod: 'reported', confidence: 0.9, trust: 'structured_db' } }] }),
    enc('cc1', '2026-03-01', { kind: 'care_call', allergyAssertions: [{ id: 'a2', substance: { raw: 'penicillin', normalized: null }, status: 'denied', reaction: null, provenance: prov('patient_reported') }] }),
  ]), COMPUTED);
  assert.equal(s.allergies[0].status, 'reported_allergy');
  const c = s.conflicts.find((x) => x.domain === 'allergy' && x.type === 'status_conflict')!;
  assert.ok(c);
  assert.equal(c.severity, 'safety_critical');
  const details = c.assertions.map((a) => a.detail).join(' | ');
  assert.match(details, /structured_db/);
  assert.match(details, /patient_reported/);
});

// ── Rule 4 — follow-ups carried, deduped, no overlay ──
test('followUps carried onto the snapshot, deduped by id, date-sorted', () => {
  const f = (id: string, targetDate: string | null): FollowUpAssertion => ({ id, subject: 'repeat HbA1c', action: 'committed', targetDate, provenance: prov('patient_reported') });
  const s = buildMemberState(member([
    enc('cc1', '2026-02-01', { kind: 'care_call', followUps: [f('f2', '2026-09-01'), f('f1', '2026-06-01')] }),
    enc('cc2', '2026-03-01', { kind: 'care_call', followUps: [f('f1', '2026-06-01')] }),   // duplicate id
  ]), COMPUTED);
  assert.equal(s.followUps.length, 2);                       // f1 deduped
  assert.deepEqual(s.followUps.map((x) => x.id), ['f1', 'f2']);   // sorted by targetDate
});

// ── Neutrality ──
test('neutrality: no patient-reported evidence → 1.0 behaviour + empty followUps', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-05-01', { problems: [problem('hypertension')], medicationAssertions: [med('metformin', 'prescribed')] }),
  ]), COMPUTED);
  assert.deepEqual(s.followUps, []);
  assert.equal(findP(s, 'local:hypertension')!.latestDocumentedStatus, 'documented_active');   // 1.0 result
  assert.equal(s.medications[0].status, 'prescribed');                                          // 1.0 result
});
