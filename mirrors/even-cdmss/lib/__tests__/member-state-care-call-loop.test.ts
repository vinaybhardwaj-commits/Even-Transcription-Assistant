import { test } from 'node:test';
import assert from 'node:assert/strict';
import { careCallOutcomeToEncounter } from '../member-state/care-call-evidence';
import { deriveAssertions, type CareCallOutcome, type AskResponse } from '../care-call-core';
import { buildMemberState } from '../member-state/aggregate-core';
import type { MemberEvidence, EncounterEvidence } from '../member-state/schema';
import type { MedicationAssertion, Provenance } from '../clinical-state/schema';

const COMPUTED = '2026-07-12T00:00:00.000Z';
const resp = (o: Partial<AskResponse> & { family: AskResponse['family']; state: AskResponse['state'] }): AskResponse => ({ askId: `${o.family}:x`, subject: '', ...o } as AskResponse);
function outcome(id: string, note_date: string, responses: AskResponse[]): CareCallOutcome {
  return {
    id, presc_uid: 'p1', individual_uid: 'm1', uhid: null, note_date, attempt: 1, called_at: `${note_date}T09:00:00Z`,
    disposition: 'connected', engine_version: 'care-call/0.1', ask_set_version: 'ask-set/0.1',
    responses, derived: deriveAssertions(responses), flags: { escalation: null }, cm_ref: null,
  };
}

// ── mapper ──
test('careCallOutcomeToEncounter: stopped+reason → care_call encounter, identifier-free, deterministic', () => {
  const o = outcome('cc-1', '2025-05-01', [resp({ family: 'MED_STATUS', state: 'answered', subject: 'metformin', answer: 'stopped', reason: 'side_effect' })]);
  const e = careCallOutcomeToEncounter(o);
  assert.equal(e.kind, 'care_call');
  assert.equal(e.encounterRef, 'cc-1');
  assert.equal(e.date, '2025-05-01');
  assert.equal(e.medicationAssertions.length, 1);
  assert.equal(e.medicationAssertions[0].status, 'stopped');
  assert.equal(e.medicationAssertions[0].stopReason, 'side_effect');
  assert.deepEqual(e.problems, []);
  assert.deepEqual(e.investigations, []);
  // identifier-free: no name/mobile fields anywhere
  assert.ok(!JSON.stringify(e).match(/mobile|first_name|last_name|dob/i));
  assert.deepEqual(careCallOutcomeToEncounter(o), careCallOutcomeToEncounter(o));   // deterministic
});

test('careCallOutcomeToEncounter: complaint resolved → complaintStatuses; empty derived → empty arrays', () => {
  const e = careCallOutcomeToEncounter(outcome('cc-2', '2025-05-01', [resp({ family: 'COMPLAINT_STATUS', state: 'answered', subject: 'cough', answer: 'resolved' })]));
  assert.equal(e.complaintStatuses?.length, 1);
  assert.equal(e.complaintStatuses![0].status, 'resolved');
  const empty = careCallOutcomeToEncounter(outcome('cc-3', '2025-05-01', [resp({ family: 'MED_STATUS', state: 'skipped', subject: 'x' })]));
  assert.deepEqual(empty.medicationAssertions, []);
});

test('Patch B: care-call encounter dated at called_at (fresh observation), not the episode note_date', () => {
  const o: CareCallOutcome = { ...outcome('cc-date', '2025-01-01', [resp({ family: 'MED_STATUS', state: 'answered', subject: 'metformin', answer: 'stopped' })]), called_at: '2026-07-12T09:00:00Z' };
  assert.equal(careCallOutcomeToEncounter(o).date, '2026-07-12');   // called_at preferred over note_date 2025-01-01
});

// ── THE CLOSURE PROOF (pure, no DB): the loop closes through the FROZEN core ──
const dbProv: Provenance = { sourceField: 'individuals-prescriptions.medications', rawText: 'x', extractionMethod: 'reported', confidence: 0.95, trust: 'structured_db' };
const opdMed = (id: string): MedicationAssertion => ({ id, medicationConcept: { raw: 'metformin', generic: 'metformin' }, status: 'prescribed', provenance: dbProv });
const opdEnc = (ref: string, date: string, meds: MedicationAssertion[]): EncounterEvidence => ({ encounterRef: ref, date, kind: 'opd', problems: [], medicationAssertions: meds, allergyAssertions: [], investigations: [] });

test('loop closure: opd prescribes X + care_call reports X stopped → frozen buildMemberState currentness = stopped', () => {
  const careCall = careCallOutcomeToEncounter(outcome('cc-stop', '2025-05-01', [resp({ family: 'MED_STATUS', state: 'answered', subject: 'metformin', answer: 'stopped', reason: 'side_effect' })]));
  const ev: MemberEvidence = {
    memberRef: 'm1', sourceWatermarks: {}, generatedAt: COMPUTED,
    encounters: [opdEnc('opd1', '2025-01-01', [opdMed('rx1')]), careCall],
  };
  const snap = buildMemberState(ev, COMPUTED);
  const metformin = snap.medications.find((m) => m.normalizedConcept.normalizedConceptId === 'local:metformin')!;
  assert.equal(metformin.status, 'stopped');                          // patient-reported wins over the prescription
  assert.equal(metformin.occurrences.some((o) => o.provenance.trust === 'patient_reported'), true);   // provenance carried
});

test('loop closure R2: a LATER re-prescription after the patient-reported stop → medication/temporal_conflict/review', () => {
  const careCall = careCallOutcomeToEncounter(outcome('cc-stop', '2025-05-01', [resp({ family: 'MED_STATUS', state: 'answered', subject: 'metformin', answer: 'stopped', reason: 'side_effect' })]));
  const ev: MemberEvidence = {
    memberRef: 'm1', sourceWatermarks: {}, generatedAt: COMPUTED,
    encounters: [opdEnc('opd1', '2025-01-01', [opdMed('rx1')]), careCall, opdEnc('opd2', '2025-06-01', [opdMed('rx2')])],
  };
  const snap = buildMemberState(ev, COMPUTED);
  assert.equal(snap.medications[0].status, 'stopped');   // still stopped — a re-script never synthesizes taking
  assert.ok(snap.conflicts.some((c) => c.domain === 'medication' && c.type === 'temporal_conflict' && c.severity === 'review'));
});
