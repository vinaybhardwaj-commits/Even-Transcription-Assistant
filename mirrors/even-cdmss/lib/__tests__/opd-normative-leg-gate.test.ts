// lib/__tests__/opd-normative-leg-gate.test.ts — R-11 Stage 2 (DORMANT): the OPD audit citation
// retrieval gains the normative leg ONLY behind OPD_NORMATIVE_LEG_ENABLED === '1' AND off the mini
// path. These are the score-invariance guards: flag off ⇒ opts byte-identical to today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opdRetrieveOpts } from '../opd-note-audit.ts';

// today's exact line-309 opts
const TODAY = { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true };

// ── Test 1 — flag unset/'0' ⇒ byte-identical to today (no useNormativeLeg key). Scoring-path guard. ──
test('flag off ⇒ opts byte-identical to today (no useNormativeLeg key)', () => {
  assert.deepEqual(opdRetrieveOpts(false, {}), TODAY);
  assert.deepEqual(opdRetrieveOpts(false, { OPD_NORMATIVE_LEG_ENABLED: '0' }), TODAY);
  assert.ok(!('useNormativeLeg' in opdRetrieveOpts(false, {})), 'the key must be ABSENT, not false');
});

// ── Test 2 — flag on + non-mini ⇒ useNormativeLeg: true ──
test('flag on + non-mini ⇒ useNormativeLeg: true', () => {
  const opts = opdRetrieveOpts(false, { OPD_NORMATIVE_LEG_ENABLED: '1' });
  assert.equal(opts.useNormativeLeg, true);
  assert.deepEqual(opts, { ...TODAY, useNormativeLeg: true });
});

// ── Test 3 — flag on + mini ⇒ NO useNormativeLeg key (mini stays byte-identical) ──
test('flag on + mini ⇒ no useNormativeLeg key (mini path can never enable the leg)', () => {
  const opts = opdRetrieveOpts(true, { OPD_NORMATIVE_LEG_ENABLED: '1' });
  assert.deepEqual(opts, TODAY);
  assert.ok(!('useNormativeLeg' in opts), 'mini path must be byte-identical');
});

// ── only the exact string '1' enables — no accidental truthy activation ──
test('only OPD_NORMATIVE_LEG_ENABLED === "1" enables the leg', () => {
  for (const v of [undefined, '', '0', 'true', 'yes', '2', 'on', ' 1 ']) {
    assert.deepEqual(opdRetrieveOpts(false, { OPD_NORMATIVE_LEG_ENABLED: v }), TODAY, `value ${JSON.stringify(v)} must not enable`);
  }
});
