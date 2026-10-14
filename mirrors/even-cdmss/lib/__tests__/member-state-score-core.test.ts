import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCase, aggregate, MEMBER_EVAL_VERSION, type ExpectedLabel } from '../member-state/validation/score-core';
import { buildMemberState } from '../member-state/aggregate-core';
import type { MemberEvidence, EncounterEvidence } from '../member-state/schema';
import type { Provenance } from '../clinical-state/schema';

const COMPUTED = '2026-07-01T00:00:00.000Z';
const prov = (trust?: string): Provenance => ({ sourceField: 'dx', rawText: 'x', extractionMethod: 'reported', confidence: 0.9, ...(trust ? { trust: trust as 'patient_reported', reporter: 'patient_via_care_manager' } : {}) });
const enc = (r: string, d: string, o: Partial<EncounterEvidence> = {}): EncounterEvidence => ({ encounterRef: r, date: d, kind: 'opd', problems: [], medicationAssertions: [], allergyAssertions: [], investigations: [], ...o });
const prob = (c: string, es: 'active' | 'resolved' | null = null, trust?: string) => ({ conceptRaw: c, icdCode: null, explicitStatus: es, provenance: prov(trust) });
const member = (encs: EncounterEvidence[]): MemberEvidence => ({ memberRef: 'M', encounters: encs, sourceWatermarks: {}, generatedAt: COMPUTED });
const exp = (o: Partial<ExpectedLabel>): ExpectedLabel => ({ caseId: 'c', stratum: 0, class: 'accuracy', ratified: false, ...o });

test('version constant', () => assert.equal(MEMBER_EVAL_VERSION, 'member-eval/0.1'));

test('retention/provenance/trust-provenance = 1.0 on well-formed input', () => {
  const ev = member([enc('e1', '2025-01-01', { problems: [prob('hypertension', null, 'patient_reported')] }), enc('e2', '2025-06-01', { problems: [prob('hypertension')] })]);
  const s = scoreCase(exp({ problems: [{ concept: 'hypertension', count: 1 }] }), buildMemberState(ev, COMPUTED), ev);
  assert.equal(s.sourceEventRetention, 1);
  assert.equal(s.provenanceRetention, 1);
  assert.equal(s.trustProvenanceRetention, 1);   // the patient_reported occurrence kept its trust
});

test('falseMerges=1 when two distinct expected concepts collapse (synonyms merge)', () => {
  const ev = member([enc('e1', '2025-01-01', { problems: [prob('HTN'), prob('hypertension')] })]);   // both → local:hypertension
  const s = scoreCase(exp({ distinctProblemConcepts: 2 }), buildMemberState(ev, COMPUTED), ev);
  assert.equal(s.falseMerges, 1);
  assert.equal(s.falseSplits, 0);
});

test('falseSplits=1 when one expected concept becomes two entities', () => {
  const ev = member([enc('e1', '2025-01-01', { problems: [prob('foo'), prob('bar')] })]);   // 2 unresolved groups
  const s = scoreCase(exp({ distinctProblemConcepts: 1 }), buildMemberState(ev, COMPUTED), ev);
  assert.equal(s.falseSplits, 1);
  assert.equal(s.falseMerges, 0);
});

test('conflictRecall [1,1] on a seeded allergy conflict', () => {
  const ev = member([enc('e1', '2025-01-01', { allergyAssertions: [{ id: 'a1', substance: { raw: 'penicillin', normalized: null }, status: 'reported_allergy', reaction: null, provenance: prov() }] }), enc('e2', '2025-02-01', { allergyAssertions: [{ id: 'a2', substance: { raw: 'penicillin', normalized: null }, status: 'denied', reaction: null, provenance: prov() }] })]);
  const s = scoreCase(exp({ class: 'invariant', conflicts: [{ domain: 'allergy', type: 'status_conflict', severity: 'safety_critical' }] }), buildMemberState(ev, COMPUTED), ev);
  assert.deepEqual(s.conflictRecall, [1, 1]);
  assert.equal(s.invariantViolations.length, 0);
});

test('problemCourseAgree [1,1] on a correctly-scored course', () => {
  const ev = member([enc('e1', '2024-01-01', { problems: [prob('migraine')] }), enc('e2', '2024-10-01', { problems: [prob('migraine')] })]);   // episodic, gap>180 → recurrent
  const s = scoreCase(exp({ problems: [{ concept: 'migraine', count: 1, course: 'recurrent' }] }), buildMemberState(ev, COMPUTED), ev);
  assert.deepEqual(s.problemCourseAgree, [1, 1]);
});

test('incorrectResolutions=1 for a documented_resolved occurrence with no explicit basis', () => {
  const ev = member([enc('e1', '2025-01-01', { problems: [prob('hypertension')] })]);   // NO resolved signal
  const built = buildMemberState(ev, COMPUTED);
  const tampered = JSON.parse(JSON.stringify(built));
  tampered.problems[0].occurrences[0].status = 'documented_resolved';   // inject an unsourced resolution
  const s = scoreCase(exp({ class: 'invariant' }), tampered, ev);
  assert.equal(s.incorrectResolutions, 1);
  assert.ok(s.invariantViolations.some((v) => /incorrect resolution/.test(v)));
});

test('scoreCase is deterministic (twice → deep-equal)', () => {
  const ev = member([enc('e1', '2025-05-01', { problems: [prob('hypertension')] })]);
  const built = buildMemberState(ev, COMPUTED);
  const e = exp({ class: 'invariant', problems: [{ concept: 'hypertension', count: 1, status: 'documented_active' }] });
  assert.deepEqual(scoreCase(e, built, ev), scoreCase(e, built, ev));
});

test('aggregate rolls up the Part-C metric set', () => {
  const ev = member([enc('e1', '2025-05-01', { problems: [prob('hypertension')] })]);
  const s = scoreCase(exp({ problems: [{ concept: 'hypertension', count: 1, course: 'single_episode', status: 'documented_active' }] }), buildMemberState(ev, COMPUTED), ev);
  const agg = aggregate([s]);
  assert.equal(agg.cases, 1);
  assert.equal(agg.sourceEventRetention, 1);
  assert.equal(agg.invariantViolations, 0);
  assert.equal(agg.problemStatusAccuracy, 1);
  assert.equal(agg.problemCourseAccuracy, 1);
});
