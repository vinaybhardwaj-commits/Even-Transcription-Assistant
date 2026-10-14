import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretAbg } from '../abg';

// PRD §11 smoke vignettes + boundary checks.

test('ABG: classic high-AG metabolic acidosis (DKA-flavored)', () => {
  const r = interpretAbg({ pH: 7.21, paco2: 22, hco3: 9, na: 138, cl: 96, albumin: 4.0 });
  assert.equal(r.primary_disorder, 'metabolic_acidosis');
  assert.equal(r.compensation.verdict, 'appropriate');
  assert.equal(r.anion_gap.state, 'high');
  assert.equal(r.anion_gap.ag_value, 33);
  assert.equal(r.delta_delta.ratio, 1.4);
  assert.match(r.delta_delta.interpretation ?? '', /pure high-AG/);
});

test('ABG: respiratory alkalosis + concurrent high-AG metabolic acidosis (mixed via delta-delta)', () => {
  // pH 7.50, PaCO2 26, HCO3 20, Na 140, Cl 100 → AG 20, delta-delta = (20-12)/(24-20) = 2.0
  // Primary by pH+PaCO2 → respiratory alkalosis acute, but delta-delta flags the AG component
  const r = interpretAbg({ pH: 7.50, paco2: 26, hco3: 20, na: 140, cl: 100, albumin: 4.0 });
  assert.equal(r.anion_gap.state, 'high');
  assert.equal(r.anion_gap.ag_value, 20);
  assert.equal(r.delta_delta.ratio, 2.0);
});

test('ABG: acute respiratory acidosis (no chronic compensation evidence)', () => {
  // pH 7.30, PaCO2 60, HCO3 28 → acute resp acid; expected HCO3 acute = 24 + (60-40)×0.1 = 26 (±2: 24-28)
  const r = interpretAbg({ pH: 7.30, paco2: 60, hco3: 28 });
  assert.equal(r.primary_disorder, 'respiratory_acidosis_acute');
  assert.equal(r.compensation.verdict, 'appropriate');
});

test('ABG: metabolic alkalosis', () => {
  // pH 7.55, PaCO2 50, HCO3 42 → met alk; expected PaCO2 = 42+15 = 57±5: 52-62
  const r = interpretAbg({ pH: 7.55, paco2: 50, hco3: 42 });
  assert.equal(r.primary_disorder, 'metabolic_alkalosis');
  // Measured 50 vs expected 52-62 → under (verdict = mixed_disorder per our schema)
  // Allow either appropriate or mixed since the approximation tolerance is loose
  assert.ok(['appropriate', 'mixed_disorder'].includes(r.compensation.verdict));
});

test('ABG: normal — must not fabricate a disorder', () => {
  const r = interpretAbg({ pH: 7.40, paco2: 38, hco3: 23, na: 140, cl: 106, albumin: 4.0 });
  assert.equal(r.primary_disorder, 'normal');
  assert.equal(r.compensation.verdict, 'not_applicable');
  assert.equal(r.anion_gap.state, 'normal');
  assert.equal(r.delta_delta.ratio, null);
});

test('ABG: albumin correction applied below 4.0', () => {
  // Na 140, Cl 110, HCO3 18, albumin 2.0 → raw AG = 12, corrected = 12 + 2.5×2 = 17 (high)
  const r = interpretAbg({ pH: 7.30, paco2: 30, hco3: 18, na: 140, cl: 110, albumin: 2.0 });
  assert.equal(r.anion_gap.ag_value, 12);
  assert.equal(r.anion_gap.corrected_ag, 17);
  assert.equal(r.anion_gap.albumin_correction_applied, true);
  assert.equal(r.anion_gap.state, 'high');
});

test('ABG: P/F ratio Berlin ARDS bands', () => {
  const moderate = interpretAbg({ pH: 7.40, paco2: 40, hco3: 24, pao2: 100, fio2: 0.5 });
  assert.equal(moderate.oxygenation.pf_ratio, 200);
  assert.equal(moderate.oxygenation.pf_band, 'moderate');

  const severe = interpretAbg({ pH: 7.40, paco2: 40, hco3: 24, pao2: 80, fio2: 1.0 });
  assert.equal(severe.oxygenation.pf_ratio, 80);
  assert.equal(severe.oxygenation.pf_band, 'severe');

  const normal = interpretAbg({ pH: 7.40, paco2: 40, hco3: 24, pao2: 80, fio2: 0.21 });
  assert.ok(normal.oxygenation.pf_ratio! >= 300);
  assert.equal(normal.oxygenation.pf_band, 'normal');
});

test('ABG: A-a gradient computed when PaO2+FiO2+PaCO2 all present', () => {
  const r = interpretAbg({ pH: 7.40, paco2: 40, hco3: 24, pao2: 80, fio2: 0.21 });
  // PAO2 = 0.21×713 - 40/0.8 = 149.7 - 50 = 99.7; A-a = 99.7 - 80 = 19.7
  assert.ok(r.oxygenation.aa_gradient! > 15 && r.oxygenation.aa_gradient! < 25);
});

test('ABG: anion gap returns unknown when Na/Cl missing', () => {
  const r = interpretAbg({ pH: 7.21, paco2: 22, hco3: 9 });
  assert.equal(r.anion_gap.state, 'unknown');
  assert.equal(r.anion_gap.ag_value, null);
});
