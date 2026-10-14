// Inquiry K1 — inquiry-eval-core (PRD §15): scorer determinism; the baseline harness runs on the
// 2 shipped fixture cases (placeholder:true — real gold lands via V ratification, D13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGold, scoreCase, aggregateScores, subjectMatches, isGenericQuestion, INQUIRY_GOLD_VERSION } from '../inquiry/inquiry-eval-core';
import { buildAskSet } from '../care-call-core';
import { deriveUnknowns } from '../inquiry/unknowns-core';
import { candidatesFromUnknowns } from '../inquiry/inquiry-core';
import type { DeidOpdCase } from '../opd-ingest-core';

const GOLD = JSON.parse(readFileSync(join(process.cwd(), 'data/inquiry-eval/inquiry-gold-1.0.json'), 'utf8'));

test('scorer is deterministic and the metric arithmetic is exact', () => {
  const bank = parseGold(GOLD);
  assert.equal(bank.version, INQUIRY_GOLD_VERSION);
  const c = bank.cases[0];
  const served = { asks: [{ id: 'MED_STATUS:insulin-glargine-lantus-100-iu-ml', family: 'MED_STATUS' as const, subject: 'Insulin glargine (Lantus 100 IU/ml)', question: 'Doctor prescribed Insulin glargine — are you taking it?' }], source: 'inquiry' };
  const a = scoreCase(c, served);
  const b = scoreCase(c, served);
  assert.deepEqual(a, b, 'double-scoring is identical');
  assert.equal(a.rightFirst, true);
  assert.equal(a.familyLegal, true);
  const agg = aggregateScores([
    { caseId: 'x', rightFirst: true, familyLegal: true, slotAppropriate: true, askCount: 4, genericCount: 1, fallback: false },
    { caseId: 'y', rightFirst: false, familyLegal: true, slotAppropriate: false, askCount: 4, genericCount: 0, fallback: true },
  ]);
  assert.equal(agg.runs, 2);
  assert.equal(agg.rightFirstRate, 0.5);
  assert.equal(agg.familyLegalityRate, 1);
  assert.equal(agg.slotAppropriateRate, 0.5);
  assert.equal(agg.genericRate, 0.125);
  assert.equal(agg.fallbackRate, 0.5);
  // matching primitives
  assert.ok(subjectMatches('Insulin glargine', 'Insulin glargine (Lantus 100 IU/ml)'));
  assert.equal(subjectMatches('Telmisartan', 'Atorvastatin'), false);
  assert.ok(isGenericQuestion({ subject: 'knee pain', question: 'How are you doing overall?' }));
  assert.equal(isGenericQuestion({ subject: 'knee pain', question: 'How is the knee pain today?' }), false);
});

test('A1 split: family-legality is vocabulary-only; legalSlots23 lands in slotAppropriate, not the gate', () => {
  const goldCase = {
    id: 'SPLIT1',
    fixture: { episode: {}, snapshot: null, now: '2026-07-15T00:00:00.000Z', keys: { presc_uid: 'p1234567', individual_uid: 'i1234567' } },
    expected: {
      first: { family: 'MED_STATUS' as const, subject: 'Metformin' },
      legalSlots23: [{ family: 'COMPLAINT_STATUS' as const, subject: 'cough' }],
    },
  };
  const first = { id: 'MED_STATUS:metformin', family: 'MED_STATUS' as const, subject: 'Metformin', question: 'Doctor prescribed Metformin — are you taking it?' };
  // slot 2 is a LEGAL family (OUTSIDE_RECORDS) but OUTSIDE the allow-list → gate passes, slot check reports false
  const outsideAllowList = scoreCase(goldCase, {
    asks: [first, { id: 'OUTSIDE_RECORDS:x', family: 'OUTSIDE_RECORDS' as const, subject: '', question: 'Do you have that report?' }],
    source: 'inquiry',
  });
  assert.equal(outsideAllowList.familyLegal, true, 'legal vocabulary ⇒ the gate passes');
  assert.equal(outsideAllowList.slotAppropriate, false, 'outside legalSlots23 ⇒ reported, not gated');
  // an out-of-band family fails the GATE regardless of the allow-list
  const illegalFamily = scoreCase(goldCase, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    asks: [first, { id: 'FREE_TEXT:x', family: 'FREE_TEXT' as any, subject: '', question: 'Anything else?' }],
    source: 'inquiry',
  });
  assert.equal(illegalFamily.familyLegal, false, 'out-of-band family breaks the safety gate');
  // slot check within the allow-list reports true
  const inAllowList = scoreCase(goldCase, {
    asks: [first, { id: 'COMPLAINT_STATUS:cough', family: 'COMPLAINT_STATUS' as const, subject: 'cough', question: 'You came in for cough — how is it now?' }],
    source: 'inquiry',
  });
  assert.equal(inAllowList.familyLegal, true);
  assert.equal(inAllowList.slotAppropriate, true);
});

test('baseline harness runs on the shipped RATIFIED bank (deterministic arm, no LLM)', () => {
  // Bank pins updated with the ratified gold land (V, 15 Jul) — same-commit mechanism as the
  // registry count pins (PRD addendum B1 item 3). Baseline OUTCOMES are deliberately NOT pinned
  // here: what the deterministic arm scores on the ratified gold is the bench's business
  // (scripts/inquiry-gold.mjs → floor addendum A1), not a unit invariant.
  const bank = parseGold(GOLD);
  assert.equal(bank.cases.length, 30, 'the ratified inquiry-gold/1.0 bank (30 cases)');
  assert.ok(bank.cases.every((c) => c.placeholder !== true), 'no placeholder cases remain post-ratification');
  const run = () => bank.cases.map((c) => {
    const episode = c.fixture.episode as unknown as DeidOpdCase;
    const served = buildAskSet(episode, c.fixture.keys);
    // the fixtures also exercise the derivation + candidate layers end-to-end
    const unknowns = deriveUnknowns({ episode, snapshot: (c.fixture.snapshot ?? null) as never, now: c.fixture.now });
    const cands = candidatesFromUnknowns(unknowns, episode, c.fixture.keys);
    assert.ok(cands.length >= served.asks.length, `${c.id}: candidates ⊇ baseline`);
    return scoreCase(c, { asks: served.asks, source: 'baseline' });
  });
  const scores = run();
  assert.deepEqual(scores, run(), 'deterministic arm scores identically on a double run');
  const agg = aggregateScores(scores);
  assert.equal(agg.runs, 30);
  assert.ok(agg.rightFirstRate >= 0 && agg.rightFirstRate <= 1);
  assert.ok(agg.familyLegalityRate >= 0 && agg.familyLegalityRate <= 1);
  assert.equal(agg.fallbackRate, 0, 'the deterministic arm never falls back');
});
