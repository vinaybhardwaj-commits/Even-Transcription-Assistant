/**
 * Pure-core tests for lib/opd-feedback-ux-core.ts (PRD §4).
 * Run: node --experimental-strip-types --test lib/__tests__/opd-feedback-ux-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planTap, makeAttempt, revertOnFail, savedLabel, formatIstClock,
  initProgress, applySaved,
} from '../opd-feedback-ux-core.ts';

test('planTap: same-pill tap is a no-op (toggle-off removed)', () => {
  assert.deepEqual(planTap('false', 'false'), { noop: true });
  assert.deepEqual(planTap(null, 'true_positive'), { noop: false, prev: null, next: 'true_positive' });
  assert.deepEqual(planTap('nitpick', 'false'), { noop: false, prev: 'nitpick', next: 'false' });
});

test('revertOnFail restores the previous verdict from the attempt', () => {
  const first = makeAttempt(null, 'true_positive', null);       // idle → tp
  assert.equal(revertOnFail(first), null);                       // fail → back to no selection
  const change = makeAttempt('true_positive', 'false', null);    // tp → false
  assert.equal(revertOnFail(change), 'true_positive');           // fail → back to tp
});

test('makeAttempt preserves the exact retry payload (verdict + comment)', () => {
  const a = makeAttempt('nitpick', 'false', 'not supported by the note');
  assert.deepEqual(a, { verdict: 'false', comment: 'not supported by the note', prev: 'nitpick' });
  // a bare tap carries a null comment (not undefined) so the re-POST body is identical
  assert.deepEqual(makeAttempt(null, 'contested', undefined), { verdict: 'contested', comment: null, prev: null });
});

test('savedLabel formats "Saved HH:MM · name" in 24h IST; anon fallback', () => {
  // 2026-07-08T03:35:00Z → IST 09:05
  assert.equal(savedLabel('V', new Date('2026-07-08T03:35:00Z')), 'Saved 09:05 · V');
  assert.equal(savedLabel('', new Date('2026-07-08T03:35:00Z')), 'Saved 09:05 · anon');
  assert.equal(savedLabel(null, new Date('2026-07-07T18:30:00Z')), 'Saved 00:00 · anon'); // midnight IST rollover
  assert.equal(formatIstClock(new Date('2026-07-08T18:30:00Z')), '00:00');
});

test('Feature B: saved dedupes by findingRef; caps at total', () => {
  let s = initProgress({ total: 3, triagedRefs: ['a'], missed: 0 });
  assert.equal(s.triaged, 1);
  s = applySaved(s, { findingRef: 'b', verdict: 'false', scope: 'finding' }); // new → +1
  assert.equal(s.triaged, 2);
  s = applySaved(s, { findingRef: 'b', verdict: 'nitpick', scope: 'finding' }); // re-verdict → no change
  assert.equal(s.triaged, 2);
  s = applySaved(s, { findingRef: 'a', verdict: 'true_positive', scope: 'finding' }); // seeded ref → no change
  assert.equal(s.triaged, 2);
  s = applySaved(s, { findingRef: 'c', verdict: 'true_positive', scope: 'finding' }); // new → +1 = 3/3
  assert.equal(s.triaged, 3);
  s = applySaved(s, { findingRef: 'd', verdict: 'false', scope: 'finding' }); // would exceed total → clamped
  assert.equal(s.triaged, 3);
});

test('Feature B: missed increments its own counter, not triaged', () => {
  let s = initProgress({ total: 5, triagedRefs: ['x', 'y'], missed: 1 });
  assert.equal(s.triaged, 2); assert.equal(s.missed, 1);
  s = applySaved(s, { scope: 'missed' });
  assert.equal(s.missed, 2); assert.equal(s.triaged, 2);
  // an event with no ref and no missed scope is a no-op
  assert.deepEqual(applySaved(s, {}), s);
});

test('Feature B: initProgress clamps seed triaged to total and de-dupes/ignores empty refs', () => {
  const s = initProgress({ total: 2, triagedRefs: ['a', 'a', '', 'b', 'c'], missed: 0 });
  assert.equal(s.triaged, 2);          // 3 distinct real refs, clamped to total 2
  assert.equal(s.seen.has('a'), true);
});
