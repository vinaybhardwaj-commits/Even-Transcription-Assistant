/**
 * R10.1 — the `?limit=` / `?offset=` query resolution, and the operator hint that quotes it.
 *
 * THE DEFECT THIS PINS: the old helper was
 *     const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : fallback;
 * and `Number(null)` is 0, which IS finite. An ABSENT param therefore passed the guard and
 * resolved to 0 — the fallback was unreachable on both legs. Both cores defensively floor at
 * `Math.max(1, …)`, so no call ever did nothing; but extract silently ran at ONE document per
 * request instead of six (measured on prod: 154 rows took 47 calls / 153 min), and the response's
 * own next-step hint printed `limit=0`, teaching any operator who copied it to keep doing that.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REEXTRACT_DEFAULT_DOCS_PER_REQUEST, REEXTRACT_MAX_DOCS_PER_REQUEST,
  REFRESH_DEFAULT_CASES_PER_REQUEST, REFRESH_MAX_CASES_PER_REQUEST,
  nextHint, resolveLimit, resolveOffset,
} from '@/lib/readmission/reextract';

const EXTRACT = (v: string | null) =>
  resolveLimit(v, REEXTRACT_DEFAULT_DOCS_PER_REQUEST, REEXTRACT_MAX_DOCS_PER_REQUEST);
const REFRESH = (v: string | null) =>
  resolveLimit(v, REFRESH_DEFAULT_CASES_PER_REQUEST, REFRESH_MAX_CASES_PER_REQUEST);

test('R10.1 — an ABSENT limit walks the intended default, not zero (the regression)', () => {
  assert.equal(EXTRACT(null), 6, 'extract must walk 6 documents when ?limit= is absent');
  assert.equal(REFRESH(null), 1, 'refresh must process 1 case when ?limit= is absent');
});

test('R10.1 — the exact shape that fooled the old guard: Number(null) === 0 is finite', () => {
  assert.equal(Number(null), 0);
  assert.ok(Number.isFinite(Number(null)), 'this is WHY the old fallback was unreachable');
  assert.equal(EXTRACT(null), REEXTRACT_DEFAULT_DOCS_PER_REQUEST);
});

test('R10.1 — an explicit limit=0 is coerced to the fallback on BOTH legs', () => {
  assert.equal(EXTRACT('0'), 6);
  assert.equal(REFRESH('0'), 1);
});

test('R10.1 — empty, blank, negative, NaN and junk all take the fallback', () => {
  for (const v of ['', '   ', '-1', '-20', 'NaN', 'abc', 'null', 'undefined', '1e-9']) {
    assert.equal(EXTRACT(v), 6, `extract: ${JSON.stringify(v)} must fall back`);
    assert.equal(REFRESH(v), 1, `refresh: ${JSON.stringify(v)} must fall back`);
  }
});

test('R10.1 — a present, valid limit of at least 1 still overrides', () => {
  assert.equal(EXTRACT('1'), 1);
  assert.equal(EXTRACT('6'), 6);
  assert.equal(EXTRACT('12'), 12);
  assert.equal(EXTRACT('3.7'), 3, 'floored, not rounded');
  assert.equal(REFRESH('2'), 2);
  assert.equal(REFRESH('3'), 3);
});

test('R10.1 — a present limit above the ceiling clamps to the ceiling', () => {
  assert.equal(EXTRACT('999'), REEXTRACT_MAX_DOCS_PER_REQUEST);
  assert.equal(REFRESH('999'), REFRESH_MAX_CASES_PER_REQUEST);
});

test('R10.1 — resolveOffset: absent/blank/junk/negative start at the beginning', () => {
  for (const v of [null, '', '  ', 'abc', '-5']) assert.equal(resolveOffset(v), 0);
  assert.equal(resolveOffset('0'), 0);
  assert.equal(resolveOffset('57'), 57);
  assert.equal(resolveOffset('57.9'), 57, 'floored');
});

test('R10.1 — the next-step hint NEVER emits limit=0, for any input the route can resolve', () => {
  for (const v of [null, '', '   ', '0', '-1', 'abc', 'NaN', '1', '6', '999']) {
    const hint = nextHint({ totalRows: 154, nextOffset: 12, limit: EXTRACT(v) });
    assert.ok(!hint.includes('limit=0'), `hint must not advertise limit=0 (input ${JSON.stringify(v)}): ${hint}`);
    assert.match(hint, /limit=[1-9][0-9]*$/, `hint must quote a limit of at least 1: ${hint}`);
  }
});

test('R10.1 — the hint quotes the limit actually spent, not a re-derived one', () => {
  assert.equal(
    nextHint({ totalRows: 154, nextOffset: 12, limit: EXTRACT('4') }),
    'call again with ?offset=12&limit=4',
  );
});

test('R10.1 — the hint still says "cohort complete" once the walk reaches the end', () => {
  const done = nextHint({ totalRows: 154, nextOffset: 154, limit: 6 });
  assert.match(done, /cohort complete/);
  assert.ok(!done.includes('limit='), 'a finished cohort must not invite another call');
  assert.match(nextHint({ totalRows: 154, nextOffset: 200, limit: 6 }), /cohort complete/);
  assert.match(nextHint({ totalRows: null, nextOffset: 12, limit: 6 }), /call again/);
});
