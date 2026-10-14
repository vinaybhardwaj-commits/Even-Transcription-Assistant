/**
 * Pure-core tests for lib/review-navigator-core.ts (REVIEW-NAVIGATOR PRD §3.2/§5).
 * Run: node --test --import tsx lib/__tests__/review-navigator-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNavigator, nextUnlabeled, type NavInput, type ItemStatus,
} from '../review-navigator-core.ts';

const it = (o: Partial<NavInput> & { key: string }): NavInput => ({
  subject: o.subject ?? 'S', signal_type: o.signal_type ?? 'sig', doctor_uid: o.doctor_uid ?? 'd',
  note_date: o.note_date ?? '2026-07-01', queue: o.queue ?? 'fresh', key: o.key,
});
const S = (m: Record<string, ItemStatus> = {}) => m;

test('group key exactness: same (subject, signal_type) groups; different signal splits', () => {
  const nav = buildNavigator([
    it({ key: 'a', subject: 'Unverified brand', signal_type: 'unverified_brand' }),
    it({ key: 'b', subject: 'Unverified brand', signal_type: 'unverified_brand' }),
    it({ key: 'c', subject: 'Unverified brand', signal_type: 'other' }), // different signal → not in the group
  ], S());
  assert.equal(nav.groups.length, 1);
  assert.equal(nav.groups[0].items.length, 2);
  assert.equal(nav.singles.length, 1);
  assert.equal(nav.singles[0].key, 'c');
});

test("'' signal folds like stewardship (empty signal groups together)", () => {
  const nav = buildNavigator([
    it({ key: 'a', subject: 'X', signal_type: '' }),
    it({ key: 'b', subject: 'X', signal_type: '' }),
  ], S());
  assert.equal(nav.groups.length, 1);
  assert.equal(nav.groups[0].n, 2);
});

test('≥2 threshold: a pair groups, a singleton does not', () => {
  const nav = buildNavigator([
    it({ key: 'p1', subject: 'Pair', signal_type: 's' }),
    it({ key: 'p2', subject: 'Pair', signal_type: 's' }),
    it({ key: 's1', subject: 'Lonely', signal_type: 's' }),
  ], S());
  assert.equal(nav.groups.length, 1);
  assert.deepEqual(nav.singles.map((x) => x.key), ['s1']);
});

test('section order + group sort (size desc, newest tie-break) + singles in queue order', () => {
  const nav = buildNavigator([
    // group A: 2 items, newest 07-05
    it({ key: 'a1', subject: 'A', signal_type: 's', note_date: '2026-07-05' }),
    it({ key: 'a2', subject: 'A', signal_type: 's', note_date: '2026-07-02' }),
    // group B: 3 items, newest 07-03 → bigger, comes first
    it({ key: 'b1', subject: 'B', signal_type: 's', note_date: '2026-07-01' }),
    it({ key: 'b2', subject: 'B', signal_type: 's', note_date: '2026-07-03' }),
    it({ key: 'b3', subject: 'B', signal_type: 's', note_date: '2026-07-02' }),
    // group C: 2 items, newest 07-09 → same size as A but newer → before A
    it({ key: 'c1', subject: 'C', signal_type: 's', note_date: '2026-07-09' }),
    it({ key: 'c2', subject: 'C', signal_type: 's', note_date: '2026-07-08' }),
    // singles
    it({ key: 'z1', subject: 'Z1', signal_type: 's' }),
    it({ key: 'z2', subject: 'Z2', signal_type: 's' }),
  ], S());
  assert.deepEqual(nav.groups.map((g) => g.subject), ['B', 'C', 'A']); // size 3, then size-2 newest-first
  assert.deepEqual(nav.singles.map((x) => x.key), ['z1', 'z2']);        // queue order
  // flattened order: group items (in group order) then singles
  assert.deepEqual(nav.order, ['b1', 'b2', 'b3', 'c1', 'c2', 'a1', 'a2', 'z1', 'z2']);
});

test('disagreement pinning: disagreements section leads the order, groups/singles below', () => {
  const nav = buildNavigator([
    it({ key: 'd1', subject: 'D', signal_type: 's', queue: 'disagreement' }),
    it({ key: 'g1', subject: 'G', signal_type: 's' }),
    it({ key: 'g2', subject: 'G', signal_type: 's' }),
  ], S());
  assert.deepEqual(nav.disagreements.map((x) => x.key), ['d1']);
  assert.equal(nav.groups.length, 1);
  assert.deepEqual(nav.order, ['d1', 'g1', 'g2']);
});

test('traversal: within-group → next group → singles; wrap; exhausted → null', () => {
  const nav = buildNavigator([
    it({ key: 'b1', subject: 'B', signal_type: 's', note_date: '2026-07-03' }),
    it({ key: 'b2', subject: 'B', signal_type: 's', note_date: '2026-07-02' }),
    it({ key: 'a1', subject: 'A', signal_type: 's', note_date: '2026-07-05' }), // group A newer → sorts first
    it({ key: 'a2', subject: 'A', signal_type: 's', note_date: '2026-07-01' }),
    it({ key: 'z', subject: 'Z', signal_type: 's' }),
  ], S());
  // both groups size 2 → newest-first: A (07-05) before B (07-03); then single z
  assert.deepEqual(nav.order, ['a1', 'a2', 'b1', 'b2', 'z']);
  const st: Record<string, ItemStatus> = {};
  assert.equal(nextUnlabeled(nav.order, st, 'a1'), 'a2');   // within group
  assert.equal(nextUnlabeled(nav.order, st, 'a2'), 'b1');   // next group
  assert.equal(nextUnlabeled(nav.order, st, 'b2'), 'z');    // into singles
  // wrap: from the last item, an earlier unlabeled is still reachable
  assert.equal(nextUnlabeled(nav.order, st, 'z'), 'a1');
  // exhausted → null (all labeled/skipped)
  const allDone: Record<string, ItemStatus> = { a1: 'labeled', a2: 'labeled', b1: 'skipped', b2: 'labeled', z: 'labeled' };
  assert.equal(nextUnlabeled(nav.order, allDone, 'z'), null);
  // currentKey null → first unlabeled from the top
  assert.equal(nextUnlabeled(nav.order, st, null), 'a1');
});

test('skip sinks within its section and traversal passes it over', () => {
  const status: Record<string, ItemStatus> = { g2: 'skipped' };
  const nav = buildNavigator([
    it({ key: 'g1', subject: 'G', signal_type: 's' }),
    it({ key: 'g2', subject: 'G', signal_type: 's' }),
    it({ key: 'g3', subject: 'G', signal_type: 's' }),
  ], status);
  // g2 skipped → sinks to the end of its group
  assert.deepEqual(nav.groups[0].items.map((x) => x.key), ['g1', 'g3', 'g2']);
  assert.deepEqual(nav.order, ['g1', 'g3', 'g2']);
  // traversal passes the skipped item over: g1 → g3 (g2 skipped is skipped over on wrap)
  assert.equal(nextUnlabeled(nav.order, status, 'g1'), 'g3');
  // once g1 & g3 are labeled, only the skipped g2 remains → exhausted
  assert.equal(nextUnlabeled(nav.order, { g1: 'labeled', g2: 'skipped', g3: 'labeled' }, 'g3'), null);
});

test('labeled stays in place (not sunk) with its status; k/n progress counts labeled+skipped', () => {
  const status: Record<string, ItemStatus> = { g1: 'labeled', g3: 'skipped' };
  const nav = buildNavigator([
    it({ key: 'g1', subject: 'G', signal_type: 's' }),
    it({ key: 'g2', subject: 'G', signal_type: 's' }),
    it({ key: 'g3', subject: 'G', signal_type: 's' }),
  ], status);
  // labeled g1 keeps its position (only skipped sink); g3 sinks
  assert.deepEqual(nav.groups[0].items.map((x) => x.key), ['g1', 'g2', 'g3']);
  assert.equal(nav.groups[0].items[0].status, 'labeled');
  assert.equal(nav.groups[0].k, 2);  // g1 labeled + g3 skipped
  assert.equal(nav.groups[0].n, 3);
});

test('determinism: same input → identical output', () => {
  const inputs = [
    it({ key: 'a1', subject: 'A', signal_type: 's', note_date: '2026-07-05' }),
    it({ key: 'a2', subject: 'A', signal_type: 's', note_date: '2026-07-04' }),
    it({ key: 'z', subject: 'Z', signal_type: 's' }),
  ];
  assert.deepEqual(buildNavigator(inputs, S()).order, buildNavigator(inputs, S()).order);
});
