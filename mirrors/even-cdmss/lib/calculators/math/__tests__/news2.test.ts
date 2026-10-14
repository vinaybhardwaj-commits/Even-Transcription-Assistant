import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNews2 } from '../news2';

// PRD §11 smoke cases + boundary checks.
test('NEWS2: all-normal vitals → 0 / low / no banner', () => {
  const r = computeNews2({ rr: 16, spo2_scale: 1, spo2: 98, o2_supp: false, temp_c: 36.8, sbp: 120, hr: 75, consciousness: 'A' });
  assert.equal(r.score, 0);
  assert.equal(r.band, 'low');
  assert.equal(r.any_single_three, false);
});

test('NEWS2: PRD §11 vignette #2 — RR 22, SpO2 95, T 38.2, BP 110, HR 105 → 5 medium amber', () => {
  const r = computeNews2({ rr: 22, spo2_scale: 1, spo2: 95, o2_supp: false, temp_c: 38.2, sbp: 110, hr: 105, consciousness: 'A' });
  // RR 22 → 2, SpO2 95 → 1, O2 supp false → 0, T 38.2 → 1, SBP 110 → 1, HR 105 → 1, A → 0 = 6
  // (PRD said "score 5" but the math is actually 6 — verifying my numbers, not the doc)
  assert.equal(r.score, 6, 'score should be 6 by NEWS2 lookup');
  assert.equal(r.band, 'medium');
});

test('NEWS2: PRD §11 vignette #3 — RR 28, SpO2 90, T 39.5, BP 88, HR 130, new confusion → ≥10 high red', () => {
  const r = computeNews2({ rr: 28, spo2_scale: 1, spo2: 90, o2_supp: false, temp_c: 39.5, sbp: 88, hr: 130, consciousness: 'C' });
  // RR 28→3, SpO2 90→3, O2 supp false→0, T 39.5→2, SBP 88→3, HR 130→2, C→3 = 16
  assert.ok(r.score >= 10, `score ${r.score} should be ≥10`);
  assert.equal(r.band, 'high');
  assert.equal(r.any_single_three, true);
});

test('NEWS2 Scale 2 / COPD: SpO2 88 on 2L O2 — air SpO2 target met but on O2', () => {
  const r = computeNews2({ rr: 18, spo2_scale: 2, spo2: 88, o2_supp: true, temp_c: 36.8, sbp: 120, hr: 78, consciousness: 'A' });
  // RR 18→0, SpO2 88 scale 2→0, O2 supp true→2, T→0, SBP→0, HR→0, A→0 = 2
  assert.equal(r.element_points.spo2, 0, 'Scale 2 should give 0 for SpO2 88');
  assert.equal(r.element_points.o2_supp, 2);
  assert.equal(r.score, 2);
});

test('NEWS2 Scale 2: SpO2 96 on O2 (above target window) → scale 2 SpO2 → 2', () => {
  const r = computeNews2({ rr: 18, spo2_scale: 2, spo2: 96, o2_supp: true, temp_c: 36.8, sbp: 120, hr: 78, consciousness: 'A' });
  assert.equal(r.element_points.spo2, 2, 'Scale 2 with SpO2 96 on O2 should score 2');
});

test('NEWS2 Scale 2: SpO2 96 on AIR (above target window without O2) → scale 2 SpO2 → 0', () => {
  const r = computeNews2({ rr: 18, spo2_scale: 2, spo2: 96, o2_supp: false, temp_c: 36.8, sbp: 120, hr: 78, consciousness: 'A' });
  assert.equal(r.element_points.spo2, 0, 'Scale 2 with SpO2 96 on air should score 0');
});

test('NEWS2: isolated tachycardia HR 115 → 2 low-medium (not a single 3, so stays low-medium)', () => {
  const r = computeNews2({ rr: 16, spo2_scale: 1, spo2: 98, o2_supp: false, temp_c: 36.8, sbp: 120, hr: 115, consciousness: 'A' });
  assert.equal(r.score, 2);
  assert.equal(r.band, 'low-medium');
});

test('NEWS2: single param scoring 3 bumps low-medium → medium', () => {
  // HR 35 alone → 3 points, total = 3, but any_single_three=true so band=medium
  const r = computeNews2({ rr: 16, spo2_scale: 1, spo2: 98, o2_supp: false, temp_c: 36.8, sbp: 120, hr: 35, consciousness: 'A' });
  assert.equal(r.score, 3);
  assert.equal(r.any_single_three, true);
  assert.equal(r.band, 'medium', 'single 3 bumps to medium per RCP escalation');
});

// Element-wise boundary checks
test('NEWS2 RR boundaries', () => {
  const base = { spo2_scale: 1 as const, spo2: 98, o2_supp: false, temp_c: 37, sbp: 120, hr: 75, consciousness: 'A' as const };
  assert.equal(computeNews2({ ...base, rr: 8 }).element_points.rr, 3);
  assert.equal(computeNews2({ ...base, rr: 9 }).element_points.rr, 1);
  assert.equal(computeNews2({ ...base, rr: 12 }).element_points.rr, 0);
  assert.equal(computeNews2({ ...base, rr: 21 }).element_points.rr, 2);
  assert.equal(computeNews2({ ...base, rr: 25 }).element_points.rr, 3);
});

test('NEWS2 SBP boundaries', () => {
  const base = { rr: 16, spo2_scale: 1 as const, spo2: 98, o2_supp: false, temp_c: 37, hr: 75, consciousness: 'A' as const };
  assert.equal(computeNews2({ ...base, sbp: 90 }).element_points.sbp, 3);
  assert.equal(computeNews2({ ...base, sbp: 91 }).element_points.sbp, 2);
  assert.equal(computeNews2({ ...base, sbp: 101 }).element_points.sbp, 1);
  assert.equal(computeNews2({ ...base, sbp: 111 }).element_points.sbp, 0);
  assert.equal(computeNews2({ ...base, sbp: 220 }).element_points.sbp, 3);
});

test('NEWS2 Temp boundaries', () => {
  const base = { rr: 16, spo2_scale: 1 as const, spo2: 98, o2_supp: false, sbp: 120, hr: 75, consciousness: 'A' as const };
  assert.equal(computeNews2({ ...base, temp_c: 35.0 }).element_points.temp, 3);
  assert.equal(computeNews2({ ...base, temp_c: 35.5 }).element_points.temp, 1);
  assert.equal(computeNews2({ ...base, temp_c: 37.0 }).element_points.temp, 0);
  assert.equal(computeNews2({ ...base, temp_c: 38.5 }).element_points.temp, 1);
  assert.equal(computeNews2({ ...base, temp_c: 39.5 }).element_points.temp, 2);
});

test('NEWS2 consciousness: any non-Alert → 3', () => {
  const base = { rr: 16, spo2_scale: 1 as const, spo2: 98, o2_supp: false, temp_c: 37, sbp: 120, hr: 75 };
  assert.equal(computeNews2({ ...base, consciousness: 'A' }).element_points.consciousness, 0);
  assert.equal(computeNews2({ ...base, consciousness: 'V' }).element_points.consciousness, 3);
  assert.equal(computeNews2({ ...base, consciousness: 'P' }).element_points.consciousness, 3);
  assert.equal(computeNews2({ ...base, consciousness: 'U' }).element_points.consciousness, 3);
  assert.equal(computeNews2({ ...base, consciousness: 'C' }).element_points.consciousness, 3);
});
