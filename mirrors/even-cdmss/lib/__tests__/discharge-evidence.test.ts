// lib/__tests__/discharge-evidence.test.ts — MemberState admission adapter (#5) SL1.
//
// The whole game is the FROZEN-CORE BOUNDARY: the admission is composed OUTSIDE the V-ratified
// spine, never by editing it. Three things must hold:
//   1. ADAPTER — dischargeToEncounter maps an EpisodeState to an admission EncounterEvidence
//      (kind 'admission'), preserving each fact's provenance, fabricating nothing.
//   2. COMPOSITION — assembleEvidenceWithAdmission (flag on) appends the admission at the TAIL.
//   3. BYTE-IDENTICAL (load-bearing) — the OPD+labs encounters it produces are the EXACT SAME as
//      the frozen assembleEvidence alone; the admission is purely additive, nothing existing moves.
//      And with the flag OFF, it is deep-equal to the frozen assembleEvidence.
// (The empty `git diff lib/member-state/**` — the other half of "frozen untouched" — is asserted in
// the report, since a test can't run git.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleEvidence } from '../member-state/assemble-core';
import { dischargeToEncounter, assembleEvidenceWithAdmission } from '../member-state-adapters/discharge-evidence';
import type { EpisodeState } from '../episode-state/schema';

function withFlag<T>(on: boolean, fn: () => T): T {
  const prev = process.env.MEMBERSTATE_ADMISSION_ADAPTER;
  if (on) process.env.MEMBERSTATE_ADMISSION_ADAPTER = '1'; else delete process.env.MEMBERSTATE_ADMISSION_ADAPTER;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MEMBERSTATE_ADMISSION_ADAPTER; else process.env.MEMBERSTATE_ADMISSION_ADAPTER = prev;
  }
}

const fact = (value: string, sourceField: string, method: 'deterministic' | 'reported' = 'deterministic') =>
  ({ value, provenance: { sourceField, rawText: value, extractionMethod: method, confidence: 1, startOffset: 0, endOffset: value.length } });

const EPISODE: EpisodeState = {
  version: 'episode-state/0.2', episodeRef: 'IP-100',
  demographics: { age: 40, sex: 'M', sexRaw: 'male' },
  pre: { presentingComplaints: [], priorConditions: [], homeMedications: [] },
  intra: {
    admission: {
      speciality: fact('Orthopedics', 'kx.speciality', 'reported'), ward: null, admissionType: null,
      careSetting: null, dischargeType: fact('Routine', 'kx.dischargeType', 'reported'),
      lengthOfStayDays: fact('3', 'kx.losDays', 'reported'),
      admitDate: fact('2026-05-20', 'kx.admitDate', 'reported'), dischargeDate: fact('2026-05-23', 'kx.dischargeDate', 'reported'),
    },
    diagnosis: fact('Left knee PCL avulsion fracture', 'extract.diagnosis'),
    procedures: [], medications: [fact('TAB PAN-D 40MG 1-0-0 for 5 days', 'extract.medications'), fact('TAB HIFENAC-MR 1-0-1', 'extract.medications')],
    investigations: [fact('MRI left knee: PCL avulsion', 'extract.investigations')],
    treatments: [], courseSummary: fact('Admitted for arthroscopic PCL reconstruction.', 'extract.courseSummary'),
    billing: { netTotal: fact('52273.45', 'kx.netTotal', 'reported') },
  },
  post: { dischargeMedications: [], followUpPlan: [], warningSigns: [] },
};

// synthetic frozen-spine inputs that yield a real OPD encounter + a real lab encounter
const INPUT = {
  memberRef: 'member-1', generatedAt: '2026-06-01T00:00:00Z',
  sourceWatermarks: { prescriptions: '2026-05-30', labs: '2026-05-30' },
  prescriptionRows: [{ uid: 'presc-1', visit_date: '2026-03-01', diagnosis_icd_codes: ['I10'],
    medications: [{ brand_name: 'Amlodipine 5mg', generic_name: 'Amlodipine' }], age: 55, gender: 'M' }],
  labRows: [{ booking_id: 'lab-1', test_date: '2026-03-05', investigation_name: 'HbA1c', value: '7.2', investigation_unit: '%', investigation_is_abnormal: 'H' }],
};

test('(1) ADAPTER: dischargeToEncounter → admission encounter, provenance preserved, no fabrication', () => {
  const enc = dischargeToEncounter(EPISODE);
  assert.equal(enc.kind, 'admission');
  assert.equal(enc.encounterRef, 'IP-100');
  assert.equal(enc.date, '2026-05-23');                       // discharge date anchors the encounter
  assert.equal(enc.problems.length, 1);
  assert.equal(enc.problems[0].conceptRaw, 'Left knee PCL avulsion fracture');
  assert.equal(enc.medicationAssertions.length, 2);
  assert.equal(enc.medicationAssertions[0].status, 'prescribed');
  assert.equal(enc.medicationAssertions[0].medicationConcept.raw, 'TAB PAN-D 40MG 1-0-0 for 5 days');
  assert.equal(enc.investigations.length, 1);
  assert.deepEqual(enc.allergyAssertions, []);                 // EpisodeState v0.2 carries no allergy facts
  // provenance is CARRIED from the EpisodeState fact, not invented
  assert.equal(enc.problems[0].provenance.rawText, 'Left knee PCL avulsion fracture');
  assert.equal(enc.problems[0].provenance.sourceField, 'extract.diagnosis');
  assert.equal(enc.medicationAssertions[0].provenance.rawText, 'TAB PAN-D 40MG 1-0-0 for 5 days');
  // every asserted fact traces to an EpisodeState fact (no rawText the episode didn't state)
  const episodeTexts = new Set([EPISODE.intra.diagnosis!.value, ...EPISODE.intra.medications.map((m) => m.value), ...EPISODE.intra.investigations.map((i) => i.value)]);
  for (const m of enc.medicationAssertions) assert.ok(episodeTexts.has(m.provenance.rawText), 'med provenance traces to an episode fact');
});

test('(2) COMPOSITION: flag ON appends the admission at the tail', () => {
  withFlag(true, () => {
    const r = assembleEvidenceWithAdmission(INPUT, EPISODE);
    assert.equal(r.encounters.at(-1)!.kind, 'admission');
    assert.equal(r.encounters.at(-1)!.encounterRef, 'IP-100');
  });
});

test('(3) BYTE-IDENTICAL: the OPD+labs encounters are EXACTLY the frozen output; admission is additive', () => {
  const base = assembleEvidence(INPUT);
  assert.ok(base.encounters.length >= 2, 'the fixture yields ≥1 OPD + ≥1 lab encounter');
  withFlag(true, () => {
    const r = assembleEvidenceWithAdmission(INPUT, EPISODE);
    assert.equal(r.encounters.length, base.encounters.length + 1, 'exactly one encounter added');
    // the existing encounters are UNMOVED and UNCHANGED (deep-equal, same order)
    assert.deepEqual(r.encounters.slice(0, base.encounters.length), base.encounters);
    // and the frozen top-level fields are untouched
    assert.equal(r.memberRef, base.memberRef);
    assert.deepEqual(r.sourceWatermarks, base.sourceWatermarks);
    assert.equal(r.generatedAt, base.generatedAt);
  });
});

test('(3) DEFAULT-OFF: flag off (or no episode) ⇒ deep-equal to the frozen assembleEvidence', () => {
  const base = assembleEvidence(INPUT);
  withFlag(false, () => assert.deepEqual(assembleEvidenceWithAdmission(INPUT, EPISODE), base, 'flag off ⇒ identical to frozen'));
  withFlag(true, () => assert.deepEqual(assembleEvidenceWithAdmission(INPUT, null), base, 'no episode ⇒ identical to frozen'));
});

test('the adapter reads the spine by TYPE only + composes, never edits (structural)', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const src = readFileSync(join(process.cwd(), 'lib/member-state-adapters/discharge-evidence.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // schema imports are TYPE-ONLY; only assembleEvidence is a value import (the allowed direction)
  assert.ok(/import type \{[^}]*EncounterEvidence[^}]*\} from '\.\.\/member-state\/schema'/.test(src), 'EncounterEvidence is type-only');
  assert.ok(/import \{ assembleEvidence \} from '\.\.\/member-state\/assemble-core'/.test(src), 'assembleEvidence is called, not reimplemented');
  assert.ok(!/admissionRows/.test(src), 'the adapter never adds an admissionRows param to the frozen core');
});
