/**
 * Tests for the per-room-category tariff helpers (lib/charge-master-core.ts).
 * Run: node --experimental-strip-types --test lib/__tests__/charge-master-tier.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierForCareSetting, priceAtTier, roomCategoryInflation, type TariffRow } from '../charge-master-core.ts';

test('tierForCareSetting maps free-text care settings to a tariff tier', () => {
  assert.equal(tierForCareSetting('Single Room (Second Floor)'), 'private');
  assert.equal(tierForCareSetting('General Ward'), 'general');
  assert.equal(tierForCareSetting('Twin Sharing'), 'semiPrivate');
  assert.equal(tierForCareSetting('ICU bed'), 'icu');
  assert.equal(tierForCareSetting('Suite room'), 'suite');
  assert.equal(tierForCareSetting('day care'), 'opd');
  assert.equal(tierForCareSetting(''), 'general');
});

const MRI: TariffRow = { kind: 'investigation', code: 'RAD00550', item: 'mribrain', opd: 8000, general: 9000, semiPrivate: 10080, private: 11160, suite: 12240, icu: 11160 };

test('priceAtTier reads the right column and falls back when a tier is absent', () => {
  assert.equal(priceAtTier(MRI, 'private'), 11160);
  assert.equal(priceAtTier(MRI, 'general'), 9000);
  assert.equal(priceAtTier(MRI, 'icu'), 11160);
  // missing tier falls back sensibly (general is always present)
  const noPvt: TariffRow = { kind: 'package', code: 'X', item: 'x', general: 5000, private: null, suite: null };
  assert.equal(priceAtTier(noPvt, 'private'), 5000);
});

test('roomCategoryInflation = extra cost vs general ward; 0 at general/opd', () => {
  const rows = [MRI, { kind: 'investigation', code: 'C', item: 'ct', general: 6000, private: 7440 } as TariffRow];
  const inf = roomCategoryInflation(rows, 'private');
  assert.equal(inf.atTier, 11160 + 7440);
  assert.equal(inf.atGeneral, 9000 + 6000);
  assert.equal(inf.delta, (11160 - 9000) + (7440 - 6000)); // 2160 + 1440 = 3600
  assert.equal(inf.n, 2);
  // no inflation when the patient IS in general / opd
  assert.equal(roomCategoryInflation(rows, 'general').delta, 0);
  assert.equal(roomCategoryInflation(rows, 'opd').delta, 0);
});
