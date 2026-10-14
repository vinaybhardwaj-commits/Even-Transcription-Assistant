/**
 * lib/__tests__/instrumentation-off.test.ts — kickoff v11 test 1, instrumentation off.
 *
 * ══ THE AMENDMENT (addendum v2 §7, 13 Aug 2026) ════════════════════════════════════════════════
 * v11 says instrumentation off "executes nothing". For `rerankJudge` that is FALSE. Four
 * expressions run whether or not a capture exists and are consumed only inside the `if (capture)`
 * at `lib/rerank.ts:506`:
 *
 *     lib/rerank.ts:460   evidence = evidenceFromCompletion(r)
 *     lib/rerank.ts:462   promptTokens
 *     lib/rerank.ts:463   completionTokens
 *     lib/rerank.ts:496   the outcome precedence
 *
 * So the requirement is amended to **"executes nothing OBSERVABLE"**, and those four are recorded
 * here as dead work rather than asserted away. `expandQuery` is the contrast: there
 * `evidenceFromCompletion` sits INSIDE the guard, so nothing runs.
 *
 * ══ WHAT COUNTS AS AN OBSERVABLE ═══════════════════════════════════════════════════════════════
 * `lib/__tests__/multi-query-telemetry.test.ts:102-108` is the house pattern — a fake collaborator
 * recording `hadCapture: !!capture`. It is NOT available for the real `retrieve`, `rerankJudge` or
 * `expandQuery`, which have no injectable collaborator. For those three the observables are the
 * returned value, the stub's per-statement counts, and the judge server's request list.
 *
 * ⚠️ NO PRODUCTION FILE WAS CHANGED TO MAKE ANY OF THIS RUN.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDbStub, type DbStub } from './telemetry-db-stub';
import { startJudgeServer, type JudgeServer } from './judge-server-stub';
import type { RetrieveOptions, RetrieveResult } from '../retrieve';
import type { TelemetryCapture } from '../retrieval-capture';

const VEC_ROWS = Array.from({ length: 10 }, (_, i) => ({ id: 201 + i, rank: i + 1 }));
const BM25_ROWS = [{ id: 201, rank: 1 }, { id: 203, rank: 2 }];
const HYDRATED = VEC_ROWS.map(({ id }) => ({
  id, source: 'mksap', book: `B${id}`, chapter: null, section: null,
  page_start: id, page_end: null, item_number: `IT-${id}`, chunk_type: 'text',
  text: `MRK${id} passage ${id} for the instrumentation-off test.`,
  token_count: 50, similarity: 0.8 - id / 1000, source_quality_weight: 1.0,
}));

const S4_VECTOR = /ROW_NUMBER\(\) OVER \(ORDER BY embedding <=> \$1::vector\)[\s\S]*NOT LIKE 'labq:%'/;
const S5A_BM25 = /ts_rank_cd\(text_tsv, plainto_tsquery/;
const S7_HYDRATE = /COALESCE\(source_quality_weight/;
const ROUTED = [S4_VECTOR, S5A_BM25, S7_HYDRATE];

const TELEMETRY_WRITES = [
  /INSERT INTO opd_retrieval_invocations/,
  /INSERT INTO opd_audit_retrieval_telemetry/,
  /INSERT INTO opd_retrieval_telemetry_failures/,
  /UPDATE opd_audit_retrieval_telemetry/,
  /UPDATE opd_retrieval_invocations/,
];

const QUERY = 'management of acute pericarditis';
const QUERY_EMBEDDING = [0.1, -0.2, 0.3, -0.4];
const OPTS: RetrieveOptions = Object.freeze({ topK: 4, skipExpand: true, queryEmbedding: QUERY_EMBEDDING });

/** The frozen own-key list of a `RetrieveResult`. v11 revision 1 asked instead for "no telemetry own
 *  property", which no return type has ever carried on any path — an assertion that passes
 *  unconditionally proves nothing, so the shape is pinned positively instead. */
const RETRIEVE_RESULT_KEYS = ['hits', 'expandedQuery', 'meta'];

let judge: JudgeServer;
let stub: DbStub;
const ready = (async () => {
  judge = await startJudgeServer({ MRK201: 9, MRK203: 8, MRK205: 7, MRK202: 6, MRK204: 5 });
  stub = installDbStub();
  stub.on(S4_VECTOR, VEC_ROWS);
  stub.on(S5A_BM25, BM25_ROWS);
  stub.on(S7_HYDRATE, HYDRATED);
  stub.on(/FROM lvc_recommendations/, []);
  const [retrieveMod, rerankMod, expandMod, mqMod, captureMod, lvcMod] = await Promise.all([
    import('../retrieve'), import('../rerank'), import('../expand'),
    import('../multi-query'), import('../retrieval-capture'), import('../lvc'),
  ]);
  return {
    retrieve: retrieveMod.retrieve,
    rerank: rerankMod.rerank, rerankJudge: rerankMod.rerankJudge, rerankCohere: rerankMod.rerankCohere,
    expandQuery: expandMod.expandQuery,
    retrieveMultiQuery: mqMod.retrieveMultiQuery,
    createTelemetryCapture: captureMod.createTelemetryCapture,
    matchLowValueCare: lvcMod.matchLowValueCare,
  };
})();

test.after(async () => { await judge?.close(); });

const cand = (id: number, text: string) => ({ id, text });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1 of 7 — retrieve
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('1a — retrieve: no capture, and two uninstrumented runs are identical statement for statement', async () => {
  const { retrieve } = await ready;
  const beforeCounts = new Map(ROUTED.map((re) => [re, stub.matching(re).length]));

  const first = await retrieve(QUERY, OPTS);
  const second = await retrieve(QUERY, OPTS);

  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(Object.keys(first), RETRIEVE_RESULT_KEYS, 'the runtime shape is exactly today\'s');
  assert.ok(first.hits.length > 0, 'not vacuous: the runs actually retrieved something');

  // It never allocates a capture; the caller does. The `undefined` it holds is what reaches
  // `expandQuery` at `:408` and `rerank` at `:589`.
  for (const re of ROUTED) {
    assert.equal(stub.matching(re).length - (beforeCounts.get(re) as number), 2, `${re} ran once per run`);
  }
  for (const re of TELEMETRY_WRITES) {
    assert.equal(stub.matching(re).length, 0, `no telemetry statement was executed: ${re}`);
  }
});

test('1a\' — and adding a capture to ONE side only leaves the returned value identical', async () => {
  // The §9 attack for test 1, kept as a case: instrumentation must be observable ONLY in the
  // capture, never in the return.
  const { retrieve, createTelemetryCapture } = await ready;
  const off = await retrieve(QUERY, OPTS);
  const capture = createTelemetryCapture('primary');
  const on = await retrieve(QUERY, OPTS, capture);
  assert.deepStrictEqual(off, on);
  assert.ok(capture.fusedCandidateIds.length > 0, 'the on side really did write into its capture');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2 of 7 — rerank
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('2 — rerank: undefined reaches judgeFn and cohereFn as the third argument, and soft failure returns early', async () => {
  const { rerank } = await ready;
  const cands = [cand(1, 'a'), cand(2, 'b')];

  const seen: Array<{ which: string; hadCapture: boolean }> = [];
  const judged = await rerank(QUERY, cands, 'judge', {
    judgeFn: (async (_q: string, c: typeof cands, capture?: TelemetryCapture) => {
      seen.push({ which: 'judge', hadCapture: !!capture });
      return c.map((x, i) => ({ ...x, rerank_score: 1 - i / 10, rerank_backend: 'judge' as const }));
    }) as never,
  });
  assert.deepStrictEqual(seen, [{ which: 'judge', hadCapture: false }]);
  assert.equal(judged.length, 2);

  await rerank(QUERY, cands, 'cohere', {
    checkHealthy: (async () => undefined) as never,
    cohereFn: (async (_q: string, c: typeof cands, capture?: TelemetryCapture) => {
      seen.push({ which: 'cohere', hadCapture: !!capture });
      return c.map((x) => ({ ...x, rerank_score: 0.5, rerank_backend: 'cohere' as const }));
    }) as never,
  });
  assert.deepStrictEqual(seen[1], { which: 'cohere', hadCapture: false });

  // `recordSoftFailure` returns at `lib/rerank.ts:278` before touching anything. With no capture a
  // generic throw still soft-falls to input order, and nothing is recorded anywhere.
  const soft = await rerank(QUERY, cands, 'judge', {
    judgeFn: (async () => { throw new Error('generic'); }) as never,
  });
  assert.deepStrictEqual(soft.map((r) => r.id), [1, 2], 'input order preserved');
  assert.deepStrictEqual(soft.map((r) => r.rerank_backend), ['none', 'none']);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3 of 7 — rerankJudge, and the four dead expressions
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('3 — rerankJudge: identical array and identical request bodies, with and without a capture', async () => {
  const { rerankJudge, createTelemetryCapture } = await ready;
  const cands = [cand(201, 'MRK201 one'), cand(203, 'MRK203 two'), cand(205, 'MRK205 three')];
  const before = judge.requests.length;

  const off = await rerankJudge(QUERY, cands);
  const capture = createTelemetryCapture('primary');
  const on = await rerankJudge(QUERY, cands, capture);

  assert.deepStrictEqual(off, on, 'the returned ranking is identical');
  assert.deepStrictEqual(off.map((r) => r.id), [201, 203, 205]);

  const reqs = judge.requests.slice(before);
  assert.equal(reqs.length, 2, 'one batch each, and no SDK retry');
  assert.equal(reqs[0].user, reqs[1].user, 'byte-identical prompts');
  assert.equal(reqs[0].model, reqs[1].model);
  assert.equal(reqs[0].temperature, reqs[1].temperature);

  // ⚠️ THE FOUR DEAD EXPRESSIONS. They ran on BOTH sides; only the on side could observe them.
  // This is the amendment: "executes nothing" is false here, "executes nothing observable" is true.
  assert.equal(capture.batches.length, 1, 'the on side observed them');
  assert.equal(capture.batches[0].outcome, 'success');            // rerank.ts:496, the precedence
  assert.ok(capture.batches[0].evidence, 'evidenceFromCompletion ran');   // rerank.ts:460
  assert.equal(capture.batches[0].promptTokens, null);            // rerank.ts:462 — usage omitted
  assert.equal(capture.batches[0].completionTokens, null);        // rerank.ts:463
  // …and the off side produced no capture at all to hold any of it.
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4 of 7 — rerankCohere
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('4 — rerankCohere: the CapturedBatch literal at :162-174 is never constructed', async () => {
  const { rerankCohere, createTelemetryCapture } = await ready;
  const cands = [cand(1, 'alpha'), cand(2, 'beta')];
  // An injected fetchImpl, so no socket is opened at all. `cohereRelevanceScores` reads
  // OPENROUTER_API_KEY directly, which the judge-server helper deleted, so the key is set here for
  // the duration of this case only and the request never leaves the process.
  process.env.OPENROUTER_API_KEY = 'test-only-never-sent';
  const fetchImpl = (async () => ({
    status: 200, ok: true,
    json: async () => ({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.4 }], usage: { cost: 0.001 } }),
  })) as unknown as typeof fetch;
  const noCost = async () => undefined;

  const off = await rerankCohere(QUERY, cands, fetchImpl, noCost);
  const capture = createTelemetryCapture('primary');
  const on = await rerankCohere(QUERY, cands, fetchImpl, noCost, capture);
  delete process.env.OPENROUTER_API_KEY;

  assert.deepStrictEqual(off, on);
  assert.deepStrictEqual(off.map((r) => r.rerank_score), [0.9, 0.4]);
  // The contrast is the proof: the batch exists only on the instrumented side.
  assert.equal(capture.batches.length, 1);
  assert.equal(capture.servedBackend, 'cohere');
  assert.equal(capture.expectedBatchCount, 1);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5 of 7 — expandQuery
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('5 — expandQuery: capture.expansion is never set, and here evidenceFromCompletion is INSIDE the guard', async () => {
  const { expandQuery, createTelemetryCapture } = await ready;
  const before = judge.requests.length;

  const off = await expandQuery('what is pericarditis');
  const capture = createTelemetryCapture('primary');
  const on = await expandQuery('what is pericarditis', undefined, capture);

  assert.equal(off, on, 'the expansion text is identical');
  assert.equal(judge.requests.length - before, 2, 'one provider call each');
  // Unlike rerankJudge, `evidenceFromCompletion` here sits inside `if (capture)` at lib/expand.ts:36,
  // so with no capture nothing runs at all — not even dead work.
  assert.ok(capture.expansion, 'the on side recorded an expansion');
  assert.equal(capture.expansion?.status, 'expanded');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6 of 7 — retrieveMultiQuery
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('6 — retrieveMultiQuery: armCaptures undefined, arms called with undefined, children never set', async () => {
  const { retrieveMultiQuery } = await ready;
  const calls: Array<{ query: string; hadCapture: boolean }> = [];
  const retrieveFn = (async (query: string, _o?: RetrieveOptions, capture?: TelemetryCapture) => {
    calls.push({ query, hadCapture: !!capture });
    return { hits: [{ id: 1, text: 't1' }, { id: 2, text: 't2' }], expandedQuery: query } as unknown as RetrieveResult;
  }) as never;
  const deps = {
    retrieveFn,
    variantsWithTelemetryFn: async () => ({
      status: 'generated' as const, variants: ['v1', 'v2'],
      evidence: null, promptTokens: null, completionTokens: null,
    }),
  };

  const res = await retrieveMultiQuery('q', { topK: 4, skipExpand: true }, deps as never);

  assert.equal(calls.length, 3, 'the original expanded arm plus two variants');
  // `armCaptures` is undefined at lib/multi-query.ts:265, so `armCaptures?.[vi]` at :274 is
  // undefined for every arm.
  for (const c of calls) assert.equal(c.hadCapture, false, `${c.query} was handed a capture`);
  assert.ok(res.hits.length > 0, 'and the runtime shape is exactly today\'s');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7 of 7 — the MatchInput seam. v11 report item 11 requires it alongside the six functions.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('7 — the MatchInput seam: no telemetry field means no capture, no declaration and no write', async () => {
  const { matchLowValueCare } = await ready;
  const beforeAll = new Map(TELEMETRY_WRITES.map((re) => [re, stub.matching(re).length]));
  const recsBefore = stub.matching(/FROM lvc_recommendations/).length;

  await matchLowValueCare(
    { scenario: 'a patient with knee pain', proposedActions: ['mri knee'], trace: false },
    { judge: async (_ctx, recs) => recs.map((rec) => ({ rec, verdict: 'insufficient_info' as const, confidence: 0, why: '', consider_instead: null })) },
  );

  // `defaultRecall` really ran — this is what stops the case passing vacuously because the pipeline
  // returned early somewhere before the seam.
  assert.equal(
    stub.matching(/FROM lvc_recommendations/).length - recsBefore, 1,
    'defaultRecall executed its corpus read, so the seam was genuinely reached',
  );
  // And wrote nothing: `tele` is undefined, so no capture, no startInvocation, no declaration, and
  // `finishRecall` returns at its first line.
  for (const re of TELEMETRY_WRITES) {
    assert.equal(
      stub.matching(re).length - (beforeAll.get(re) as number), 0,
      `the uninstrumented seam executed a telemetry statement: ${re}`,
    );
  }
});
