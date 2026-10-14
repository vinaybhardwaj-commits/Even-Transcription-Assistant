// lib/__tests__/corpus-eval-verify.test.ts — Brainstem PR 0 verifier core (pure). Covers the
// fail-safe parse (bad output ⇒ not_assessable, never a guessed support), the support-rate
// convention (directly / assessable, not_assessable excluded; Wilson CI), cite-or-label, and the
// coverage-deficit histogram. No model, no db. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerdict, supportStats, wilson, citeOrLabel, deficitHistogram, buildVerifyUser,
  VERIFY_SYSTEM, type SupportVerdict,
} from '../corpus-eval/verify-core';

test('parseVerdict is fail-safe: valid → verdict; junk/empty/invalid → not_assessable, never a guess', () => {
  assert.equal(parseVerdict('{"verdict":"directly_supports","supporting_span":"x","why":"y"}').verdict, 'directly_supports');
  assert.equal(parseVerdict('prose then {"verdict":"contradicts","supporting_span":null,"why":"z"} tail').verdict, 'contradicts');
  assert.equal(parseVerdict('').verdict, 'not_assessable');
  assert.equal(parseVerdict('not json').verdict, 'not_assessable');
  assert.equal(parseVerdict('{"verdict":"maybe"}').verdict, 'not_assessable', 'out-of-enum ⇒ not_assessable');
  assert.equal(parseVerdict(null).verdict, 'not_assessable');
  // never fabricates a support when it cannot parse
  assert.ok(!['directly_supports', 'partially_supports'].includes(parseVerdict('garbage').verdict));
});

test('support rate = directly / assessable; not_assessable excluded from the denominator', () => {
  const v: SupportVerdict[] = [
    'directly_supports', 'directly_supports', 'directly_supports',   // 3 direct
    'partially_supports',                                             // 1 partial
    'not_supported',                                                  // 1 unsupported
    'contradicts',                                                    // 1 contradict
    'not_assessable', 'not_assessable',                              // 2 excluded from denom
  ];
  const s = supportStats(v);
  assert.equal(s.n_total, 8);
  assert.equal(s.n_assessable, 6, 'assessable = 8 − 2 not_assessable');
  assert.equal(s.support_rate, 3 / 6, 'strict: directly (3) / assessable (6)');
  assert.equal(s.support_rate_incl_partial, 4 / 6, 'inclusive: (directly+partial) / assessable');
  assert.equal(s.unsupported_rate, 1 / 6);
  assert.equal(s.contradicts_rate, 1 / 6);
  assert.equal(s.not_assessable_rate, 2 / 8);
  assert.ok(s.support_rate_ci && s.support_rate_ci[0] < 0.5 && s.support_rate_ci[1] > 0.5, 'CI brackets the point');
});

test('Wilson CI: sane bounds, tightens with n, all-supports stays < 1', () => {
  const [lo1, hi1] = wilson(9, 10);
  const [lo2, hi2] = wilson(90, 100);
  assert.ok(lo1 >= 0 && hi1 <= 1 && lo1 < 0.9 && hi1 > 0.9);
  assert.ok(hi2 - lo2 < hi1 - lo1, 'n=100 CI is tighter than n=10');
  const [lo3, hi3] = wilson(10, 10);
  assert.ok(hi3 <= 1 && lo3 < 1 && lo3 > 0.6, 'all-supports: upper bounded at 1, lower < 1');
  assert.deepEqual(wilson(0, 0), [0, 0], 'empty is safe');
});

test('cite-or-label fraction', () => {
  const c = citeOrLabel([{ cited: true }, { cited: true }, { cited: false }, { cited: false }, { cited: false }]);
  assert.equal(c.n_claims, 5); assert.equal(c.cited, 2); assert.equal(c.uncited, 3);
  assert.equal(c.cited_fraction, 2 / 5);
  assert.equal(citeOrLabel([]).cited_fraction, null);
});

test('coverage-deficit histogram: deciles + median/p90, clamped', () => {
  const h = deficitHistogram([0.05, 0.15, 0.15, 0.95, 1.2, -0.3]);   // 1.2→1.0, -0.3→0
  assert.equal(h.n, 6);
  assert.equal(h.bins.length, 10);
  assert.equal(h.bins[0].count, 2, '0.00 and -0.3→0 land in [0,0.1)');
  assert.equal(h.bins[1].count, 2, 'the two 0.15 land in [0.1,0.2)');
  assert.equal(h.bins[9].count, 2, '0.95 and 1.2→1.0 land in [0.9,1.0]');
  assert.ok(h.median != null && h.p90 != null && h.mean != null);
});

test('the verifier prompt is registry-named + judges from excerpts alone (no patient record)', () => {
  assert.ok(/citation-support verifier/i.test(VERIFY_SYSTEM));
  assert.ok(/NO access to the patient record/i.test(VERIFY_SYSTEM), 'no PHI path — excerpts only');
  // the user builder numbers the excerpts and never leaks a prompt/record — claim + excerpts only
  const u = buildVerifyUser('aspirin reduces MI risk', [{ text: 'Aspirin lowers the risk of myocardial infarction.', meta: { book: 'MKSAP', page_start: 5 } }]);
  assert.ok(u.includes('CLAIM:') && u.includes('[1]') && u.includes('MKSAP'));
});
