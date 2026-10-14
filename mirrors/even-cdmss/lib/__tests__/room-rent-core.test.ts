/**
 * Pure-core tests for lib/room-rent-core.ts.
 * Run: node --experimental-strip-types --test lib/__tests__/room-rent-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoomCategory, excessBedDays, computeBedDayCost, type RoomRentTable } from '../room-rent-core.ts';

const TABLE: RoomRentTable = {
  status: 'estimate',
  dayCareBenchmarkDays: 1,
  default: { key: 'private_room', perDay: 6500 },
  categories: [
    { key: 'day_care', label: 'Day care / OPD', perDay: 0, aliases: ['day care', 'opd'] },
    { key: 'general_ward', label: 'General ward', perDay: 2500, aliases: ['ward', 'general'] },
    { key: 'private_room', label: 'Single / private room', perDay: 6500, aliases: ['single room', 'single', 'private'] },
    { key: 'icu', label: 'ICU', perDay: 16000, aliases: ['icu', 'intensive care'] },
  ],
};

test('matchRoomCategory prefers the longest alias and falls back', () => {
  assert.equal(matchRoomCategory('Single Room (Second Floor)', TABLE).key, 'private_room');
  assert.equal(matchRoomCategory('ICU', TABLE).key, 'icu');
  assert.equal(matchRoomCategory('general ward', TABLE).key, 'general_ward');
  const fb = matchRoomCategory('penthouse', TABLE);   // no alias → fallback, matched:false
  assert.equal(fb.key, 'private_room');
  assert.equal(fb.matched, false);
});

test('excessBedDays = LOS − benchmark, floored at 0', () => {
  assert.equal(excessBedDays(8, TABLE), 7);     // benchmark 1
  assert.equal(excessBedDays(1, TABLE), 0);
  assert.equal(excessBedDays(0, TABLE), 0);
  assert.equal(excessBedDays(5, TABLE, 3), 2);  // override benchmark
});

test('computeBedDayCost: 8-day single room over-stay = 7 × 6500 = 45,500 (est.)', () => {
  const r = computeBedDayCost(8, 'Single Room (Second Floor)', true, TABLE);
  assert.equal(r.cost, 45_500);
  assert.equal(r.days, 7);
  assert.equal(r.estimate, true);
  assert.match(r.detail, /7 excess bed-days × ₹6,500/);
});

test('computeBedDayCost returns 0 when not flagged, day-care, or single-day', () => {
  assert.equal(computeBedDayCost(8, 'single room', false, TABLE).cost, 0);   // not flagged
  assert.equal(computeBedDayCost(3, 'day care', true, TABLE).cost, 0);       // day-care, no rent
  assert.equal(computeBedDayCost(1, 'single room', true, TABLE).cost, 0);    // no excess days
});

test('tariff-status table drops the (est.) label', () => {
  const r = computeBedDayCost(4, 'ICU', true, { ...TABLE, status: 'tariff' });
  assert.equal(r.cost, 3 * 16000);
  assert.equal(r.estimate, false);
  assert.doesNotMatch(r.detail, /est\./);
});
