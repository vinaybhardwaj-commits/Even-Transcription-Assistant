import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentMemberState, MEMBER_STATE_PRESENT_VERSION } from '../member-state/present-core';
import { buildMemberState } from '../member-state/aggregate-core';
import type { MemberEvidence, EncounterEvidence } from '../member-state/schema';
import type { Provenance, MedicationAssertion, AllergyAssertion, MedicationStatus, AllergyStatus } from '../clinical-state/schema';

const COMPUTED = '2026-07-01T00:00:00.000Z';
const prov = (): Provenance => ({ sourceField: 'dx', rawText: 'x', extractionMethod: 'reported', confidence: 0.9, trust: 'structured_db' });
const enc = (r: string, d: string, o: Partial<EncounterEvidence> = {}): EncounterEvidence => ({ encounterRef: r, date: d, kind: 'opd', problems: [], medicationAssertions: [], allergyAssertions: [], investigations: [], ...o });
const prob = (c: string) => ({ conceptRaw: c, icdCode: null, explicitStatus: null as null, provenance: prov() });
const med = (raw: string, status: MedicationStatus, dose: string | null = null): MedicationAssertion => ({ id: `m-${raw}-${status}`, medicationConcept: { raw, generic: raw }, status, dose, provenance: prov() });
const allergy = (raw: string, status: AllergyStatus): AllergyAssertion => ({ id: `a-${raw}-${status}`, substance: { raw, normalized: null }, status, reaction: null, provenance: prov() });
const inv = (analyteRaw: string, value: string, unit: string | null, abnormal: string | null = null) => ({ analyteRaw, value, unit, abnormal, provenance: prov() });

// One member exercising every mapping. asOf (derived) = 2025-06-01 (max encounter date).
const EVIDENCE: MemberEvidence = {
  memberRef: 'M1', sourceWatermarks: { db13: COMPUTED }, generatedAt: COMPUTED,
  encounters: [
    enc('e1', '2024-01-01', {
      problems: [prob('hypertension'), prob('migraine')],
      medicationAssertions: [med('atorvastatin', 'prescribed')],
      allergyAssertions: [allergy('penicillin', 'reported_allergy')],
      investigations: [inv('HbA1c', '9.0', '%', 'true'), inv('creatinine', '1.0', 'mg/dL')],
    }),
    enc('e2', '2025-06-01', {                                   // asOf; migraine omitted here → uncertain
      problems: [prob('hypertension')],
      medicationAssertions: [med('metformin', 'prescribed', '500mg'), med('atorvastatin', 'stopped')],
      allergyAssertions: [allergy('penicillin', 'denied')],
      investigations: [inv('HbA1c', '6.5', '%', 'false'), inv('creatinine', '88', 'umol/L')],
    }),
  ],
};
const VIEW = presentMemberState(buildMemberState(EVIDENCE, COMPUTED));

test('version + provenance passthrough', () => {
  assert.equal(MEMBER_STATE_PRESENT_VERSION, 'member-state-present/0.1');
  assert.equal(VIEW.asOf, '2025-06-01');
  assert.equal(VIEW.computedAt, COMPUTED);
  assert.equal(VIEW.versions.reconciliation, 'member-reconcile/0.3');
});

test('course: chronic re-documented → Persistent (warn)', () => {
  const htn = VIEW.problems.find((p) => p.concept === 'hypertension')!;
  assert.deepEqual(htn.course, { label: 'Persistent', tone: 'warn' });
  assert.deepEqual(htn.status, { label: 'Active', tone: 'active' });
});

test('status: an omitted/silent problem renders Uncertain, NEVER Active', () => {
  const mig = VIEW.problems.find((p) => p.concept === 'migraine')!;
  assert.equal(mig.status.tone, 'uncertain');
  assert.match(mig.status.label, /^Uncertain — last documented 2024-01-01$/);
  assert.notEqual(mig.status.label, 'Active');
});

test('medication currentness: prescribed carries "not confirmed taken"; stopped → Stopped', () => {
  const metf = VIEW.medications.find((m) => m.concept === 'metformin')!;
  assert.deepEqual(metf.currentness, { label: 'Prescribed', tone: 'active' });
  assert.equal(metf.caption, 'prescribed — not confirmed taken');
  assert.equal(metf.latestDose, '500mg');
  const ator = VIEW.medications.find((m) => m.concept === 'atorvastatin')!;
  assert.deepEqual(ator.currentness, { label: 'Stopped', tone: 'stopped' });
  assert.equal(ator.caption, null);
});

test('allergy: reported_allergy + matching allergy Discrepancy → conflicted:true, critical', () => {
  const pen = VIEW.allergies.find((a) => a.substance === 'penicillin')!;
  assert.deepEqual(pen.status, { label: 'Allergy', tone: 'critical' });
  assert.equal(pen.conflicted, true);
});

test('series: two-point HbA1c → direction down; mixed-unit creatinine → mixedUnits true', () => {
  const hba1c = VIEW.investigations.find((i) => i.analyte === 'HbA1c')!;   // .raw preserves source casing
  assert.equal(hba1c.direction, 'down');
  assert.equal(hba1c.mixedUnits, false);
  assert.equal(hba1c.points.length, 2);
  assert.equal(hba1c.points[0].abnormal, true);
  const creat = VIEW.investigations.find((i) => i.analyte === 'creatinine')!;
  assert.equal(creat.unit, null);
  assert.equal(creat.mixedUnits, true);
});

test('conflicts sorted safety_critical → review → informational; counts.safetyCritical', () => {
  assert.equal(VIEW.conflicts[0].severity, 'safety_critical');   // the allergy conflict leads
  const rank = { safety_critical: 0, review: 1, informational: 2 };
  for (let i = 1; i < VIEW.conflicts.length; i++) assert.ok(rank[VIEW.conflicts[i - 1].severity] <= rank[VIEW.conflicts[i].severity]);
  assert.equal(VIEW.counts.safetyCritical, VIEW.conflicts.filter((c) => c.severity === 'safety_critical').length);
  assert.ok(VIEW.counts.safetyCritical >= 1);
});

test('counts reflect the view arrays', () => {
  assert.equal(VIEW.counts.problems, VIEW.problems.length);
  assert.equal(VIEW.counts.medications, VIEW.medications.length);
  assert.equal(VIEW.counts.allergies, VIEW.allergies.length);
  assert.equal(VIEW.counts.investigations, VIEW.investigations.length);
  assert.equal(VIEW.counts.conflicts, VIEW.conflicts.length);
});

test('Patch A: view dates render as YYYY-MM-DD (dayOnly, idempotent on already-day strings)', () => {
  const ev: MemberEvidence = {
    memberRef: 'M2', sourceWatermarks: {}, generatedAt: COMPUTED,
    encounters: [
      enc('e1', '2023-12-29T00:00:00+05:30', { problems: [prob('hypertension')], investigations: [inv('creatinine', '1.0', 'mg/dL')] }),
      enc('e2', '2024-06-01', { investigations: [inv('creatinine', '1.2', 'mg/dL')] }),   // already a day string
    ],
  };
  const v = presentMemberState(buildMemberState(ev, COMPUTED));
  const creat = v.investigations.find((i) => i.analyte === 'creatinine')!;
  assert.deepEqual(creat.points.map((p) => p.date), ['2023-12-29', '2024-06-01']);   // timestamp trimmed, day passthrough
  const htn = v.problems.find((p) => p.concept === 'hypertension')!;
  assert.equal(htn.first, '2023-12-29');                                 // ProblemView first trimmed
  // an omitted problem's "Uncertain — last documented {date}" label is also day-only
  assert.match(htn.status.label, /2023-12-29$/);
});

test('presentMemberState is deterministic (twice → deep-equal)', () => {
  const snap = buildMemberState(EVIDENCE, COMPUTED);
  assert.deepEqual(presentMemberState(snap), presentMemberState(snap));
});
