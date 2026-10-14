// lib/__tests__/right-care-fixes.test.ts — the two grounding-independent defects the Slice-2
// A/B surfaced (Right-Care fixes PRD, 13-Jul-2026). Fix A: the audit's "uncertain" hedging —
// prompt discipline + a VISIBLE parse fallback. Fix B: the Order-check syncope catalog gap —
// the two new recs exist in the seed and their DETERMINISTIC recall leg hits exactly the gold
// case (C04) and none of the other check bank cases. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYZE_SYSTEM, normNetValue } from '../doc-audit-core';
import { keywordRecall, type LvcRecommendation } from '../lvc-core';
import { GROUND_BANK } from '../right-care-ground-eval-core';
import SEED from '../../data/choosing-wisely-seed.json';

const NEW_IDS = ['cwus-aan-001', 'cwus-ahaacchrs-001'] as const;

test('Fix A: ANALYZE_SYSTEM carries the verdict discipline (uncertain = equipoise only)', () => {
  assert.ok(ANALYZE_SYSTEM.includes('VERDICT DISCIPLINE'));
  assert.match(ANALYZE_SYSTEM, /"uncertain" ONLY for genuine clinical equipoise/);
  assert.match(ANALYZE_SYSTEM, /guideline-concordant care .* is "high-value"/);
  assert.match(ANALYZE_SYSTEM, /omit it rather than marking it "uncertain"/);
  // the live gate caught the model emitting non-enum verdicts ("caveat", "safety") that the
  // parser fallback laundered to 'uncertain' — the prompt now forbids them explicitly.
  assert.match(ANALYZE_SYSTEM, /MUST be exactly one of high-value \| context-dependent \| low-value \| uncertain/);
  assert.match(ANALYZE_SYSTEM, /not "caveat", "safety", "informational"/);
});

test('Fix A: normNetValue contract unchanged, but the parse fallback is now visible', () => {
  // contract: valid enums pass through untouched
  for (const v of ['high-value', 'context-dependent', 'low-value', 'uncertain']) {
    assert.equal(normNetValue(v), v);
  }
  assert.equal(normNetValue('High Value'), 'high-value');   // whitespace/case folding still works
  // fallback: unchanged value, but it WARNS (a parse hiccup must not silently look clinical)
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
  try {
    assert.equal(normNetValue('garbage-verdict'), 'uncertain');
    assert.equal(normNetValue(undefined), 'uncertain');
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 2);
  assert.match(warns[0], /parse fallback, not a clinical judgment/);
});

type SeedRec = LvcRecommendation & { verbatim_verified: boolean };
const seedRecs = (SEED as { recommendations: SeedRec[] }).recommendations;

test('Fix B: the two syncope recs are in the seed, verified, unique, well-formed', () => {
  const ids = seedRecs.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'seed ids must stay unique');
  for (const id of NEW_IDS) {
    const r = seedRecs.find((x) => x.id === id);
    assert.ok(r, `${id} missing from the seed`);
    assert.equal(r!.verbatim_verified, true, `${id} must be verified or the loader parks it`);
    assert.equal(r!.status, 'active');
    assert.equal(r!.region, 'US');
    assert.match(r!.statement, /syncope/i);
    assert.ok((r!.keywords ?? []).includes('syncope'), `${id} needs the syncope recall keyword`);
  }
});

test('Fix B gold: deterministic recall hits C04 with BOTH new recs, and no other check case', () => {
  const newRecs = seedRecs.filter((r) => (NEW_IDS as readonly string[]).includes(r.id));
  assert.equal(newRecs.length, 2);
  for (const c of GROUND_BANK.filter((x) => x.mode === 'check')) {
    const hits = keywordRecall(c.scenario!, (c.proposedActions ?? []).map((name) => ({ name })), newRecs);
    if (c.id === 'C04') {
      assert.deepEqual(hits.map((r) => r.id).sort(), [...NEW_IDS].sort(),
        'C04 (simple syncope + CT head + carotid doppler) must recall both new recs');
    } else {
      assert.deepEqual(hits, [], `${c.id} must not recall the syncope recs (regression guard)`);
    }
  }
});
