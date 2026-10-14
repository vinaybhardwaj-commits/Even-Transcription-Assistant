# CDMSS rerank telemetry: addendum v2, the pass-2 kickoff

**13 August 2026. Revision 2**, after an adversarial pass over revision 1 found two severe
defects and eighteen smaller ones. Section 16 lists them.

Test 60 and test 1. The two tests that prove the safety claim.

---

## 0. Authority and preflight

This document governs all work after `10f4a653138226a0f17f8ae60046e9fdbef02bfb` on
`exp/rerank-telemetry`.

It **supersedes** `CDMSS-RERANK-TELEMETRY-ADDENDUM-v1-13-AUG-2026.md` where they conflict.
Every settled decision in v1 section 10 stands, **except** v1 section 3's "not edited at
all in this pass" line for `lib/retrieval-telemetry-failure-store.ts`, which was scoped to
v1's pass and is lifted here for item 0a only.

It **amends** `CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md` at test 1.
Test 60's wording was already amended by v1 decision 9. Section 12 records both.

### Preflight. Stop on any mismatch.

```text
branch:  exp/rerank-telemetry
HEAD:    10f4a653138226a0f17f8ae60046e9fdbef02bfb
tree:    clean
```

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short
```

---

## 1. What this pass is

Four deliverables, in this order.

1. **Item 0.** Three corrections owed from pass 1.
2. **Item 1.** A shared judge-server helper.
3. **Item 2.** Test 60, ranking invariance, two cases.
4. **Item 3.** Test 1, instrumentation off, seven cases.

**Not in this pass.** Per-role manifest defects. The `retrieval_terminal_rejected` phase.
The discriminated union. Steps 19 and 21. Any deploy, migration or canary.

---

## 2. Grounding. Read before writing.

| File | Why |
|---|---|
| `CDMSS-RERANK-TELEMETRY-ADDENDUM-v1-13-AUG-2026.md` sections 3.2 and 10 | the pin hazards and the ten settled decisions |
| `lib/retrieve.ts` 382 to 669 | the function under test |
| `lib/rerank.ts` 242 to 525 | `rerank`, `rerankJudge`, `judgeBatchBoundaries` |
| `lib/__tests__/telemetry-db-stub.ts` whole file, header first | the database seam and its limits |
| `lib/__tests__/vertex-primary-ladder.test.ts` lines 39 to 89 | the local-server pattern to copy |
| `lib/__tests__/multi-query-telemetry.test.ts` lines 92 to 118 | the house pattern for test 1 |
| `lib/__tests__/lvc-telemetry-seam.test.ts` whole file | pass 1's stub usage, and the seam case test 1 extends |
| `lib/retrieval-capture.ts` 225 to 240 | where batches get sorted |

---

## 3. File contract

### Create

```text
lib/__tests__/judge-server-stub.ts                    the shared helper, NOT a .test.ts
lib/__tests__/retrieval-ranking-invariance.test.ts    test 60
lib/__tests__/instrumentation-off.test.ts             test 1
```

`judge-server-stub.ts` must not end in `.test.ts`. The glob is
`lib/**/__tests__/*.test.ts`. `telemetry-db-stub.ts` is named the same way for the same
reason.

`retrieval-ranking-invariance.test.ts` is on v11's create list. The other two are **new to
v11's file contract**, and section 12 records that.

### Edit

```text
.gitignore                                            one added line
lib/retrieval-telemetry-failure-store.ts              one comment block, item 0a
CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md    Part IX, plus two errata
```

### Add to the commit, unedited

```text
CDMSS-RERANK-TELEMETRY-ADDENDUM-v2-13-AUG-2026.md
```

Add one `!` exception line for it to `.gitignore`, matching the existing form. Do not use
`git add -f`.

### Pins that already cover files this pass touches

Addendum v1 section 3.2 catalogued three mechanisms. All three apply here, and one is
scoped differently from v1.

1. **`lib/__tests__/retrieval-telemetry-lifecycle.test.ts:209-216`** reads
   `lib/retrieval-telemetry-failure-store.ts` and fails on any line matching `/^(let|var) /`.
   v1 scoped this warning to `lib/retrieval-settlement.ts`. **It covers the failure store
   too.** Do not start any new comment line with `let ` or `var ` at column 0.
2. **`lib/__tests__/telemetry-non-exposure.test.ts`** walks `app/` and `lib/` and fails on
   `FROM` or `JOIN` against a telemetry table outside its `ALLOWED` set. **The three new
   files are not in that set.** The new tests target `mksap_chunks`, so the risk is low.
   Do not write a telemetry-table SQL string into any of them.
3. **`scripts/lib/import-scan.mjs`** matches import statements with one regex over raw file
   text and does not skip comments. A comment that spells the two keywords of a type-only
   import adjacently rewrites `lib/architecture/map.generated.ts`. Pass 1 hit this. Item 0b
   records it permanently.

### Do not touch

Everything in v11 section 4 stands. In addition, and this is the whole point of the pass:

**No production file changes except item 0a's comment. None.** If a test cannot be written
without changing `lib/retrieve.ts`, `lib/rerank.ts`, `lib/expand.ts` or
`lib/multi-query.ts`, **stop and report**. Do not add a seam, an export, a parameter or a
hook. `JUDGE_BATCH` and `judgeBatchBoundaries` stay unexported: D16 forbids it, and a test
that needed them exported would be measuring a different function from the one that ships.

---

## 4. Item 0. Three corrections owed from pass 1.

### 0a. `lib/retrieval-telemetry-failure-store.ts` lines 66 to 67 are a false statement, and addendum v1 said they were true.

```
lib/retrieval-telemetry-failure-store.ts:66-67
 * Read the failure phases recorded for one run, most recent first. Used ONLY by the reconciler
 * (D13), which needs to know whether a stalled row stalled with evidence or in silence.
```

```
lib/retrieval-settlement.ts:19    import { failurePhasesForRun } from './retrieval-telemetry-failure-store';
lib/retrieval-settlement.ts:110   return reconcilerStateFor('started', await failurePhasesForRun(run.runId));
```

Settlement is a second reader. Addendum v1 instructed that this be left alone because the
claim "is about who reads them, and it is **true**". It is not, and that reason was written
into Part VIII section 4.

Fix the comment. Say the reconciler reads it, and that settlement also reads it for a
revision-0 run through `stateForUnwrittenRun`. **Comment only.** The JSDoc block is lines
65 to 71, above `failurePhasesForRun` at line 72, so a comment-only edit is possible.

### 0b. Record the import-scanner hazard permanently.

Pass 1 found it the hard way. Add it to Part IX as a fourth entry in the class that
addendum v1 section 3.2 catalogues, so a future pass does not rediscover it. Section 3
above already carries it forward.

### 0c. Two line citations in Part VIII are wrong.

Part VIII section 6 says the pinned arms are "at lines 215 and 216 of the route". They are
at 246 to 248. Lines 215 and 216 are the comment about the spread. Correct both.

Do **not** try to fix the pass-1 commit message, which says "three source cases" where test
42 has four. An amend is forbidden. Record it in Part IX and leave it.

---

## 5. Item 1. The judge-server helper.

`lib/__tests__/judge-server-stub.ts`. A local HTTP server standing in for the judge, so
`rerankJudge` runs for real.

### Why a local server works even with the database stub installed

The pass rests on this. Verify it yourself and put the output in the report.

`telemetry-db-stub.ts:103` replaces `globalThis.fetch`. The OpenAI SDK does **not** use
`globalThis.fetch`. `node_modules/openai/core.js:144` is
`this.fetch = overriddenFetch ?? index_1.fetch`, bound at client **construction**
(`lib/llm.ts:41`), and the resolved shim is `node-fetch@2`, which uses the `http` module.
So the judge request bypasses the database stub and reaches a real socket on 127.0.0.1.

Check that `require('openai/_shims/index.js').fetch === globalThis.fetch` is `false`, and
that it stays false after a stub-style replacement of `globalThis.fetch`.

### What the server receives

`rerankJudge` sends exactly this, `lib/rerank.ts:450-459`:

```ts
const r = await governedChat(undefined, 'rerank_judge', {
  model: JUDGE_MODEL,
  messages: [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: userMsg },
  ],
  temperature: 0.0,
  max_tokens: 200,
  ...({ options: { num_ctx: 4096 }, keep_alive: '15m' } as Record<string, unknown>),
}, { gemini: geminiUtilityModel(), promptRef: 'rerank/JUDGE_SYSTEM' });
```

`traceId` is `undefined`, so `lib/trace.ts:844` runs `chatWithFallback` and the request goes
to `POST ${OLLAMA_BASE_URL}/v1/chat/completions` with `Authorization: Bearer ollama`.
`maxRetries` is 0 and the timeout is 90 000 ms (`lib/llm.ts:41`): exactly one wire call per
batch, no SDK retry.

`label` and `promptRef` are dropped on this arm. Neither is observable. Do not assert on
them.

### What the server must return

HTTP 200, `content-type: application/json`. Only three response fields are read, at
`lib/rerank.ts:461-464`: `choices[0].message.content`, `usage.prompt_tokens`,
`usage.completion_tokens`. `content` must be the scoring object as a **string**, for example
`'{"0": 8, "1": 3, "2": 10}'`.

**If `usage` is absent the code does not throw.** Both `typeof` guards go false and the two
token counts become `null`, and the batch still records `outcome: 'success'`. Include
`usage` only if you assert on token counts. Do not spend a cycle adding it otherwise.

### How the server tells one batch from another

**Only by passage text.** Model, system prompt, temperature, max_tokens, options,
keep_alive and the `QUESTION:` prefix are byte-identical across batches. `[${idx}]` at
`lib/rerank.ts:431` uses the **local** slice index and restarts at `[0]` every batch, so
the bracket carries no batch identity.

Two constraints on the fixture text, from `lib/rerank.ts:430` and `:59`. The text is
truncated to `MAX_SNIPPET_CHARS = 600` **first**, then whitespace-collapsed by
`.replace(/\s+/g, ' ').trim()`. So the marker must sit inside the first 600 characters and
survive whitespace collapse.

Give every fixture passage a unique leading token. Key the server's response on which
tokens appear in the user message. State the keying in the helper's header.

### The env writes

Two groups. The document previously said all of them must precede the import and gave a
reason that applied to only some. Both groups are listed, and the reason is now per line.

**Must precede the dynamic import of `../rerank`, because they are read at module load:**

```ts
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;   // lib/llm.ts:39, NO /v1 suffix
delete process.env.GCP_PROJECT;                             // lib/llm.ts:52
process.env.RERANK_JUDGE_MODEL = 'test-judge';              // lib/rerank.ts:57, only if you assert on model
```

**Read at run time, so order does not matter, but set them anyway:**

```ts
process.env.LLM_PIPELINE = 'mini';       // lib/llm.ts:95, forces geminiUtilityModel() undefined
delete process.env.GEMINI_ALL;           // lib/llm.ts:311
delete process.env.GEMINI_UTILITY;       // lib/llm.ts:311
delete process.env.GCP_SA_KEY;           // lib/llm.ts:82
delete process.env.GEMINI_VIA_OPENROUTER;// lib/llm.ts:133
```

**And these two, which revision 1 missed and which can open a real outbound socket:**

```ts
delete process.env.RERANK_BACKEND;
delete process.env.OPENROUTER_API_KEY;
```

`cohereRelevanceScores` at `lib/rerank.ts:118` reads `OPENROUTER_API_KEY` directly and posts
to `https://openrouter.ai/api/v1/rerank`. It has **no `miniPipeline()` gate**, so
`LLM_PIPELINE = 'mini'` does not stop it. If `RERANK_BACKEND=cohere` is exported in the
shell, `rerank()` takes the env-default cohere arm and makes a real outbound HTTPS call,
breaching section 13's 127.0.0.1 rule.

Copy the lazy-promise pattern from `lib/__tests__/vertex-primary-ladder.test.ts:59-76`, with
teardown in `test.after`. **Do not** copy `llm-call-bounds.test.ts`, which imports
`../llm.ts` statically and gets away with it only because it never routes through the module
client.

### What the helper must expose

At minimum: start on port 0 and report the port, register a scoring response per batch keyed
on passage marker, record every request body received, and close. The request list is what
test 1 uses to prove no extra call was made.

---

## 6. Item 2. Test 60, ranking invariance.

### THE SHAPE OF THE TEST. Read this before anything else in this section.

**One side runs with a capture. The other side runs with the capture argument omitted
entirely.** Revision 1 of this document left that out, and an attack showed that a test
calling `retrieve` twice *with* captures satisfied every other requirement and proved
nothing.

```ts
const off = await retrieve(QUERY, OPTS);                    // exactly two arguments
const capture = createTelemetryCapture('primary');
const on  = await retrieve(QUERY, OPTS, capture);           // exactly three
assert.deepStrictEqual(off, on);
```

`OPTS` must be the **same object reference** on both calls, not two equal literals.

**Pin the shape in the test's own source.** Read this file with `readFileSync` and assert
that the two-argument form appears exactly once and the three-argument form appears exactly
once, per case. Without that pin, a later edit that gives the off side a capture makes the
test vacuous and nothing catches it. Say in a comment that this is what the pin is for.

### Case A. `useReranker: false`.

Fully deterministic. No judge, no socket beyond the stub. Proves fusion, hydrate, source
weighting and the final trim.

### Case B. `useReranker: true`, against the judge server.

Proves batch boundaries and prompts. This case is why the harness exists.

### The oracle

```ts
assert.deepStrictEqual(off, on);
```

On the **whole** `RetrieveResult`, `meta` included. It carries no timestamp, no uuid, no
duration and no counter, so against a fixed stub every field is a pure function of the routed
rows and `opts`. A spot check of `hits.map(h => h.id)` is weaker than the code allows.

In case B, `rerank_score` and `rerank_backend` become deterministic because the judge server
returns fixed scores. Do not exclude them.

**Also compare the scorer context.** v11's test 60 names "ordered output, scorer context,
batch boundaries and prompts". `RetrieveResult` carries no scorer context, so build the
rendered cited context from `hits` on both sides and compare the two strings. Do not compute
an HMAC. The rendered bytes are what the HMAC is taken over, and comparing them is the same
claim without a key.

### The `opts` the test must use

```ts
{ topK: 4, skipExpand: true, queryEmbedding: [...], useReranker: false | true }
```

Every one of these is load-bearing.

- **`skipExpand: true`** stops `retrieve` reaching `expandQuery` (`lib/retrieve.ts:408`).
- **`queryEmbedding`** stops it reaching `embedQuery` (`lib/retrieve.ts:411-413`). Every
  element must be a number: `vectorLiteral` calls `.toFixed(7)` on each
  (`lib/llm.ts:611`) and throws before any SQL otherwise.
- **`topK: 4`** gives `poolSize = Math.min(30, topK * 3) = 12`, which is what makes case B
  produce exactly three judge batches. It also pins the final trim.
- **No `restrictSources`.** See the routing table.
- **No `useEmbeddingV2`.** `USE_EMBEDDING_V2` is a hardcoded `false`
  (`lib/llm.ts:596`), not an env read. Passing `true` arms statement S1, disables the
  `queryEmbedding` escape, and changes `embCol` to `embedding_v2` so **S4 and S6 both stop
  matching their own routing fragments**.
- **Leave `hybrid` at default.** `lib/retrieve.ts:385` is `opts.hybrid !== false`, so S5a
  runs whether you want it or not. Route it.

### The seven statements and their routing fragments

Verified pairwise non-overlapping under the `opts` above. Re-verify and report.

| # | What | Runs when | Fragment |
|---|---|---|---|
| S1 | `embedding_v2` column probe | `useV2` | `/information_schema\.columns/` |
| S2 | plainto lexemes | `bm25Mode` discriminating | `/::text AS q/` |
| S3 | DF estimate per lexeme | same as S2 | `/EXPLAIN \(FORMAT JSON\)/` |
| S4 | vector leg | **always** | `/ROW_NUMBER\(\) OVER \(ORDER BY embedding <=> \$1::vector\)[\s\S]*NOT LIKE 'labq:%'/` |
| S5a | BM25 default | `hybrid && bm25Enabled` | `/ts_rank_cd\(text_tsv, plainto_tsquery/` |
| S5b | BM25 discriminating | `bm25Mode` and a surviving tsquery | `/WITH cand AS \(/` |
| S6 | normative leg | `useNormativeLeg` | `/ROW_NUMBER\(\) OVER \(ORDER BY embedding <=> \$1::vector\)[\s\S]*source = ANY\(\$3\)/` |
| S7 | final hydrate | `fusedIds.length > 0` | `/COALESCE\(source_quality_weight/` |

**S4 and S6 are built from the same template and share their first line byte for byte.** They
differ only in the rendered filter. If the test passes `restrictSources`, S4's filter also
gains `source = ANY($3)`, and then **S4's fragment matches nothing at all** while S6's
fragment captures both. That failure presents as a missing route, not as a regex problem, so
it will be misdiagnosed. Do not pass `restrictSources`.

### Non-vacuity. Every one is required.

1. **Assert the exact expected hit ids, in the exact expected order, on both sides.** Not
   just that the two sides agree.
2. **Assert the main return path was taken, by value.** The early return at
   `lib/retrieve.ts:540-546` and the main return at `:653-668` emit **identical `meta` field
   names**, including both conditional spreads under identical guards. Revision 1 claimed the
   shapes differ. They do not. Only three values do: the early path hard-codes `fused: 0`,
   `pool_size: 0` and `reranked: false`. Assert `meta.pool_size` equals the real pool size,
   which is 12 under the `opts` above.
3. **Assert each routed statement ran the expected number of times.** Register routes once,
   run both sides against one stub, and assert `stub.matching(RE).length === 2` for S4, S5a
   and S7. Do **not** call `stub.reset()` between the runs: it clears routes as well as
   calls, and the second run would then see only unmatched statements returning `[]`.
   This assertion is what catches a missed route, because
   `telemetry-db-stub.ts:115` returns `[]` for anything unmatched and all three legs at
   `lib/retrieve.ts:508`, `:509` and `:511` swallow every error.
4. **Assert the capture is genuinely populated.** `capture.fusedCandidateIds`,
   `capture.hydratedCandidateIds` and `capture.orderedFinalCandidateIds` non-empty and
   correct. If the on side wrote nothing, invariance is trivial.
5. **Case B: assert the reranked order differs from the input order.** Scores initialise to
   zero at `lib/rerank.ts:414` and the sort at `:523` is stable, so an all-zero run returns
   input order and looks perfectly invariant. Choose judge scores that reorder, and assert
   the reorder happened.
6. **Case B: assert `capture.expectedBatchCount === 3`.** `JUDGE_BATCH` is 5 and is not
   exported, so hardcode 5 and cite `lib/rerank.ts:58`. Twelve hydrated candidates give
   boundaries `[{0,5},{5,10},{10,12}]`. Report the observed hydrated count alongside, so a
   fixture drift shows up as a number rather than as a mystery.

### Batch order

`capture.batches` is in **completion order**, not boundary order. The push at
`lib/rerank.ts:507` is the last statement of an async callback inside the `Promise.all` at
`:427`. The repair sort lives only in `buildRetrievalPayload`
(`lib/retrieval-capture.ts:231-233`) and uses `.slice()`, so the capture is never repaired in
place.

Sort a copy by `index` before comparing, or key expectations by `index`. Reading
`capture.batches[0]` and expecting `{start: 0, end: 5}` is a race. Say which you did.

### Do not assert on these

`intendedProvider` is the hardcoded string `'vertex'` (`lib/rerank.ts:511`) even when served
locally. A local server produces `servedProvider: 'ollama'` and therefore
`served_route_class: 'local'` (`lib/retrieval-capture.ts:100`), never `'vertex'`. Both are
correct behaviour.

---

## 7. Item 3. Test 1, instrumentation off, seven cases.

### The amendment

v11 says instrumentation off "executes nothing". For `rerankJudge` that is false. Four
expressions run whether or not a capture exists and are consumed only inside `if (capture)`
at `lib/rerank.ts:506`:

```
lib/rerank.ts:460   evidence = evidenceFromCompletion(r)
lib/rerank.ts:462   promptTokens
lib/rerank.ts:463   completionTokens
lib/rerank.ts:496   the outcome precedence
```

**Amended to "executes nothing observable".** Report all four as dead work. Revision 1 named
only the first.

### The seven cases

| Function | The observable |
|---|---|
| `retrieve` | two `RetrieveResult` objects deep-equal, and `stub.matching(RE).length` equal per statement across the two runs. It never allocates a capture; the caller does. The capture it holds, which is `undefined`, reaches `expandQuery` at `:408` and `rerank` at `:589` |
| `rerank` | `recordSoftFailure` returns at `lib/rerank.ts:278` before touching anything. `undefined` reaches `cohereFn` and `judgeFn` as the third argument |
| `rerankJudge` | identical returned array, and the judge server received an identical set of request bodies. Record the four dead expressions |
| `rerankCohere` | the `CapturedBatch` literal at `:162-174` is never constructed |
| `expandQuery` | `capture.expansion` never set at `lib/expand.ts:36` or `:47`. Here `evidenceFromCompletion` **is** inside the guard, so nothing runs |
| `retrieveMultiQuery` | `armCaptures` undefined at `lib/multi-query.ts:265`, each arm called with `undefined` at `:274`, `capture.children` never set at `:302` |
| **the `MatchInput` seam** | `matchLowValueCare` with no `telemetry` field creates no capture, declares nothing and writes nothing. v11 report item 11 requires the seam alongside the six functions, and revision 1 dropped it. Reuse pass 1's stub setup from `lib/__tests__/lvc-telemetry-seam.test.ts` |

Do **not** count `db.calls` by sequence position. `stub.calls` order is not deterministic for
S4, S5 and S6, which are dispatched in one `Promise.all`. Use `stub.matching(RE)`.

Revision 1 also required asserting "no telemetry own property" on every return. **Dropped.**
No return type in the six functions has ever carried such a property on any code path, so the
assertion passes unconditionally and proves nothing. Assert instead that the returned
object's own keys deep-equal a frozen expected key list.

### The house pattern

`lib/__tests__/multi-query-telemetry.test.ts:102-108`. Note that its technique, a fake
collaborator recording `hadCapture: !!capture`, is **not available** for the real `retrieve`,
`rerankJudge` or `expandQuery`, which have no injectable collaborator. For those three the
observables are the returned value, the stub's per-statement counts, and the judge server's
request list.

---

## 8. Traps. Read this section twice.

Each is verified against the code.

1. **A missed stub route is indistinguishable from an empty leg.** `telemetry-db-stub.ts:115`
   returns `[]` and does not throw. It **does** throw a routed `Error` at `:116`, and
   `decodeCall` throws on a batch body.
2. **All three legs swallow every error.** `lib/retrieve.ts:508`, `:509` and `:511` each
   carry `.catch(() => [] as RankRow[])`. Revision 1 said two of three.
3. **The hydrate has no `.catch`.** `lib/retrieve.ts:560`. A routed `Error` there rejects the
   test, the opposite of trap 2.
4. **`installDbStub` is a singleton with no uninstall.** A second call wipes every route
   (`:80`, `:90`). `globalThis.fetch` is never restored. `reset()` clears routes as well as
   calls.
5. **Column type comes from the first non-null sample value, not a schema** (`:58-62`). A
   fixture id written as a string parses back as a string, `byId.get(id)` at
   `lib/retrieve.ts:563` misses, and `:564` silently drops the hit. Write ids as numbers.
6. **`stub.calls` order is not deterministic** for S4, S5 and S6. Use `matching`.
7. **RRF ties resolve by `Map` insertion order.** The three insertion loops are at
   `lib/retrieve.ts:520`, `:521` and `:523`; the sort at `:528-529` reads only the value.
   Choose a fixture with no tied RRF scores.
8. **`topK` defaults to a module-load env read** (`lib/llm.ts:597`). `POOL`, `poolSize` and
   the final trim all move with it. The test passes `topK` explicitly.
9. **`.env.local` does not reach the test process.** No `--env-file` on the test script. But
   see section 5: an exported shell variable still does.
10. **`Infinity` passes the finite-score guard** at `lib/rerank.ts:482` and clamps. JSON
    cannot express `NaN`, so a `nonnumeric` outcome needs a string, boolean, null or object.
11. **A missing score key and a genuine zero are the same entry** in `scores`. Only
    `missingScoreKeys` distinguishes them.
12. **`capture.passageTexts` holds raw clinical text** (`lib/retrieve.ts:580`). Never
    stringify a capture into an assertion message.
13. **The judge timeout is 90 000 ms with no retry.** An unrouted server holds the test 90
    seconds rather than failing fast.
14. **No existing test imports the `retrieve` function.** Ten test files import from
    `lib/retrieve.ts`, all of them pure helpers or types. You are the first to drive the
    function itself through a stub.

---

## 9. Attack your own tests

Report every attack, including the ones that failed to break anything.

- Delete one stub route. Case A must fail on non-vacuity 3.
- Give the **off** side a capture. The source pin from section 6 must fail. If it does not,
  the pin is not doing its job and the test is vacuous.
- Make the judge server return all-equal scores. Case B must fail on non-vacuity 5.
- Make the judge server return all-zero scores. Case B must fail.
- Return a malformed `content` string. Assert what happens and report it.
- Omit `usage` from the server response. Report what happens.
- Swap two fixture rows so RRF ties. Report whether the result changes.
- Run each case twice within one test body. Both runs must agree. If not, that is a real
  determinism defect and a finding, not a test bug. `node --test` gives each **file** its own
  process, so "twice in one process" means twice inside one test body or in two sibling
  `test()` blocks in the same file. If you use two blocks, remember trap 4.
- For test 1, add a capture to one side only and confirm the case still passes.

---

## 10. Gate

Run addendum v1 section 9 unchanged, including the pre-gate check that
`lib/architecture/map.generated.ts` is unmodified before staging.

Three additions.

- Report the wall-clock time of the three new files. A 90-second judge timeout turns a
  routing mistake into a slow green.
- Confirm no test opened a socket to anything but `127.0.0.1`, and say how you confirmed it.
- Report the value of `RERANK_BACKEND` and whether `OPENROUTER_API_KEY` was set in the shell
  that ran the tests, before you deleted them.

The final test total is observed and reported, never predeclared.

---

## 11. Report. A new Part IX.

Insert **above** Part VIII, and update the summary header at the top of the file, as pass 1
did.

1. Parent SHA and the SHA-256 of this addendum.
2. All nine gate results, the observed count, the pre-gate map check, and the three additions
   from section 10.
3. The `openai/_shims` check from section 5, with output.
4. The seven routing fragments as implemented, and the re-verification that they are pairwise
   non-overlapping under the stated `opts`.
5. Every non-vacuity assertion from section 6, and what each would catch.
6. **The source pin from section 6, quoted, and the attack that proves it fires.**
7. Every attack from section 9, including the failures.
8. The four dead expressions in `rerankJudge`, named.
9. The observed hydrated-candidate count and batch count for case B.
10. Item 0's three corrections.
11. The two v11 amendments and the two file-contract additions, from section 12.
12. Whether the two runs agreed, and any determinism defect found.
13. Anything flagged rather than decided, and any defect found and left alone.

State plainly that no production file changed beyond item 0a's comment, nothing was deployed,
no migration was run, and no production database was touched.

---

## 12. Amendments and additions recorded

**Amendments to v11.**

1. **Test 60's wording.** "The same injected collaborators" became "an identical environment
   on both sides". This was already settled in **addendum v1 decision 9**. It is restated
   here, not made here. v1's wording binds.
2. **Test 1's wording.** "Executes nothing" becomes "executes nothing observable", because
   four expressions in `rerankJudge` run either way.

Both are the same kind as pass 1's finding on test 42: v11 asks for something the code cannot
provide. Record all three together so the pattern is visible.

**Additions to v11's file contract.** `lib/__tests__/instrumentation-off.test.ts` and
`lib/__tests__/judge-server-stub.ts` are not on v11's create list.
`retrieval-ranking-invariance.test.ts` is.

**Two v11 requirements revision 1 silently narrowed, now restored.** Test 60's scorer context
is compared in section 6. Report item 11's `MatchInput` seam is case seven in section 7.

---

## 13. Commit

```text
one scoped commit
parent exactly 10f4a653138226a0f17f8ae60046e9fdbef02bfb
no amend
no rebase
no push
no git add -f
git status --short clean at the end
git diff --cached --name-only empty at the end
git show --stat contains only the files section 3 authorizes
no socket opened to anything but 127.0.0.1
```

**Do not push. V pushes.**

---

## 14. Flag, do not improvise

If a test cannot be written without changing a production file, stop and report. That is the
one thing this pass must not do. A seam added to make a test pass means the test measures a
different function from the one that ships, which is the exact failure this harness was
chosen to avoid.

The engine is frozen. Do not deploy. Do not target a canary. Do not start C0.

---

## 15. What the attack on revision 1 found

An agent was told to break revision 1. Two defects were severe.

| # | Defect | Fixed in |
|---|---|---|
| 1 | **The oracle never said one side runs without a capture.** A test calling `retrieve` twice with captures satisfied every requirement and every mandated attack, proving only that `retrieve` is deterministic against a fixed stub | section 6, plus the source pin |
| 2 | **Non-vacuity 2 was impossible.** Both returns emit identical `meta` field names under identical guards. The claim that the shapes differ was false. Only three values differ | section 6, non-vacuity 2 |
| 3 | `RERANK_BACKEND` and `OPENROUTER_API_KEY` were not deleted. `cohereRelevanceScores` reads the key directly with no `miniPipeline()` gate, so a real outbound HTTPS call was possible | section 5 |
| 4 | The env list said all writes must precede the import. Only three of nine are read at module load | section 5 |
| 5 | Nothing said how to get twelve candidates. It needs `topK: 4`, which gives `poolSize` 12 | section 6 |
| 6 | `useEmbeddingV2` was forbidden for the escape but never linked to the routing fragments, which it also breaks | section 6 |
| 7 | The `restrictSources` warning understated the failure. S4 stops matching its own statement entirely | section 6 |
| 8 | Non-vacuity 3 gave no expected count, so `>= 0` was literally compliant | section 6 |
| 9 | The `db.calls` sequence assertion contradicted trap 6 in the same document | section 7 |
| 10 | "No telemetry own property" was unfalsifiable | section 7 |
| 11 | The dead work is four expressions, not one | section 7 |
| 12 | `.gitignore` was required by prose and absent from the Edit block | section 3 |
| 13 | The lifecycle pin covers the failure store, and v1 scoped that warning to a different file | section 3 |
| 14 | The non-exposure walk does not allow the three new files | section 3 |
| 15 | v1 section 3 forbids editing the failure store, which item 0a requires | section 0 |
| 16 | v1 decision 9 already recorded test 60's amendment; revision 1 presented it as new | section 12 |
| 17 | v11 test 60 also requires scorer context, dropped without record | section 6 |
| 18 | v11 report item 11 also requires the `MatchInput` seam, dropped without record | section 7 |
| 19 | Six line citations were wrong: `:65-66`, `:509`'s ending, `:411`'s ternary, `:520-522`, "two of three legs", and the count of files importing `lib/retrieve.ts` | throughout |
| 20 | "Three deliverables" followed by four items, and "three v11 amendments" where section 9 listed two | sections 1, 11 |

Two claims survived every attack and are load-bearing: the OpenAI SDK does not use
`globalThis.fetch`, so a local judge server works alongside the database stub; and the seven
routing fragments are pairwise non-overlapping under the stated `opts`.
