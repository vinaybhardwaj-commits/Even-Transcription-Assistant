/**
 *   node --test --import tsx lib/__tests__/preop-instruments-core.test.ts
 *
 * The three instruments as pure arithmetic (PRD §3, §8). The published numbers, the
 * tri-state fold, Charlson's mutual exclusions, the not-computable floor, and the text
 * the board prints off a computed result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  charlsonAgeBandLabel, charlsonAgePoints, charlsonBurdenLabel, charlsonCategories,
  charlsonScoreText, computeCharlson, computeMfi5, computeRcri, frailtyLabel,
  mfi5ScoreText, PREOP_INSTRUMENTS_VERSION, rcriClass, rcriClassText, rcriScoreText,
  riskPctText, type Tri,
} from '../preop-instruments-core.ts';

const ABSENT6 = {
  highRiskSurgery: 'absent', ischaemicHeartDisease: 'absent', congestiveHeartFailure: 'absent',
  cerebrovascularDisease: 'absent', insulinTreatedDiabetes: 'absent', creatinineOver2: 'absent',
} as const;

test('version constant', () => {
  assert.equal(PREOP_INSTRUMENTS_VERSION, 'preop-instruments/1');
});

test("RCRI — Lee's published classes and risks", () => {
  assert.deepEqual(rcriClass(0), { klass: 'I', riskPct: 0.4 });
  assert.deepEqual(rcriClass(1), { klass: 'II', riskPct: 0.9 });
  assert.deepEqual(rcriClass(2), { klass: 'III', riskPct: 6.6 });
  assert.deepEqual(rcriClass(3), { klass: 'IV', riskPct: 11 });
  assert.deepEqual(rcriClass(6), { klass: 'IV', riskPct: 11 });
});

test('RCRI — six factors, one point each, no weighting', () => {
  const all = computeRcri({
    highRiskSurgery: 'present', ischaemicHeartDisease: 'present', congestiveHeartFailure: 'present',
    cerebrovascularDisease: 'present', insulinTreatedDiabetes: 'present', creatinineOver2: 'present',
  });
  assert.equal(all.lo, 6);
  assert.equal(all.kind, 'point');
  assert.equal(all.factors.length, 6);
  assert.equal(computeRcri(ABSENT6).lo, 0);
});

test('an unknown input widens to a range and names itself in the missing list', () => {
  const r = computeRcri({ ...ABSENT6, creatinineOver2: 'unknown' });
  assert.equal(r.kind, 'range');
  assert.deepEqual([r.lo, r.hi], [0, 1]);
  assert.deepEqual(r.missing, ['creatinine_over_2']);
  // The lower bound is the CONFIRMED bound: an unknown contributes 0 to it, never a guess.
  assert.equal(r.factors.find((f) => f.id === 'creatinine_over_2')?.points, 0);
  assert.equal(r.factors.find((f) => f.id === 'creatinine_over_2')?.maxPoints, 1);
});

test('every input unknown is NOT-COMPUTABLE, never a range from zero', () => {
  const u: Tri = 'unknown';
  const r = computeRcri({
    highRiskSurgery: u, ischaemicHeartDisease: u, congestiveHeartFailure: u,
    cerebrovascularDisease: u, insulinTreatedDiabetes: u, creatinineOver2: u,
  });
  assert.equal(r.kind, 'not_computable');
  assert.equal(r.lo, null);
  assert.equal(r.hi, null);
  assert.equal(r.missing.length, 6);
});

test('mFI-5 — five items, one point each', () => {
  const m = computeMfi5({
    functionalStatusDependent: 'present', diabetesMellitus: 'present', copdOrPneumonia: 'present',
    congestiveHeartFailure: 'present', hypertensionOnMedication: 'present',
  });
  assert.equal(m.lo, 5);
  assert.equal(m.factors.length, 5);
  // INDEPENDENT functional status scores 0 — the item is "dependent", not "status known".
  const indep = computeMfi5({
    functionalStatusDependent: 'absent', diabetesMellitus: 'absent', copdOrPneumonia: 'absent',
    congestiveHeartFailure: 'absent', hypertensionOnMedication: 'absent',
  });
  assert.equal(indep.lo, 0);
});

test('Charlson — the published age adjustment', () => {
  assert.equal(charlsonAgePoints(49), 0);
  assert.equal(charlsonAgePoints(50), 1);
  assert.equal(charlsonAgePoints(59), 1);
  assert.equal(charlsonAgePoints(60), 2);
  assert.equal(charlsonAgePoints(70), 3);
  assert.equal(charlsonAgePoints(80), 4);
  assert.equal(charlsonAgePoints(97), 4);
  assert.equal(charlsonAgeBandLabel(61), 'Age band 60–69');
});

test('Charlson — the published weights', () => {
  const one = computeCharlson({ age: 30, categories: charlsonCategories({ dementia: 'present' }) });
  assert.equal(one.lo, 1);
  const two = computeCharlson({ age: 30, categories: charlsonCategories({ hemiplegia: 'present' }) });
  assert.equal(two.lo, 2);
  const three = computeCharlson({ age: 30, categories: charlsonCategories({ moderate_severe_liver_disease: 'present' }) });
  assert.equal(three.lo, 3);
  const six = computeCharlson({ age: 30, categories: charlsonCategories({ aids: 'present' }) });
  assert.equal(six.lo, 6);
});

test('Charlson — the severe member of a pair REPLACES the mild one, at both bounds', () => {
  // Diabetes with end-organ damage (2) does not stack on diabetes uncomplicated (1).
  const both = computeCharlson({
    age: 30, categories: charlsonCategories({ diabetes_end_organ_damage: 'present', diabetes_uncomplicated: 'present' }),
  });
  assert.equal(both.lo, 2);
  // ...and an UNKNOWN mild twin cannot inflate the upper bound either.
  const unknownMild = computeCharlson({
    age: 30, categories: charlsonCategories({ diabetes_end_organ_damage: 'present', diabetes_uncomplicated: 'unknown' }),
  });
  assert.equal(unknownMild.lo, 2);
  assert.equal(unknownMild.hi, 2);
  assert.equal(unknownMild.kind, 'point');
  const mets = computeCharlson({
    age: 30, categories: charlsonCategories({ metastatic_solid_tumour: 'present', any_tumour: 'present' }),
  });
  assert.equal(mets.lo, 6);
});

test('Charlson — an unknown age joins the missing list and is worth at most the top band', () => {
  const c = computeCharlson({ age: null, categories: charlsonCategories({}) });
  assert.equal(c.kind, 'range');
  assert.deepEqual([c.lo, c.hi], [0, 4]);
  assert.deepEqual(c.missing, ['age']);
});

test('the text the board prints', () => {
  assert.equal(riskPctText(0.4), '0.4%');
  assert.equal(riskPctText(11), '11%');
  const point = computeRcri({ ...ABSENT6, ischaemicHeartDisease: 'present', insulinTreatedDiabetes: 'present' });
  assert.equal(rcriScoreText(point), '2');
  assert.equal(rcriClassText(point), 'Class III · 6.6%');
  const crossing = computeRcri({ ...ABSENT6, ischaemicHeartDisease: 'present', creatinineOver2: 'unknown' });
  assert.equal(rcriScoreText(crossing), '1–2');
  assert.equal(rcriClassText(crossing), 'Class II–III · 0.9–6.6%');
  // A range whose bounds share a Lee class prints the confirmed bound: the count is
  // uncertain, the answer is not.
  const sameClass = computeRcri({
    highRiskSurgery: 'present', ischaemicHeartDisease: 'present', congestiveHeartFailure: 'present',
    cerebrovascularDisease: 'absent', insulinTreatedDiabetes: 'absent', creatinineOver2: 'unknown',
  });
  assert.equal(rcriScoreText(sameClass), '3');
  assert.equal(rcriClassText(sameClass), 'Class IV · 11%');

  assert.equal(mfi5ScoreText(computeMfi5({
    functionalStatusDependent: 'unknown', diabetesMellitus: 'present', copdOrPneumonia: 'present',
    congestiveHeartFailure: 'absent', hypertensionOnMedication: 'present',
  })), '3–4/5');
  assert.equal(charlsonScoreText(computeCharlson({ age: 61, categories: charlsonCategories({ myocardial_infarction: 'present', diabetes_uncomplicated: 'present' }) })), '4');

  assert.equal(frailtyLabel(0), 'not frail');
  assert.equal(frailtyLabel(2), 'intermediate frailty');
  assert.equal(frailtyLabel(3), 'frail');
  assert.equal(charlsonBurdenLabel(2), 'low burden');
  assert.equal(charlsonBurdenLabel(4), 'moderate burden');
  assert.equal(charlsonBurdenLabel(5), 'high burden');
});

test('charlsonCategories makes the closed-world decision EXPLICIT at the call site', () => {
  const closed = charlsonCategories({ dementia: 'present' }, 'absent');
  assert.equal(closed.aids, 'absent');
  const open = charlsonCategories({ dementia: 'present' }, 'unknown');
  assert.equal(open.aids, 'unknown');
  assert.equal(open.dementia, 'present');
});
