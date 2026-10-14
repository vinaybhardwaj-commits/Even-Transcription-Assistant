/**
 *   node --experimental-strip-types --test lib/__tests__/model-programme-core.test.ts
 * Model-programme meters: model-side armed until v1 freezes; reviewer cadence always live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeters, PROGRAMME, ARMED_LABEL, type ProgrammeInput } from '../model-programme-core.ts';

const input = (o: Partial<ProgrammeInput> = {}): ProgrammeInput => ({
  frozenVersion: null,
  teacherPool: 4200, evalPairs: 300, panelsFilled: 2, adjudications: 120,
  cadenceWeek: 40, cadenceTarget: 50, roster: 6, ...o,
});

test('pre-freeze (version absent): four model-side meters armed, value null, armed label', () => {
  const m = buildMeters(input());
  const model = m.filter((x) => x.key !== 'cadence');
  assert.equal(model.length, 4);
  for (const x of model) {
    assert.equal(x.armed, true);
    assert.equal(x.value, null);
    assert.equal(x.fill, null);
    assert.equal(x.sub, ARMED_LABEL);
  }
});

test('pre-freeze: reviewer cadence ALWAYS live (never armed, never faked)', () => {
  const c = buildMeters(input()).find((x) => x.key === 'cadence')!;
  assert.equal(c.armed, false);
  assert.equal(c.value, 40);
  assert.equal(c.target, 50);
  assert.equal(c.fill, 0.8);
  assert.match(c.sub, /6 reviewers/);
});

test('post-freeze: model-side meters unarm and carry real values + fill', () => {
  const m = buildMeters(input({ frozenVersion: '1.0.0' }));
  const pool = m.find((x) => x.key === 'teacher_pool')!;
  assert.equal(pool.armed, false);
  assert.equal(pool.value, 4200);
  assert.equal(pool.target, PROGRAMME.teacherPool);
  assert.equal(pool.fill, 4200 / 15000);
  assert.match(pool.sub, /at 1\.0\.0/);
});

test('meters returned in mockup order', () => {
  assert.deepEqual(buildMeters(input()).map((x) => x.key),
    ['teacher_pool', 'eval_pairs', 'panels', 'adjudications', 'cadence']);
});

test('fill clamps to [0,1] even when value exceeds target', () => {
  const m = buildMeters(input({ frozenVersion: '1.0.0', teacherPool: 99999 }));
  assert.equal(m.find((x) => x.key === 'teacher_pool')!.fill, 1);
});
