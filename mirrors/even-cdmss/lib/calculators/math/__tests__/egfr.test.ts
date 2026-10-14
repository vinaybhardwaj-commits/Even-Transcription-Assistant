// node:test based — zero new npm deps per house rule.
// Run: node --test --import tsx lib/calculators/math/__tests__/egfr.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ckdEpi2021, cockcroftGault, stageFromEgfr, computeEgfr, umolLtoMgDl } from '../egfr';

// CKD-EPI 2021 spot checks against published reference values.
// Hand-verified arithmetic; the rounded-to-1-decimal results are the contract.
const CKDEPI_CASES = [
  { name: 'young healthy F, SCr 0.7',     inputs: { age: 32, sex: 'F' as const, scr_mg_dl: 0.7 }, expectStage: 'G1',  expectRange: [110, 125] },
  { name: 'mid-life M, SCr 1.0',          inputs: { age: 45, sex: 'M' as const, scr_mg_dl: 1.0 }, expectStage: 'G1',  expectRange: [85, 100] },
  { name: 'older M, SCr 1.8 (CKD3b)',     inputs: { age: 68, sex: 'M' as const, scr_mg_dl: 1.8 }, expectStage: 'G3b', expectRange: [35, 45] },
  { name: 'elderly F, SCr 4.2 (CKD5)',    inputs: { age: 75, sex: 'F' as const, scr_mg_dl: 4.2 }, expectStage: 'G5',  expectRange: [9, 14] },
  { name: 'F SCr 1.2 (CKD3a)',            inputs: { age: 55, sex: 'F' as const, scr_mg_dl: 1.2 }, expectStage: 'G3a', expectRange: [48, 58] },
];

for (const c of CKDEPI_CASES) {
  test(`ckdEpi2021: ${c.name}`, () => {
    const egfr = ckdEpi2021(c.inputs);
    assert.ok(egfr >= c.expectRange[0] && egfr <= c.expectRange[1],
      `eGFR ${egfr} outside expected ${c.expectRange[0]}-${c.expectRange[1]}`);
    assert.equal(stageFromEgfr(egfr), c.expectStage);
  });
}

// Cockcroft-Gault spot checks.
const CG_CASES: { name: string; inputs: Parameters<typeof cockcroftGault>[0]; expectRange: [number, number]; skip?: string }[] = [
  // Fixture corrected 13 Jul 2026 (V ruling): the old [115,130] range forgot the ×0.85 female
  // factor — standard CG for this case = 109.3 mL/min. The implementation was always correct.
  { name: 'young healthy F, SCr 0.7, 60 kg',   inputs: { age: 32, sex: 'F' as const, scr_mg_dl: 0.7, weight_kg: 60 }, expectRange: [105, 115] },
  { name: 'older M, SCr 1.8, 78 kg',           inputs: { age: 68, sex: 'M' as const, scr_mg_dl: 1.8, weight_kg: 78 }, expectRange: [40, 50] },
  { name: 'elderly F low weight, SCr 4.2, 52', inputs: { age: 75, sex: 'F' as const, scr_mg_dl: 4.2, weight_kg: 52 }, expectRange: [8, 14] },
];

for (const c of CG_CASES) {
  test(`cockcroftGault: ${c.name}`, { skip: c.skip }, () => {
    const cg = cockcroftGault(c.inputs);
    assert.ok(cg !== null, 'CG should compute when weight provided');
    assert.ok(cg! >= c.expectRange[0] && cg! <= c.expectRange[1],
      `CG ${cg} outside ${c.expectRange[0]}-${c.expectRange[1]}`);
  });
}

test('cockcroftGault returns null without weight', () => {
  const cg = cockcroftGault({ age: 60, sex: 'M', scr_mg_dl: 1.2 });
  assert.equal(cg, null);
});

test('computeEgfr returns conservative_for_nti as the lower of the two', () => {
  // 68 M, SCr 1.8, 78 kg — CKD-EPI ~40, CG ~44; conservative should pick CKD-EPI
  const r = computeEgfr({ age: 68, sex: 'M', scr_mg_dl: 1.8, weight_kg: 78 });
  assert.ok(r.cockcroft_gault !== null);
  const expectedConservative = Math.round(Math.min(r.ckdepi_2021, r.cockcroft_gault!) * 10) / 10;
  assert.equal(r.conservative_for_nti, expectedConservative);
});

test('stageFromEgfr boundaries', () => {
  assert.equal(stageFromEgfr(90),  'G1');
  assert.equal(stageFromEgfr(89.9),'G2');
  assert.equal(stageFromEgfr(60),  'G2');
  assert.equal(stageFromEgfr(59.9),'G3a');
  assert.equal(stageFromEgfr(45),  'G3a');
  assert.equal(stageFromEgfr(44.9),'G3b');
  assert.equal(stageFromEgfr(30),  'G3b');
  assert.equal(stageFromEgfr(29.9),'G4');
  assert.equal(stageFromEgfr(15),  'G4');
  assert.equal(stageFromEgfr(14.9),'G5');
});

test('umolLtoMgDl conversion', () => {
  // 130 µmol/L ≈ 1.47 mg/dL
  assert.equal(umolLtoMgDl(130), 1.47);
  // 88.4 µmol/L = exactly 1.0 mg/dL
  assert.equal(umolLtoMgDl(88.4), 1.0);
});
