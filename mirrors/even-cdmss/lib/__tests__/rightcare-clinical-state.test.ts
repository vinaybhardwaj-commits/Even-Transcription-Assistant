// lib/__tests__/rightcare-clinical-state.test.ts — Right Care × ClinicalState Slice 1.
// The PRD gate's unit-provable checks live here so they re-prove on every CI run:
// construction per mode (counts > 0), the doc-audit adapter round-trip, fail-open,
// the flag-off neutrality contract, server-side reconstruction for persistence, and
// the member-link validation + identity/state separation. Run: npm test.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildRightCareState, rightCareExtractInput, rightCareStateEnabled, stateForRun } from '../right-care-state';
import { extractedCaseToState, stateToExtractedCase } from '../clinical-state/to-audit-family';
import { clinicalStateResultField } from '../clinical-state/ui-view';
import { validateClinicalState, stateCounts } from '../clinical-state/schema';
import { parseMemberLink, recordAuditLinkEnabled } from '../record-audit-link-store';
import type { ExtractedCase } from '../doc-audit-core';

beforeEach(() => {
  delete process.env.RIGHT_CARE_CLINICAL_STATE;
  delete process.env.RECORD_AUDIT_LINK;
  delete process.env.CLINICAL_STATE_LLM;
});

// A representative de-identified extracted case (what /api/doc-audit/extract produces —
// name/UHID already stripped by the content pass).
function sampleCase(): ExtractedCase {
  return {
    docType: 'discharge_summary', detectedDocType: 'discharge_summary', confidence: 0.9,
    patient: { age: 58, sex: 'female' },
    diagnosis: 'Acute cholecystitis', indication: 'Symptomatic gallstones',
    procedure: 'Laparoscopic cholecystectomy',
    investigations: ['USG abdomen', 'CBC'], treatments: ['IV ceftriaxone'],
    medications: ['Tab paracetamol 650 mg'],
    courseSummary: 'Admitted with RUQ pain; lap chole done day 2; uneventful recovery.',
    disposition: 'Discharged stable', followUp: 'Review in 1 week', rawNotes: '',
    completeness: [{ key: 'diagnosis', status: 'present' }, { key: 'follow_up', status: 'missing' }] as ExtractedCase['completeness'],
    adminFacts: { lengthOfStayDays: 3, admissionType: 'elective', careSetting: 'general ward' },
    riskFactors: ['obesity'],
  };
}

test('Order check constructs a ClinicalState from the provided input with counts > 0', async () => {
  const built = await buildRightCareState(rightCareExtractInput('check', {
    scenario: '34M, 5 days of non-specific low back pain, no red flags. No fever.',
    proposedActions: ['MRI lumbar spine'],
    age: 34, sex: 'M',
  }));
  assert.ok(built, 'construction must succeed');
  const s = validateClinicalState(built!.state);
  assert.equal(s.surface, 'appropriateness');
  assert.equal(s.demographics.age, 34);
  assert.equal(s.demographics.sex, 'M');
  const counts = stateCounts(s);
  assert.ok(Object.values(counts).reduce((a, b) => a + b, 0) > 0, `stateCounts must be > 0: ${JSON.stringify(counts)}`);
  assert.ok(s.negatives.some((f) => /fever/i.test(f.concept)), 'the explicit "No fever" negation must land');
});

test('Care pathway constructs from the presentation field with counts > 0', async () => {
  const built = await buildRightCareState(rightCareExtractInput('pathway', {
    scenario: '62F with sudden-onset chest pain radiating to the left arm, worsening for 2 hours',
    age: 62, sex: 'F',
  }));
  assert.ok(built);
  const s = validateClinicalState(built!.state);
  assert.equal(s.surface, 'appropriateness');
  assert.ok(Object.values(stateCounts(s)).reduce((a, b) => a + b, 0) > 0);
  // no complaint/vitals fields were provided → checklist unknowns still populate the state
  assert.ok(s.unknowns.length > 0, 'critical-concept checklist must mark unmentioned concepts unknown');
});

test('Record audit adapts the existing ExtractedCase and round-trips on the shared fields', () => {
  const ec = sampleCase();
  const state = validateClinicalState(extractedCaseToState(ec));
  assert.equal(state.surface, 'doc_audit');
  assert.ok(Object.values(stateCounts(state)).reduce((a, b) => a + b, 0) > 0);
  const back = stateToExtractedCase(state);
  assert.equal(back.diagnosis, ec.diagnosis);
  assert.equal(back.procedure, ec.procedure);
  assert.deepEqual(back.investigations, ec.investigations);
  assert.deepEqual(back.medications, ec.medications);
  assert.deepEqual(back.riskFactors, ec.riskFactors);
  assert.equal(back.disposition, ec.disposition);
  assert.equal(back.courseSummary, ec.courseSummary);
  assert.deepEqual(back.adminFacts, ec.adminFacts);
  assert.equal(back.patient.age, ec.patient.age);
  assert.equal(back.patient.sex, ec.patient.sex);
});

test('fail-open: a throwing LLM stage keeps the deterministic state; junk input never throws', async () => {
  process.env.CLINICAL_STATE_LLM = '1';
  const built = await buildRightCareState(
    rightCareExtractInput('check', { scenario: 'Adult with viral URTI requesting antibiotics' }),
    async () => { throw new Error('model down'); },
  );
  assert.ok(built, 'LLM failure must fall back to the stage-1 state, not null');
  assert.ok(Object.values(stateCounts(built!.state)).reduce((a, b) => a + b, 0) > 0);
  // reconstruction path: malformed inputs → null, never a throw (the mode/save is unchanged)
  assert.equal(stateForRun('check', null), null);
  assert.equal(stateForRun('check', { scenario: '' }), null);
  assert.equal(stateForRun('check', 'not an object'), null);
  assert.equal(stateForRun('audit', { nonsense: true }), null);
});

test('flag-off neutrality: no gate flag → feature inert; UI field off → {}', async () => {
  assert.equal(rightCareStateEnabled(), false, 'RIGHT_CARE_CLINICAL_STATE must default OFF');
  assert.equal(recordAuditLinkEnabled(), false, 'RECORD_AUDIT_LINK must default OFF');
  // the link write is DOUBLE-gated: RECORD_AUDIT_LINK alone is not enough
  process.env.RECORD_AUDIT_LINK = '1';
  assert.equal(recordAuditLinkEnabled(), false);
  process.env.RIGHT_CARE_CLINICAL_STATE = '1';
  assert.equal(recordAuditLinkEnabled(), true);
  assert.equal(rightCareStateEnabled(), true);
  // the additive response field contributes NOTHING when disabled — byte-identical payload
  const built = await buildRightCareState(rightCareExtractInput('check', { scenario: 'chest pain' }));
  assert.deepEqual(clinicalStateResultField(built!.state, 0, false), {});
  assert.deepEqual(clinicalStateResultField(null, 0, true), {});
  assert.ok(clinicalStateResultField(built!.state, 0, true).clinicalState);
});

test('save-run reconstruction: same pure builders, schema-valid, per mode', () => {
  const check = stateForRun('check', {
    scenario: '62F asymptomatic breast cancer, planning staging PET-CT',
    proposedActions: ['PET-CT'], patient: { age: 62, sex: 'F' },
  });
  assert.ok(check);
  assert.equal(check!.surface, 'appropriateness');
  assert.equal(check!.demographics.age, 62);
  const pathway = stateForRun('pathway', { scenario: 'acute severe headache, worst of life', patient: {} });
  assert.ok(pathway);
  const audit = stateForRun('audit', sampleCase() as unknown as Record<string, unknown>);
  assert.ok(audit);
  assert.equal(audit!.surface, 'doc_audit');
  // reconstruction equals a direct adapter run (deterministic)
  assert.deepEqual(audit, validateClinicalState(extractedCaseToState(sampleCase())));
});

test('member link: strict validation, and identity stays OUT of the state', () => {
  assert.deepEqual(parseMemberLink({ uhid: ' EH-102938 ', name: 'Asha Rao', junk: 'x' }), { uhid: 'EH-102938', name: 'Asha Rao' });
  assert.equal(parseMemberLink({}), null);
  assert.equal(parseMemberLink({ uhid: '   ' }), null);
  assert.equal(parseMemberLink(['uhid']), null);
  assert.equal(parseMemberLink('EH-102938'), null);
  assert.equal(parseMemberLink({ uhid: 42 }), null);
  // separation proof at the unit level: the state built from the de-identified case carries
  // no identity fields at all — the linkage key lives only in its own table.
  const stateJson = JSON.stringify(extractedCaseToState(sampleCase()));
  for (const idish of ['uhid', 'mrn', '"name"', 'dob', 'Asha']) {
    assert.ok(!stateJson.toLowerCase().includes(idish.toLowerCase()), `state must not carry ${idish}`);
  }
});
