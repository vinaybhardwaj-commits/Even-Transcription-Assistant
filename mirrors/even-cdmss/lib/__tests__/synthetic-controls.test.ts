// Synthetic known-positives + the six negative controls — CI hard gate (PRD
// CDMSS-METAMORPHIC-AND-SYNTHETIC-CONTROLS v1.0 §4). Single definition: this file asserts what
// lib/metamorphic-core.ts `runSyntheticControls()` returns — the same call the engine-health
// panel renders live. Every fixture plants exactly ONE rulebook-ratified defect (M5) with its
// expected_signal_type recorded beside it; recall_det = fired / planted is the deterministic
// leg's first recall figure (measured 19/19 = 1.0 at 46c7cf9). Banned-FDC fixtures use
// PLACEHOLDER molecule names against a test table — the standing rule from
// cdsco-banned-fdc-core.test.ts binds here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSyntheticControls, SYNTHETIC_FIXTURES } from '../metamorphic-core';

const report = runSyntheticControls();

test('coverage floor (PRD §4): ≥5 dose-ceiling, ≥3 SOS, ≥3 banned-FDC, ≥4 interaction, ≥4 incomplete-dosing positives; exactly 6 negatives', () => {
  const by = (fam: string) => SYNTHETIC_FIXTURES.filter((f) => f.family === fam).length;
  assert.ok(by('dose_ceiling') >= 5, `dose_ceiling ${by('dose_ceiling')}`);
  assert.ok(by('dose_sos') >= 3, `dose_sos ${by('dose_sos')}`);
  assert.ok(by('banned_fdc') >= 3, `banned_fdc ${by('banned_fdc')}`);
  assert.ok(by('interaction') >= 4, `interaction ${by('interaction')}`);
  assert.ok(by('incomplete_dosing') >= 4, `incomplete_dosing ${by('incomplete_dosing')}`);
  assert.equal(report.negatives.length, 6);
});

test('fixtures carry no PHI, no db13 uid, and banned-FDC fixtures use placeholder molecules only', () => {
  for (const fx of SYNTHETIC_FIXTURES) {
    assert.ok(!('uid' in (fx.case as unknown as Record<string, unknown>)), `${fx.id} carries a uid`);
    if (fx.family === 'banned_fdc' || fx.usesBannedTestTable) {
      for (const m of fx.case.medications) {
        assert.match(`${m.generic || ''} ${m.resolvedGeneric || ''}`.toLowerCase(), /mol-[a-z]/,
          `${fx.id}: banned-FDC fixture must use placeholder molecule names (mol-a/mol-b/…)`);
      }
    }
  }
});

for (const p of report.positives) {
  test(`positive ${p.id} fires ${p.expected_signal_type} — ${p.note}`, () => {
    assert.ok(p.fired, `${p.id} did NOT fire. Observed: ${p.observed}`);
  });
}

for (const n of report.negatives) {
  test(`negative ${n.id} stays silent — ${n.note}`, () => {
    assert.ok(!n.fired, `${n.id} fired its guarded signal ${n.expected_signal_type}. Observed: ${n.observed}`);
    assert.ok(n.held, `${n.id} produced a scoring finding. Observed: ${n.observed}`);
  });
}

test('recall_det = fired / planted, over the deterministic leg only (no LLM recall claim — PRD §6)', () => {
  assert.equal(report.planted, report.positives.length);
  assert.equal(report.recall_det, report.fired / report.planted);
  // Ratified at 46c7cf9: every planted defect fires. If a positive stops firing this fails above
  // AND here — recall is a measurement, but a silent drop below 1.0 is a regression to catch.
  assert.equal(report.recall_det, 1);
});
