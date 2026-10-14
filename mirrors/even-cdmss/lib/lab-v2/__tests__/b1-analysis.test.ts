/**
 * LAB-MCP-V2 §17.4 — the pure arithmetic behind compare (§9, §17.4 item 5).
 *
 * These are the assertions that make a comparison checkable by someone who did not run it: the
 * denominators add up, and the interval is the same interval on every machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, bootstrapClustered, bootstrapMetric, countDenominators,
  diffSubjects, jaccard, mulberry32, pairCase, type CaseMetrics,
} from '../analysis-core';

test('§17.4: Jaccard is order- and duplicate-insensitive, and empty ∩ empty is 1', () => {
  assert.equal(jaccard(['a', 'b'], ['b', 'a']), 1);
  assert.equal(jaccard(['a', 'a', 'b'], ['b', 'a']), 1);
  assert.equal(jaccard([], []), 1);
  assert.equal(jaccard(['a'], []), 0);
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
});

test('§17.4: the subject diff is sorted, so a diff is stable across runs', () => {
  const d = diffSubjects(['z', 'a'], ['a', 'm']);
  assert.deepEqual(d, { added: ['m'], removed: ['z'], kept: ['a'] });
});

test('§9: attempted = succeeded + failed + cancelled + expired, and `sums` says so', () => {
  const items = [
    { execution_status: 'succeeded', assessment_status: 'assessed', attribution_status: 'verified' },
    { execution_status: 'succeeded', assessment_status: 'unassessable', attribution_status: 'verified' },
    { execution_status: 'succeeded', assessment_status: 'assessed', attribution_status: 'invalid' },
    { execution_status: 'failed', assessment_status: 'not_reached', attribution_status: 'unknown' },
    { execution_status: 'cancelled', assessment_status: 'not_reached', attribution_status: 'unknown' },
    { execution_status: 'expired', assessment_status: 'not_reached', attribution_status: 'unknown' },
  ];
  const d = countDenominators(items);
  assert.equal(d.attempted, 6);
  assert.equal(d.succeeded, 3);
  assert.equal(d.failed, 1);
  assert.equal(d.cancelled, 1);
  assert.equal(d.expired, 1);
  assert.equal(d.sums, true);
  assert.equal(d.attempted, d.succeeded + d.failed + d.cancelled + d.expired);
  // The metric denominator is SMALLER than succeeded: unassessable and attribution-invalid are
  // successful executions that no metric may be divided by.
  assert.equal(d.unassessable, 1);
  assert.equal(d.attribution_invalid, 1);
  assert.equal(d.assessable_verified, 1);
});

test('§9: a `partial` execution makes `sums` false rather than being folded in silently', () => {
  const d = countDenominators([
    { execution_status: 'succeeded', assessment_status: 'assessed', attribution_status: 'verified' },
    { execution_status: 'partial', assessment_status: 'assessed', attribution_status: 'verified' },
  ]);
  assert.equal(d.attempted, 2);
  assert.equal(d.sums, false, 'a bucket nobody counted must be visible, not absorbed');
});

test('§17.4: the seeded RNG is deterministic', () => {
  const a = mulberry32(BOOTSTRAP_SEED);
  const b = mulberry32(BOOTSTRAP_SEED);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [mulberry32(1)(), mulberry32(1)(), mulberry32(1)()]);
});

test('§17.4: the bootstrap is deterministic under the fixed seed, run after run', () => {
  const values = Array.from({ length: 30 }, (_, i) => ({ cluster: `m${i % 6}`, value: (i % 5) - 2 }));
  const a = bootstrapClustered(values);
  const b = bootstrapClustered(values);
  assert.deepEqual(a, b, 'two people comparing the same run must get the same interval');
  assert.equal(a.resamples, BOOTSTRAP_RESAMPLES);
  assert.equal(a.seed, BOOTSTRAP_SEED);
  assert.equal(a.clusters, 6);
  assert.equal(a.n, 30);
  assert.ok(a.lo != null && a.hi != null && a.lo <= a.mean! && a.mean! <= a.hi);
  // The seed is REPORTED, so a reader can reproduce the interval rather than take it on trust.
  // (That a different seed draws a different sequence is asserted directly on the RNG above; on a
  // symmetric fixture two seeds can legitimately land on the same percentile, so asserting the
  // intervals differ would be a brittle claim about this fixture rather than about the seed.)
  assert.equal(bootstrapClustered(values, BOOTSTRAP_RESAMPLES, 1).seed, 1);
});

test('§17.4: the bootstrap clusters on member, not on rows', () => {
  // Twenty rows, two members, perfectly separated: every row of m1 is +10, every row of m2 is −10.
  // Resampling ROWS would give a tight interval around 0; resampling MEMBERS must not, because
  // the evidence is two observations, not twenty.
  const values = [
    ...Array.from({ length: 10 }, () => ({ cluster: 'm1', value: 10 })),
    ...Array.from({ length: 10 }, () => ({ cluster: 'm2', value: -10 })),
  ];
  const out = bootstrapClustered(values);
  assert.equal(out.clusters, 2);
  assert.equal(out.mean, 0);
  // With two clusters the resample can draw m1 twice or m2 twice, so the interval must reach the
  // extremes. A row bootstrap would have collapsed to roughly ±4.
  assert.ok(out.lo! <= -9, `lo was ${out.lo} — a row bootstrap would hide the correlation`);
  assert.ok(out.hi! >= 9, `hi was ${out.hi}`);
});

test('§17.4: one cluster yields a mean but no interval, and says how many clusters there were', () => {
  const out = bootstrapClustered([{ cluster: 'm1', value: 3 }, { cluster: 'm1', value: 5 }]);
  assert.equal(out.mean, 4);
  assert.equal(out.lo, null);
  assert.equal(out.hi, null);
  assert.equal(out.clusters, 1);
});

test('§17.4: a case with no member key is its own cluster, not a shared bucket', () => {
  const mk = (case_key: string, member_key: string | null, nqi: number): CaseMetrics => ({
    case_key, member_key, n_findings: 1, n_low_value: 0, note_quality_index: nqi, band: 'B',
    subjects: ['s'], result_hash: 'h',
  });
  const pairs = [
    pairCase(mk('a', null, 70), mk('a', null, 75)),
    pairCase(mk('b', null, 70), mk('b', null, 65)),
  ];
  const out = bootstrapMetric(pairs, (p) => p.delta_note_quality_index);
  assert.equal(out.clusters, 2, 'two unkeyed cases are two clusters, never one');
  assert.equal(out.n, 2);
});

test('§17.4: a paired case reports deltas, band movement, Jaccard and hash equality', () => {
  const base: CaseMetrics = {
    case_key: 'u1', member_key: 'mk1', n_findings: 3, n_low_value: 2,
    note_quality_index: 70, band: 'C', subjects: ['a', 'b', 'c'], result_hash: 'h1',
  };
  const arm: CaseMetrics = {
    case_key: 'u1', member_key: 'mk1', n_findings: 2, n_low_value: 1,
    note_quality_index: 78, band: 'B', subjects: ['a', 'b', 'd'], result_hash: 'h2',
  };
  const p = pairCase(base, arm);
  assert.equal(p.delta_n_findings, -1);
  assert.equal(p.delta_n_low_value, -1);
  assert.equal(p.delta_note_quality_index, 8);
  assert.equal(p.band_before, 'C');
  assert.equal(p.band_after, 'B');
  assert.equal(p.band_changed, true);
  assert.deepEqual(p.subjects_added, ['d']);
  assert.deepEqual(p.subjects_removed, ['c']);
  assert.equal(p.subject_jaccard, 2 / 4);
  assert.equal(p.result_hash_equal, false);
});

test('§17.4: a missing metric on either side is null, never zero', () => {
  const mk = (nqi: number | null): CaseMetrics => ({
    case_key: 'u', member_key: null, n_findings: null, n_low_value: null,
    note_quality_index: nqi, band: null, subjects: [], result_hash: null,
  });
  const p = pairCase(mk(70), mk(null));
  // A null delta is "we could not measure it"; a zero delta is "it did not move". Conflating them
  // would put an unmeasured case into a mean at 0 and drag it toward no-effect.
  assert.equal(p.delta_note_quality_index, null);
  assert.equal(p.delta_n_findings, null);
  const out = bootstrapMetric([p], (x) => x.delta_note_quality_index);
  assert.equal(out.n, 0, 'and it contributes to no denominator');
});
