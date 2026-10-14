import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretHyponatremia } from '../hyponatremia';

// Classic SIADH (PRD §11). Fixture corrected 13 Jul 2026 (V ruling): Na 128 is 'moderate' under
// the biochemical classification (moderate = 125–129) — exactly what the implementation returns.
test('Hyponatremia: classic SIADH (euvolemic, U-Na high, U-osm concentrated, on SSRI)', () => {
  const r = interpretHyponatremia({
    na: 128, serum_osm: 268, glucose: 105,
    urine_na: 45, urine_osm: 380, volume_status: 'euvolemic',
    meds: ['ssri'], recent_ivf: false, tsh: 2.1, cortisol: 18,
  });
  assert.equal(r.tonicity, 'hypotonic');
  assert.equal(r.pseudohyponatremia_flag, false);
  assert.equal(r.ods_risk, false);
  assert.equal(r.severity_label, 'moderate');
  assert.equal(r.correction_ceiling_24h_meq_l, 8);
});

// Pseudohyponatremia from hyperglycemia (PRD §11)
test('Hyponatremia: pseudo from hyperglycemia (corrected Na > measured)', () => {
  const r = interpretHyponatremia({
    na: 130, serum_osm: 312, glucose: 580, volume_status: 'unsure', meds: [],
  });
  // Katz: 130 + 1.6 × (580-100)/100 = 130 + 7.68 = 137.7 (or Hillier 2.4 for >400: 130 + 2.4×4.8 = 141.5)
  // Glucose >400 → Hillier; expected ~141.5
  assert.ok(r.corrected_na > 140, `corrected ${r.corrected_na} should be >140 with Hillier on glucose 580`);
  assert.equal(r.tonicity, 'hypertonic');
  assert.equal(r.pseudohyponatremia_flag, true);
});

// Hypovolemic (PRD §11) — low U-Na, vomiting/diarrhea
test('Hyponatremia: hypovolemic from extrarenal loss', () => {
  const r = interpretHyponatremia({
    na: 122, serum_osm: 258, glucose: 100,
    urine_na: 12, volume_status: 'hypovolemic', meds: [],
  });
  assert.equal(r.tonicity, 'hypotonic');
  assert.equal(r.volume_status, 'hypovolemic');
  assert.equal(r.severity_label, 'moderate');
  // Na 122 is not <105 and we have no K provided → no ODS risk
  assert.equal(r.ods_risk, false);
});

// ODS risk: Na very low
test('Hyponatremia: ODS risk fires for Na < 105', () => {
  const r = interpretHyponatremia({
    na: 102, glucose: 100, volume_status: 'euvolemic', meds: [],
  });
  assert.equal(r.ods_risk, true);
  assert.ok(r.ods_risk_factors.length > 0);
  assert.ok(r.ods_risk_factors.some((f) => f.includes('chronicity')));
});

// ODS risk: hypokalemia
test('Hyponatremia: ODS risk fires for K < 3', () => {
  const r = interpretHyponatremia({
    na: 125, glucose: 100, k: 2.8, volume_status: 'euvolemic', meds: [],
  });
  assert.equal(r.ods_risk, true);
  assert.ok(r.ods_risk_factors.some((f) => f.includes('hypokalemia')));
});

// Free-water excess computation
test('Hyponatremia: free-water excess for 70kg male, Na 125', () => {
  const r = interpretHyponatremia({
    na: 125, glucose: 100, volume_status: 'euvolemic', meds: [], weight_kg: 70, sex: 'M',
  });
  // TBW = 70 × 0.6 = 42; excess = 42 × (1 - 125/140) = 42 × 0.107 = 4.5L
  assert.ok(r.free_water_deficit_l !== null);
  assert.ok(r.free_water_deficit_l! > 4 && r.free_water_deficit_l! < 5);
});

// No weight → no FWD
test('Hyponatremia: free-water excess returns null without weight', () => {
  const r = interpretHyponatremia({
    na: 125, glucose: 100, volume_status: 'euvolemic', meds: [],
  });
  assert.equal(r.free_water_deficit_l, null);
});

// Estimated osm when not provided
test('Hyponatremia: estimated osm fires when serum_osm absent', () => {
  const r = interpretHyponatremia({
    na: 128, glucose: 105, volume_status: 'euvolemic', meds: [],
  });
  // 2×128 + 105/18 + 14/2.8 = 256 + 5.83 + 5 = 266.8
  assert.ok(r.serum_osm_estimated !== null);
  assert.ok(r.serum_osm_estimated! > 265 && r.serum_osm_estimated! < 270);
  assert.equal(r.tonicity, 'hypotonic');
});
