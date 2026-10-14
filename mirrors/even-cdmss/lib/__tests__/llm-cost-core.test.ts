/**
 *   node --experimental-strip-types --test lib/__tests__/llm-cost-core.test.ts
 * Pure LLM cost core: model matching, tiered rates, ₹ conversion, formatting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, ratesFor, perCallInr, costInr, modelLabel, fmtInr, type Pricing } from '../llm-cost-core.ts';

const P: Pricing = {
  fxUsdInr: 94.7,
  models: [
    { match: 'flash', label: 'Gemini 2.5 Flash', inUsdPerM: 0.30, outUsdPerM: 2.50 },
    { match: 'pro', label: 'Gemini 2.5 Pro', inUsdPerM: 1.25, outUsdPerM: 10.0, hiThresholdTokens: 200000, hiInUsdPerM: 2.50, hiOutUsdPerM: 15.0 },
  ],
  fallback: { label: 'Gemini (other)', inUsdPerM: 1.25, outUsdPerM: 10.0 },
};
const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('priceFor matches flash before pro, and falls back', () => {
  assert.equal(modelLabel('gemini-2.5-flash', P), 'Gemini 2.5 Flash');
  assert.equal(modelLabel('gemini-2.5-pro', P), 'Gemini 2.5 Pro');
  assert.equal(modelLabel('gemini-3.0-ultra', P), 'Gemini (other)');
});

test('perCallInr computes ₹ from tokens (Pro base tier)', () => {
  // 10k in @ $1.25/M + 2k out @ $10/M = $0.0325 → ×94.7 ≈ ₹3.08
  near(perCallInr('gemini-2.5-pro', 10000, 2000, P), 3.08);
  // Flash: 1120 in @ $0.30/M + 240 out @ $2.50/M = $0.000936 → ₹0.089
  near(perCallInr('gemini-2.5-flash', 1120, 240, P), 0.0886, 0.01);
});

test('perCallInr applies the >200k Pro high tier', () => {
  const base = ratesFor('gemini-2.5-pro', false, P);
  const hi = ratesFor('gemini-2.5-pro', true, P);
  assert.equal(base.inRate, 1.25); assert.equal(hi.inRate, 2.50); assert.equal(hi.outRate, 15.0);
  // 250k in + 5k out at high tier: (250000*2.5 + 5000*15)/1e6 = $0.7 → ×94.7 ≈ ₹66.3
  near(perCallInr('gemini-2.5-pro', 250000, 5000, P), 66.29, 0.1);
  // flash has no high tier → hi flag ignored
  assert.equal(ratesFor('gemini-2.5-flash', true, P).inRate, 0.30);
});

test('costInr with explicit tier (aggregate path) matches base rate for summed tokens', () => {
  // A day-bucket sum of 1M in / 300k out on Pro at base tier = (1e6*1.25 + 3e5*10)/1e6 = $4.25 → ₹402.5
  near(costInr('gemini-2.5-pro', 1_000_000, 300_000, false, P), 402.48, 0.5);
});

test('fmtInr rounds with Indian grouping; paise for tiny amounts', () => {
  assert.equal(fmtInr(11040.4), '₹11,040');
  assert.equal(fmtInr(0.089, { paise: true }), '₹0.09');
  assert.equal(fmtInr(0), '₹0');
});
