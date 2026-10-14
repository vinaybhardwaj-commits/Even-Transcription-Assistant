/**
 * lib/__tests__/retrieval-ranking-invariance.test.ts — kickoff v11 test 60, ranking invariance.
 *
 * ══ THE SHAPE OF THIS TEST, WHICH IS THE ONLY THING THAT MAKES IT WORTH ANYTHING ═══════════════
 *
 *   ONE SIDE RUNS WITH A CAPTURE. THE OTHER OMITS THE ARGUMENT ENTIRELY.
 *
 *       const off = await retrieve(QUERY, OPTS_A);              // exactly two arguments
 *       const on  = await retrieve(QUERY, OPTS_A, captureA);    // exactly three
 *
 * `OPTS_A` is the SAME OBJECT REFERENCE on both calls, not two equal literals, and it is frozen so
 * neither run can mutate what the other reads.
 *
 * ⚠️ AND THE CALL FORMS ARE PINNED IN THIS FILE'S OWN SOURCE, at the bottom. Without that pin a
 * later edit that hands the off side a capture makes every assertion here vacuous — both sides would
 * be instrumented, the two results would still agree, and nothing would notice. An adversarial pass
 * over addendum v2 revision 1 built exactly that test: it satisfied every other requirement and
 * proved only that `retrieve` is deterministic against a fixed stub. The pin is what forbids it.
 *
 * ══ THE ENVIRONMENT: IDENTICAL ON BOTH SIDES (addendum v1 decision 9) ══════════════════════════
 * v11 asked for "the same injected collaborators". `retrieve`, `rerankJudge` and `expandQuery` have
 * no injection parameter at all, so that was amended to "an identical environment on both sides":
 * the same database stub with the same routes registered once, the same judge server, and the same
 * `opts` object. Routes are registered ONCE and both runs share them — `stub.reset()` is never
 * called between runs, because it clears routes as well as calls and the second run would then see
 * only unmatched statements returning `[]`.
 *
 * ⚠️ NO PRODUCTION FILE WAS CHANGED TO MAKE THIS RUN. `JUDGE_BATCH` and `judgeBatchBoundaries` stay
 * unexported; the batch count is asserted from the observed judge requests and from an expectation
 * derived by hand from `lib/rerank.ts:58`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDbStub, type DbStub } from './telemetry-db-stub';
import { startJudgeServer, type JudgeServer } from './judge-server-stub';
import { buildCitedContext } from '../citations-core';

const SELF = readFileSync('lib/__tests__/retrieval-ranking-invariance.test.ts', 'utf8');

// ── The fixture ────────────────────────────────────────────────────────────────────────────────
// Ids are NUMBERS, deliberately (trap 5): the stub types a column from its first non-null sample
// value, so an id written as a string parses back as a string, `byId.get(id)` at
// `lib/retrieve.ts:563` misses, and `:564` drops the hit silently.
const VEC_ROWS = Array.from({ length: 18 }, (_, i) => ({ id: 101 + i, rank: i + 1 }));
const BM25_ROWS = [{ id: 101, rank: 1 }, { id: 103, rank: 2 }, { id: 105, rank: 3 }];

/** Every passage carries a unique leading marker — the only thing that tells one judge batch from
 *  another (`[idx]` restarts at 0 each batch). It sits well inside MAX_SNIPPET_CHARS = 600 and
 *  survives the whitespace collapse at `lib/rerank.ts:430`. */
const marker = (id: number) => `MRK${id}`;
const HYDRATED = VEC_ROWS.map(({ id }) => ({
  id,
  source: 'mksap',
  book: `Book ${id}`,
  chapter: `Chapter ${id}`,
  section: `Section ${id}`,
  page_start: id,
  page_end: id + 1,
  item_number: `IT-${id}`,
  chunk_type: 'text',
  text: `${marker(id)} a clinical passage used only by this test, numbered ${id}.`,
  token_count: 100 + id,
  similarity: 0.9 - id / 1000,
  source_quality_weight: 1.0,
}));

// RRF_K is 60 (`lib/retrieve.ts:114`). Scores are 1/(60+rank) summed per leg, and this fixture was
// chosen so no two totals tie — trap 7: ties would resolve by Map insertion order and the expected
// order below would be an accident rather than a derivation.
//   101 -> 1/61 + 1/61 = 0.03278689      104 -> 1/64 = 0.01562500
//   103 -> 1/63 + 1/62 = 0.03200205      106 -> 1/66 = 0.01515152   … and so on, strictly decreasing
//   105 -> 1/65 + 1/63 = 0.03125763
//   102 -> 1/62         = 0.01612903
const FUSED_TOP_4 = [101, 103, 105, 102];
const FUSED_TOP_12 = [101, 103, 105, 102, 104, 106, 107, 108, 109, 110, 111, 112];

// Judge scores on the 0–10 scale, keyed by marker. Chosen to REORDER (non-vacuity 5): all-zero or
// all-equal scores return input order and look perfectly invariant while proving nothing.
const JUDGE_SCORES: Record<string, number> = {
  MRK112: 10, MRK108: 9, MRK101: 8, MRK110: 7, MRK103: 6, MRK105: 5,
  MRK102: 4, MRK104: 3, MRK106: 2, MRK107: 1, MRK109: 0.5, MRK111: 0.2,
};
/** Derived from JUDGE_SCORES: the 12 candidates sorted by score, then trimmed to topK = 4. */
const RERANKED_TOP_4 = [112, 108, 101, 110];

const QUERY = 'what is the management of acute pericarditis';
// A real 8-element nomic-shaped stub vector. Every element must be a number: `vectorLiteral` calls
// `.toFixed(7)` on each (`lib/llm.ts:611`) and throws before any SQL otherwise.
const QUERY_EMBEDDING = [0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8];

// ⚠️ FROZEN, AND THE SAME REFERENCE ON BOTH CALLS. Each field is load-bearing:
//   skipExpand    stops `retrieve` reaching `expandQuery` (`lib/retrieve.ts:408`)
//   queryEmbedding stops it reaching `embedQuery` (`:411-413`)
//   topK: 4       gives poolSize 12 when the reranker is on, which is what makes case B exactly
//                 three judge batches; it also pins the final trim
//   no restrictSources  — it would add `source = ANY($3)` to the VECTOR leg's filter too, and S4's
//                 routing fragment would then match NOTHING while S6's captured both
//   no useEmbeddingV2   — `USE_EMBEDDING_V2` is a hardcoded false (`lib/llm.ts:596`); passing true
//                 arms S1, disables the queryEmbedding escape, and switches embCol to
//                 `embedding_v2`, so S4 and S6 both stop matching their own fragments
//   hybrid left at default — `lib/retrieve.ts:385` is `opts.hybrid !== false`, so S5a runs anyway
const OPTS_A = Object.freeze({ topK: 4, skipExpand: true, queryEmbedding: QUERY_EMBEDDING, useReranker: false });
const OPTS_B = Object.freeze({ topK: 4, skipExpand: true, queryEmbedding: QUERY_EMBEDDING, useReranker: true });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CASE C — THE PRODUCTION SHAPE. Fixture, weights and expected orders.
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠️ WHY THIS CASE EXISTS (addendum v3 §1). Cases A and B prove invariance for ONE opts shape, and
// production uses a different one. Four fields differ and two of them matter:
//   · `useSourceWeights: true` is set by production and by NO test before this one. The block at
//     `lib/retrieve.ts:604-627` ends in `hits.sort(...)`, so it was dead code under the whole suite —
//     a capture-conditional edit inside it would change production ranking under instrumentation and
//     still pass every assertion at `31424cb`.
//   · `topK: 8` gives poolSize 24, not 12, so the batch arithmetic under test was not the shipped one.
// Production also sets neither `skipExpand` nor `queryEmbedding`, so expansion and embedding run for
// real here — both served by the same local server, through the same OpenAI client.

const VEC_ROWS_C = Array.from({ length: 26 }, (_, i) => ({ id: 301 + i, rank: i + 1 }));
const BM25_ROWS_C = [{ id: 301, rank: 1 }, { id: 303, rank: 2 }, { id: 305, rank: 3 }];

/** The fused top-24 under poolSize 24, by the same RRF arithmetic as cases A and B, tie-free. */
const FUSED_C = [
  301, 303, 305, 302, 304, 306, 307, 308, 309, 310, 311, 312,
  313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324,
];

/**
 * Three source profiles, cycled across the fused order, chosen so `computeSourceQualityWeight`
 * returns three CLEARLY different weights — a fixture where every source weighs the same exercises
 * the block and proves nothing about it.
 *
 *   bookTier × chunkTypeBonus × tokenLengthFactor   (`lib/source-quality.ts:109-115`)
 *   MKSAP 19    · explanation · 500 tokens  =  1.00 × 1.05 × 1.00  =  1.0500
 *   StatPearls  · narrative   · 500 tokens  =  0.90 × 1.00 × 1.00  =  0.9000
 *   PubMed      · (null)      ·  30 tokens  =  0.80 × 0.95 × 0.70  =  0.5320
 *
 * `bookTier` matches against `${book} ${source}` lowercased, so the third profile's strings are
 * chosen to hit NO tier and fall to the 0.80 unknown-book default. None is a lab source, so
 * `clampSourceWeight` leaves all three untouched.
 */
const PROFILES_C = [
  { book: 'MKSAP 19', source: 'mksap-19', chunk_type: 'explanation', token_count: 500, weight: 1.05 },
  { book: 'StatPearls', source: 'statpearls', chunk_type: 'narrative', token_count: 500, weight: 0.9 },
  { book: 'Journal of Minor Findings', source: 'pubmed', chunk_type: null, token_count: 30, weight: 0.532 },
];
const profileFor = (id: number) => PROFILES_C[FUSED_C.indexOf(id) % 3];

const HYDRATED_C = VEC_ROWS_C.map(({ id }) => {
  const p = profileFor(id) ?? PROFILES_C[0];
  return {
    id, source: p.source, book: p.book, chapter: `Chapter ${id}`, section: `Section ${id}`,
    page_start: id, page_end: id + 1, item_number: `IT-${id}`, chunk_type: p.chunk_type,
    text: `MRK${id} a clinical passage used only by case C, numbered ${id}.`,
    token_count: p.token_count, similarity: 0.9 - id / 1000, source_quality_weight: 1.0,
  };
});

/**
 * Judge scores descending in FUSED order, so the judge alone would return the fused order and the
 * SOURCE WEIGHTS are the only thing that can reorder. Distinct, so neither sort has a tie.
 */
const JUDGE_SCORES_C: Record<string, number> = Object.fromEntries(
  FUSED_C.map((id, k) => [`MRK${id}`, Number((10 - k * 0.35).toFixed(4))]),
);

/** What the top 8 would be on `rerank_score` alone — i.e. if `useSourceWeights` were false. */
const UNWEIGHTED_TOP_8_C = [301, 303, 305, 302, 304, 306, 307, 308];
/** What it is once `rerank_score_weighted = rerank_score × weight` is sorted. Order AND membership differ. */
const WEIGHTED_TOP_8_C = [301, 302, 303, 307, 304, 310, 308, 313];

// ── The seven statements, and the fragments that route them ────────────────────────────────────
// Verified pairwise non-overlapping under the opts above by `pairwise fragments` below, which is an
// executed check rather than a claim.
const S1_V2_PROBE = /information_schema\.columns/;
const S2_LEXEMES = /::text AS q/;
const S3_DF = /EXPLAIN \(FORMAT JSON\)/;
const S4_VECTOR = /ROW_NUMBER\(\) OVER \(ORDER BY embedding <=> \$1::vector\)[\s\S]*NOT LIKE 'labq:%'/;
const S5A_BM25 = /ts_rank_cd\(text_tsv, plainto_tsquery/;
const S5B_BM25_DISC = /WITH cand AS \(/;
const S6_NORMATIVE = /ROW_NUMBER\(\) OVER \(ORDER BY embedding <=> \$1::vector\)[\s\S]*source = ANY\(\$3\)/;
const S7_HYDRATE = /COALESCE\(source_quality_weight/;

const RAN_ALWAYS = [S4_VECTOR, S5A_BM25, S7_HYDRATE];
const NEVER_RUN: Array<[string, RegExp]> = [
  ['S1 embedding_v2 probe', S1_V2_PROBE], ['S2 lexemes', S2_LEXEMES], ['S3 DF estimate', S3_DF],
  ['S5b discriminating BM25', S5B_BM25_DISC], ['S6 normative leg', S6_NORMATIVE],
];

// tsx compiles tests to CJS (no top-level await), so setup is a lazy promise every case awaits.
// The judge server's env writes MUST precede the dynamic import: `lib/llm.ts` reads
// OLLAMA_BASE_URL and GCP_PROJECT at module load, and `lib/rerank.ts` reads RERANK_JUDGE_MODEL and
// RERANK_BACKEND at module load.
let judge: JudgeServer;
let stub: DbStub;
const ready = (async () => {
  judge = await startJudgeServer(JUDGE_SCORES);
  stub = installDbStub();
  // Registered ONCE. Both runs of both cases share them.
  stub.on(S4_VECTOR, VEC_ROWS);
  stub.on(S5A_BM25, BM25_ROWS);
  stub.on(S7_HYDRATE, HYDRATED);
  const retrieveMod = await import('../retrieve');
  const captureMod = await import('../retrieval-capture');
  const auditMod = await import('../opd-note-audit');
  return {
    retrieve: retrieveMod.retrieve,
    createTelemetryCapture: captureMod.createTelemetryCapture,
    opdRetrieveOpts: auditMod.opdRetrieveOpts,
  };
})();

test.after(async () => { await judge?.close(); });

/** The rendered scorer context — the exact bytes an HMAC would be taken over, compared without a key. */
const scorerContext = (r: { hits: unknown[] }) =>
  buildCitedContext(r.hits as unknown as Parameters<typeof buildCitedContext>[0]);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 60 — case A: useReranker false. Fully deterministic, no judge, no socket beyond the stub.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('60 A — useReranker false: instrumentation on and off return byte-identical results', async () => {
  const { retrieve, createTelemetryCapture } = await ready;
  const before = stub.calls.length;

  const off = await retrieve(QUERY, OPTS_A);
  const captureA = createTelemetryCapture('primary');
  const on = await retrieve(QUERY, OPTS_A, captureA);

  // ── THE ORACLE: the WHOLE RetrieveResult, meta included. It carries no timestamp, uuid, duration
  // or counter, so against a fixed stub every field is a pure function of the routed rows and opts.
  // A spot check of hits.map(h => h.id) would be weaker than the code allows.
  assert.deepStrictEqual(off, on);

  // ── Non-vacuity 1: the exact ids, in the exact order, on BOTH sides — not merely that they agree.
  assert.deepStrictEqual(off.hits.map((h) => h.id), FUSED_TOP_4);
  assert.deepStrictEqual(on.hits.map((h) => h.id), FUSED_TOP_4);

  // ── Non-vacuity 2: the MAIN return ran, asserted BY VALUE. The early return at
  // `lib/retrieve.ts:540-546` and the main return at `:653-668` emit identical meta FIELD NAMES,
  // including both conditional spreads under identical guards, so no field distinguishes them.
  // Only three values do. With the reranker off, poolSize is topK.
  assert.equal(off.meta?.pool_size, 4, 'pool_size is topK with the reranker off — 0 would be the empty-fusion early return');
  assert.equal(off.meta?.fused, 4);
  assert.equal(off.meta?.reranked, false);
  assert.equal(off.meta?.vector_pool, 18);
  assert.equal(off.meta?.bm25_pool, 3);

  // ── The scorer context, which v11's test 60 names alongside the ordered output. `RetrieveResult`
  // carries none, so it is rendered from `hits` with the production renderer and compared as bytes.
  // Not an HMAC: these ARE the bytes the HMAC is taken over, so comparing them is the same claim.
  assert.equal(scorerContext(off), scorerContext(on));
  assert.ok(scorerContext(off).includes('MRK101'), 'the rendered context is real, not an empty string');

  // ── Non-vacuity 3: every routed statement ran exactly TWICE, once per side. This is what catches
  // a missed route: `telemetry-db-stub.ts:115` returns [] for anything unmatched, and all three legs
  // at `lib/retrieve.ts:508`, `:509` and `:511` swallow every error, so a missing route is
  // indistinguishable from an empty leg without this.
  for (const re of RAN_ALWAYS) {
    assert.equal(stub.matching(re).length, 2, `expected exactly 2 calls matching ${re}`);
  }
  for (const [name, re] of NEVER_RUN) {
    assert.equal(stub.matching(re).length, 0, `${name} must not run under these opts`);
  }
  assert.equal(stub.calls.length - before, 6, 'three statements per side, twice');

  // ── Non-vacuity 4: the capture is genuinely populated. If the on side wrote nothing, invariance
  // would be trivially true.
  assert.deepStrictEqual(captureA.fusedCandidateIds, FUSED_TOP_4);
  assert.deepStrictEqual(captureA.hydratedCandidateIds, FUSED_TOP_4);
  assert.deepStrictEqual(captureA.orderedFinalCandidateIds, FUSED_TOP_4);
  assert.equal(captureA.retrievalOutcome, 'success');
  assert.equal(captureA.indexVersion, 'embedding|nomic-embed-text');
  assert.equal(captureA.batches.length, 0, 'the reranker is off, so no batch exists');

  // ── And no judge socket was opened at all on this case.
  assert.equal(judge.requests.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 60 — case B: useReranker true, against the local judge server. This is why the harness exists.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('60 B — useReranker true: identical results, batch boundaries and prompts across on and off', async () => {
  const { retrieve, createTelemetryCapture } = await ready;
  const before = stub.calls.length;
  const judgeBefore = judge.requests.length;
  // Counted as a DELTA across this case, because case A already ran against the same stub and
  // `stub.reset()` is deliberately never called — it would clear the routes too.
  const countBefore = new Map(RAN_ALWAYS.map((re) => [re, stub.matching(re).length]));

  const off = await retrieve(QUERY, OPTS_B);
  const captureB = createTelemetryCapture('primary');
  const on = await retrieve(QUERY, OPTS_B, captureB);

  // The oracle, whole. `rerank_score` and `rerank_backend` are deterministic here because the judge
  // server returns fixed scores, so they are NOT excluded.
  assert.deepStrictEqual(off, on);

  // Non-vacuity 1, and non-vacuity 5: the reranked order must DIFFER from the input order. Scores
  // initialise to zero (`lib/rerank.ts:414`) and the sort at `:523` is stable, so an all-zero run
  // returns input order and looks perfectly invariant.
  assert.deepStrictEqual(off.hits.map((h) => h.id), RERANKED_TOP_4);
  assert.deepStrictEqual(on.hits.map((h) => h.id), RERANKED_TOP_4);
  assert.notDeepStrictEqual(
    off.hits.map((h) => h.id), FUSED_TOP_12.slice(0, 4),
    'the judge REORDERED: this is the assertion an all-zero or all-equal judge would fail',
  );
  assert.equal(off.hits[0].rerank_score, 1.0);
  assert.equal(off.hits[0].rerank_backend, 'judge');

  // Non-vacuity 2, by value. With the reranker on, poolSize = min(30, topK * 3) = 12.
  assert.equal(off.meta?.pool_size, 12, 'the main return ran; the early return hard-codes 0');
  assert.equal(off.meta?.reranked, true);
  assert.equal(off.meta?.fused, 4, 'fused is hits.length AFTER the trim to topK');

  assert.equal(scorerContext(off), scorerContext(on));

  // Non-vacuity 3.
  for (const re of RAN_ALWAYS) {
    assert.equal(
      stub.matching(re).length - (countBefore.get(re) as number), 2,
      `expected exactly 2 more calls matching ${re} — one per side`,
    );
  }
  for (const [name, re] of NEVER_RUN) {
    assert.equal(stub.matching(re).length, 0, `${name} must not run under these opts`);
  }
  assert.equal(stub.calls.length - before, 6);

  // Non-vacuity 4.
  assert.deepStrictEqual(captureB.fusedCandidateIds, FUSED_TOP_12);
  assert.deepStrictEqual(captureB.hydratedCandidateIds, FUSED_TOP_12);
  assert.deepStrictEqual(captureB.orderedFinalCandidateIds, RERANKED_TOP_4);

  // Non-vacuity 6: exactly three judge batches. JUDGE_BATCH is 5 and is NOT exported (`lib/rerank.ts:58`),
  // so 5 is hardcoded here and the expectation derived from it: 12 hydrated candidates give
  // boundaries [{0,5},{5,10},{10,12}]. The observed hydrated count is asserted alongside, so a
  // fixture drift shows up as a number rather than a mystery.
  const JUDGE_BATCH_LITERAL = 5;             // lib/rerank.ts:58, not exported
  const hydratedCount = captureB.hydratedCandidateIds.length;
  assert.equal(hydratedCount, 12, 'observed hydrated candidate count');
  assert.equal(captureB.expectedBatchCount, Math.ceil(hydratedCount / JUDGE_BATCH_LITERAL));
  assert.equal(captureB.expectedBatchCount, 3);
  assert.equal(captureB.batches.length, 3);
  assert.equal(captureB.servedBackend, 'judge');

  // ⚠️ SORTED BY INDEX BEFORE COMPARING. `capture.batches` is in COMPLETION order, not boundary
  // order: the push at `lib/rerank.ts:507` is the last statement of an async callback inside the
  // `Promise.all` at `:427`, and the repair sort lives only in `buildRetrievalPayload`
  // (`lib/retrieval-capture.ts:231-233`), which uses `.slice()` and never repairs in place.
  // Reading `capture.batches[0]` and expecting `{start: 0, end: 5}` would be a race.
  const byIndex = captureB.batches.slice().sort((a, b) => a.index - b.index);
  assert.deepStrictEqual(
    byIndex.map((b) => ({ index: b.index, start: b.start, end: b.end })),
    [{ index: 0, start: 0, end: 5 }, { index: 1, start: 5, end: 10 }, { index: 2, start: 10, end: 12 }],
  );
  for (const b of byIndex) assert.equal(b.outcome, 'success');

  // ── The PROMPTS, which is the other half of what this case exists to prove. Three requests per
  // side, and the two sides' request sets are identical once ordered — the batches race, so they
  // are keyed by their marker set rather than by arrival position.
  const reqs = judge.requests.slice(judgeBefore);
  assert.equal(reqs.length, 6, 'three batches per side, and no SDK retry (maxRetries 0)');
  const key = (r: { markers: string[] }) => r.markers.join(',');
  const offReqs = reqs.slice(0, 3).map(key).sort();
  const onReqs = reqs.slice(3, 6).map(key).sort();
  assert.deepStrictEqual(offReqs, onReqs, 'identical batch boundaries and passage sets on both sides');
  assert.deepStrictEqual(offReqs, [
    'MRK101,MRK103,MRK105,MRK102,MRK104',
    'MRK106,MRK107,MRK108,MRK109,MRK110',
    'MRK111,MRK112',
  ].sort());
  // The full user message is identical too, not just the marker set.
  const offBodies = reqs.slice(0, 3).map((r) => r.user).sort();
  const onBodies = reqs.slice(3, 6).map((r) => r.user).sort();
  assert.deepStrictEqual(offBodies, onBodies, 'byte-identical prompts');
  assert.ok(reqs[0].user.startsWith(`QUESTION:\n${QUERY}`));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 60 — case C: THE PRODUCTION SHAPE. topK 8, reranker on, SOURCE WEIGHTS ON, expansion and
// embedding unescaped. This is the case that closes the single-configuration limit in Part IX.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('60 C — the production opts: identical results with source weighting, expansion and embedding all live', async () => {
  const { retrieve, createTelemetryCapture, opdRetrieveOpts } = await ready;

  // ⚠️ THE OPTS COME FROM THE CODE, NOT FROM A LITERAL. `opdRetrieveOpts` is what
  // `defaultRetrieve` hands `retrieve()` at `lib/opd-note-audit.ts:647`, so calling it means this
  // case tracks production if the function ever changes — and the deep-equal below makes that
  // change LOUD rather than silent.
  const OPTS_C = Object.freeze(opdRetrieveOpts(false, {}));
  assert.deepStrictEqual(
    { ...OPTS_C },
    { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true },
    'opdRetrieveOpts(false, {}) is no longer the four-field production shape this case was built for',
  );

  // Case C's own rows. Registered once, before both runs, and last-route-wins means they take over
  // from cases A and B — which have already run, because node:test runs a file's cases in order.
  stub.on(S4_VECTOR, VEC_ROWS_C);
  stub.on(S5A_BM25, BM25_ROWS_C);
  stub.on(S7_HYDRATE, HYDRATED_C);
  judge.setScores(JUDGE_SCORES_C);

  const countBefore = new Map(RAN_ALWAYS.map((re) => [re, stub.matching(re).length]));
  const judgeBefore = judge.requests.length;

  const off = await retrieve(QUERY, OPTS_C);
  const captureC = createTelemetryCapture('primary');
  const on = await retrieve(QUERY, OPTS_C, captureC);

  // ── The oracle, whole, on the production shape.
  assert.deepStrictEqual(off, on);

  // ── Non-vacuity 1: the exact ids in the exact order, on both sides.
  assert.deepStrictEqual(off.hits.map((h) => h.id), WEIGHTED_TOP_8_C);
  assert.deepStrictEqual(on.hits.map((h) => h.id), WEIGHTED_TOP_8_C);
  assert.equal(off.hits.length, 8, 'trimmed to topK = 8');

  // ── ⚠️ THE POINT OF THIS CASE: the source weights REORDERED the hits, and it is checked two ways.
  // First against the hand-derived order the judge alone would have produced.
  assert.notDeepStrictEqual(
    off.hits.map((h) => h.id), UNWEIGHTED_TOP_8_C,
    'source weighting changed nothing — the block ran and nothing checked it',
  );
  // Second, and non-circularly, from the RETURNED data alone: re-sorting the returned hits by their
  // own raw `rerank_score` gives a different order than the order they came back in. That can only
  // be true if something other than rerank_score decided the final order.
  const byRawScore = off.hits.slice().sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0));
  assert.notDeepStrictEqual(
    byRawScore.map((h) => h.id), off.hits.map((h) => h.id),
    'the returned order IS the raw rerank_score order, so the weighting had no effect',
  );
  // And the weighted sort key really was written onto every hit.
  for (const h of off.hits) {
    const w = (h as unknown as Record<string, number>).source_quality_weight;
    const weighted = (h as unknown as Record<string, number>).rerank_score_weighted;
    assert.ok([1.05, 0.9, 0.532].includes(w), `unexpected weight ${w} on hit ${h.id}`);
    assert.ok(Math.abs(weighted - (h.rerank_score ?? 0) * w) < 1e-12, 'rerank_score_weighted = score × weight');
  }
  // ⚠️ AND THE DEMOTION IS THE CLEANEST STATEMENT OF THE EFFECT. The fixture gives eight of the 24
  // hydrated rows the 0.532 profile; 305 and 306 are inside the top 8 on raw judge score and are
  // pushed OUT of it once weighted. So the block did not merely run — it changed who survives the
  // trim, which is the ranking claim `useSourceWeights` makes.
  const lowWeightIds = FUSED_C.filter((id) => profileFor(id)?.weight === 0.532);
  assert.ok(lowWeightIds.length >= 8, 'the fixture really is mixed: low-weight rows exist in the pool');
  assert.ok(UNWEIGHTED_TOP_8_C.some((id) => lowWeightIds.includes(id)), '…and some reach the unweighted top 8');
  assert.equal(
    off.hits.some((h) => lowWeightIds.includes(h.id)), false,
    'every 0.532-weight row was demoted out of the final top 8 by the weighting',
  );
  // The surviving weights are the two high tiers, and nothing else.
  assert.deepStrictEqual(
    [...new Set(off.hits.map((h) => (h as unknown as Record<string, number>).source_quality_weight))].sort(),
    [0.9, 1.05],
  );

  // ── Non-vacuity 2, by value: poolSize is min(30, topK × 3) = 24 with the reranker on.
  assert.equal(off.meta?.pool_size, 24, 'pool_size is 24 at topK 8 — 12 would mean topK 4, 0 the early return');
  assert.equal(off.meta?.reranked, true);
  assert.equal(off.meta?.source_weighted, true, 'the weighting block is the one under test here');
  assert.equal(off.meta?.fused, 8);

  assert.equal(scorerContext(off), scorerContext(on));

  // ── Non-vacuity 3: the same three statements, twice each, and none of the other four.
  for (const re of RAN_ALWAYS) {
    assert.equal(stub.matching(re).length - (countBefore.get(re) as number), 2, `expected 2 more calls matching ${re}`);
  }
  for (const [name, re] of NEVER_RUN) {
    assert.equal(stub.matching(re).length, 0, `${name} must not run under the production opts either`);
  }

  // ── Non-vacuity 4: the capture is populated, at the production pool size.
  assert.deepStrictEqual(captureC.fusedCandidateIds, FUSED_C);
  assert.equal(captureC.fusedCandidateIds.length, 24);
  assert.deepStrictEqual(captureC.hydratedCandidateIds, FUSED_C);
  assert.deepStrictEqual(captureC.orderedFinalCandidateIds, WEIGHTED_TOP_8_C);
  assert.equal(captureC.retrievalOutcome, 'success');

  // ── Non-vacuity 6: the batch count follows the HYDRATED count, not topK. JUDGE_BATCH is 5 and is
  // not exported (`lib/rerank.ts:58`).
  const JUDGE_BATCH_LITERAL = 5;
  const hydratedCount = captureC.hydratedCandidateIds.length;
  assert.equal(hydratedCount, 24, 'observed hydrated candidate count');
  assert.equal(captureC.expectedBatchCount, Math.ceil(hydratedCount / JUDGE_BATCH_LITERAL));
  assert.equal(captureC.expectedBatchCount, 5, 'ceil(24 / 5)');
  assert.equal(captureC.batches.length, 5);
  const byIndex = captureC.batches.slice().sort((a, b) => a.index - b.index);
  assert.deepStrictEqual(
    byIndex.map((b) => ({ start: b.start, end: b.end })),
    [{ start: 0, end: 5 }, { start: 5, end: 10 }, { start: 10, end: 15 }, { start: 15, end: 20 }, { start: 20, end: 24 }],
  );

  // ── ⚠️ THE TWO ESCAPES CASES A AND B TAKE ARE GONE, AND THAT IS ASSERTED, NOT ASSUMED.
  const reqs = judge.requests.slice(judgeBefore);
  const expansions = reqs.filter((r) => r.kind === 'expansion');
  const embeddings = reqs.filter((r) => r.kind === 'embedding');
  const judged = reqs.filter((r) => r.kind === 'judge');
  assert.equal(expansions.length, 2, 'expandQuery ran once per side — no skipExpand');
  assert.equal(embeddings.length, 2, 'embedQuery ran once per side — no queryEmbedding');
  assert.equal(judged.length, 10, 'five judge batches per side');
  // The expansion really reached the expansion prompt, and the embedding really saw the EXPANDED text.
  assert.match(expansions[0].system, /medical query rewriter/);
  assert.ok(off.expandedQuery.startsWith(QUERY), 'the expansion appended to the original question');
  assert.ok(off.expandedQuery.length > QUERY.length, 'and it is not a no-op');
  assert.equal(embeddings[0].input, off.expandedQuery, 'embedQuery was handed the EXPANDED query');
  assert.equal(embeddings[0].input, embeddings[1].input, 'both sides embedded identical text');

  // ⚠️ AND THE VECTOR ITSELF MUST MATCH, WHICH IS NOT IMPLIED BY THE ABOVE. FOUND BY ATTACK:
  // making the embedding server return a different vector on its second call broke NOTHING, because
  // the database stub routes on statement TEXT and ignores bound parameters — so both runs got the
  // same rows from a different query vector and every other assertion still held. The vector reaches
  // the database only as `$1`, so that is where it has to be compared.
  const vecCalls = stub.matching(S4_VECTOR).slice(-2);
  assert.equal(vecCalls.length, 2, 'both sides issued the vector leg');
  assert.equal(
    vecCalls[0].params[0], vecCalls[1].params[0],
    'the two sides bound DIFFERENT query vectors to $1 — the embedding is not deterministic',
  );
  assert.ok(String(vecCalls[0].params[0]).startsWith('['), 'and it really is a vector literal');
  // And the capture recorded the expansion, which is what `lib/expand.ts:36` writes.
  assert.ok(captureC.expansion, 'capture.expansion was populated');
  assert.equal(captureC.expansion?.status, 'expanded');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The pins that stop this file from going vacuous
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('60 — THE CALL-FORM PIN: one side omits the capture argument, per case', () => {
  // ⚠️ WHAT THIS IS FOR. Every assertion above compares two runs. If a later edit gives the OFF side
  // a capture, the two runs stay equal, every case still passes, and the test proves only that
  // `retrieve` is deterministic — which is not what test 60 claims. This pin is the thing that
  // fails in that case, and it is the reason the two call forms are written as they are.
  //
  // The needles are BUILT, never written as literals, so the pin cannot be satisfied by its own
  // source text. The trailing `;` is what stops the two-argument needle from matching inside the
  // three-argument call.
  //
  // ⚠️ AND IT COUNTS CODE, NOT PROSE. The header of this file illustrates both call forms, so a
  // count over the raw source saw two of the two-argument form and failed — found by running it.
  // That is the same hazard the import scanner hit in pass 1: a text-level check that does not skip
  // comments reads an explanation as the thing it explains. Comment lines are stripped first, which
  // also means the illustration above can be edited freely without silently weakening the pin.
  const call = (opts: string, cap?: string) => `await retrieve(QUERY, ${opts}${cap ? `, ${cap}` : ''});`;
  const CODE = SELF.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const count = (needle: string) => CODE.split(needle).length - 1;

  // ⚠️ OPTS_C IS IN THIS LIST, AND THAT IS NOT OPTIONAL. Case C is the production shape; if the pin
  // did not cover it, the one case that matters most would be the one case free to go vacuous.
  for (const [opts, cap] of [['OPTS_A', 'captureA'], ['OPTS_B', 'captureB'], ['OPTS_C', 'captureC']] as const) {
    assert.equal(count(call(opts)), 1, `exactly one TWO-argument retrieve call for ${opts}`);
    assert.equal(count(call(opts, cap)), 1, `exactly one THREE-argument retrieve call for ${opts}`);
  }
  // And the pin itself is not vacuous: the needles it looks for really are absent when they should be.
  assert.equal(count(call('OPTS_A', 'captureB')), 0, 'the counter can return 0 — it is not matching everything');
});

test('60 — the seven routing fragments are pairwise non-overlapping on the statements that ran', () => {
  // Re-verified rather than asserted from the document. Each statement the run actually issued is
  // matched by exactly ONE of the seven fragments.
  const ALL: Array<[string, RegExp]> = [
    ['S1', S1_V2_PROBE], ['S2', S2_LEXEMES], ['S3', S3_DF], ['S4', S4_VECTOR],
    ['S5a', S5A_BM25], ['S5b', S5B_BM25_DISC], ['S6', S6_NORMATIVE], ['S7', S7_HYDRATE],
  ];
  assert.ok(stub.calls.length > 0, 'the cases above ran first and left statements to check');
  for (const c of stub.calls) {
    const hit = ALL.filter(([, re]) => re.test(c.query)).map(([n]) => n);
    assert.equal(hit.length, 1, `statement matched ${hit.length} fragments (${hit.join(', ')}): ${c.query.slice(0, 80)}`);
  }
  // S4 and S6 share their first line byte for byte and differ only in the rendered filter, which is
  // why S4's fragment is anchored on `NOT LIKE 'labq:%'` and S6's on `source = ANY($3)`.
  const vecStmt = stub.matching(S4_VECTOR)[0].query;
  assert.equal(S6_NORMATIVE.test(vecStmt), false, 'the normative fragment does not capture the vector statement');
});
