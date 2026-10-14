/**
 * lib/__tests__/explicit-judge-retrieve.test.ts — J3 and J4, through the real `retrieve` and
 * `retrieveMultiQuery`, against the real loopback judge.
 *
 * GOVERNED BY addendum v15 (signed by V, 16 August 2026), sections 3 and 4.1, under Saul review 27
 * and review 28. Kickoff v11 §9 is the numbering authority for J3 and J4. Addendum v18 (signed by
 * V, 16 August 2026, under Saul review 29) §3.8 adds J4's arm-count assertions — three arms,
 * asserted at the seam AND on `capture.children` — as the follow-up review 29 carried with J4's
 * closure.
 *
 * WHAT THIS FILE PROVES.
 *   · J3. `retrieve` under a hostile Cohere default. The OMITTED-backend control demonstrates
 *         Cohere intent and downgrade. The EXPLICIT-judge arm shows zero Cohere outbound requests,
 *         judge intent, judge service, no downgrade, nonzero batches, and actual reordering.
 *         "Zero Cohere outbound requests" is a WIRE fact (v15 §4.1): no request leaves for any
 *         Cohere endpoint during the explicit-judge arm. It is observed on the transport, not
 *         inferred from a counter — the counter-level fact is J2's, in `rerank-pass-2.test.ts`.
 *   · J4. `retrieveMultiQuery` keeps reranking OFF on every retrieval arm and performs EXACTLY ONE
 *         fusion-level rerank whose third argument is the value the caller passed as
 *         `opts.rerankBackend` — here `'judge'` — as OBSERVED at that seam.
 *
 * WHAT THIS FILE DOES NOT CLAIM.
 *   · Nothing about expansion "agreeing" on a rerank backend. Expansion is independent (v15 §3, J4).
 *   · Nothing about `rerankBackend` being ABSENT on the retrieval arms. The spread carries it onto
 *     every arm by design; what is asserted is the OBSERVED `useReranker` on each arm, which is what
 *     turns reranking off there.
 *   · Nothing about TCP framing, TLS or headers.
 *
 * HOW `retrieve` IS DRIVEN WITHOUT A DATABASE. The db stub (`installDbStub`) replaces
 * `globalThis.fetch` and routes Neon-shaped statements by regex to fixture rows, exactly as
 * `retrieval-ranking-invariance.test.ts` does. The OpenAI SDK does not use `globalThis.fetch` — it
 * binds node-fetch at client construction — so the judge requests reach the loopback server on a
 * real socket while the SQL never leaves the process. Both stubs coexist by construction.
 *
 * ⚠️ AND THAT IS WHAT MAKES THE WIRE CLAIM OBSERVABLE. `cohereRelevanceScores` in `lib/rerank.ts`
 * calls the global `fetch`. With the db stub installed, a Cohere request would arrive at the stub's
 * fetch, which fails closed on a non-Neon body — so it cannot escape to the network — and it is
 * COUNTED by a spy wrapped around that fetch. Zero Cohere outbound requests means: the spy saw no
 * request to any Cohere endpoint, AND the loopback recorder saw only judge and embedding traffic.
 *
 * ORDER OF EVALUATION (v15 §10.4): server first, then the dynamic imports.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDbStub, type DbStub } from './telemetry-db-stub';
import {
  startJudgeServer, installConnectionGuard, uninstallConnectionGuard, type JudgeServer,
} from './judge-server-stub';
import type { RetrieveOptions } from '../retrieve';
import type { TelemetryCapture } from '../retrieval-capture';

// ── The ten environment variables `startJudgeServer` mutates and never restores (kickoff §4.5) ───
const ENV_TOUCHED = [
  'OLLAMA_BASE_URL', 'RERANK_JUDGE_MODEL', 'LLM_PIPELINE', 'GCP_PROJECT', 'GCP_SA_KEY',
  'GEMINI_ALL', 'GEMINI_UTILITY', 'GEMINI_VIA_OPENROUTER', 'RERANK_BACKEND', 'OPENROUTER_API_KEY',
] as const;
const envSnapshot = new Map<string, string | undefined>();
for (const k of ENV_TOUCHED) envSnapshot.set(k, process.env[k]);
function restoreEnv(): void {
  for (const [k, v] of envSnapshot) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// ── The fixture, in the shape retrieval-ranking-invariance.test.ts established ───────────────────
// Ids are NUMBERS: the stub types a column from its first sample, and a string id would miss the
// hydrate map and drop the hit silently. Twelve vector rows so the reranker's pool (topK 4 → pool 12
// with the reranker on) is exactly the fixture, and 12 / JUDGE_BATCH 5 = three judge batches.
const VEC_ROWS = Array.from({ length: 12 }, (_, i) => ({ id: 101 + i, rank: i + 1 }));
const BM25_ROWS = [{ id: 101, rank: 1 }, { id: 103, rank: 2 }, { id: 105, rank: 3 }];
const marker = (id: number) => `MRK${id}`;
const HYDRATED = VEC_ROWS.map(({ id }) => ({
  id, source: 'mksap', book: `Book ${id}`, chapter: `Chapter ${id}`, section: `Section ${id}`,
  page_start: id, page_end: id + 1, item_number: `IT-${id}`, chunk_type: 'text',
  text: `${marker(id)} a clinical passage used only by this proof, numbered ${id}.`,
  token_count: 100 + id, similarity: 0.9 - id / 1000, source_quality_weight: 1.0,
}));
// Fusion order (RRF, K = 60): 101, 103, 105 carry both legs and lead; the rest follow by vector rank.
const FUSED_ORDER = [101, 103, 105, 102, 104, 106, 107, 108, 109, 110, 111, 112];
// Judge scores chosen to REORDER — a fixture that returned fused order would prove nothing.
const JUDGE_SCORES: Record<string, number> = {
  MRK112: 10, MRK108: 9, MRK101: 8, MRK110: 7, MRK103: 6, MRK105: 5,
  MRK102: 4, MRK104: 3, MRK106: 2, MRK107: 1, MRK109: 0.5, MRK111: 0.2,
};
const RERANKED_TOP_4 = [112, 108, 101, 110];
const QUERY = 'what is the management of acute pericarditis';
const QUERY_EMBEDDING = [0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8];

// The three statements `retrieve` issues on this path, and the two it must not.
const S4_VECTOR = /ROW_NUMBER\(\) OVER \(ORDER BY embedding <=> \$1::vector\)[\s\S]*NOT LIKE 'labq:%'/;
const S5A_BM25 = /ts_rank_cd\(text_tsv, plainto_tsquery/;
const S7_HYDRATE = /COALESCE\(source_quality_weight/;

type Booted = {
  judge: JudgeServer;
  stub: DbStub;
  retrieve: typeof import('../retrieve').retrieve;
  retrieveMultiQuery: typeof import('../multi-query').retrieveMultiQuery;
  createTelemetryCapture: typeof import('../retrieval-capture').createTelemetryCapture;
  buildRetrievalPayload: typeof import('../retrieval-capture').buildRetrievalPayload;
  _resetRerankHealth: typeof import('../rerank')._resetRerankHealth;
};
let booted: Booted | null = null;

async function boot(): Promise<Booted> {
  if (booted) return booted;
  const judge = await startJudgeServer(JUDGE_SCORES);
  try {
    // ⚠️ THE HOSTILE COHERE DEFAULT, MADE REAL. `lib/rerank.ts` reads `RERANK_BACKEND` into the module
    // const `BACKEND` ONCE, at module evaluation. `startJudgeServer` deletes the variable (so a
    // shell-exported `cohere` cannot reach a real Cohere endpoint through an unguarded test), and
    // this file's dynamic import of `../rerank` has not yet run. Setting the variable HERE — after
    // the stub's delete, before the import — gives THIS process a genuine Cohere env default: the
    // words of J3 and proof 70 are "backend Cohere by environment default", and this is that,
    // rather than a simulation through a RerankDeps seam that `retrieve` does not expose.
    //
    // It is safe because (a) the connection guard is installed on the next line, so a Cohere call
    // that somehow reached the transport would be refused, and (b) `OPENROUTER_API_KEY` is unset by
    // the stub, so `cohereRelevanceScores` throws its typed Unreachable BEFORE any fetch. The env is
    // restored in `after()`, and `BACKEND` is module-scoped to this file's import graph.
    process.env.RERANK_BACKEND = 'cohere';
    installConnectionGuard();
    const stub = installDbStub();
    stub.on(S4_VECTOR, VEC_ROWS);
    stub.on(S5A_BM25, BM25_ROWS);
    stub.on(S7_HYDRATE, HYDRATED);
    const retrieveMod = await import('../retrieve');
    const mqMod = await import('../multi-query');
    const captureMod = await import('../retrieval-capture');
    const rerankMod = await import('../rerank');
    booted = {
      judge, stub,
      retrieve: retrieveMod.retrieve, retrieveMultiQuery: mqMod.retrieveMultiQuery,
      createTelemetryCapture: captureMod.createTelemetryCapture,
      buildRetrievalPayload: captureMod.buildRetrievalPayload,
      _resetRerankHealth: rerankMod._resetRerankHealth,
    };
  } catch (e) {
    await judge.close().catch(() => {});
    throw e;
  }
  return booted;
}

after(async () => {
  uninstallConnectionGuard();
  if (booted) { booted._resetRerankHealth(); await booted.judge.close().catch(() => {}); booted = null; }
  restoreEnv();
});

/**
 * A spy over the global fetch (which is the db stub's fetch once installed), counting any call whose
 * URL names a Cohere/OpenRouter rerank endpoint. Restored in `finally` by the caller.
 */
function spyCohereFetch(): { cohereCalls: string[]; restore: () => void } {
  const g = globalThis as unknown as { fetch: (u: unknown, i?: unknown) => Promise<unknown> };
  const original = g.fetch;
  const cohereCalls: string[] = [];
  g.fetch = async (u: unknown, i?: unknown) => {
    const url = String(u);
    if (/openrouter\.ai|cohere|\/rerank\b/i.test(url)) cohereCalls.push(url);
    return original(u, i);
  };
  return { cohereCalls, restore: () => { g.fetch = original; } };
}

// ⚠️ THE HOSTILE COHERE DEFAULT is set in `boot()`, between `startJudgeServer` and the dynamic import
// of `../rerank`, so the module const `BACKEND` reads `cohere` in this process. On the OMITTED
// backend arm the env-default resilient chain therefore runs with Cohere INTENDED; Cohere is
// unreachable because `OPENROUTER_API_KEY` is unset (a real typed `RerankBackendUnreachable` from
// real production code, thrown BEFORE any fetch), and the chain downgrades to the judge. That is
// Cohere intent + downgrade, observed end to end through `retrieve`.

const BASE_OPTS: RetrieveOptions = Object.freeze({
  topK: 4, skipExpand: true, queryEmbedding: QUERY_EMBEDDING, useReranker: true,
});

async function retrieveArm(opts: RetrieveOptions) {
  const { judge, retrieve, createTelemetryCapture, buildRetrievalPayload, _resetRerankHealth } = await boot();
  _resetRerankHealth();
  judge.setRecording(true); judge.resetObservations();
  const spy = spyCohereFetch();
  try {
    const capture = createTelemetryCapture('primary');
    const result = await retrieve(QUERY, opts, capture);
    await judge.settled();
    const wire = judge.snapshot();
    const payload = buildRetrievalPayload(capture, { hmacKey: 'j3-key', scorerContext: '' });
    return { result, capture, payload, wire, cohereCalls: spy.cohereCalls };
  } finally { spy.restore(); judge.setRecording(false); judge.resetObservations(); _resetRerankHealth(); }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// J3 — retrieve under a hostile Cohere default.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('J3.0 — the fixture is live: retrieve with the reranker OFF returns the fused order and dials no judge', async () => {
  const { judge, retrieve, createTelemetryCapture } = await boot();
  judge.setRecording(true); judge.resetObservations();
  try {
    const capture = createTelemetryCapture('primary');
    const r = await retrieve(QUERY, { ...BASE_OPTS, useReranker: false }, capture);
    await judge.settled();
    assert.deepEqual(r.hits.map((h) => h.id), FUSED_ORDER.slice(0, 4), 'fusion order, no rerank');
    assert.equal(capture.batches.length, 0);
    assert.equal(judge.snapshot().length, 0, 'no judge request when the reranker is off');
  } finally { judge.setRecording(false); judge.resetObservations(); }
});

test('J3.1 — OMITTED-BACKEND CONTROL: the resilient arm runs; under a Cohere env default it shows Cohere intent AND downgrade', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;   // Cohere unreachable, typed, before any fetch
  try {
    const { capture, payload, wire, cohereCalls, result } = await retrieveArm({ ...BASE_OPTS });   // rerankBackend ABSENT
    // The explicit flag went false and the resilient arm ran under the Cohere env default.
    assert.equal(capture.batches.length > 0, true, 'reranking happened');
    // COHERE INTENT: the env default was Cohere, and the capture says so.
    assert.equal(payload.intended_backend, 'cohere', 'Cohere was INTENDED under the hostile default');
    assert.equal(capture.intendedBackend, 'cohere');
    // DOWNGRADE: the judge served, and the downgrade is recorded as its own fact.
    assert.equal(payload.served_backend, 'judge', 'the judge served');
    assert.equal(payload.rerank_backend_downgraded, true, 'the DOWNGRADE is recorded');
    assert.equal(capture.rerankBackendDowngraded, true);
    assert.equal(payload.expected_batch_count, payload.recorded_rerank_batches, 'the row reconciles on the judge count');
    // Cohere was intended — but no Cohere request LEFT, because the key was absent and the typed
    // error fired before fetch. Stated so the downgrade is not mistaken for a wire event.
    assert.deepEqual(cohereCalls, [], 'no Cohere request left the process');
    assert.ok(wire.length >= 3, 'the judge received the batches on the wire');
    assert.deepEqual(result.hits.map((h) => h.id), RERANKED_TOP_4, 'the judge reordered');
  } finally { if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey; }
});

test('J3.2 — EXPLICIT-JUDGE ARM: zero Cohere outbound requests, judge intent, judge service, no downgrade, nonzero batches, actual reordering', async () => {
  // Even with a Cohere key PRESENT — the most hostile version, where a Cohere call would succeed at
  // the transport if anything reached for it — the explicit judge arm must never issue one.
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'j3-hostile-key-not-a-secret';
  try {
    const { capture, payload, wire, cohereCalls, result } = await retrieveArm({ ...BASE_OPTS, rerankBackend: 'judge' });
    // ZERO COHERE OUTBOUND REQUESTS — the wire fact, on both channels.
    assert.deepEqual(cohereCalls, [], 'the fetch spy saw no request to any Cohere endpoint');
    for (const o of wire) {
      assert.equal(/rerank/i.test(o.path) && !/chat\/completions/.test(o.path), false, `no rerank-shaped path on the loopback: ${o.path}`);
      assert.match(o.path, /\/v1\/(chat\/completions|embeddings)/, 'only judge chats and embeddings reached the loopback');
    }
    // Judge intent, judge service, no downgrade.
    assert.equal(payload.intended_backend, 'judge');
    assert.equal(payload.served_backend, 'judge');
    assert.equal(payload.rerank_backend_downgraded, false);
    assert.equal(capture.rerankBackendDowngraded, false);
    // Nonzero batches, reconciled.
    assert.equal(capture.batches.length, 3, 'pool 12 at JUDGE_BATCH 5 → three batches');
    assert.equal(payload.expected_batch_count, 3);
    assert.equal(payload.recorded_rerank_batches, 3);
    assert.equal(wire.filter((o) => /chat\/completions/.test(o.path)).length, 3, 'three judge requests on the wire');
    // ACTUAL REORDERING: the reranked top-4 differs from the fused top-4.
    assert.deepEqual(result.hits.map((h) => h.id), RERANKED_TOP_4);
    assert.notDeepEqual(RERANKED_TOP_4, FUSED_ORDER.slice(0, 4), 'the judge changed the order');
    assert.equal(result.meta?.reranked, true);
  } finally { if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey; }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// J4 — retrieveMultiQuery: reranking off on every arm, exactly one fusion-level rerank.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('J4.1 — every retrieval arm is called with useReranker OFF; exactly ONE fusion-level rerank; its third argument is the value passed as opts.rerankBackend', async () => {
  const { retrieveMultiQuery, retrieve, createTelemetryCapture } = await boot();
  // Observe the two seams `retrieveMultiQuery` exposes for exactly this: `retrieveFn` (each arm) and
  // `rerankFn` (the fusion call). Both DELEGATE to the real functions after recording, so the run is
  // still real — the arms hit the db stub, the fusion rerank hits the loopback judge.
  const arms: Array<{ query: string; useReranker: unknown; rerankBackend: unknown }> = [];
  const fusion: Array<{ third: unknown; n: number }> = [];
  const rerankMod = await import('../rerank');
  const capture = createTelemetryCapture('lab_multi_query');
  const out = await retrieveMultiQuery(QUERY, { ...BASE_OPTS, rerankBackend: 'judge' }, {
    retrieveFn: async (q, o, cap) => {
      // `typeof retrieve` declares `opts` optional; retrieveMultiQuery always passes one. A real
      // check, not a cast: if an arm ever arrived with no opts, that would be a finding.
      assert.ok(o, 'retrieveMultiQuery passes an opts object to every arm');
      arms.push({ query: q, useReranker: o.useReranker, rerankBackend: o.rerankBackend });
      return retrieve(q, o, cap);
    },
    rerankFn: async (q, c, third, deps, cap) => { fusion.push({ third, n: c.length }); return rerankMod.rerank(q, c, third, deps, cap); },
    // Deterministic variants, no LLM: the seam reports what it can (`not_collected`), honestly.
    variantsFn: async () => ['variant one of the question', 'variant two of the question'],
  }, capture);

  // EVERY retrieval arm: reranking OFF. The original plus two variants is three arms.
  assert.equal(arms.length, 3, 'one original arm and two variant arms');
  for (const a of arms) assert.equal(a.useReranker, false, `arm "${a.query.slice(0, 30)}" has reranking OFF`);
  // ⚠️ `rerankBackend` IS carried onto every arm by the spread, BY DESIGN. Asserting it absent would
  // pass and prove nothing — the override that matters is `useReranker: false`, asserted above.
  for (const a of arms) assert.equal(a.rerankBackend, 'judge', 'the spread carries rerankBackend; useReranker:false is what turns reranking off');

  // EXACTLY ONE fusion-level rerank, and its third argument is the value the caller passed.
  assert.equal(fusion.length, 1, 'exactly one fusion-level rerank call');
  assert.equal(fusion[0].third, 'judge', 'the observed third argument is opts.rerankBackend');
  assert.ok(fusion[0].n > 1, 'the fused pool has more than one candidate, so rerank really ran');

  // And it really reranked: the capture carries judge batches and the result is reordered.
  assert.ok(capture.batches.length > 0, 'the fusion rerank stamped batches on the multi-query capture');
  assert.equal(capture.servedBackend, 'judge');
  assert.equal(capture.rerankBackendDowngraded, false);
  assert.ok(out.hits.length > 0);
});

test('J4.2 — the fusion rerank happens ONCE even when the arms return overlapping pools; no arm-level rerank stamps a batch', async () => {
  const { retrieveMultiQuery, retrieve, createTelemetryCapture, judge } = await boot();
  const rerankMod = await import('../rerank');
  const capture = createTelemetryCapture('lab_multi_query');
  let fusionCalls = 0;
  const armCaptures: TelemetryCapture[] = [];
  judge.setRecording(true); judge.resetObservations();
  try {
    await retrieveMultiQuery(QUERY, { ...BASE_OPTS, rerankBackend: 'judge' }, {
      retrieveFn: async (q, o, cap) => { if (cap) armCaptures.push(cap); return retrieve(q, o, cap); },
      rerankFn: async (q, c, third, deps, cap) => { fusionCalls += 1; return rerankMod.rerank(q, c, third, deps, cap); },
      variantsFn: async () => ['variant one', 'variant two'],
    }, capture);
    await judge.settled();
    assert.equal(fusionCalls, 1);
    // THE ARM COUNT, both sides of the seam (v18 §3.8 — review 29 closed J4 and carried this as a
    // follow-up). `retrieveMultiQuery` builds `allQueries = [expandedQuery, ...variants]`, and with
    // the two deterministic variants above there are THREE arms. `armCaptures` here is the
    // collection this test's own `retrieveFn` pushes to, so its length counts calls;
    // `capture.children` is the array production built, assigned inside `retrieveMultiQuery`.
    assert.equal(armCaptures.length, 3);        // calls observed at the seam
    assert.ok(capture.children, 'retrieveMultiQuery assigned the children array');
    assert.equal(capture.children.length, 3);   // the array production built
    // No ARM capture carries a batch: reranking was off on every arm, so nothing was stamped there.
    for (const ac of armCaptures) assert.equal(ac.batches.length, 0, 'an arm rerank would have stamped a batch here');
    // The only judge traffic on the wire is the fusion rerank's batches.
    const judgeChats = judge.snapshot().filter((o) => /chat\/completions/.test(o.path)).length;
    assert.equal(judgeChats, capture.batches.length, 'every judge request on the wire belongs to the ONE fusion rerank');
  } finally { judge.setRecording(false); judge.resetObservations(); }
});
