import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAskSet, deriveAssertions, escalationFlag, validateOutcome,
  CARE_CALL_ENGINE, ASK_SET_VERSION, type AskResponse,
} from '../care-call-core';
import type { DeidOpdCase, OpdMed } from '../opd-ingest-core';

const KEYS = { presc_uid: 'presc123', individual_uid: 'indiv123', uhid: null, note_date: '2026-07-09' };
function mkCase(over: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [], impressionCodes: [],
    impressions: [], history: [], comorbidities: [], medications: [], investigations: [], advice: [], examination: [],
    allergies: 'nil', followUpType: null, followUpDateSet: false, ...over,
  };
}
const med = (o: Partial<OpdMed>): OpdMed => ({ ...o });
const resp = (o: Partial<AskResponse> & { family: AskResponse['family']; state: AskResponse['state'] }): AskResponse => ({ askId: `${o.family}:x`, subject: '', ...o } as AskResponse);

// ── buildAskSet ──
test('buildAskSet: high-alert med first', () => {
  const c = mkCase({ medications: [med({ generic: 'Atorvastatin' }), med({ generic: 'Metformin', highAlert: true })] });
  const { asks } = buildAskSet(c, KEYS);
  const medAsks = asks.filter((a) => a.family === 'MED_STATUS');
  assert.equal(medAsks[0].subject, 'Metformin');
  assert.equal(medAsks[0].meta?.highAlert, true);
});

test('buildAskSet: med cap 3 (4th med → overflow)', () => {
  const c = mkCase({ medications: [med({ generic: 'A' }), med({ generic: 'B' }), med({ generic: 'C' }), med({ generic: 'D' })] });
  const { asks, overflow } = buildAskSet(c, KEYS);
  assert.equal(asks.filter((a) => a.family === 'MED_STATUS').length, 3);
  assert.ok(overflow.some((o) => o.family === 'MED_STATUS' && o.subject === 'D'));
});

test('buildAskSet: overall cap 5, rest overflow', () => {
  const c = mkCase({ medications: [med({ generic: 'A' }), med({ generic: 'B' }), med({ generic: 'C' })], presentingComplaints: ['knee pain', 'cough'], allergies: null });
  const { asks, overflow } = buildAskSet(c, KEYS);
  assert.equal(asks.length, 5);
  assert.ok(overflow.length >= 1);
});

test('buildAskSet: follow-up keyword extraction (advice "repeat")', () => {
  const c = mkCase({ advice: ['Repeat HbA1c in October'] });
  const { asks } = buildAskSet(c, KEYS);
  const fu = asks.find((a) => a.family === 'FOLLOWUP_ACTION');
  assert.ok(fu);
  assert.match(fu!.question, /Repeat HbA1c/);
});

test('buildAskSet: no follow-up when no keyword and no followUpType', () => {
  assert.equal(buildAskSet(mkCase({ advice: ['take rest'] }), KEYS).asks.some((a) => a.family === 'FOLLOWUP_ACTION'), false);
});

test('buildAskSet: followUpType real + no date → follow-up ask', () => {
  const c = mkCase({ followUpType: 'MANDATORY_FOLLOW_UP', followUpDateSet: false });
  assert.equal(buildAskSet(c, KEYS).asks.some((a) => a.family === 'FOLLOWUP_ACTION'), true);
});

test('buildAskSet: complaint cap 2', () => {
  const c = mkCase({ presentingComplaints: ['a', 'b', 'c'] });
  assert.equal(buildAskSet(c, KEYS).asks.filter((a) => a.family === 'COMPLAINT_STATUS').length, 2);
});

test('buildAskSet: allergy only when the note field is blank', () => {
  assert.equal(buildAskSet(mkCase({ allergies: null }), KEYS).asks.some((a) => a.family === 'ALLERGY_CONFIRM'), true);
  assert.equal(buildAskSet(mkCase({ allergies: 'Penicillin' }), KEYS).asks.some((a) => a.family === 'ALLERGY_CONFIRM'), false);
});

test('buildAskSet: outside-records is generated last if room', () => {
  const { asks } = buildAskSet(mkCase({ allergies: 'nil' }), KEYS);
  assert.equal(asks[asks.length - 1].family, 'OUTSIDE_RECORDS');
});

test('buildAskSet: empty-ish case → just the outside-records ask', () => {
  const { asks } = buildAskSet(mkCase({ allergies: 'nil' }), KEYS);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].family, 'OUTSIDE_RECORDS');
});

test('buildAskSet: deterministic ask ids + deep-equal on re-run', () => {
  const c = mkCase({ medications: [med({ generic: 'Metformin', highAlert: true })], presentingComplaints: ['knee pain'], allergies: null });
  assert.deepEqual(buildAskSet(c, KEYS), buildAskSet(c, KEYS));
});

// ── deriveAssertions ──
test('deriveAssertions: med chips → statuses; stopped carries reason; parse generic/brand', () => {
  const responses: AskResponse[] = [
    resp({ family: 'MED_STATUS', state: 'answered', subject: 'Metformin (Glycomet 500)', answer: 'stopped', reason: 'side_effect' }),
    resp({ family: 'MED_STATUS', state: 'answered', subject: 'Aspirin', answer: 'reported_taking' }),
  ];
  const d = deriveAssertions(responses);
  assert.equal(d.medications.length, 2);
  const m0 = d.medications[0];
  assert.equal(m0.status, 'stopped');
  assert.equal(m0.stopReason, 'side_effect');
  assert.equal(m0.medicationConcept.generic, 'Metformin');
  assert.equal(m0.medicationConcept.brand, 'Glycomet 500');
  assert.equal(d.medications[1].status, 'reported_taking');
});

test('deriveAssertions: skip produces NO assertion', () => {
  assert.equal(deriveAssertions([resp({ family: 'MED_STATUS', state: 'skipped', subject: 'X' })]).medications.length, 0);
});

test('deriveAssertions: complaint + follow-up + allergy chips', () => {
  const d = deriveAssertions([
    resp({ family: 'COMPLAINT_STATUS', state: 'answered', subject: 'knee pain', answer: 'resolved' }),
    resp({ family: 'FOLLOWUP_ACTION', state: 'answered', subject: 'Repeat HbA1c', answer: 'committed', targetDate: '2026-10-01' }),
    resp({ family: 'ALLERGY_CONFIRM', state: 'answered', subject: '', answer: 'denied' }),
  ]);
  assert.equal(d.complaints[0].status, 'resolved');
  assert.equal(d.followUps[0].action, 'committed');
  assert.equal(d.followUps[0].targetDate, '2026-10-01');
  assert.equal(d.allergies[0].status, 'denied');
  assert.equal(d.allergies[0].substance.normalized, 'no known allergy');   // dated documented-negative
});

test('deriveAssertions: reported_allergy carries the free-text substance', () => {
  const d = deriveAssertions([resp({ family: 'ALLERGY_CONFIRM', state: 'answered', subject: '', answer: 'reported_allergy', freeText: 'Penicillin — rash' })]);
  assert.equal(d.allergies[0].status, 'reported_allergy');
  assert.equal(d.allergies[0].substance.raw, 'Penicillin — rash');
});

test('deriveAssertions: every derived assertion carries valid clinical-state/1.2 patient-reported Provenance', () => {
  const d = deriveAssertions([resp({ family: 'MED_STATUS', state: 'answered', subject: 'Metformin', answer: 'reported_taking' })]);
  const p = d.medications[0].provenance;
  assert.equal(p.sourceField, 'care_call_outcomes');
  assert.equal(p.extractionMethod, 'reported');
  assert.equal(p.confidence, 0.9);
  assert.equal(p.reporter, 'patient_via_care_manager');
  assert.equal(p.trust, 'patient_reported');
});

test('deriveAssertions: deterministic (twice → deep-equal)', () => {
  const r = [resp({ family: 'MED_STATUS', state: 'answered', subject: 'Metformin', answer: 'stopped', reason: 'cost' })];
  assert.deepEqual(deriveAssertions(r), deriveAssertions(r));
});

// ── escalationFlag ──
test('escalationFlag: complaint worse → symptom_worse', () => {
  assert.equal(escalationFlag([resp({ family: 'COMPLAINT_STATUS', state: 'answered', answer: 'worse' })])?.reason, 'symptom_worse');
});
test('escalationFlag: high-alert med stopped → high_alert_med_stopped', () => {
  assert.equal(escalationFlag([resp({ family: 'MED_STATUS', state: 'answered', answer: 'stopped', highAlert: true })])?.reason, 'high_alert_med_stopped');
});
test('escalationFlag: non-high-alert stopped → null', () => {
  assert.equal(escalationFlag([resp({ family: 'MED_STATUS', state: 'answered', answer: 'stopped', highAlert: false })]), null);
});
test('escalationFlag: not_taking high-alert → escalation', () => {
  assert.equal(escalationFlag([resp({ family: 'MED_STATUS', state: 'answered', answer: 'not_taking', highAlert: true })])?.reason, 'high_alert_med_stopped');
});

// ── validateOutcome ──
test('validateOutcome: illegal disposition · foreign askId · legal partial', () => {
  const served = new Set(['MED_STATUS:metformin']);
  assert.equal(validateOutcome({ disposition: 'bogus', responses: [] }, served).ok, false);
  assert.equal(validateOutcome({ disposition: 'connected', responses: [{ askId: 'FOREIGN:x', family: 'MED_STATUS', subject: '', state: 'answered', answer: 'reported_taking' }] }, served).ok, false);
  assert.equal(validateOutcome({ disposition: 'connected', responses: [{ askId: 'MED_STATUS:metformin', family: 'MED_STATUS', subject: '', state: 'answered', answer: 'reported_taking' }, { askId: 'MED_STATUS:metformin', family: 'MED_STATUS', subject: '', state: 'skipped' }] }, served).ok, true);
});

test('validateOutcome: illegal enum answer rejected', () => {
  assert.equal(validateOutcome({ disposition: 'connected', responses: [{ askId: 'a', family: 'COMPLAINT_STATUS', subject: '', state: 'answered', answer: 'not_a_status' }] }, new Set()).ok, false);
});

test('version constants', () => { assert.equal(CARE_CALL_ENGINE, 'care-call/0.1'); assert.equal(ASK_SET_VERSION, 'ask-set/0.1'); });
