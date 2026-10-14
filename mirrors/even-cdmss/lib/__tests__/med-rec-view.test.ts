// lib/__tests__/med-rec-view.test.ts — MemberState admission adapter (#5) SL3: the read-time
// medication-reconciliation VIEW. PURE tests of computeMedRecView over the frozen-spine composition:
//   1. LINKED — an OPD baseline + this admission ⇒ continued / newly-started / GAP, each with the
//      right provenance link-back on the sides it has (facts-only: no invented pairing).
//   2. UNLINKED — no member match ⇒ admission-list-only mode, no reconciliation rows (a missing
//      baseline is never rendered as a clean recon).
//   3. LINKED-BUT-NO-BASELINE — resolves but has no pre-admission OPD meds ⇒ also admission-only.
//   4. FLAG OFF — the composition never fires, so no admission occurrence is reconciled.
// Med-rec ONLY: the view carries no problem/allergy field (Gate D scope). Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMedRecView } from '../member-state-adapters/med-rec-view';
import type { MedRecInput } from '../member-state-adapters/med-rec-view';
import type { EpisodeState } from '../episode-state/schema';

const T = '2026-07-01T00:00:00.000Z';

function withFlag<R>(on: boolean, fn: () => R): R {
  const prev = process.env.MEMBERSTATE_ADMISSION_ADAPTER;
  if (on) process.env.MEMBERSTATE_ADMISSION_ADAPTER = '1'; else delete process.env.MEMBERSTATE_ADMISSION_ADAPTER;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MEMBERSTATE_ADMISSION_ADAPTER; else process.env.MEMBERSTATE_ADMISSION_ADAPTER = prev;
  }
}

const fact = (value: string, sf: string, m: 'deterministic' | 'reported' = 'deterministic') =>
  ({ value, provenance: { sourceField: sf, rawText: value, extractionMethod: m, confidence: 1, startOffset: 0, endOffset: value.length } });

// OPD baseline: atorvastatin (2 visits) + metformin (1 visit). Admission continues atorvastatin,
// starts aspirin, and OMITS metformin (no documented stop) ⇒ metformin is a reconciliation gap.
const PRESCRIPTION_ROWS = [
  { uid: 'p1', visit_date: '2024-06-01', diagnosis_icd_codes: ['E11'], medications: [{ brand_name: 'metformin', generic_name: 'metformin' }] },
  { uid: 'p2', visit_date: '2025-01-01', diagnosis_icd_codes: ['E78'], medications: [{ brand_name: 'atorvastatin', generic_name: 'atorvastatin' }] },
  { uid: 'p3', visit_date: '2025-06-01', diagnosis_icd_codes: ['E78'], medications: [{ brand_name: 'atorvastatin', generic_name: 'atorvastatin' }] },
];
const EPISODE: EpisodeState = {
  version: 'episode-state/0.2', episodeRef: 'IP-REC', demographics: { age: 61, sex: 'M', sexRaw: 'male' },
  pre: { presentingComplaints: [], priorConditions: [], homeMedications: [] },
  intra: {
    admission: { speciality: null, ward: null, admissionType: null, careSetting: null, dischargeType: null,
      lengthOfStayDays: null, admitDate: fact('2025-09-01', 'kx.admitDate', 'reported'), dischargeDate: fact('2025-09-05', 'kx.dischargeDate', 'reported') },
    diagnosis: fact('I10', 'extract.diagnosis'), procedures: [],
    medications: [fact('atorvastatin', 'extract.medications'), fact('aspirin', 'extract.medications')],  // continues ator; starts aspirin; omits metformin
    investigations: [], treatments: [], courseSummary: fact('x', 'extract.courseSummary'), billing: { netTotal: null },
  },
  post: { dischargeMedications: [], followUpPlan: [], warningSigns: [] },
};

const linkedInput = (over: Partial<MedRecInput> = {}): MedRecInput => ({
  memberRef: 'IU-1', generatedAt: T, computedAt: T, linked: true,
  prescriptionRows: PRESCRIPTION_ROWS, labRows: [], ...over,
});

test('linked: continued / newly-started / gap classified, provenance on the sides that exist', () => {
  const view = withFlag(true, () => computeMedRecView(linkedInput(), EPISODE));
  assert.equal(view.mode, 'reconciliation');
  const by = Object.fromEntries(view.rows.map((r) => [r.drug, r]));

  // atorvastatin: in OPD baseline AND at discharge ⇒ continued, both sides cite a real occurrence
  assert.equal(by.atorvastatin.status, 'continued');
  assert.ok(by.atorvastatin.opdBaseline && by.atorvastatin.admission, 'continued cites both sides');
  assert.equal(by.atorvastatin.admission!.encounterRef, 'IP-REC', 'discharge side is admission-anchored');
  assert.equal(by.atorvastatin.opdBaseline!.date, '2025-06-01', 'baseline side is the LATEST OPD occurrence');

  // aspirin: at discharge only ⇒ newly-started, no OPD baseline side
  assert.equal(by.aspirin.status, 'newly_started');
  assert.equal(by.aspirin.opdBaseline, null, 'newly-started has no baseline — never an invented pairing');
  assert.equal(by.aspirin.admission!.encounterRef, 'IP-REC');

  // metformin: OPD baseline, absent at discharge, no documented stop ⇒ reconciliation gap
  assert.equal(by.metformin.status, 'reconciliation_gap');
  assert.ok(by.metformin.opdBaseline, 'the gap cites the OPD baseline occurrence');
  assert.equal(by.metformin.admission, null, 'the gap has no discharge side');

  assert.equal(view.counts.reconciliation_gap, 1);
  assert.equal(view.counts.newly_started, 1);
  assert.equal(view.counts.continued, 1);
  // the actionable gap sorts to the top
  assert.equal(view.rows[0].status, 'reconciliation_gap');
});

test('unlinked: admission-list-only, no reconciliation rows (missing baseline stays visible)', () => {
  const view = withFlag(true, () => computeMedRecView(linkedInput({ linked: false, memberRef: '', prescriptionRows: [] }), EPISODE));
  assert.equal(view.mode, 'admission_only');
  assert.equal(view.linked, false);
  assert.ok(view.admissionMedications.some((m) => m.drug === 'atorvastatin'), 'the admission meds are listed');
  assert.ok(view.admissionMedications.some((m) => m.drug === 'aspirin'));
  // never a fabricated clean reconciliation — no gap/stopped rows conjured from a missing baseline
  assert.equal(view.counts.reconciliation_gap, 0);
  assert.equal(view.counts.stopped, 0);
});

test('linked but no pre-admission OPD meds: still admission-only (no baseline to compare)', () => {
  const view = withFlag(true, () => computeMedRecView(linkedInput({ prescriptionRows: [] }), EPISODE));
  assert.equal(view.mode, 'admission_only');
  assert.equal(view.linked, true, 'the member resolved…');
  assert.ok(view.admissionMedications.length >= 2, '…but with no baseline, the admission meds list stands alone');
});

test('flag off: the composition never fires — no admission occurrence is reconciled', () => {
  const view = withFlag(false, () => computeMedRecView(linkedInput(), EPISODE));
  // with the flag off, assembleEvidenceWithAdmission returns the frozen OPD-only evidence: the
  // admission drugs (aspirin) never appear, and the OPD drugs have no discharge side.
  assert.ok(!view.rows.some((r) => r.drug === 'aspirin'), 'aspirin (admission-only) is absent flag-off');
  assert.ok(view.rows.every((r) => r.admission === null), 'no discharge-side occurrence exists flag-off');
});

test('med-rec ONLY: the view exposes no problem / allergy continuity field (Gate D scope)', () => {
  const view = withFlag(true, () => computeMedRecView(linkedInput(), EPISODE));
  const keys = new Set(Object.keys(view));
  for (const forbidden of ['problems', 'allergies', 'problemContinuity', 'allergyConflicts']) {
    assert.ok(!keys.has(forbidden), `the view must not carry '${forbidden}' — that is v1.1`);
  }
});
