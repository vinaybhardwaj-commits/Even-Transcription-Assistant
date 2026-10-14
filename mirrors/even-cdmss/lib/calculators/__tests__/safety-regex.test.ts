// Node built-in test runner — no new npm deps.
// Run with: node --test --import tsx lib/calculators/__tests__/safety-regex.test.ts
// (tsx is dev-only via npx, no install needed: npx -y tsx --test ...)
// In CI add: "test": "node --test --experimental-strip-types lib/calculators/__tests__/**/*.test.ts"
// once Node 22 is widely used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySafetyRedaction,
  POSITIVE_TEST_CASES,
  NEGATIVE_TEST_CASES,
} from '../safety-regex';

for (const tc of POSITIVE_TEST_CASES) {
  test(`safety-regex positive: ${tc.input}`, () => {
    const r = applySafetyRedaction(tc.input);
    assert.equal(r.matches.length, tc.expectMatches, 'match count');
    assert.equal(r.matches[0].category, tc.category, 'category');
    assert.match(r.redacted, /\[number intentionally omitted/);
    assert.notEqual(r.redacted, tc.input);
  });
}

for (const tc of NEGATIVE_TEST_CASES) {
  test(`safety-regex negative (preserve ${tc.reason}): ${tc.input}`, () => {
    const r = applySafetyRedaction(tc.input);
    assert.equal(r.matches.length, 0, 'no matches');
    assert.equal(r.redacted, tc.input, 'unchanged');
  });
}

const FLUID_TYPE_SENTENCES = [
  'Hypertonic saline is the indicated agent for symptomatic severe hyponatremia.',
  'Isotonic crystalloid is appropriate for initial resuscitation.',
  'Lactated Ringer is preferred over normal saline in large-volume resuscitation.',
];
for (const s of FLUID_TYPE_SENTENCES) {
  test(`safety-regex preserves fluid TYPE: ${s.slice(0, 50)}...`, () => {
    const r = applySafetyRedaction(s);
    assert.equal(r.matches.length, 0);
    assert.equal(r.redacted, s);
  });
}

test('safety-regex mixed: redact dose, preserve lab unit', () => {
  const input = 'Patient SCr 1.4 mg/dL; consider amiodarone 200 mg PO daily.';
  const r = applySafetyRedaction(input);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].category, 'drug_dose');
  assert.match(r.matches[0].matched, /200\s*mg/);
  assert.match(r.redacted, /SCr 1\.4 mg\/dL/);
  assert.match(r.redacted, /\[number intentionally omitted/);
});
