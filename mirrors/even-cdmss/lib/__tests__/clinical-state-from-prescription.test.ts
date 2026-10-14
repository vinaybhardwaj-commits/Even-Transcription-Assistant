import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  medicationLineToAssertion, allergyTextToAssertions, prescriptionToAssertions,
} from '../clinical-state/from-prescription';
import { emptyClinicalState, validateClinicalState, CLINICAL_STATE_VERSION } from '../clinical-state/schema';

// Three REAL db13 individuals-prescriptions lines (probe 11 Jul 2026), inline verbatim.
const SUCROSS = {
  brand_name: 'Sucross Ano Cream', generic_name: 'Lidocaine+Metronidazole+Sucralfate',
  dosage: 'LA', strength: '', frequency: '1-0-1', duration: '5 days',
  route_of_administration: '', instruction_to_patient: '', default_opd_service_category: '', is_vital: '', uid: 'x1',
};
const DFO = { brand_name: 'DFO 4X Gel', generic_name: 'Diclofenac', dosage: '', frequency: '', duration: '' };
const OPTIQ = { brand_name: 'Optiqmega Capsule', generic_name: '' };

test('medicationLineToAssertion: real db13 line → prescribed assertion with mapped fields + provenance', () => {
  const a = medicationLineToAssertion(SUCROSS)!;
  assert.ok(a);
  assert.equal(a.status, 'prescribed');
  assert.equal(a.medicationConcept.raw, 'Sucross Ano Cream');
  assert.equal(a.medicationConcept.brand, 'Sucross Ano Cream');
  assert.equal(a.medicationConcept.generic, 'Lidocaine+Metronidazole+Sucralfate');
  assert.equal(a.medicationConcept.normalizedConceptId, null);
  assert.equal(a.dose, 'LA');
  assert.equal(a.frequency, '1-0-1');
  assert.equal(a.duration, '5 days');
  assert.equal(a.strength, null);            // empty sub-field → null (never '')
  assert.equal(a.route, null);
  assert.equal(a.instruction, null);
  assert.equal(a.encounterRef, null);
  assert.equal(a.provenance.sourceField, 'individuals-prescriptions.medications');
  assert.equal(a.provenance.extractionMethod, 'reported');
  assert.equal(a.provenance.confidence, 0.95);
  assert.equal(a.provenance.rawText, 'Sucross Ano Cream (Lidocaine+Metronidazole+Sucralfate)');
});

test('medicationLineToAssertion: DFO + Optiqmega → brand/generic mapped; generic optional', () => {
  const dfo = medicationLineToAssertion(DFO)!;
  assert.equal(dfo.medicationConcept.brand, 'DFO 4X Gel');
  assert.equal(dfo.medicationConcept.generic, 'Diclofenac');
  assert.equal(dfo.status, 'prescribed');

  const opt = medicationLineToAssertion(OPTIQ)!;
  assert.equal(opt.medicationConcept.raw, 'Optiqmega Capsule');   // brand used as raw
  assert.equal(opt.medicationConcept.brand, 'Optiqmega Capsule');
  assert.equal(opt.medicationConcept.generic, undefined);          // empty generic → undefined
});

test('medicationLineToAssertion: both brand + generic empty → null (skip the line)', () => {
  assert.equal(medicationLineToAssertion({ brand_name: '', generic_name: '', dosage: '5mg' }), null);
  assert.equal(medicationLineToAssertion({ brand_name: '   ', generic_name: '' }), null);   // whitespace = empty
  assert.equal(medicationLineToAssertion({}), null);
});

test('allergyTextToAssertions: NKA notations → one denied; empty → []; substantive → reported_allergy', () => {
  const no = allergyTextToAssertions('No ');
  assert.equal(no.length, 1);
  assert.equal(no[0].status, 'denied');
  assert.equal(no[0].substance.raw, 'No ');                  // raw preserved verbatim
  assert.equal(no[0].substance.normalized, 'no known allergy');
  assert.equal(no[0].provenance.sourceField, 'individuals-prescriptions.patient_details__allergies');
  assert.equal(no[0].provenance.confidence, 0.9);

  assert.deepEqual(allergyTextToAssertions(''), []);
  assert.deepEqual(allergyTextToAssertions(null), []);
  assert.deepEqual(allergyTextToAssertions(undefined), []);
  assert.deepEqual(allergyTextToAssertions('   '), []);       // whitespace → no assertion (not denied)

  assert.equal(allergyTextToAssertions('NKDA')[0].status, 'denied');
  assert.equal(allergyTextToAssertions('nil known')[0].status, 'denied');
  assert.equal(allergyTextToAssertions('"No"')[0].status, 'denied');   // quote-insensitive
});

test('allergyTextToAssertions: "NK" (not-known) → denied; substantive text containing nk is NOT swept', () => {
  const nk = allergyTextToAssertions('NK');
  assert.equal(nk.length, 1);
  assert.equal(nk[0].status, 'denied');
  assert.equal(nk[0].substance.normalized, 'no known allergy');
  assert.equal(allergyTextToAssertions(' nk ')[0].status, 'denied');            // whitespace-insensitive
  // a real substance whose text merely CONTAINS "nk" must stay reported (whole-string match only)
  assert.equal(allergyTextToAssertions('NK reaction to penicillin')[0].status, 'reported_allergy');
});

test('allergyTextToAssertions: substantive text → one reported_allergy, raw preserved, reaction null', () => {
  const p = allergyTextToAssertions('Penicillin – rash');
  assert.equal(p.length, 1);
  assert.equal(p[0].status, 'reported_allergy');
  assert.equal(p[0].substance.raw, 'Penicillin – rash');
  assert.equal(p[0].substance.normalized, null);
  assert.equal(p[0].reaction, null);
  assert.equal(p[0].provenance.confidence, 0.6);
});

test('prescriptionToAssertions: full 2-line array + "No" allergy → 2 med + 1 denied', () => {
  const out = prescriptionToAssertions([SUCROSS, DFO], 'No');
  assert.equal(out.medicationAssertions.length, 2);
  assert.equal(out.allergyAssertions.length, 1);
  assert.equal(out.allergyAssertions[0].status, 'denied');
  assert.equal(out.medicationAssertions[0].medicationConcept.raw, 'Sucross Ano Cream');
});

test('prescriptionToAssertions: accepts a JSON string array; skips empty lines', () => {
  const out = prescriptionToAssertions(JSON.stringify([SUCROSS, { brand_name: '', generic_name: '' }, DFO]), 'Penicillin');
  assert.equal(out.medicationAssertions.length, 2);            // empty line dropped
  assert.equal(out.allergyAssertions[0].status, 'reported_allergy');
});

test('prescriptionToAssertions: malformed / non-array input → empty, never throws', () => {
  // malformed medications → [] meds; the independent allergy still maps
  const bad = prescriptionToAssertions('{not json', 'No');
  assert.deepEqual(bad.medicationAssertions, []);
  assert.equal(bad.allergyAssertions.length, 1);
  assert.equal(bad.allergyAssertions[0].status, 'denied');
  assert.deepEqual(prescriptionToAssertions(null), { medicationAssertions: [], allergyAssertions: [] });
  assert.deepEqual(prescriptionToAssertions(12345), { medicationAssertions: [], allergyAssertions: [] });
  assert.deepEqual(prescriptionToAssertions({ not: 'an array' }), { medicationAssertions: [], allergyAssertions: [] });
  assert.deepEqual(prescriptionToAssertions('[]'), { medicationAssertions: [], allergyAssertions: [] });
  // a garbage line inside a valid array degrades to skip, not throw
  const mixed = prescriptionToAssertions([SUCROSS, null, 42, 'str', { brand_name: 'X' }]);
  assert.equal(mixed.medicationAssertions.length, 2);
});

test('id determinism: same input → same id across calls (both assertion kinds)', () => {
  assert.equal(medicationLineToAssertion(SUCROSS)!.id, medicationLineToAssertion(SUCROSS)!.id);
  assert.equal(allergyTextToAssertions('Penicillin')[0].id, allergyTextToAssertions('Penicillin')[0].id);
  // distinct inputs → distinct ids
  assert.notEqual(medicationLineToAssertion(SUCROSS)!.id, medicationLineToAssertion(DFO)!.id);
});

test('schema: emptyClinicalState is 1.1 with empty assertion arrays and passes the updated zod', () => {
  const s = emptyClinicalState('ddx');
  assert.equal(s.version, CLINICAL_STATE_VERSION);
  assert.equal(s.version, 'clinical-state/1.2');
  assert.deepEqual(s.medicationAssertions, []);
  assert.deepEqual(s.allergyAssertions, []);
  assert.doesNotThrow(() => validateClinicalState(s));
  // a populated state also validates
  const populated = { ...s, ...prescriptionToAssertions([SUCROSS, DFO], 'Penicillin – rash') };
  assert.doesNotThrow(() => validateClinicalState(populated));
});
