/**
 *   node --experimental-strip-types --test lib/__tests__/lvc-core.test.ts
 * Pure appropriateness/low-value-care matcher gate (lvc-core). Required before LL.2b wires
 * approved rules into lvc_recommendations — the matcher behaviour must be pinned by tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keywordRecall, passesFloor, assembleFlags, dedupeById, confidenceFloorFor,
  type LvcRecommendation, type JudgedRec,
} from '../lvc-core.ts';

function rec(id: string, keywords: string[], over: Partial<LvcRecommendation> = {}): LvcRecommendation {
  return {
    id, region: 'IN', society: 'EHRC', specialty: null,
    statement: `Avoid ${id}`, precondition: null, action_type: 'other', consider_instead: null,
    rationale: 'low yield', keywords, citation_doi: null, citation_pmid: '123', citation_url: 'https://pubmed.ncbi.nlm.nih.gov/123/',
    source_release_year: 2025, status: 'active', ...over,
  };
}

test('keywordRecall: substring match on normalized haystack; <3-char keywords ignored', () => {
  const recs = [
    rec('r-ppi', ['esomeprazole', 'ppi']),
    rec('r-warf', ['warfarin']),
    rec('r-short', ['pa']), // <3 chars → ignored, must not match
  ];
  const hit = keywordRecall('Epigastric pain, prescribed Esomeprazole 40mg BD', [{ name: 'esomeprazole' }], recs);
  assert.deepEqual(hit.map((r) => r.id), ['r-ppi']); // warfarin absent; 'pa' ignored
});

test('passesFloor: only "applies" above the surface floor fires (two-tier)', () => {
  assert.equal(confidenceFloorFor('surface'), 0.5);
  assert.equal(confidenceFloorFor('autoflag'), 0.75);
  assert.equal(passesFloor({ verdict: 'applies', confidence: 0.6 }, 'surface'), true);
  assert.equal(passesFloor({ verdict: 'applies', confidence: 0.4 }, 'surface'), false);
  assert.equal(passesFloor({ verdict: 'applies', confidence: 0.6 }, 'autoflag'), false); // below 0.75
  assert.equal(passesFloor({ verdict: 'applies', confidence: 0.8 }, 'autoflag'), true);
  assert.equal(passesFloor({ verdict: 'does_not_apply', confidence: 0.99 }, 'surface'), false);
  assert.equal(passesFloor({ verdict: 'insufficient_info', confidence: 0.99 }, 'surface'), false);
});

test('assembleFlags: gates, sorts by confidence desc, maps citation', () => {
  const judged: JudgedRec[] = [
    { rec: rec('low', ['x']), verdict: 'applies', confidence: 0.55, why: 'w1', consider_instead: 'alt' },
    { rec: rec('high', ['y']), verdict: 'applies', confidence: 0.9, why: 'w2', consider_instead: null },
    { rec: rec('dropped', ['z']), verdict: 'applies', confidence: 0.3, why: 'w3', consider_instead: null }, // below floor
    { rec: rec('na', ['q']), verdict: 'does_not_apply', confidence: 0.99, why: 'w4', consider_instead: null },
  ];
  const flags = assembleFlags(judged, 'surface');
  assert.deepEqual(flags.map((f) => f.id), ['high', 'low']); // 0.3 + does_not_apply gated out, sorted desc
  assert.equal(flags[0].citation.pmid, '123');
  assert.equal(flags[1].consider_instead, 'alt');
});

test('dedupeById keeps first occurrence across lists', () => {
  const a = [rec('1', []), rec('2', [])];
  const b = [rec('2', []), rec('3', [])];
  assert.deepEqual(dedupeById(a, b).map((r) => r.id), ['1', '2', '3']);
});
