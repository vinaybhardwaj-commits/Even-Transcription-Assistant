// lib/__tests__/rerank-backend.test.ts — R-10 rerank backend hardening + OpenRouter Cohere ruler.
// Verifies the functional discrimination probe + 3-way error taxonomy (Stage 0) and rerankCohere
// (Stage 1). Injected fetch/clock — no network/LLM. Production stays on judge (score-invariant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  rerank, resolveRerankBackend, resolveEnvRerankBackend, assertRerankBackendHealthy, rerankCohere, _resetRerankHealth,
  RerankBackendError, RerankBackendUnreachable, RerankBackendUnhealthy, RerankBackendMissing,
  RERANK_HEALTH_MIN_REL, RERANK_HEALTH_MIN_MARGIN,
  type RerankDeps, type RerankCandidate, type RerankResult,
} from '../rerank.ts';
import { pickScoreFields } from '../mcp-tools.ts';

const cands = () => [{ id: 1, text: 'alpha' }, { id: 2, text: 'beta' }];
function countingBackend(tag: 'judge' | 'cohere', counter: { n: number }): NonNullable<RerankDeps['cohereFn']> {
  return async <U extends RerankCandidate>(_q: string, c: U[]): Promise<RerankResult<U>[]> => {
    counter.n++;
    return c.map((x, i) => ({ ...x, rerank_score: 1 - i / c.length, rerank_backend: tag }));
  };
}
// a Cohere-shaped /rerank response
const cohereRes = (pairs: [number, number][]) =>
  (async () => new Response(JSON.stringify({ results: pairs.map(([index, relevance_score]) => ({ index, relevance_score })) }), { status: 200 })) as unknown as typeof fetch;

const withKey = async (fn: () => Promise<void>) => {
  const prev = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = 'k';
  try { await fn(); } finally { if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev; }
};

// ── routing (pure) — bge is gone; judge default, cohere override ──
test('resolveRerankBackend: explicit override wins, else env default; only judge|cohere', () => {
  assert.equal(resolveRerankBackend('cohere', 'judge'), 'cohere');
  assert.equal(resolveRerankBackend('judge', 'cohere'), 'judge');
  assert.equal(resolveRerankBackend(undefined, 'judge'), 'judge');
  assert.equal(resolveRerankBackend(undefined, 'cohere'), 'cohere');
});

test('no backend arg routes to the env default (judge in the test env), not cohere', async () => {
  const judge = { n: 0 }, cohere = { n: 0 };
  await rerank('q', cands(), undefined, { judgeFn: countingBackend('judge', judge), cohereFn: countingBackend('cohere', cohere), checkHealthy: async () => {} });
  assert.equal(judge.n, 1); assert.equal(cohere.n, 0);
});

// ── §5.1 probe PASSES on a discriminating backend ──
test('assertRerankBackendHealthy passes when rel=0.8, irr=0.02', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    await assertRerankBackendHealthy('cohere', { fetchImpl: cohereRes([[0, 0.8], [1, 0.02]]), now: () => 1000 });
  });
});

// ── §5.2 FAILS Unhealthy on thin margin ──
test('probe fails RerankBackendUnhealthy when the margin < MIN_MARGIN (rel=0.5, irr=0.45)', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    await assert.rejects(
      assertRerankBackendHealthy('cohere', { fetchImpl: cohereRes([[0, 0.5], [1, 0.45]]), now: () => 1000 }),
      (e: unknown) => e instanceof RerankBackendUnhealthy,
    );
  });
});

// ── §5.3 FAILS Unhealthy on constant scores (the silent no-op the OLD guard missed) ──
test('probe fails Unhealthy when the backend returns CONSTANT scores (no discrimination)', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    await assert.rejects(
      assertRerankBackendHealthy('cohere', { fetchImpl: cohereRes([[0, 0.7], [1, 0.7]]), now: () => 1000 }),
      (e: unknown) => e instanceof RerankBackendUnhealthy,   // margin 0 < 0.15
    );
  });
});

// ── §5.4 FAILS Unreachable on fetch throw / non-200 / missing key ──
test('probe fails RerankBackendUnreachable on fetch throw, non-200, or missing key', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await assert.rejects(assertRerankBackendHealthy('cohere', { fetchImpl: boom, now: () => 1 }), (e: unknown) => e instanceof RerankBackendUnreachable);
    _resetRerankHealth();
    const http500 = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(assertRerankBackendHealthy('cohere', { fetchImpl: http500, now: () => 2 }), (e: unknown) => e instanceof RerankBackendUnreachable);
  });
  // missing key ⇒ Unreachable (no env key)
  const prev = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  try {
    _resetRerankHealth();
    await assert.rejects(assertRerankBackendHealthy('cohere', { fetchImpl: cohereRes([[0, 0.9], [1, 0.0]]), now: () => 3 }), (e: unknown) => e instanceof RerankBackendUnreachable);
  } finally { if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev; }
});

// ── §5.5 memoized per (backend,model), 10-min TTL ──
test('probe is memoized within the TTL — two calls ⇒ one fetch', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    let calls = 0;
    const spy = (async () => { calls++; return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.8 }, { index: 1, relevance_score: 0.02 }] }), { status: 200 }); }) as unknown as typeof fetch;
    await assertRerankBackendHealthy('cohere', { fetchImpl: spy, now: () => 100000 });
    await assertRerankBackendHealthy('cohere', { fetchImpl: spy, now: () => 100000 + 60000 });   // +1min, within 10min TTL
    assert.equal(calls, 1, 'second call within TTL must not re-fetch');
  });
});

// ── §5.6 rerankCohere maps results[].index back, sets cohere, NO sigmoid ──
test('rerankCohere maps index→candidate, uses relevance_score directly (no sigmoid), tags cohere', async () => {
  await withKey(async () => {
    // candidate 0='alpha', 1='beta'; Cohere ranks beta(0.8) > alpha(0.02), returned out of order
    const out = await rerankCohere('q', cands(), cohereRes([[1, 0.8], [0, 0.02]]));
    assert.equal(out[0].id, 2, 'beta (index 1, score 0.8) sorts first');
    assert.equal(out[0].rerank_score, 0.8, 'relevance_score used directly — NOT sigmoided (0.8, not ~0.69)');
    assert.equal(out[0].rerank_backend, 'cohere');
    assert.equal(out[1].id, 1);
    assert.equal(out[1].rerank_score, 0.02);
  });
});

// ── §5.7 explicit cohere is STRICT: probe runs before scoring; a probe failure propagates ──
test('explicit cohere runs the health probe BEFORE scoring, and a probe failure propagates (not swallowed)', async () => {
  const order: string[] = [];
  await rerank('q', cands(), 'cohere', {
    checkHealthy: async () => { order.push('probe'); },
    cohereFn: async (_q, c) => { order.push('score'); return c.map((x) => ({ ...x, rerank_score: 0.5, rerank_backend: 'cohere' as const })); },
  });
  assert.deepEqual(order, ['probe', 'score'], 'probe strictly precedes scoring');

  await assert.rejects(
    rerank('q', cands(), 'cohere', {
      checkHealthy: async () => { throw new RerankBackendUnhealthy('cohere', 'm', 'no discrimination'); },
      cohereFn: async () => { throw new Error('cohere must not run when the probe fails'); },
    }),
    (e: unknown) => e instanceof RerankBackendError && e instanceof RerankBackendUnhealthy,
  );
});

test('a TRANSIENT (generic, non-typed) failure still soft-falls to input order', async () => {
  const out = await rerank('q', cands(), 'cohere', {
    checkHealthy: async () => {},
    cohereFn: async () => { throw new Error('transient 503') /* NOT a RerankBackendError */; },
  });
  assert.equal(out.length, 2);
  assert.ok(out.every((h) => h.rerank_backend === 'none'), 'generic failure ⇒ input order preserved');
});

// ── R-10 D2: resilient env-default fallback chain (cohere → judge → input-order) ──
// The env default in the test process is 'judge'; `deps.envBackend:'cohere'` simulates the post-flip
// production default so the resilient path is exercised without a real env change.
test('D2.1 env-default cohere: a typed cohere failure ⇒ falls back to JUDGE (tier 1), never throws', async () => {
  const judge = { n: 0 };
  const out = await rerank('q', cands(), undefined, {
    envBackend: 'cohere', checkHealthy: async () => {},   // probe healthy
    cohereFn: async () => { throw new RerankBackendUnreachable('cohere', 'm', 'simulated 403'); },
    judgeFn: countingBackend('judge', judge),
  });
  assert.equal(judge.n, 1, 'judge ran as the fallback');
  assert.ok(out.every((h) => h.rerank_backend === 'judge'), 'result comes from the judge tier');

  // a PROBE failure (not just the call) also downgrades to judge
  const judge2 = { n: 0 };
  const out2 = await rerank('q', cands(), undefined, {
    envBackend: 'cohere',
    checkHealthy: async () => { throw new RerankBackendUnhealthy('cohere', 'm', 'no discrimination'); },
    cohereFn: async () => { throw new Error('cohere must not run when the probe fails'); },
    judgeFn: countingBackend('judge', judge2),
  });
  assert.equal(judge2.n, 1);
  assert.ok(out2.every((h) => h.rerank_backend === 'judge'));
});

test('D2.2 env-default cohere: cohere AND judge both throw ⇒ INPUT ORDER (none), never throws', async () => {
  const out = await rerank('q', cands(), undefined, {
    envBackend: 'cohere', checkHealthy: async () => {},
    cohereFn: async () => { throw new RerankBackendMissing('cohere', 'm', '404'); },
    judgeFn: async () => { throw new Error('judge is down too'); },
  });
  assert.equal(out.length, 2);
  assert.ok(out.every((h) => h.rerank_backend === 'none'), 'both tiers down ⇒ order-preserving input map');
  assert.equal(out[0].id, 1, 'original order preserved');
  assert.equal(out[1].id, 2);
});

test('D2.3 EXPLICIT cohere: a typed cohere failure PROPAGATES (strict — NO fallback to judge)', async () => {
  const judge = { n: 0 };
  await assert.rejects(
    rerank('q', cands(), 'cohere', {   // explicit backend ⇒ strict, even though a judgeFn is available
      checkHealthy: async () => {},
      cohereFn: async () => { throw new RerankBackendUnreachable('cohere', 'm', 'simulated 403'); },
      judgeFn: countingBackend('judge', judge),
    }),
    (e: unknown) => e instanceof RerankBackendUnreachable,
  );
  assert.equal(judge.n, 0, 'the explicit-cohere path must never fall back to the judge');
});

test('D2.4 env-default cohere HEALTHY ⇒ cohere scores; probe invoked once (memoization proven in §5.5)', async () => {
  const cohere = { n: 0 }; let probes = 0;
  const out = await rerank('q', cands(), undefined, {
    envBackend: 'cohere',
    checkHealthy: async () => { probes++; },
    cohereFn: countingBackend('cohere', cohere),
    judgeFn: async () => { throw new Error('judge must not run when cohere is healthy'); },
  });
  assert.equal(cohere.n, 1); assert.equal(probes, 1);
  assert.ok(out.every((h) => h.rerank_backend === 'cohere'));
});

// ── R-10 D3: rerank spend routed to the cost sink ──
test('D3 a successful cohere rerank records ONE cost entry carrying the response usage.cost', async () => {
  await withKey(async () => {
    const recorded: Array<{ cost: number | null | undefined; model?: string }> = [];
    const recordCost = async (cost: number | null | undefined, model?: string) => { recorded.push({ cost, model }); };
    const res = (async () => new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }], usage: { cost: 0.0021 },
    }), { status: 200 })) as unknown as typeof fetch;
    const out = await rerankCohere('q', cands(), res, recordCost);
    assert.equal(out.length, 2, 'scores still returned');
    assert.equal(recorded.length, 1, 'exactly one cost entry per rerank');
    assert.equal(recorded[0].cost, 0.0021, 'the response usage.cost is routed to the sink');
    assert.equal(recorded[0].model, 'cohere/rerank-v3.5');
  });
  // no usage in the response ⇒ the hook is still called with null (the real recordRerankCost no-ops on null)
  await withKey(async () => {
    const recorded: Array<number | null | undefined> = [];
    await rerankCohere('q', cands(), cohereRes([[0, 0.9], [1, 0.1]]), async (cost) => { recorded.push(cost); });
    assert.deepEqual(recorded, [null]);
  });
});

// ── §5.8 no 'bge' symbol remains ──
test('the rerank module no longer contains any bge symbol', () => {
  const src = readFileSync('lib/rerank.ts', 'utf8');
  assert.ok(!/\bbge\b/i.test(src), 'no bge identifier/comment should remain');
  assert.ok(!/rerankBge|assertBgeAvailable|BGE_MODEL/.test(src));
});

// thresholds are the settled defaults
test('discrimination thresholds default to 0.40 / 0.15', () => {
  assert.equal(RERANK_HEALTH_MIN_REL, 0.40);
  assert.equal(RERANK_HEALTH_MIN_MARGIN, 0.15);
});

// scoresOnly trim (unchanged) — kept from the prior file
// ═══ Rerank-flip-prep (PRD v1.1 + Addendum A, 31 Jul 2026) — §5 tests 1–7 ═══
// The env read is module-level, so each case re-imports the module with a cache-busting query
// string under a patched env, capturing console.warn emitted at load.
import { miniPipeline } from '../llm.ts';
import { opdRetrieveOpts } from '../opd-note-audit.ts';

test('§5.1 the LIVE production case: RERANK_BACKEND=Cohere resolves to judge AND warns', () => {
  const r = resolveEnvRerankBackend('Cohere');
  assert.equal(r.backend, 'judge', 'Cohere (capital C) must NOT select the cross-encoder — that would be the flip');
  assert.ok(r.warning?.includes('unrecognised RERANK_BACKEND="Cohere"'), 'the seven-day silent mismatch must now be loud, naming the bad value');
});

test('§5.1b …and the warning actually FIRES at real module load (cold-start proof, subprocess)', () => {
  // ESM caching makes this unprovable in-process (the module loaded once at the top of this file),
  // so the one cold-start proof runs the real import in a child with the live production env value.
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e',
    `import('./lib/rerank.ts').then((m) => { const f = m.resolveRerankBackend ?? m.default.resolveRerankBackend; console.log('BACKEND=' + f(undefined)); });`],
  { env: { ...process.env, RERANK_BACKEND: 'Cohere' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BACKEND=judge/, 'with the env holding Cohere the effective backend stays judge');
  assert.ok(r.stderr.includes('unrecognised RERANK_BACKEND="Cohere"'),
    'the cold-start warning must reach stderr naming the bad value');
});

test('§5.2 exact lowercase cohere (whitespace-trimmed) selects cohere silently; COHERE warns to judge', () => {
  for (const v of ['cohere', ' cohere ']) {
    const r = resolveEnvRerankBackend(v);
    assert.equal(r.backend, 'cohere', `${JSON.stringify(v)} must select the cross-encoder`);
    assert.equal(r.warning, null, `${JSON.stringify(v)} is valid — no warning`);
  }
  const upper = resolveEnvRerankBackend('COHERE');
  assert.equal(upper.backend, 'judge', 'case is NOT folded — by Addendum A ruling');
  assert.ok(upper.warning);
});

test('§5.3 judge, trimmed judge and unset are silent; any other value warns to judge', () => {
  for (const v of ['judge', ' judge ', undefined]) {
    const r = resolveEnvRerankBackend(v);
    assert.equal(r.backend, 'judge');
    assert.equal(r.warning, null, `${JSON.stringify(v)} must not warn`);
  }
  const typo = resolveEnvRerankBackend('cohre');
  assert.equal(typo.backend, 'judge');
  assert.ok(typo.warning?.includes('"cohre"'), 'a typo must be loud, never silently absorbed');
  // and the module-level read IS this function applied to process.env — enforced at the source:
  const src = readFileSync('lib/rerank.ts', 'utf8');
  assert.ok(src.includes('resolveEnvRerankBackend(process.env.RERANK_BACKEND)'),
    'the module const must come from the tested resolver');
  assert.ok(!/as 'judge' \| 'cohere';/.test(src.split('\n').find((l) => l.includes('process.env.RERANK_BACKEND')) ?? ''),
    'the bare cast must be gone');
});

test('§5.4 miniPipeline normalizes: Mini and " mini " both select the mini pipeline', () => {
  const prev = process.env.LLM_PIPELINE;
  try {
    for (const v of ['Mini', ' mini ', 'mini']) {
      process.env.LLM_PIPELINE = v;
      assert.equal(miniPipeline(), true, `${JSON.stringify(v)} must select mini`);
    }
    process.env.LLM_PIPELINE = 'nope';
    assert.equal(miniPipeline(), false);
    delete process.env.LLM_PIPELINE;
    assert.equal(miniPipeline(), false);
  } finally {
    if (prev === undefined) delete process.env.LLM_PIPELINE; else process.env.LLM_PIPELINE = prev;
  }
});

test('§5.5 INVARIANCE: no rerankBackend ⇒ retrieve options deep-equal to today, no extra key', () => {
  const TODAY = { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true };
  assert.deepEqual(opdRetrieveOpts(false, {}), TODAY);
  assert.deepEqual(opdRetrieveOpts(false, {}, undefined, undefined), TODAY);
  assert.deepEqual(opdRetrieveOpts(true, {}), TODAY);
  // the guarded spread must not add the key with an undefined value — Object.keys is the proof
  assert.deepEqual(Object.keys(opdRetrieveOpts(false, {}, undefined, undefined)), Object.keys(TODAY));
  assert.ok(!('rerankBackend' in opdRetrieveOpts(false, {})), 'unset ⇒ the key is ABSENT, not undefined');
  // and the normative-leg combination is unchanged too
  assert.deepEqual(opdRetrieveOpts(false, {}, true), { ...TODAY, useNormativeLeg: true });
});

test('§5.6 rerankBackend:cohere reaches retrieve() — carried in the opts and threaded at the call sites', () => {
  assert.equal(opdRetrieveOpts(false, {}, undefined, 'cohere').rerankBackend, 'cohere');
  assert.equal(opdRetrieveOpts(true, {}, undefined, 'judge').rerankBackend, 'judge');
  // the leg and the backend compose without disturbing each other
  assert.deepEqual(opdRetrieveOpts(false, {}, true, 'cohere'),
    { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true, useNormativeLeg: true, rerankBackend: 'cohere' });
  // thread integrity, enforced at the source so a refactor cannot silently drop the parameter:
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(audit.includes('defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend)'),
    'auditOpdNote must pass opts.rerankBackend into its retrieve');
  assert.ok(audit.includes('opdRetrieveOpts(mini, process.env, evalNormativeLeg, rerankBackend)'),
    'defaultRetrieve must forward the backend into the opts builder');
  const retrieveSrc = readFileSync('lib/retrieve.ts', 'utf8');
  assert.ok(retrieveSrc.includes('opts.rerankBackend'), 'retrieve() must still forward the backend to rerank()');
  const lab = readFileSync('lib/lab-batch.ts', 'utf8');
  assert.ok(lab.includes('rerankBackend: evalCfg.rerankBackend'),
    'the lab entry point that accepts evalModel must expose rerankBackend beside it');
});

test('§5.7 explicit cohere via the threaded path stays STRICT — typed errors propagate, no fallback', async () => {
  const judge = { n: 0 };
  await assert.rejects(
    rerank('q', cands(), 'cohere', {
      checkHealthy: async () => { throw new RerankBackendUnhealthy('cohere', 'm', 'down'); },
      judgeFn: countingBackend('judge', judge),
    }),
    (e: unknown) => e instanceof RerankBackendUnhealthy,
  );
  assert.equal(judge.n, 0, 'strictness means the judge is NEVER consulted on an explicit cohere failure');
});

test('pickScoreFields drops text/section, keeps ids + scores', () => {
  const t = pickScoreFields({ final_rank: 1, id: 7, source: 's', book: 'b', chapter: 'c', section: 'sec', item_number: 'i', similarity: 0.5, vector_rank: 2, bm25_rank: 3, bm25_variant_ranks: [3, null], rrf_score: 0.1, rerank_score: 0.9, rerank_backend: 'cohere', source_quality_weight: 0.95, text: 'BIG' });
  assert.equal('text' in t, false);
  assert.equal('section' in t, false);
  assert.equal(t.rerank_backend, 'cohere');
});
