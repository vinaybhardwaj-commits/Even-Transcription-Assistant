/**
 * LAB-MCP-V2 §17.7 round C3 fix 1 — decision 98, `rank_correlation` back inside [−1, 1].
 *
 * ⚠️ WHAT WAS WRONG, AND WHY IT MATTERED MORE THAN A BOUND. `rankCorrelation` took each id's
 * position in the FULL top-k list (0..k−1) while `n` was the count of SHARED ids, so the two
 * rankings were not permutations of the same 1..n and `1 − 6Σd²/(n(n²−1))` lost its bound.
 * Production returned −3.35, −1.75 and −0.971 (mean −2.02) on three prose queries at k = 10.
 *
 * A reader takes −2.02 as "strongly anticorrelated": the two retrieval configurations rank things
 * in opposite orders. The true values for those same three queries are 0, 0.4 and 0.429 — mildly
 * POSITIVE. **The sign was wrong, not merely the scale**, so the fault could have retired a
 * retrieval change that was in fact agreeing with its baseline. That is why the first test below
 * reproduces the exact production numbers rather than testing the bound abstractly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCorrelation } from '../tools/retrieval-compare';

/** The formula as it was, kept here ONLY to prove the fixtures reproduce production. */
function rankCorrelationBeforeDecision98(a: number[], b: number[]): number | null {
  const rankB = new Map(b.map((id, i) => [id, i]));
  const shared = a.map((id, i) => ({ ra: i, rb: rankB.get(id) }))
    .filter((x): x is { ra: number; rb: number } => x.rb != null);
  const n = shared.length;
  if (n < 3) return null;
  let d2 = 0;
  for (const s of shared) d2 += (s.ra - s.rb) ** 2;
  return Math.round((1 - (6 * d2) / (n * (n * n - 1))) * 1000) / 1000;
}

const A = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * Three fixture pairs that reproduce the three production values EXACTLY under the old formula.
 * `a` is the same ten ids in order on all three; only `b` differs, as it would across queries.
 */
const PRODUCTION = [
  { name: 'query 1', a: A, b: [3, 14, 8, 4, 12, 11, 19, 1, 6, 16], before: -3.35, after: 0 },
  { name: 'query 2', a: A, b: [18, 2, 11, 3, 20, 15, 5, 1, 10, 19], before: -1.75, after: 0.4 },
  { name: 'query 3', a: A, b: [4, 2, 8, 16, 10, 3, 17, 9, 15, 14], before: -0.971, after: 0.429 },
];

test('§17.7 decision 98: the three production values are reproduced, and the fixed ones are in bounds', () => {
  for (const q of PRODUCTION) {
    assert.equal(rankCorrelationBeforeDecision98(q.a, q.b), q.before,
      `${q.name} must reproduce what production returned, or this test is about something else`);
    assert.equal(rankCorrelation(q.a, q.b), q.after, `${q.name} after decision 98`);
    assert.ok(q.after >= -1 && q.after <= 1, `${q.name} is inside [-1, 1]`);
  }
  // The mean production reported, and the mean it should have reported. ⚠️ THE SIGN CHANGES.
  const mean = (xs: number[]) => Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100;
  assert.equal(mean(PRODUCTION.map((q) => q.before)), -2.02, 'the mean production reported');
  assert.equal(mean(PRODUCTION.map((q) => q.after)), 0.28, 'and the mean it should have: mildly POSITIVE');

  /**
   * THE HAND COMPUTATION, query 1, shown rather than asserted against another implementation.
   *
   *   a = [1,2,3,4,5,6,7,8,9,10]      b = [3,14,8,4,12,11,19,1,6,16]
   *   shared, in a's order            = 1, 3, 4, 6, 8            → n = 5
   *   position in b                   = 7, 0, 3, 8, 2
   *
   *   BEFORE — ranks are positions in the FULL lists, so they are not a permutation of 1..5:
   *     d = (0−7), (2−0), (3−3), (5−8), (7−2)      →  d² = 49 + 4 + 0 + 9 + 25 = 87
   *     ρ = 1 − 6·87 / (5·24) = 1 − 522/120 = 1 − 4.35 = −3.35        ← out of bounds
   *
   *   AFTER — rank the shared ids among themselves, 0..4, by a's order and by b's order:
   *     rank in a : 1→0, 3→1, 4→2, 6→3, 8→4
   *     b order   : 3(0), 8(2), 4(3), 1(7), 6(8)
   *     rank in b : 3→0, 8→1, 4→2, 1→3, 6→4
   *     d = (1: 0−3), (3: 1−0), (4: 2−2), (6: 3−4), (8: 4−1)  →  d² = 9 + 1 + 0 + 1 + 9 = 20
   *     ρ = 1 − 6·20 / (5·24) = 1 − 120/120 = 0                       ← in bounds
   */
  const rho3 = (d2: number, n: number) => Math.round((1 - (6 * d2) / (n * (n * n - 1))) * 1000) / 1000;
  assert.equal(rho3(87, 5), -3.35, 'the hand computation of the OLD value');
  assert.equal(rho3(20, 5), 0, 'and of the new one');

  /**
   * Query 3, the one whose n differs — n = 6, so the denominator is 6·35 = 210.
   *   shared in a's order = 2, 3, 4, 8, 9, 10   ·   position in b = 1, 5, 0, 2, 7, 4
   *   BEFORE: d² = 0 + 9 + 9 + 25 + 1 + 25 = 69   ρ = 1 − 414/210 = −0.9714… → −0.971
   *   AFTER : rank in a  2→0, 3→1, 4→2, 8→3, 9→4, 10→5
   *           b order    4(0), 2(1), 8(2), 10(4), 3(5), 9(7)
   *           rank in b  4→0, 2→1, 8→2, 10→3, 3→4, 9→5
   *           d² = 1 + 9 + 4 + 1 + 1 + 4 = 20     ρ = 1 − 120/210 = 0.4285… → 0.429
   */
  assert.equal(rho3(69, 6), -0.971);
  assert.equal(rho3(20, 6), 0.429);
});

test('§17.7 decision 98: identical order is 1, exactly reversed SHARED order is −1', () => {
  assert.equal(rankCorrelation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), 1);
  assert.equal(rankCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  // ⚠️ AND THE POINT OF "SHARED": the two lists need not be equal for either extreme. Here only
  // 1, 4, 7 are in both; b holds them in the opposite order, surrounded by ids a never returned.
  assert.equal(rankCorrelation([1, 2, 3, 4, 5, 6, 7], [99, 7, 98, 4, 97, 1, 96]), -1,
    'reversed on what they share, whatever else each list carries');
  assert.equal(rankCorrelation([1, 2, 3, 4, 5, 6, 7], [99, 1, 98, 4, 97, 7, 96]), 1,
    'and in agreement on what they share, at positions that are nowhere near each other');
  // ⚠️ THE WHOLE FAULT IN TWO LINES. On the same two pairs the old formula reported −11.5 for the
  // reversed one — nowhere near −1 — and 0.5 for the agreeing one, understating perfect agreement
  // because it was measuring the gap between positions in two lists of seven rather than the gap
  // between three ranks.
  assert.equal(rankCorrelationBeforeDecision98([1, 2, 3, 4, 5, 6, 7], [99, 7, 98, 4, 97, 1, 96]), -11.5);
  assert.equal(rankCorrelationBeforeDecision98([1, 2, 3, 4, 5, 6, 7], [99, 1, 98, 4, 97, 7, 96]), 0.5);

  // Unchanged by this fix: under three shared ids there is no correlation to report.
  assert.equal(rankCorrelation([1, 2], [1, 2]), null);
  assert.equal(rankCorrelation([1, 2, 3], [9, 8, 7]), null, 'nothing shared, nothing to correlate');
});

test('§17.7 decision 98: over 200 random pairs, every result is null or inside [−1, 1]', () => {
  // A seeded LCG, so a failure is reproducible rather than a story about a run that once failed.
  let state = 20260906;
  const rnd = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sample = (poolSize: number, take: number): number[] => {
    const pool = [...Array(poolSize).keys()].map((i) => i + 1);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, take);
  };

  let nulls = 0;
  let extremes = 0;
  let wouldHaveBrokenBefore = 0;
  for (let trial = 0; trial < 200; trial += 1) {
    // Varying k and pool overlap, so the sample covers "almost disjoint" and "almost identical".
    const k = 3 + Math.floor(rnd() * 12);
    const pool = k + Math.floor(rnd() * 20);
    const a = sample(pool, k);
    const b = sample(pool, k);
    const rho = rankCorrelation(a, b);
    if (rho === null) { nulls += 1; continue; }
    assert.ok(rho >= -1 && rho <= 1,
      `rho ${rho} is outside [-1, 1] for a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    assert.equal(rho, Math.round(rho * 1000) / 1000, 'and is rounded to three decimals');
    if (rho === 1 || rho === -1) extremes += 1;
    const before = rankCorrelationBeforeDecision98(a, b);
    if (before !== null && (before < -1 || before > 1)) wouldHaveBrokenBefore += 1;
  }
  // The sample has to actually exercise the thing: a property test that never produced a
  // correlation would pass while proving nothing.
  assert.ok(nulls < 200, 'some pairs shared at least three ids');
  assert.ok(extremes >= 0);
  // ⚠️ AND THE SAME SAMPLE BREAKS THE OLD FORMULA, so this test would have FAILED before the fix.
  assert.ok(wouldHaveBrokenBefore > 0,
    'the sample must contain pairs the pre-98 formula put out of bounds, or it does not test the fix');
});
