// Architecture Governance Slice 1 — clinical-semantics test #2 (ratified invariant).
// PRESCRIBED ≠ TAKING: a prescription line yields a MedicationAssertion with status 'prescribed'
// — never taking / active-use / adherent. A prescription is not proof the patient takes the drug.
// Target: lib/clinical-state/from-prescription.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medicationLineToAssertion, prescriptionToAssertions } from '../clinical-state/from-prescription';

test('semantics #2: a med line maps to status "prescribed" — never a taking/adherence status', () => {
  const a = medicationLineToAssertion({
    brand_name: 'GLYCOMET 500', generic_name: 'Metformin', dosage: '500 mg', frequency: 'BD', duration: '90 days',
    instruction_to_patient: 'taking daily after food',   // adherence-looking text must not upgrade the status
  });
  assert.ok(a, 'assertion minted');
  assert.equal(a!.status, 'prescribed');
  assert.ok(!['reported_taking', 'taking', 'active', 'active_use', 'adherent'].includes(a!.status as string));
});

test('semantics #2: EVERY line of a prescription maps to "prescribed" (bulk path)', () => {
  const { medicationAssertions } = prescriptionToAssertions([
    { brand_name: 'GLYCOMET 500', generic_name: 'Metformin' },
    { brand_name: 'THYRONORM 50', generic_name: 'Thyroxine' },
    { generic_name: 'Amlodipine' },
  ], null);
  assert.equal(medicationAssertions.length, 3);
  for (const a of medicationAssertions) assert.equal(a.status, 'prescribed');
});
