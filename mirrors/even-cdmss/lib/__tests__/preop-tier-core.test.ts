/**
 *   node --test --import tsx lib/__tests__/preop-tier-core.test.ts
 *
 * Tier rule v0 (PREOP-RISK-AGENT-MOCKUP-v1 §3, the binding spec). Every cell of the
 * band table, both escalation clauses, the AMBER floor in both directions, and the
 * needs-review predicate that also feeds the chooser badge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTier, confirmedSeverity, crossesBoundary, severityForScore, within72h, within7d,
  PREOP_TIER_RULE_VERSION,
} from '../preop-tier-core.ts';
import {
  charlsonCategories, computeCharlson, computeMfi5, computeRcri, type Tri,
} from '../preop-instruments-core.ts';

const rcri = (n: number) => computeRcri({
  highRiskSurgery: n > 0 ? 'present' : 'absent',
  ischaemicHeartDisease: n > 1 ? 'present' : 'absent',
  congestiveHeartFailure: n > 2 ? 'present' : 'absent',
  cerebrovascularDisease: n > 3 ? 'present' : 'absent',
  insulinTreatedDiabetes: n > 4 ? 'present' : 'absent',
  creatinineOver2: n > 5 ? 'present' : 'absent',
});
const mfi = (n: number) => computeMfi5({
  functionalStatusDependent: n > 0 ? 'present' : 'absent',
  diabetesMellitus: n > 1 ? 'present' : 'absent',
  copdOrPneumonia: n > 2 ? 'present' : 'absent',
  congestiveHeartFailure: n > 3 ? 'present' : 'absent',
  hypertensionOnMedication: n > 4 ? 'present' : 'absent',
});
const cci = (age: number, extra: Record<string, Tri> = {}) =>
  computeCharlson({ age, categories: charlsonCategories(extra as never, 'absent') });

const ctx = (over: Partial<{ pacFinalized: boolean; daysToSurgery: number | null; reviewed: boolean }> = {}) =>
  ({ pacFinalized: true, daysToSurgery: 30, reviewed: false, ...over });

test('the band table, every cell (mockup §3)', () => {
  // RCRI — by Lee class, not by raw count
  assert.equal(severityForScore('rcri', 0), 'GREEN');   // Class I
  assert.equal(severityForScore('rcri', 1), 'AMBER');   // Class II
  assert.equal(severityForScore('rcri', 2), 'RED');     // Class III
  assert.equal(severityForScore('rcri', 5), 'RED');     // Class IV
  // mFI-5
  assert.equal(severityForScore('mfi5', 0), 'GREEN');
  assert.equal(severityForScore('mfi5', 1), 'GREEN');
  assert.equal(severityForScore('mfi5', 2), 'AMBER');
  assert.equal(severityForScore('mfi5', 3), 'RED');
  // Charlson
  assert.equal(severityForScore('charlson', 0), 'GREEN');
  assert.equal(severityForScore('charlson', 2), 'GREEN');
  assert.equal(severityForScore('charlson', 3), 'AMBER');
  assert.equal(severityForScore('charlson', 4), 'AMBER');
  assert.equal(severityForScore('charlson', 5), 'RED');
});

test('composite = max severity across the three instruments', () => {
  const t = computeTier({ rcri: rcri(0), mfi5: mfi(2), charlson: cci(40), context: ctx() });
  assert.equal(t.tier, 'AMBER');          // mFI-5 2 is the highest band present
  assert.equal(t.dominant, 'mfi5');
  assert.equal(t.ruleVersion, PREOP_TIER_RULE_VERSION);
});

test('a range scores at its CONFIRMED lower bound', () => {
  const r = computeRcri({
    highRiskSurgery: 'absent', ischaemicHeartDisease: 'absent', congestiveHeartFailure: 'absent',
    cerebrovascularDisease: 'unknown', insulinTreatedDiabetes: 'unknown', creatinineOver2: 'unknown',
  });
  assert.deepEqual([r.lo, r.hi], [0, 3]);
  assert.equal(confirmedSeverity(r), 'GREEN');       // scored at 0, not at 3
  assert.equal(crossesBoundary(r), true);
});

test('missing data alone never mints RED — the floor is AMBER, and only AMBER', () => {
  // Upper bound would be Class IV (RED). The tier floors at AMBER and stops there.
  const r = computeRcri({
    highRiskSurgery: 'unknown', ischaemicHeartDisease: 'unknown', congestiveHeartFailure: 'unknown',
    cerebrovascularDisease: 'absent', insulinTreatedDiabetes: 'absent', creatinineOver2: 'absent',
  });
  const t = computeTier({ rcri: r, mfi5: mfi(0), charlson: cci(30), context: ctx() });
  assert.deepEqual([r.lo, r.hi], [0, 3]);
  assert.equal(t.tier, 'AMBER');
  assert.equal(t.amberFloorApplied, true);
  assert.equal(t.redCount, 0);
  assert.deepEqual(t.escalations, []);
});

test('a boundary-crossing range can never render GREEN either', () => {
  const m = computeMfi5({
    functionalStatusDependent: 'unknown', diabetesMellitus: 'absent', copdOrPneumonia: 'absent',
    congestiveHeartFailure: 'absent', hypertensionOnMedication: 'present',
  });
  assert.deepEqual([m.lo, m.hi], [1, 2]);            // GREEN -> AMBER
  const t = computeTier({ rcri: rcri(0), mfi5: m, charlson: cci(30), context: ctx() });
  assert.equal(t.tier, 'AMBER');
  assert.equal(t.unconfirmed, true);
});

test('a range whose bounds share a band is NOT unconfirmed and floors nothing', () => {
  const m = computeMfi5({
    functionalStatusDependent: 'unknown', diabetesMellitus: 'present', copdOrPneumonia: 'present',
    congestiveHeartFailure: 'absent', hypertensionOnMedication: 'present',
  });
  assert.deepEqual([m.lo, m.hi], [3, 4]);            // RED -> RED
  assert.equal(crossesBoundary(m), false);
  const t = computeTier({ rcri: rcri(0), mfi5: m, charlson: cci(30), context: ctx() });
  assert.equal(t.unconfirmed, false);
  assert.equal(t.amberFloorApplied, false);
  assert.equal(t.tier, 'RED');
});

test('CRITICAL clause 1 — RED on two instruments', () => {
  const t = computeTier({ rcri: rcri(2), mfi5: mfi(3), charlson: cci(30), context: ctx() });
  assert.equal(t.redCount, 2);
  assert.deepEqual(t.escalations, ['red_on_two_instruments']);
  assert.equal(t.tier, 'CRITICAL');
});

test('CRITICAL clause 2 — a single RED with no finalized PAC inside 72 h', () => {
  const inside = computeTier({ rcri: rcri(2), mfi5: mfi(0), charlson: cci(30), context: ctx({ pacFinalized: false, daysToSurgery: 3 }) });
  assert.deepEqual(inside.escalations, ['red_without_finalized_pac_72h']);
  assert.equal(inside.tier, 'CRITICAL');

  // ...but a finalized PAC disarms it, and so does distance from the knife.
  const withPac = computeTier({ rcri: rcri(2), mfi5: mfi(0), charlson: cci(30), context: ctx({ pacFinalized: true, daysToSurgery: 3 }) });
  assert.equal(withPac.tier, 'RED');
  const farOff = computeTier({ rcri: rcri(2), mfi5: mfi(0), charlson: cci(30), context: ctx({ pacFinalized: false, daysToSurgery: 4 }) });
  assert.equal(farOff.tier, 'RED');
});

test('the 72 h clause never fires on an AMBER case, however thin', () => {
  const t = computeTier({ rcri: rcri(1), mfi5: mfi(0), charlson: cci(30), context: ctx({ pacFinalized: false, daysToSurgery: 0 }) });
  assert.equal(t.tier, 'AMBER');
  assert.deepEqual(t.escalations, []);
});

test('needs review = unreviewed RED/CRITICAL with surgery within 7 days', () => {
  const base = { rcri: rcri(2), mfi5: mfi(0), charlson: cci(30) };
  assert.equal(computeTier({ ...base, context: ctx({ daysToSurgery: 7 }) }).needsReview, true);
  assert.equal(computeTier({ ...base, context: ctx({ daysToSurgery: 8 }) }).needsReview, false);
  assert.equal(computeTier({ ...base, context: ctx({ daysToSurgery: 7, reviewed: true }) }).needsReview, false);
  assert.equal(computeTier({ ...base, context: ctx({ daysToSurgery: null }) }).needsReview, false);
  // AMBER never enters the band, however close the surgery is.
  assert.equal(computeTier({ rcri: rcri(1), mfi5: mfi(0), charlson: cci(30), context: ctx({ daysToSurgery: 0 }) }).needsReview, false);
});

test('the two windows, at their edges', () => {
  assert.equal(within72h(3), true);
  assert.equal(within72h(4), false);
  assert.equal(within72h(0), true);
  assert.equal(within72h(-1), false);      // the surgery already happened
  assert.equal(within72h(null), false);
  assert.equal(within7d(7), true);
  assert.equal(within7d(8), false);
});

test('an all-unknown episode is AMBER, never GREEN — a blank patient is a finding', () => {
  const u: Tri = 'unknown';
  const r = computeRcri({
    highRiskSurgery: u, ischaemicHeartDisease: u, congestiveHeartFailure: u,
    cerebrovascularDisease: u, insulinTreatedDiabetes: u, creatinineOver2: u,
  });
  const m = computeMfi5({
    functionalStatusDependent: u, diabetesMellitus: u, copdOrPneumonia: u,
    congestiveHeartFailure: u, hypertensionOnMedication: u,
  });
  const c = computeCharlson({ age: null, categories: charlsonCategories({}, 'unknown') });
  assert.equal(r.kind, 'not_computable');
  assert.equal(m.kind, 'not_computable');
  assert.equal(c.kind, 'not_computable');
  const t = computeTier({ rcri: r, mfi5: m, charlson: c, context: ctx() });
  assert.equal(t.tier, 'AMBER');
  assert.equal(t.dominant, null);
  assert.equal(t.redCount, 0);
});

test('the dominant instrument breaks ties in board order (RCRI first)', () => {
  const t = computeTier({ rcri: rcri(2), mfi5: mfi(3), charlson: cci(90, { any_tumour: 'present' }), context: ctx() });
  assert.equal(t.dominant, 'rcri');
  const t2 = computeTier({ rcri: rcri(0), mfi5: mfi(3), charlson: cci(90, { any_tumour: 'present' }), context: ctx() });
  assert.equal(t2.dominant, 'mfi5');
});
