// lib/__tests__/multi-query-fusion.test.ts — CDMSS-RETRIEVAL-FUSION-PRD §2.5, Stage A.
// The fusion is exercised through retrieveMultiQuery with INJECTED collaborators (retrieveFn /
// rerankFn / variantsFn), so the RRF → single-rerank → source-weight logic is verified with no DB
// or LLM. Tests 1 and 4 are the R-1/R-3 regression guards; test 7 is the R-6 guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveMultiQuery, type MultiQueryDeps } from '../multi-query.ts';
import { assertEmbeddingV2Available, EmbeddingV2ColumnMissingError } from '../retrieve.ts';
import type { RetrieveResult } from '../retrieve.ts';

// minimal ChunkHit factory
const chunk = (id: number, over: Record<string, unknown> = {}) => ({
  id, source: 'src', book: 'MKSAP 19', chapter: null, section: null, page_start: null, page_end: null,
  item_number: null, chunk_type: 'narrative', text: `chunk ${id}`, token_count: 300, similarity: 0.5, ...over,
});

// a retrieveFn stub whose per-query hit lists are supplied by a map keyed on the query string
const retrieveStub = (byQuery: Record<string, ReturnType<typeof chunk>[]>): MultiQueryDeps['retrieveFn'] =>
  (async (q: string) => ({ hits: byQuery[q] ?? [], expandedQuery: q }) as unknown as RetrieveResult) as MultiQueryDeps['retrieveFn'];

// ── Test 1 — fusion is RRF-based, NOT raw-cosine (the R-1/R-3 regression guard) ──
test('RRF fusion: a chunk ranked #1 by two variants beats a chunk ranked #1 by one variant with higher cosine', async () => {
  // A is rank-1 in v1 and v2 (rrf = 2/(60+1)); B is rank-1 in the original only, with a HIGHER cosine.
  const A = chunk(1, { similarity: 0.60 });
  const B = chunk(2, { similarity: 0.99 });
  const res = await retrieveMultiQuery('orig', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1', 'v2'],
    retrieveFn: retrieveStub({ orig: [B], v1: [A], v2: [A] }),
  });
  assert.equal(res.hits[0].id, 1, 'A (twice rank-1) must outrank B despite B having higher cosine');
  assert.equal(res.hits[1].id, 2);
  // proof the old defect is gone: B has the higher similarity yet loses.
  assert.ok(res.hits[1].similarity > res.hits[0].similarity);
  // rrf_score exposed and ordered
  assert.ok(res.hits[0].rrf_score! > res.hits[1].rrf_score!);
  // variant_ranks index-aligned to variants [orig, v1, v2]
  assert.deepEqual(res.hits[0].variant_ranks, [null, 1, 1]);
  assert.deepEqual(res.hits[1].variant_ranks, [1, null, null]);
});

// ── Test 2 — rerank called EXACTLY once, with the ORIGINAL question ──
test('rerank runs once over the fused pool against the original question — never a variant', async () => {
  const calls: { query: string; n: number }[] = [];
  const res = await retrieveMultiQuery('the original question', { topK: 5, useReranker: true, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['variant one', 'variant two'],
    retrieveFn: retrieveStub({ 'the original question': [chunk(1)], 'variant one': [chunk(2)], 'variant two': [chunk(3)] }),
    rerankFn: (async (query: string, cands: { __orig: unknown }[]) => {
      calls.push({ query, n: cands.length });
      return cands.map((c, i) => ({ ...c, rerank_score: 1 - i / cands.length, rerank_backend: 'judge' as const }));
    }) as unknown as MultiQueryDeps['rerankFn'],
  });
  assert.equal(calls.length, 1, 'rerank must be called exactly once');
  assert.equal(calls[0].query, 'the original question', 'rerank must use the original question, not a variant');
  assert.ok(res.hits.every((h) => typeof (h as { rerank_score?: number }).rerank_score === 'number'));
});

// ── Test 3 — source weights applied after rerank: 0.95-tier beats 0.80-tier at equal rerank score ──
test('source weighting: a guidelines (0.95) chunk outranks an unknown-journal (0.80) chunk at equal rerank score', async () => {
  const guideline = chunk(1, { book: 'ACC/AHA guidelines', similarity: 0.5 });   // bookTier 'guidelines' → 0.95
  const unknown = chunk(2, { book: 'Some Unknown Journal', similarity: 0.5 });    // unknown-book default → 0.80
  const res = await retrieveMultiQuery('q', { topK: 5, useReranker: true, useSourceWeights: true }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1'],
    retrieveFn: retrieveStub({ q: [unknown], v1: [guideline] }),
    // equal rerank score for both, so ordering is decided purely by source weight
    rerankFn: (async (_query: string, cands: unknown[]) =>
      (cands as { __orig: unknown }[]).map((c) => ({ ...c, rerank_score: 0.5, rerank_backend: 'judge' as const }))) as unknown as MultiQueryDeps['rerankFn'],
  });
  assert.equal(res.hits[0].id, 1, 'the 0.95-tier guideline chunk must sort first');
  const w = (h: unknown) => (h as { source_quality_weight?: number }).source_quality_weight ?? 0;
  assert.ok(w(res.hits[0]) > w(res.hits[1]));
});

// ── Test 4 — per-variant calls run with reranker/weights OFF; those stages happen once at fusion ──
test('per-variant retrieve() runs with useReranker/useSourceWeights false; fusion reranks once', async () => {
  const perVariantOpts: Record<string, unknown>[] = [];
  let rerankCalls = 0;
  await retrieveMultiQuery('orig', { topK: 5, useReranker: true, useSourceWeights: true }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1', 'v2'],
    retrieveFn: (async (q: string, o: Record<string, unknown>) => {
      perVariantOpts.push(o);
      return { hits: [chunk(q === 'orig' ? 1 : q === 'v1' ? 2 : 3)], expandedQuery: q } as unknown as RetrieveResult;
    }) as unknown as MultiQueryDeps['retrieveFn'],
    rerankFn: (async (_q: string, cands: unknown[]) => { rerankCalls++; return (cands as { __orig: unknown }[]).map((c, i) => ({ ...c, rerank_score: 1 - i, rerank_backend: 'judge' as const })); }) as unknown as MultiQueryDeps['rerankFn'],
  });
  assert.equal(perVariantOpts.length, 3, 'original + 2 variants = 3 retrievals');
  for (const o of perVariantOpts) {
    assert.equal(o.useReranker, false, 'variant-level reranker must be OFF');
    assert.equal(o.useSourceWeights, false, 'variant-level source weighting must be OFF');
    assert.equal(o.skipExpand, true, 'variants are already reformulations — no expansion');
  }
  assert.equal(rerankCalls, 1, 'rerank happens ONCE, at fusion');
});

// ── Test 5 — variant-generation failure ⇒ original query alone, no throw ──
test('variant generation returning nothing falls back to the original query alone, no throw', async () => {
  const res = await retrieveMultiQuery('lone question', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => [],   // present .catch() behaviour: failure ⇒ []
    retrieveFn: retrieveStub({ 'lone question': [chunk(1), chunk(2)] }),
  });
  assert.deepEqual(res.variants, ['lone question']);
  assert.equal(res.perVariantCounts.length, 1);
  assert.equal(res.hits.length, 2);
  assert.deepEqual(res.hits[0].variant_ranks, [1]);   // single query ⇒ single-element rank vector
});

// ── Test 6 — diagnostics populate without includeQuarantined (the lab_retrieve multiQuery arm) ──
test('multi-query hits always carry rrf_score + variant_ranks — no includeQuarantined needed', async () => {
  const res = await retrieveMultiQuery('q', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1'],
    retrieveFn: retrieveStub({ q: [chunk(1)], v1: [chunk(1), chunk(2)] }),
  });
  for (const h of res.hits) {
    assert.equal(typeof h.rrf_score, 'number');
    assert.ok(Array.isArray(h.variant_ranks) && h.variant_ranks.length === 2);
  }
});

// ── Test 7 — R-6 guard raises a NAMED error rather than a silently-empty vector leg ──
test('R-6 guard: assertEmbeddingV2Available throws a named error when v2 is on but the column is absent', () => {
  assert.throws(() => assertEmbeddingV2Available(true, false), (e: unknown) => {
    assert.ok(e instanceof EmbeddingV2ColumnMissingError);
    assert.equal((e as Error).name, 'EmbeddingV2ColumnMissingError');
    return true;
  });
  assert.doesNotThrow(() => assertEmbeddingV2Available(true, true));   // column present ⇒ fine
  assert.doesNotThrow(() => assertEmbeddingV2Available(false, false)); // v2 off ⇒ never fires (production)
});
