/**
 *   node --experimental-strip-types --test lib/__tests__/learning-flywheel-core.test.ts
 * Flywheel strip: safe ratios (zero-denominator → null → "—") and view assembly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ratio, pct, buildFlywheel, type FlywheelCounts } from '../learning-flywheel-core.ts';

test('ratio: null on zero denominator, value otherwise', () => {
  assert.equal(ratio(3, 0), null);
  assert.equal(ratio(0, 0), null);
  assert.equal(ratio(1, 4), 0.25);
  assert.equal(ratio(0, 4), 0);
});

test('pct: "—" for null, whole-percent otherwise', () => {
  assert.equal(pct(null), '—');
  assert.equal(pct(0), '0%');
  assert.equal(pct(0.074), '7%');
  assert.equal(pct(0.205), '21%');
  assert.equal(pct(1), '100%');
});

const counts = (o: Partial<FlywheelCounts> = {}): FlywheelCounts => ({
  auditsWeek: 700, daysElapsed: 5, engine: '0.81.7',
  findingsWeek: 1200, labelsWeek: 90,
  approvedByType: [{ type: 'lvc_rule', n: 2 }, { type: 'harvest_topic', n: 0 }], suppressionsWeek: 1,
  lvcTotal: 400, lvcWithRef: 84, llmTotal: 1000, llmGrounded: 205, ...o,
});

test('buildFlywheel: perDay rounds audits over elapsed days; ≥1 divisor', () => {
  assert.equal(buildFlywheel(counts()).audits.perDay, 140);
  assert.equal(buildFlywheel(counts({ auditsWeek: 3, daysElapsed: 0 })).audits.perDay, 3);
});

test('buildFlywheel: attribution + grounded ratios (the two first-ever headline numbers)', () => {
  const v = buildFlywheel(counts());
  assert.equal(pct(v.better.attribution), '21%'); // 84/400
  assert.equal(pct(v.better.grounded), '21%');    // 205/1000
});

test('buildFlywheel: zero corpus denominators → null → "—", never a fake 0%', () => {
  const v = buildFlywheel(counts({ lvcTotal: 0, lvcWithRef: 0, llmTotal: 0, llmGrounded: 0 }));
  assert.equal(v.better.attribution, null);
  assert.equal(v.better.grounded, null);
  assert.equal(pct(v.better.attribution), '—');
});

test('buildFlywheel: approved list drops zero-count types', () => {
  const v = buildFlywheel(counts());
  assert.deepEqual(v.actions.approved, [{ type: 'lvc_rule', n: 2 }]);
  assert.equal(v.actions.suppressions, 1);
});
