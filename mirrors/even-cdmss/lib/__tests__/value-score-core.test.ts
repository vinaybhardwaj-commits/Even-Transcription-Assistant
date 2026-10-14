/**
 * Pure-core tests for lib/value-score-core.ts.
 * Run: node --experimental-strip-types --test lib/__tests__/value-score-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeScorecard, findingPenalty, bandFor, DEFAULT_WEIGHTS,
  type ScoreInput,
} from '../value-score-core.ts';

test('bandFor thresholds', () => {
  assert.equal(bandFor(92), 'A');
  assert.equal(bandFor(85), 'A');
  assert.equal(bandFor(70), 'B');
  assert.equal(bandFor(55), 'C');
  assert.equal(bandFor(40), 'D');
  assert.equal(bandFor(39), 'E');
});

test('findingPenalty scales with verdict severity and confidence', () => {
  assert.equal(findingPenalty({ verdict: 'low-value', confidence: 1 }), 45);
  assert.equal(findingPenalty({ verdict: 'context-dependent', confidence: 1 }), 22.5);
  assert.equal(findingPenalty({ verdict: 'high-value', confidence: 1 }), 0);
  assert.equal(findingPenalty({ verdict: 'low-value', confidence: 0.5 }), 22.5);
});

test('a clean, complete episode scores high (band A)', () => {
  const input: ScoreInput = {
    findings: [],                       // nothing low-value
    completenessCoverage: 1,            // fully documented
    patientCentred: { present: 5, total: 5 },
  };
  const sc = computeScorecard(input);
  assert.equal(sc.domains.find((d) => d.domain === 'appropriateness')!.score, 100);
  assert.equal(sc.domains.find((d) => d.domain === 'documentation')!.score, 100);
  assert.equal(sc.domains.find((d) => d.domain === 'cost')!.score, 100);
  assert.equal(sc.headline, 100);
  assert.equal(sc.band, 'A');
  assert.equal(sc.confidence, 'low');   // no findings = little signal
  assert.equal(sc.lowValueSpend, null);
});

test('domains route by tag; cost driven by low-value tariff spend; untagged → appropriateness', () => {
  const input: ScoreInput = {
    findings: [
      { verdict: 'low-value', confidence: 1, domain: 'efficiency', tariff: 25_000 },     // over-stay, ₹25k
      { verdict: 'low-value', confidence: 0.9, domain: 'safety' },                        // abx duration
      { verdict: 'low-value', confidence: 1 },                                            // untagged → appropriateness
      { verdict: 'high-value', confidence: 1, domain: 'appropriateness' },                // no penalty
    ],
    completenessCoverage: 0.78,
    patientCentred: { present: 4, total: 5 },
    adminFacts: { lengthOfStayDays: 8, admissionType: 'elective', careSetting: 'room' },
    costCap: 50_000,
  };
  const sc = computeScorecard(input);
  const by = (d: string) => sc.domains.find((x) => x.domain === d)!;
  // efficiency: one full low-value (−45) → 55
  assert.equal(by('efficiency').score, 55);
  // safety: −45*0.9 = −40.5 → 59.5 → round in headline only; domain score clamped/rounded? domain keeps raw clamp
  assert.equal(Math.round(by('safety').score), 60);
  // appropriateness: untagged low-value (−45) + high-value (0) → 55
  assert.equal(by('appropriateness').score, 55);
  // documentation = 78
  assert.equal(by('documentation').score, 78);
  // patient-centred = 80
  assert.equal(by('patient_centred').score, 80);
  // cost: ₹25,000 of ₹50,000 cap → 50
  assert.equal(by('cost').score, 50);
  assert.equal(sc.lowValueSpend, 25_000);
  assert.equal(sc.confidence, 'high');   // 4 findings
  // headline is the weighted mean, lands mid-band
  assert.ok(sc.headline > 40 && sc.headline < 85);
});

test('estimated bed-day cost dents the cost domain even with no tariffed spend', () => {
  const sc = computeScorecard({
    findings: [{ verdict: 'low-value', confidence: 1, domain: 'efficiency' }],  // over-stay, no tariff
    completenessCoverage: 0.78,
    patientCentred: { present: 2.5, total: 4 },
    adminFacts: { lengthOfStayDays: 8, admissionType: 'elective', careSetting: 'single room' },
    bedDayCost: 45_500,
    bedDayDetail: '7 excess bed-days × ₹6,500 single room (est.)',
    // default cap 100_000
  });
  const cost = sc.domains.find((d) => d.domain === 'cost')!;
  assert.equal(cost.score, 55);                 // 100 − 45.5 → 55
  assert.equal(sc.excessBedDayCost, 45_500);
  assert.equal(sc.lowValueSpend, null);         // no tariff-cited spend
  assert.match(cost.basis, /est\. bed-days|excess bed-days/);
});

test('weights are configurable and normalised', () => {
  const base: ScoreInput = {
    findings: [{ verdict: 'low-value', confidence: 1, domain: 'appropriateness' }],
    completenessCoverage: 1,
    patientCentred: { present: 5, total: 5 },
  };
  // Heavily weight appropriateness → headline pulled toward its (low) score.
  const heavy = computeScorecard({ ...base, weights: { appropriateness: 0.9 } });
  const balanced = computeScorecard(base);
  assert.ok(heavy.headline < balanced.headline);
});
