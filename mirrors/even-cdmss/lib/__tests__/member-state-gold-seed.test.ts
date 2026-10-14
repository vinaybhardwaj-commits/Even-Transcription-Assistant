import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLD_SEED, MEMBER_BANK_VERSION } from '../member-state/validation/gold-seed';
import { scoreCase, aggregate } from '../member-state/validation/score-core';
import { BASELINE, checkBaseline, MEMBER_STATE_BASELINE } from '../member-state/validation/baseline';
import { buildMemberState } from '../member-state/aggregate-core';

const COMPUTED = '2026-07-01T00:00:00.000Z';
const byId = Object.fromEntries(GOLD_SEED.map((c) => [c.expected.caseId, c]));
const run = (id: string) => { const c = byId[id]; const built = buildMemberState(c.evidence, COMPUTED); return { c, built, score: scoreCase(c.expected, built, c.evidence) }; };

test('gold seed is FROZEN: 20 strata, every case ratified:true, member-bank/1.0', () => {
  assert.equal(GOLD_SEED.length, 20);
  assert.ok(GOLD_SEED.every((c) => c.expected.ratified === true));
  assert.equal(MEMBER_BANK_VERSION, 'member-bank/1.0');
});

test('frozen baseline member-state-baseline/1.0: the seed clears every floor (no breaches)', () => {
  assert.equal(MEMBER_STATE_BASELINE, 'member-state-baseline/1.0');
  const agg = aggregate(GOLD_SEED.map((c) => scoreCase(c.expected, buildMemberState(c.evidence, COMPUTED), c.evidence)));
  assert.deepEqual(checkBaseline(agg), []);   // GATED + FLOORED + HARD all clear
  assert.equal(BASELINE.frozenPins.reconcile, 'member-reconcile/0.3');
});

test('HARD gates hold for EVERY case: retention/provenance/trust 100%, incorrect-resolution 0', () => {
  for (const c of GOLD_SEED) {
    const built = buildMemberState(c.evidence, COMPUTED);
    const s = scoreCase(c.expected, built, c.evidence);
    assert.equal(s.sourceEventRetention, 1, `${c.expected.caseId} source-event retention`);
    assert.equal(s.provenanceRetention, 1, `${c.expected.caseId} provenance retention`);
    assert.equal(s.trustProvenanceRetention, 1, `${c.expected.caseId} trust-provenance retention`);
    assert.equal(s.incorrectResolutions, 0, `${c.expected.caseId} incorrect resolutions`);
  }
});

test('EVERY invariant-class case scores zero invariantViolations against the frozen core', () => {
  for (const c of GOLD_SEED.filter((x) => x.expected.class === 'invariant')) {
    const built = buildMemberState(c.evidence, COMPUTED);
    const s = scoreCase(c.expected, built, c.evidence);
    assert.deepEqual(s.invariantViolations, [], `${c.expected.caseId}: ${s.invariantViolations.join('; ')}`);
  }
});

// ── Per-stratum semantic assertions (the executable spec) ──
test('S3: explicit resolution → documented_resolved', () => assert.equal(run('S3').built.problems.find((p) => p.normalizedConcept.raw === 'N39.0')!.latestDocumentedStatus, 'documented_resolved'));
test('S4: omitted later → uncertain, never resolved', () => assert.equal(run('S4').built.problems.find((p) => p.normalizedConcept.raw === 'I10')!.latestDocumentedStatus, 'uncertain_current_status'));
test('S5: allergy reported dominates denied + safety_critical conflict', () => {
  const { built } = run('S5');
  assert.equal(built.allergies[0].status, 'reported_allergy');
  assert.ok(built.conflicts.some((c) => c.domain === 'allergy' && c.severity === 'safety_critical'));
});
test('S6: prescribed, currentness never inferred to taking', () => assert.equal(run('S6').built.medications[0].status, 'prescribed'));
test('S8: broader/narrower not merged → 2 distinct problems', () => { const { built, score } = run('S8'); assert.equal(built.problems.length, 2); assert.equal(score.falseMerges, 0); });
test('S9: mixed units → unit:null + value_conflict', () => {
  const { built } = run('S9');
  assert.equal(built.investigations[0].unit, null);
  assert.equal(built.investigations[0].series.length, 2);
  assert.ok(built.conflicts.some((c) => c.domain === 'investigation' && c.type === 'value_conflict'));
});
test('S12: two simultaneous → 2 parallel problems', () => assert.equal(run('S12').built.problems.length, 2));
test('S14: "rule out PE" not merged with confirmed PE', () => assert.equal(run('S14').built.problems.length, 2));
test('S15: patient complaint resolved → documented_resolved occurrence (explicit, not silence)', () => assert.equal(run('S15').built.problems.find((p) => p.normalizedConcept.normalizedConceptId === 'local:hypertension')!.latestDocumentedStatus, 'documented_resolved'));
test('S16: patient-reported stopped overrides prescription', () => assert.equal(run('S16').built.medications[0].status, 'stopped'));
test('S17: allergy trust-conflict records BOTH trusts in the Discrepancy detail', () => {
  const { built } = run('S17');
  assert.equal(built.allergies[0].status, 'reported_allergy');
  const c = built.conflicts.find((x) => x.domain === 'allergy' && x.type === 'status_conflict')!;
  const d = c.assertions.map((a) => a.detail).join(' | ');
  assert.match(d, /structured_db/);
  assert.match(d, /patient_reported/);
});
test('S18: followUps carried, deduped by id, no overlay', () => {
  const { built } = run('S18');
  assert.equal(built.followUps.length, 2);                                  // f1 deduped across two encounters
  assert.deepEqual(built.followUps.map((f) => f.id).sort(), ['f1', 'f2']);  // both carried (deterministic, order-robust)
});
test('S20: neutrality — zero patient-reported → empty followUps + 1.0 statuses', () => {
  const { built } = run('S20');
  assert.deepEqual(built.followUps, []);
  assert.equal(built.problems[0].latestDocumentedStatus, 'documented_active');
  assert.equal(built.medications[0].status, 'prescribed');
  assert.equal(built.allergies[0].status, 'reported_allergy');
});

// ── Accuracy dimensions (scored, never gated) ──
test('S1: chronic re-documented across years → persistent (R1 chronicity fix)', () => { const { built, score } = run('S1'); assert.equal(built.problems[0].course, 'persistent'); assert.deepEqual(score.problemCourseAgree, [1, 1]); });
test('S2: episodic present-gap-present → recurrent (unchanged by R1)', () => { const { built, score } = run('S2'); assert.equal(built.problems[0].course, 'recurrent'); assert.deepEqual(score.problemCourseAgree, [1, 1]); });
test('S7: explicit stopped reflected in status', () => assert.equal(run('S7').built.medications[0].status, 'stopped'));

// ── Stratum 19 — RATIFIED (R2): keeps stopped + surfaces a temporal_conflict ──
test('S19: keeps stopped after a re-prescription + one medication/temporal_conflict/review (both trusts)', () => {
  const { built } = run('S19');
  assert.equal(built.medications[0].status, 'stopped');
  const c = built.conflicts.filter((x) => x.domain === 'medication');
  assert.equal(c.length, 1);
  assert.equal(c[0].type, 'temporal_conflict');
  const d = c[0].assertions.map((a) => a.detail).join(' | ');
  assert.match(d, /patient_reported/);
  assert.match(d, /structured_db/);
});

// ── Stratum 13 — evidence immutability + recompute ──
test('S13: evidence is not mutated; a corrected copy recomputes to a different snapshot', () => {
  const c = byId['S13'];
  const before = JSON.parse(JSON.stringify(c.evidence));
  const s1 = buildMemberState(c.evidence, COMPUTED);
  assert.deepEqual(c.evidence, before);   // immutable
  const corrected = JSON.parse(JSON.stringify(c.evidence));
  corrected.encounters.push({ encounterRef: 's13e2', date: '2025-06-01', kind: 'opd', problems: [{ conceptRaw: 'E78.5', icdCode: null, explicitStatus: null, provenance: { sourceField: 'dx', rawText: 'x', extractionMethod: 'reported', confidence: 0.9 } }], medicationAssertions: [], allergyAssertions: [], investigations: [] });
  const s2 = buildMemberState(corrected, COMPUTED);
  assert.notEqual(s1.problems.length, s2.problems.length);
});

test('aggregate over the full seed: retention 1.0, zero invariant violations, zero incorrect resolutions', () => {
  const scores = GOLD_SEED.map((c) => scoreCase(c.expected, buildMemberState(c.evidence, COMPUTED), c.evidence));
  const agg = aggregate(scores);
  assert.equal(agg.sourceEventRetention, 1);
  assert.equal(agg.trustProvenanceRetention, 1);
  assert.equal(agg.incorrectResolutions, 0);
  assert.equal(agg.invariantViolations, 0);
});
