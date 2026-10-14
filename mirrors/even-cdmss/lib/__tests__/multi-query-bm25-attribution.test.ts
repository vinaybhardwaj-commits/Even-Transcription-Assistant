// lib/__tests__/multi-query-bm25-attribution.test.ts — BM25 attribution through multi-query fusion.
// Closes the gap where a chunk arriving via a LATER variant's BM25 leg lost its bm25_rank (the fused
// hit kept only the first sighting). Exercised with INJECTED collaborators — no DB/LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveMultiQuery, type MultiQueryDeps } from '../multi-query.ts';
import type { RetrieveResult } from '../retrieve.ts';

// A ChunkHitWithMeta-shaped hit, optionally carrying a per-variant bm25_rank (as retrieve() stamps
// under withDiagnostics).
const hit = (id: number, over: Record<string, unknown> = {}) => ({
  id, source: 'src', book: 'MKSAP 19', chapter: null, section: null, page_start: null, page_end: null,
  item_number: null, chunk_type: 'narrative', text: `chunk ${id}`, token_count: 300, similarity: 0.5,
  vector_rank: null, bm25_rank: null, ...over,
});

// per-query hit lists, keyed on the query string
const retrieveStub = (byQuery: Record<string, ReturnType<typeof hit>[]>): MultiQueryDeps['retrieveFn'] =>
  (async (q: string) => ({ hits: byQuery[q] ?? [], expandedQuery: q }) as unknown as RetrieveResult) as MultiQueryDeps['retrieveFn'];

const read = (h: unknown) => h as { bm25_rank?: number | null; bm25_variant_ranks?: (number | null)[]; variant_ranks?: (number | null)[]; rrf_score?: number };

// ── Test 1 — a chunk arriving via BM25 in variant 2 ONLY keeps its bm25_rank on the fused hit ──
test('bm25_rank surviving from a later variant is preserved (the exact bug being fixed)', async () => {
  // chunk 7 arrives in variant 2 via its BM25 leg (bm25_rank 3), and in the original via the vector leg
  // only (bm25_rank null). The old first-seen spread would have kept null and lost the attribution.
  const res = await retrieveMultiQuery('orig', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1', 'v2'],
    retrieveFn: retrieveStub({
      orig: [hit(7, { bm25_rank: null })],           // seen FIRST, via vector only
      v1: [hit(99, { bm25_rank: null })],
      v2: [hit(7, { bm25_rank: 3 })],                // same chunk, via BM25 in a LATER variant
    }),
  });
  const c7 = res.hits.find((h) => h.id === 7)!;
  assert.equal(read(c7).bm25_rank, 3, 'the later variant\'s BM25 rank must survive fusion');
});

// ── Test 2 — bm25_variant_ranks is index-aligned to variants, null-filled where absent ──
test('bm25_variant_ranks aligns to variants and is null where the chunk did not arrive via that BM25 leg', async () => {
  const res = await retrieveMultiQuery('orig', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1', 'v2'],
    retrieveFn: retrieveStub({
      orig: [hit(7, { bm25_rank: null })],   // arm 0 — vector only
      v1: [hit(7, { bm25_rank: 5 })],        // arm 1 — BM25 rank 5
      v2: [hit(7, { bm25_rank: 3 })],        // arm 2 — BM25 rank 3
    }),
  });
  const c7 = read(res.hits.find((h) => h.id === 7)!);
  assert.deepEqual(c7.bm25_variant_ranks, [null, 5, 3]);
  assert.equal(c7.bm25_variant_ranks!.length, 3, 'index-aligned to the 3 queries');
});

// ── Test 3 — scalar bm25_rank = min non-null across the array ──
test('scalar bm25_rank is the best (min) non-null across variants', async () => {
  const res = await retrieveMultiQuery('orig', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1', 'v2'],
    retrieveFn: retrieveStub({
      orig: [hit(7, { bm25_rank: 8 })],
      v1: [hit(7, { bm25_rank: 2 })],
      v2: [hit(7, { bm25_rank: 5 })],
    }),
  });
  assert.equal(read(res.hits.find((h) => h.id === 7)!).bm25_rank, 2);   // min(8,2,5)
});

// ── Test 4 — a vector-only chunk carries bm25_rank null (no false attribution) ──
test('a chunk that never arrived via any BM25 leg has bm25_rank null', async () => {
  const res = await retrieveMultiQuery('orig', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1'],
    retrieveFn: retrieveStub({
      orig: [hit(7, { bm25_rank: null })],
      v1: [hit(7, { bm25_rank: null })],
    }),
  });
  const c7 = read(res.hits.find((h) => h.id === 7)!);
  assert.equal(c7.bm25_rank, null);
  assert.deepEqual(c7.bm25_variant_ranks, [null, null]);
});

// ── Test 5 — existing variant_ranks / rrf_score behaviour unchanged (Stage A regression guard) ──
test('variant_ranks and rrf_score are unchanged by the provenance addition', async () => {
  const res = await retrieveMultiQuery('orig', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1', 'v2'],
    retrieveFn: retrieveStub({
      orig: [hit(1, { bm25_rank: null })],
      v1: [hit(2, { bm25_rank: 1 })],
      v2: [hit(2, { bm25_rank: 1 })],   // chunk 2 is rank-1 in v1 & v2
    }),
  });
  // chunk 2 (two variants) outranks chunk 1 (one) — RRF unchanged
  assert.equal(res.hits[0].id, 2);
  assert.deepEqual(read(res.hits.find((h) => h.id === 2)!).variant_ranks, [null, 1, 1]);
  assert.deepEqual(read(res.hits.find((h) => h.id === 1)!).variant_ranks, [1, null, null]);
  assert.ok(read(res.hits[0]).rrf_score! > read(res.hits[1]).rrf_score!);
});

// ── withDiagnostics is passed to each per-variant retrieve so bm25_rank gets stamped ──
test('each per-variant retrieve() is called with withDiagnostics true (so bm25_rank is populated)', async () => {
  const seenOpts: Record<string, unknown>[] = [];
  await retrieveMultiQuery('orig', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => q,
    variantsFn: async () => ['v1'],
    retrieveFn: (async (_q: string, o: Record<string, unknown>) => { seenOpts.push(o); return { hits: [hit(1)], expandedQuery: _q } as unknown as RetrieveResult; }) as unknown as MultiQueryDeps['retrieveFn'],
  });
  assert.ok(seenOpts.length >= 2);
  for (const o of seenOpts) assert.equal(o.withDiagnostics, true);
});
