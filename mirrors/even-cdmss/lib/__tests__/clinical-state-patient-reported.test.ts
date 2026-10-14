import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyClinicalState, validateClinicalState, CLINICAL_STATE_VERSION,
  zComplaintStatusAssertion, zFollowUpAssertion,
} from '../clinical-state/schema';
import type { MedicationAssertion } from '../clinical-state/schema';

test('Provenance trust axis (1.2): optional reporter/trust validate; absent still validates', () => {
  assert.equal(CLINICAL_STATE_VERSION, 'clinical-state/1.2');
  const withTrust: MedicationAssertion = {
    id: 'm1', medicationConcept: { raw: 'atorvastatin' }, status: 'stopped', stopReason: 'side_effect',
    provenance: { sourceField: 'care_call', rawText: 'I stopped it', extractionMethod: 'reported', confidence: 0.6, reporter: 'patient_via_care_manager', trust: 'patient_reported' },
  };
  const s = emptyClinicalState('ddx');
  s.medicationAssertions.push(withTrust);
  assert.doesNotThrow(() => validateClinicalState(s));

  const s2 = emptyClinicalState('ddx');   // provenance WITHOUT reporter/trust (existing db13 shape)
  s2.medicationAssertions.push({ id: 'm2', medicationConcept: { raw: 'x' }, status: 'prescribed', provenance: { sourceField: 'db', rawText: 'x', extractionMethod: 'reported', confidence: 0.9 } });
  assert.doesNotThrow(() => validateClinicalState(s2));

  const bad = emptyClinicalState('ddx');
  (bad.medicationAssertions as unknown[]).push({ id: 'm3', medicationConcept: { raw: 'x' }, status: 'prescribed', provenance: { sourceField: 'db', rawText: 'x', extractionMethod: 'reported', confidence: 0.9, trust: 'made_up' } });
  assert.throws(() => validateClinicalState(bad));   // bad trust enum rejected
});

test('MedicationAssertion.stopReason enum validates through the state', () => {
  const ok = emptyClinicalState('ddx');
  ok.medicationAssertions.push({ id: 'm', medicationConcept: { raw: 'x' }, status: 'stopped', stopReason: 'cost', provenance: { sourceField: 'x', rawText: 'y', extractionMethod: 'reported', confidence: 0.6 } });
  assert.doesNotThrow(() => validateClinicalState(ok));
  const bad = emptyClinicalState('ddx');
  (bad.medicationAssertions as unknown[]).push({ id: 'm', medicationConcept: { raw: 'x' }, status: 'stopped', stopReason: 'nope', provenance: { sourceField: 'x', rawText: 'y', extractionMethod: 'reported', confidence: 0.6 } });
  assert.throws(() => validateClinicalState(bad));
});

test('zComplaintStatusAssertion validates ComplaintStatus, rejects bogus', () => {
  const base = { id: 'c1', concept: { raw: 'cough' }, provenance: { sourceField: 'care_call', rawText: 'better', extractionMethod: 'reported', confidence: 0.6 } };
  for (const status of ['resolved', 'improving', 'unchanged', 'worse']) assert.doesNotThrow(() => zComplaintStatusAssertion.parse({ ...base, status }));
  assert.throws(() => zComplaintStatusAssertion.parse({ ...base, status: 'BOGUS' }));
});

test('zFollowUpAssertion validates FollowUpAction (+ optional targetDate), rejects bogus', () => {
  const base = { id: 'f1', subject: 'repeat HbA1c', provenance: { sourceField: 'care_call', rawText: 'will do', extractionMethod: 'reported', confidence: 0.6 } };
  for (const action of ['committed', 'already_done_inhouse', 'already_done_outside', 'declined', 'undecided']) assert.doesNotThrow(() => zFollowUpAssertion.parse({ ...base, action }));
  assert.doesNotThrow(() => zFollowUpAssertion.parse({ ...base, action: 'committed', targetDate: '2026-09-01' }));
  assert.throws(() => zFollowUpAssertion.parse({ ...base, action: 'nope' }));
});
