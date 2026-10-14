/**
 * Pure-core tests for lib/opd-funnel-core.ts (RIGHT-CARE-INDICATOR-PRD §4 / §9).
 * Run: node --test --import tsx lib/__tests__/opd-funnel-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageBandOf, buildStratumModel, computeDoctorOE, pooledRate, funnelLimit, funnelCurve,
  funnelPosition, MIN_STRATUM_N, Z_95,
  type LvcCell,
} from '../opd-funnel-core.ts';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('ageBandOf boundaries', () => {
  assert.equal(ageBandOf(0), '0-17'); assert.equal(ageBandOf(17), '0-17');
  assert.equal(ageBandOf(18), '18-44'); assert.equal(ageBandOf(44), '18-44');
  assert.equal(ageBandOf(45), '45-64'); assert.equal(ageBandOf(64), '45-64');
  assert.equal(ageBandOf(65), '65+'); assert.equal(ageBandOf(120), '65+');
  assert.equal(ageBandOf(null), null); assert.equal(ageBandOf(-1), null);
});

test('stratum fallback hierarchy: band×age (n≥30) → band marginal (n≥30) → global', () => {
  // band HIGH, age 45-64: a fat cell (n=40) → uses its own rate
  const cells: LvcCell[] = [
    { doctor_uid: 'a', band: 'HIGH', age_band: '45-64', n: 40, o: 20 }, // rate .5, n≥30 → own
    { doctor_uid: 'b', band: 'HIGH', age_band: '18-44', n: 10, o: 9 },  // thin band×age; band HIGH total n=50≥30 → band rate
    { doctor_uid: 'c', band: 'LOW', age_band: '0-17', n: 5, o: 1 },     // thin everywhere → global
  ];
  const m = buildStratumModel(cells);
  near(m.rateFor('HIGH', '45-64'), 0.5);                 // own fat cell
  // band HIGH marginal = (20+9)/(40+10) = 29/50 = .58
  near(m.rateFor('HIGH', '18-44'), 29 / 50);             // thin cell → band marginal
  // global = (20+9+1)/(40+10+5) = 30/55
  near(m.rateFor('LOW', '0-17'), 30 / 55);               // thin band+cell → global
  near(m.global, 30 / 55);
});

test('age unavailable (null) collapses band×age → band marginal (reproduces the gate)', () => {
  const cells: LvcCell[] = [
    { doctor_uid: 'a', band: 'MODERATE', age_band: null, n: 20, o: 12 },
    { doctor_uid: 'b', band: 'MODERATE', age_band: null, n: 20, o: 8 },
  ];
  const m = buildStratumModel(cells);
  // band×age key MODERATE|∅ has n=40≥30, rate = 20/40 = .5 — equals the band marginal
  near(m.rateFor('MODERATE', null), 0.5);
  near(m.byBand.get('MODERATE')!.o / m.byBand.get('MODERATE')!.n, 0.5);
});

test('O/E arithmetic: expected = Σ n·stratumMean; raw = O/n; oe = O/E', () => {
  // population defines stratum means: LOW rate .4 (n=50), HIGH rate .8 (n=50)
  const pop: LvcCell[] = [
    { doctor_uid: 'pop', band: 'LOW', age_band: null, n: 50, o: 20 },
    { doctor_uid: 'pop', band: 'HIGH', age_band: null, n: 50, o: 40 },
  ];
  // doctor D: 10 LOW notes (4 lvc) + 10 HIGH notes (9 lvc)
  const doc: LvcCell[] = [
    { doctor_uid: 'D', band: 'LOW', age_band: null, n: 10, o: 4 },
    { doctor_uid: 'D', band: 'HIGH', age_band: null, n: 10, o: 9 },
  ];
  const res = computeDoctorOE([...pop, ...doc]).find((d) => d.doctor_uid === 'D')!;
  assert.equal(res.n, 20); assert.equal(res.o, 13);
  near(res.raw_rate, 13 / 20);
  // stratum means include the doctor's OWN notes (indirect standardization population = everyone):
  //   LOW total (50+10)/(20+4)=60/24 → .4 ; HIGH total (50+10)/(40+9)=60/49 → 49/60
  const lowRate = 24 / 60, highRate = 49 / 60;
  const e = 10 * lowRate + 10 * highRate;
  near(res.expected_rate, e / 20);
  near(res.oe!, 13 / e);
  near(res.band_mix.LOW, 0.5); near(res.band_mix.HIGH, 0.5);
});

test('zero denominator → oe null; unbanded cells excluded', () => {
  // a doctor with only unbanded notes → not in the O/E output at all
  const cells: LvcCell[] = [
    { doctor_uid: 'U', band: null, age_band: null, n: 5, o: 3 },
    { doctor_uid: 'Z', band: 'LOW', age_band: null, n: 4, o: 0 }, // global rate 0 → E=0 → oe null
  ];
  const res = computeDoctorOE(cells);
  assert.ok(!res.some((d) => d.doctor_uid === 'U'), 'unbanded-only doctor excluded');
  const z = res.find((d) => d.doctor_uid === 'Z')!;
  assert.equal(z.o, 0); assert.equal(z.oe, null); // E=0 (global rate 0) → null, not Infinity/NaN
});

test('exclusion-set filtering: excluded doctor drops from output AND from stratum means', () => {
  const cells: LvcCell[] = [
    { doctor_uid: 'house', band: 'HIGH', age_band: null, n: 100, o: 100 }, // would drag HIGH rate to ~1
    { doctor_uid: 'real', band: 'HIGH', age_band: null, n: 40, o: 20 },    // real HIGH rate .5
  ];
  const excl = new Set(['house']);
  const m = buildStratumModel(cells, excl);
  near(m.rateFor('HIGH', null), 0.5);   // house excluded → mean is the real doctor's .5, not ~.86
  const res = computeDoctorOE(cells, excl);
  assert.ok(!res.some((d) => d.doctor_uid === 'house'));
  const real = res.find((d) => d.doctor_uid === 'real')!;
  near(real.oe!, 1.0); // obs .5 / exp .5
});

test('funnel limits vs hand-computed', () => {
  // p̄=0.6, n=100 → se = sqrt(.6*.4/100)=sqrt(.0024)=0.04898979...
  near(pooledRate([{ n: 60, o: 36 }, { n: 40, o: 24 }]), 0.6);
  const se = Math.sqrt((0.6 * 0.4) / 100);
  const l = funnelLimit(0.6, 100, Z_95);
  near(l.lo, 0.6 - 1.96 * se); near(l.hi, 0.6 + 1.96 * se);
  // clamp: tiny n widens beyond [0,1] → clamped
  const wide = funnelLimit(0.6, 1, Z_95);
  assert.ok(wide.lo >= 0 && wide.hi <= 1);
  // n≤0 → flat at p̄
  assert.deepEqual(funnelLimit(0.6, 0, Z_95), { lo: 0.6, hi: 0.6 });
});

test('funnelCurve dedupes+sorts n; funnelPosition classifies vs limits + building', () => {
  const curve = funnelCurve(0.6, [100, 100, 25]);
  assert.deepEqual(curve.map((c) => c.n), [25, 100]);
  assert.ok(curve[0].hi95 > curve[1].hi95); // narrower at higher n
  assert.equal(funnelPosition(0.99, 0.6, 100), 'above');
  assert.equal(funnelPosition(0.30, 0.6, 100), 'below');
  assert.equal(funnelPosition(0.60, 0.6, 100), 'within');
  assert.equal(funnelPosition(0.99, 0.6, 5), 'building'); // n<10 → building regardless
  assert.equal(MIN_STRATUM_N, 30);
});
