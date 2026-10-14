// lib/__tests__/normative-leg.test.ts — CDMSS-NORMATIVE-LEG-PRD §2.5 (R-11 Stage 1).
// Pure unit tests for the dormant, opt-in normative retrieval leg — no DB. Tests 1 & 5 are the
// score-invariance guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveMultiQuery, type MultiQueryDeps } from '../multi-query.ts';
import {
  buildFilterClauses, renderFilterSql, normativeVectorSql, resolveNormativeSources,
  normativeLegK, DEFAULT_NORMATIVE_SOURCES,
} from '../retrieve.ts';
import type { RetrieveResult } from '../retrieve.ts';

// ── Test 3 — default normativeSources = ['choosing-wisely']; labq:% never included by default ──
test('resolveNormativeSources defaults to choosing-wisely + the two activated guideline keys; never labq:% by default', () => {
  // default now includes the Even/ICMR activated (lab:) keys — inert until activation (23 Jul allowlist)
  const DEF = ['choosing-wisely', 'lab:guidelines-even-protocols', 'lab:guidelines-icmr-amr-2019'];
  assert.deepEqual(resolveNormativeSources(undefined, undefined), DEF);
  assert.deepEqual(DEFAULT_NORMATIVE_SOURCES, DEF);
  assert.equal(DEFAULT_NORMATIVE_SOURCES[0], 'choosing-wisely', 'choosing-wisely stays first, unchanged');
  // env may add ACTIVATED lab: sources, but quarantined labq: is stripped
  assert.deepEqual(resolveNormativeSources(undefined, 'lab:guidelines-hf, labq:secret-batch'), [...DEF, 'lab:guidelines-hf']);
  // an EXPLICIT list (lab measurement) is honoured as-is — the "name it to include it" affordance
  assert.deepEqual(resolveNormativeSources(['labq:guidelines-lvc-22jul'], undefined), ['labq:guidelines-lvc-22jul']);
  assert.deepEqual(resolveNormativeSources([], 'lab:x'), [...DEF, 'lab:x']);   // empty explicit ⇒ default+env
});

// ── Test 6 — N_norm reads env, defaults 5 ──
test('normativeLegK reads env NORMATIVE_LEG_K, defaults 5', () => {
  assert.equal(normativeLegK(undefined), 5);
  assert.equal(normativeLegK(''), 5);
  assert.equal(normativeLegK('7'), 7);
  assert.equal(normativeLegK('0'), 5);       // non-positive ⇒ default
  assert.equal(normativeLegK('abc'), 5);     // non-numeric ⇒ default
  assert.equal(normativeLegK('12'), 12);
});

// ── Test 2 — the third leg is the vector query filtered to source = ANY($n), LIMIT N_norm ──
test('the normative leg is the vector SQL filtered to source = ANY, capped at N_norm', () => {
  const { clauses, params } = buildFilterClauses({ restrictSources: ['choosing-wisely'] });
  const normFilterSQL = renderFilterSql(clauses, 3);   // $FP_0 → $3, after $1=vlit $2=minSim
  const sql = normativeVectorSql('embedding', normFilterSQL, 5);
  // same shape as the main vector leg
  assert.ok(sql.includes('ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector)'));
  assert.ok(sql.includes('1 - (embedding <=> $1::vector) > $2'));
  assert.ok(sql.includes('embedding IS NOT NULL'));
  // restricted to the normative sources via the SHIPPED source = ANY($n) shape (bound array, not interpolated)
  assert.ok(sql.includes('source = ANY($3)'), 'must reuse restrictSources source = ANY($n)');
  assert.ok(!sql.includes('choosing-wisely'), 'sources are a bound param, never interpolated');
  assert.ok(sql.includes('LIMIT 5'), 'capped at N_norm');
  assert.deepEqual(params, [['choosing-wisely']]);
});

// ── Test 1 — the leg does not touch the default filter clauses (byte-identical default path) ──
test('the normative leg leaves the default filter clauses byte-identical', () => {
  // The default retrieve() filter (no restrictSources / no normative opt) is unchanged; the leg is a
  // SEPARATE query built ONLY when useNormativeLeg is set. buildFilterClauses with no opts is today's.
  const { clauses, params } = buildFilterClauses({});
  assert.deepEqual(clauses, ['text IS NOT NULL', 'visible IS NOT FALSE', "source NOT LIKE 'labq:%'"]);
  assert.deepEqual(params, []);
});

// ── Test 5 (thread) — useNormativeLeg threads through multi-query to each per-variant retrieve ──
test('useNormativeLeg + normativeSources thread through retrieveMultiQuery to each per-variant retrieve', async () => {
  const seenOpts: Record<string, unknown>[] = [];
  await retrieveMultiQuery('q', { topK: 5, useReranker: false, useSourceWeights: false, useNormativeLeg: true, normativeSources: ['choosing-wisely'] }, {
    expandFn: async (query) => query,
    variantsFn: async () => ['v1', 'v2'],
    retrieveFn: (async (_q: string, o: Record<string, unknown>) => { seenOpts.push(o); return { hits: [], expandedQuery: _q } as unknown as RetrieveResult; }) as unknown as MultiQueryDeps['retrieveFn'],
  });
  assert.equal(seenOpts.length, 3, 'original + 2 variants');
  for (const o of seenOpts) {
    assert.equal(o.useNormativeLeg, true, 'the leg opt reaches every variant');
    assert.deepEqual(o.normativeSources, ['choosing-wisely']);
  }
});
