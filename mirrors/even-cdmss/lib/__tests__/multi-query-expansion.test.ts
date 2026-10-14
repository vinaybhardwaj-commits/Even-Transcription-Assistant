// lib/__tests__/multi-query-expansion.test.ts — CDMSS-QUERY-EXPANSION-PRD §3.4 (R-8, Stage A-2).
// Verifies query expansion is restored to the multi-query path with INJECTED collaborators
// (expandFn / retrieveFn / variantsFn) — no DB or LLM. Test 4 is the D3 regression guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveMultiQuery, type MultiQueryDeps } from '../multi-query.ts';
import type { RetrieveResult } from '../retrieve.ts';

const chunk = (id: number, over: Record<string, unknown> = {}) => ({
  id, source: 'src', book: 'MKSAP 19', chapter: null, section: null, page_start: null, page_end: null,
  item_number: null, chunk_type: 'narrative', text: `chunk ${id}`, token_count: 300, similarity: 0.5, ...over,
});

// a retrieveFn that records the query text of every call and returns one hit per call
const recordingRetrieve = (seen: string[]): MultiQueryDeps['retrieveFn'] =>
  (async (q: string) => { seen.push(q); return { hits: [chunk(1)], expandedQuery: q } as unknown as RetrieveResult; }) as MultiQueryDeps['retrieveFn'];

// ── Test 1 — expandQuery called EXACTLY once, with the original question ──
test('expandQuery runs exactly once, on the original question', async () => {
  const expandCalls: string[] = [];
  await retrieveMultiQuery('the original q', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => { expandCalls.push(q); return `EXPANDED::${q}`; },
    variantsFn: async () => ['v1', 'v2'],
    retrieveFn: recordingRetrieve([]),
  });
  assert.equal(expandCalls.length, 1, 'expandQuery must be called exactly once');
  assert.equal(expandCalls[0], 'the original q', 'expandQuery must receive the ORIGINAL question');
});

// ── Test 2 — original arm gets the EXPANDED text; variant arms get the VARIANT text ──
test('the original arm retrieves on expanded text; variant arms retrieve on variant text', async () => {
  const seen: string[] = [];
  await retrieveMultiQuery('montelukast question', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => `EXPANDED::${q}`,
    variantsFn: async () => ['variant A', 'variant B'],
    retrieveFn: recordingRetrieve(seen),
  });
  assert.equal(seen.length, 3, 'original + 2 variants');
  assert.equal(seen[0], 'EXPANDED::montelukast question', 'original arm must retrieve on the expanded text');
  assert.deepEqual(seen.slice(1).sort(), ['variant A', 'variant B'], 'variant arms retrieve on raw variant text');
  // the expanded original is never mutated into a variant, and vice-versa
  assert.ok(!seen.slice(1).some((q) => q.startsWith('EXPANDED::')), 'no variant may carry the expansion');
});

// ── Test 3 — variants are generated from the ORIGINAL question, not the expanded text ──
test('variant generation runs on the original question, never the expanded paragraph', async () => {
  const variantArgs: string[] = [];
  await retrieveMultiQuery('lbp imaging', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => `EXPANDED::${q}`,
    variantsFn: async (q) => { variantArgs.push(q); return ['v1']; },
    retrieveFn: recordingRetrieve([]),
  });
  assert.deepEqual(variantArgs, ['lbp imaging'], 'variantsFn must see the ORIGINAL question, not the expansion');
});

// ── Test 4 — a caller-supplied skipExpand is RESPECTED (the D3 regression guard) ──
test('skipExpand:true from the caller turns expansion OFF — expandQuery is not called', async () => {
  const expandCalls: string[] = [];
  const seen: string[] = [];
  const res = await retrieveMultiQuery('raw question', { topK: 5, skipExpand: true, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => { expandCalls.push(q); return `EXPANDED::${q}`; },
    variantsFn: async () => ['v1'],
    retrieveFn: recordingRetrieve(seen),
  });
  assert.equal(expandCalls.length, 0, 'skipExpand:true must prevent the expansion call');
  assert.equal(seen[0], 'raw question', 'the original arm retrieves on the RAW question when expansion is off');
  assert.equal(res.expandedQuery, 'raw question', 'expandedQuery reflects the raw question when off');
});

// ── Test 5 — expansion failure ⇒ falls back to the original question, no throw ──
test('expansion fail-open (returns the original question) leaves the original arm on the raw question', async () => {
  const seen: string[] = [];
  const res = await retrieveMultiQuery('q', { topK: 5, useReranker: false, useSourceWeights: false }, {
    // expandQuery's own contract on failure is to return the original question, never throw.
    expandFn: async (q) => q,
    variantsFn: async () => ['v1'],
    retrieveFn: recordingRetrieve(seen),
  });
  assert.equal(res.expandedQuery, 'q');
  assert.equal(seen[0], 'q', 'on fail-open the original arm retrieves on the original question');
  assert.ok(res.hits.length > 0);
});

// ── Test 6 — per-variant calls STILL pass useReranker:false, useSourceWeights:false (Stage A guard) ──
test('per-variant retrieve() keeps reranker/weights OFF after expansion is restored', async () => {
  const perVariantOpts: Record<string, unknown>[] = [];
  await retrieveMultiQuery('q', { topK: 5, useReranker: true, useSourceWeights: true }, {
    expandFn: async (q) => `EXPANDED::${q}`,
    variantsFn: async () => ['v1', 'v2'],
    retrieveFn: (async (_q: string, o: Record<string, unknown>) => {
      perVariantOpts.push(o);
      return { hits: [chunk(1)], expandedQuery: _q } as unknown as RetrieveResult;
    }) as unknown as MultiQueryDeps['retrieveFn'],
  });
  assert.equal(perVariantOpts.length, 3);
  for (const o of perVariantOpts) {
    assert.equal(o.useReranker, false, 'variant-level reranker must stay OFF');
    assert.equal(o.useSourceWeights, false, 'variant-level source weighting must stay OFF');
    assert.equal(o.skipExpand, true, 'each arm hands retrieve() final text — no double-expansion');
  }
});

// ── Test 7 — expandedQuery is present on the result ──
test('expandedQuery is returned on MultiRetrieveResult', async () => {
  const res = await retrieveMultiQuery('q', { topK: 5, useReranker: false, useSourceWeights: false }, {
    expandFn: async (q) => `EXPANDED::${q}`,
    variantsFn: async () => ['v1'],
    retrieveFn: recordingRetrieve([]),
  });
  assert.equal(typeof res.expandedQuery, 'string');
  assert.equal(res.expandedQuery, 'EXPANDED::q');
});
