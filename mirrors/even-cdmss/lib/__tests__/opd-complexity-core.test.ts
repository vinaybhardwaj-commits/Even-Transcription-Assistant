/**
 * Pure-core tests for lib/opd-complexity-core.ts (RIGHT-CARE-INDICATOR-PRD §3 / §9).
 * Run: node --experimental-strip-types --test lib/__tests__/opd-complexity-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowStart, chronicPoints, labPoints, utilPoints, complexityPoints, bandFor, buildComplexity,
  countDistinctChronicIcds, countAbnormalLabs, scalarCount, ABNORMAL_LAB_THRESHOLD, UTIL_ENC_THRESHOLD,
} from '../opd-complexity-core.ts';

test('chronicPoints tiers: 0 | 1–2 | 3+ → 0 | 1 | 2', () => {
  assert.equal(chronicPoints(0), 0);
  assert.equal(chronicPoints(1), 1);
  assert.equal(chronicPoints(2), 1);
  assert.equal(chronicPoints(3), 2);
  assert.equal(chronicPoints(7), 2);
});

test('lab/util points fire at their thresholds (3 abnormal / 4 encounters)', () => {
  assert.equal(ABNORMAL_LAB_THRESHOLD, 3);
  assert.equal(UTIL_ENC_THRESHOLD, 4);
  assert.equal(labPoints(2), 0); assert.equal(labPoints(3), 1); assert.equal(labPoints(9), 1);
  assert.equal(utilPoints(3), 0); assert.equal(utilPoints(4), 1); assert.equal(utilPoints(10), 1);
});

test('bandFor: full point table (LOW/MODERATE/HIGH boundaries)', () => {
  const b = (chronic: number, labs: number, enc12: number, enc24: number) =>
    bandFor({ chronic_codes: chronic, abnormal_labs: labs, enc_12m: enc12, enc_24m: enc24 });
  // points 0 → LOW  (has 24m history so not new)
  assert.equal(b(0, 0, 0, 1), 'LOW');
  // points 1 → MODERATE
  assert.equal(b(1, 0, 0, 2), 'MODERATE');
  // points 2 → MODERATE (chronic 1 + lab 1)
  assert.equal(b(1, 3, 0, 2), 'MODERATE');
  // points 2 → MODERATE (chronic 3+ alone = 2)
  assert.equal(b(3, 0, 0, 2), 'MODERATE');
  // points 3 → HIGH (2 + 1)
  assert.equal(b(3, 3, 0, 5), 'HIGH');
  // points 4 → HIGH (2 + 1 + 1)
  assert.equal(b(3, 3, 4, 6), 'HIGH');
});

test('NEW_TO_US precedence: zero encounters in prior 24m overrides the point band', () => {
  assert.equal(bandFor({ chronic_codes: 5, abnormal_labs: 9, enc_12m: 9, enc_24m: 0 }), 'NEW_TO_US');
  assert.equal(bandFor({ chronic_codes: 0, abnormal_labs: 0, enc_12m: 0, enc_24m: 0 }), 'NEW_TO_US');
  // one 24m encounter → no longer new, falls to the point band (here LOW)
  assert.equal(bandFor({ chronic_codes: 0, abnormal_labs: 0, enc_12m: 0, enc_24m: 1 }), 'LOW');
});

test('complexityPoints sums the three legs', () => {
  assert.equal(complexityPoints({ chronic_codes: 3, abnormal_labs: 3, enc_12m: 4 }), 4);
  assert.equal(complexityPoints({ chronic_codes: 0, abnormal_labs: 0, enc_12m: 0 }), 0);
});

test('buildComplexity returns band + echoes inputs', () => {
  const out = buildComplexity({ chronic_codes: 3, abnormal_labs: 3, enc_12m: 4, enc_24m: 6, as_of: '2026-07-08' });
  assert.equal(out.band, 'HIGH');
  assert.equal(out.inputs.chronic_codes, 3);
  assert.equal(out.inputs.as_of, '2026-07-08');
});

test('windowStart: 12m / 24m before the index date (UTC month math)', () => {
  assert.equal(windowStart('2026-07-08T10:00:00.000Z', 12).slice(0, 10), '2025-07-08');
  assert.equal(windowStart('2026-07-08T10:00:00.000Z', 24).slice(0, 10), '2024-07-08');
  assert.equal(windowStart('not-a-date', 12), 'not-a-date'); // unparseable passthrough
});

test('db13-row parsers: distinct chronic ICDs, abnormal count, scalar count; NULL-safe', () => {
  assert.equal(countDistinctChronicIcds([{ icd_code: 'E11' }, { icd_code: 'e11' }, { icd_code: 'I10' }, { icd_code: '' }, { icd_code: null }]), 2);
  assert.equal(countDistinctChronicIcds(null), 0);
  assert.equal(countDistinctChronicIcds(undefined), 0);
  assert.equal(countAbnormalLabs([{}, {}, {}]), 3);
  assert.equal(countAbnormalLabs(null), 0);
  assert.equal(scalarCount([{ n: 7 }], 'n'), 7);
  assert.equal(scalarCount([], 'n'), 0);
  assert.equal(scalarCount(null, 'n'), 0);
});

test('index-encounter exclusion is an as-of property: with only the index in-window, prior counts are 0 → NEW_TO_US', () => {
  // The SQL filters strictly < asOf; the pure recipe then sees enc_24m = 0 for a first-ever visit.
  assert.equal(bandFor({ chronic_codes: 0, abnormal_labs: 0, enc_12m: 0, enc_24m: 0 }), 'NEW_TO_US');
});
