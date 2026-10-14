/**
 * lib/__tests__/reasoning-outcome.test.ts — Reasoning Observability Stage 3
 * (version→outcome). Pure coverage; no DB, no scorer re-run:
 *
 *   1. outcomeForPrompt maps the committed scorecard's metrics to the right prompt +
 *      version/hash; unknown / no-gold ids → null.
 *   2. RECOMPUTE: the reported arm stats are re-derived from the scorecard's RAW runs
 *      against the ratified gold bank, reusing the harness's own score/aggregate functions
 *      (read-only import) — the panel's numbers cannot drift from the raw evidence.
 *   3. The maturity gate rejects 'mature' without a cleared gold — and the LIVE manifests
 *      pass it (the CI assertion the PRD asks for).
 *   4. The provenance label source composes 'guideline-derived' for cwus-ahaacchrs-001.
 *   5. Determinism: two calls produce identical outcomes; the measured hash matches the
 *      live registry today (evidence is current).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { outcomeForPrompt, allOutcomes, outcomeClearsGold, maturityGateViolations, GOLD_PASS_FLOOR, type PromptOutcome } from '../reasoning/outcome-core';
import { promptFingerprint } from '../reasoning/registry-core';
import { PROMPT_MANIFESTS } from '../reasoning/manifest';
import { scoreCheckAgainstGold, aggregateCheckGold } from '../right-care-ground-eval-core';
import SCORECARD from '../../data/right-care-eval/check-gold-scorecard-v1.json';
import GOLD_BANK from '../../data/right-care-eval/check-gold-1.0.json';
import SEED from '../../data/choosing-wisely-seed.json';

const ROOT = path.join(__dirname, '..', '..');

interface RawStat { mean: number; std: number; perRepeat: number[] }
interface RawArm { recall: RawStat; specificity: RawStat; precision: RawStat; f1: RawStat; perRepeat: Array<Record<string, number>> }
const sc = SCORECARD as unknown as {
  version: string; gold: string; repeats: number;
  armStats: { off: RawArm; on: RawArm };
  caseTable: Array<{ id: string }>;
  runs: Array<{ id: string; arm: 'off' | 'on'; k: number; fired: string[] }>;
};
const bank = GOLD_BANK as unknown as { cases: Array<{ id: string; gold: { mustFire: string[]; mustNotFire: string[] } }> };

test('outcomeForPrompt maps the committed scorecard to the right prompt version/hash', () => {
  const o = outcomeForPrompt('lvc-core/JUDGE_SYSTEM');
  assert.ok(o, 'Order check has an outcome');
  assert.equal(o!.gold, 'right-care-check-gold/1.0');
  assert.equal(o!.scorecard, sc.version);
  assert.equal(o!.cases, 36);
  assert.equal(o!.repeats, 5);
  const base = o!.arms.find((a) => a.arm === 'ungrounded')!;
  const grounded = o!.arms.find((a) => a.arm === 'grounded')!;
  // Headline numbers straight off the committed artifact. Re-measured 16-Jul-2026 on the
  // calibrated JUDGE_SYSTEM: grounded 1.0 recall improved 97.8% → 100% (non-regressed).
  assert.equal(base.recall.mean, 1, 'ungrounded recall 100%');
  assert.equal(base.f1.mean, 1);
  assert.equal(base.specificity.mean, 1);
  assert.equal(grounded.recall.mean, sc.armStats.on.recall.mean, 'grounded recall 100%');
  assert.equal(grounded.recall.mean, 1);
  assert.equal(grounded.f1.mean, sc.armStats.on.f1.mean);
  // ₹/p50 are honest nulls — the harness never recorded them.
  assert.equal(o!.rupeesPerRun, null);
  assert.equal(o!.p50Ms, null);
  // No-gold / unknown ids → null, never a throw.
  assert.equal(outcomeForPrompt('pathway-core/ENRICH_SYSTEM'), null);
  assert.equal(outcomeForPrompt('no-such/PROMPT'), null);
});

test('RECOMPUTE: arm stats re-derive from the raw runs via the harness scorer — no drift', () => {
  const goldById = new Map(bank.cases.map((c) => [c.id, c.gold]));
  for (const arm of ['off', 'on'] as const) {
    const perRepeatRecall: number[] = [];
    for (let k = 1; k <= sc.repeats; k++) {
      const rows = sc.runs
        .filter((r) => r.arm === arm && r.k === k)
        .map((r) => {
          const gold = goldById.get(r.id);
          assert.ok(gold, `gold case ${r.id} exists in the ratified bank`);
          return { score: scoreCheckAgainstGold(r.fired, gold!), mustNotFireTargets: gold!.mustNotFire.length };
        });
      assert.equal(rows.length, 36, `arm=${arm} k=${k} covers all 36 cases`);
      const m = aggregateCheckGold(rows);
      const reported = sc.armStats[arm].perRepeat[k - 1];
      assert.equal(m.recall, reported.recall, `recall arm=${arm} k=${k}`);
      assert.equal(m.specificity, reported.specificity, `specificity arm=${arm} k=${k}`);
      assert.equal(m.f1 ?? 0, reported.f1, `f1 arm=${arm} k=${k}`);
      perRepeatRecall.push(m.recall);
    }
    const mean = perRepeatRecall.reduce((a, b) => a + b, 0) / perRepeatRecall.length;
    assert.ok(Math.abs(mean - sc.armStats[arm].recall.mean) < 1e-9, `recall mean arm=${arm}`);
  }
});

test('maturity gate: mature requires a cleared gold; the LIVE manifests pass (CI assertion)', () => {
  // The real gate — must be green on every commit.
  assert.deepEqual(maturityGateViolations(PROMPT_MANIFESTS), [], 'live manifests violate no maturity rule');

  // Synthetic: 'mature' with no gold at all → rejected.
  const noGold = maturityGateViolations([{ id: 'pathway-core/ENRICH_SYSTEM', maturity: 'mature' }]);
  assert.equal(noGold.length, 1);
  assert.match(noGold[0], /NO committed gold/);

  // Synthetic: 'mature' with a failing gold → rejected; with a clearing, current gold → allowed.
  const failing: PromptOutcome = { ...outcomeForPrompt('lvc-core/JUDGE_SYSTEM')!, arms: [{ arm: 'ungrounded', flag: '', recall: { mean: 0.5, std: 0 }, specificity: { mean: 1, std: 0 }, precision: { mean: 1, std: 0 }, f1: { mean: 0.66, std: 0 } }] };
  assert.equal(outcomeClearsGold(failing), false);
  assert.match(maturityGateViolations([{ id: 'x/Y', maturity: 'mature' }], () => failing)[0], /below the 0.9 floor/);
  const passing = outcomeForPrompt('lvc-core/JUDGE_SYSTEM')!;
  assert.equal(outcomeClearsGold(passing), true, `baseline clears the ${GOLD_PASS_FLOOR} floor`);
  assert.deepEqual(maturityGateViolations([{ id: 'x/Y', maturity: 'mature' }], () => passing), []);

  // Stale-hash guard: a clearing gold measured on OLD prompt bytes cannot hold 'mature'.
  const stale: PromptOutcome = { ...passing, current: false };
  assert.match(maturityGateViolations([{ id: 'x/Y', maturity: 'mature' }], () => stale)[0], /changed since its gold was measured/);
});

test('provenance rider: cwus-ahaacchrs-001 labels as guideline-derived', () => {
  const seed = SEED as unknown as { recommendations: Array<{ id: string; society: string; region: string; source_release_year: number; notes?: string }> };
  const rec = seed.recommendations.find((r) => r.id === 'cwus-ahaacchrs-001')!;
  assert.ok(rec, 'seed row exists');
  assert.match(rec.notes ?? '', /guideline-derived/i, 'the seed notes mark it guideline-derived');
  // The label composer's exact conditional (app/api/admin/seed-choosing-wisely/route.ts):
  const label = `Source: ${rec.society} (${/guideline-derived/i.test(rec.notes ?? '') ? 'guideline-derived' : 'Choosing Wisely'}, ${rec.region}, ${rec.source_release_year}).`;
  assert.equal(label, 'Source: AHA/ACC/HRS (guideline-derived, US, 2017).');
  const routeText = readFileSync(path.join(ROOT, 'app', 'api', 'admin', 'seed-choosing-wisely', 'route.ts'), 'utf8');
  assert.ok(routeText.includes(`/guideline-derived/i.test(r.notes ?? '') ? 'guideline-derived' : 'Choosing Wisely'`), 'route carries the conditional label');
  // An ordinary ABIM list item keeps the original label.
  const plain = seed.recommendations.find((r) => r.id === 'cwus-aabb-001');
  if (plain) assert.ok(!/guideline-derived/i.test(plain.notes ?? ''), 'ABIM rows unaffected');
});

test('determinism + evidence currency', () => {
  assert.deepEqual(outcomeForPrompt('lvc-core/JUDGE_SYSTEM'), outcomeForPrompt('lvc-core/JUDGE_SYSTEM'));
  assert.equal(allOutcomes().length, 1, 'Order check is the only gold-backed vertical today');
  const o = outcomeForPrompt('lvc-core/JUDGE_SYSTEM')!;
  assert.equal(o.measuredHash, promptFingerprint('lvc-core/JUDGE_SYSTEM')!.hash, 'prompt bytes unchanged since the 16-Jul-2026 calibration re-pin');
  assert.equal(o.current, true);
});
