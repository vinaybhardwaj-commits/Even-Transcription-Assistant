# CDMSS rerank telemetry: addendum v3, the pass-3 kickoff

**13 August 2026.** Close the safety claim on the production shape, then measure the
overhead. This is the last engineering pass before V can set guardrails and authorise a
deploy.

---

## 0. Authority and preflight

Governs all work after `31424cb45f0cf66606c6d1acf68c96ed121013b4` on
`exp/rerank-telemetry`.

**Supersedes** addendum v2 where they conflict. Every settled decision in v1 section 10
and v2 section 10 stands.

**Amends** nothing in v11 that v1 and v2 have not already amended. Section 11 records the
running list.

```text
branch:  exp/rerank-telemetry
HEAD:    31424cb45f0cf66606c6d1acf68c96ed121013b4
tree:    clean
```

```bash
git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --short
```

---

## 1. Why this pass exists

Pass 2's test 60 proved ranking invariance for **one `opts` shape, and production uses a
different one.**

```
lib/opd-note-audit.ts:639          topK: 8, useReranker: true, useSourceWeights: true, hybrid: true
invariance test lines 103-104      topK: 4, skipExpand: true, queryEmbedding: …, useReranker: false | true
```

Four fields differ. Two of them matter.

- **`useSourceWeights: true` is never set by any test.** The source-weighting block at
  `lib/retrieve.ts:604-630` ends in a `hits.sort(...)`. It is dead code under the whole
  suite. A capture-conditional edit inside it changes production ranking under
  instrumentation and passes every assertion in `31424cb`.
- **`topK: 8` gives `poolSize` 24, not 12.** The batch arithmetic under test is not the
  batch arithmetic that ships.

Two more, less severe: production sets neither `skipExpand` nor `queryEmbedding`, so it
runs `expandQuery` and `embedQuery` for real and the test escapes both.

**That limit is a defect in addendum v2, not in the build.** v2 specified `topK: 4` to get
a clean three-batch count, and the optimisation moved the test off the production path.

---

## 2. What this pass is

| Item | What |
|---|---|
| 0 | Part IX erratum stating the single-configuration limit |
| 1 | Extend the judge server to serve `/v1/embeddings` |
| 2 | Test 60 case C, at the exact production shape |
| 3 | The canary-gate test the decisions document requires |
| 4 | Step 21, the five overhead numbers and three extras |

**Not in this pass.** Step 19's query texts. The remaining 38 tests. Per-role manifest
defects. The `retrieval_terminal_rejected` phase. The discriminated union. Any deploy,
migration or canary.

---

## 3. File contract

### Create

```text
scripts/telemetry-overhead-measure.mjs        item 4
```

### Edit

```text
.gitignore                                              one added line
lib/__tests__/judge-server-stub.ts                      item 1
lib/__tests__/retrieval-ranking-invariance.test.ts      item 2
lib/__tests__/retrieval-telemetry-lifecycle.test.ts     item 3, or a new file if you flag it
CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md      Part X, plus the item 0 erratum
```

### Add to the commit, unedited

```text
CDMSS-RERANK-TELEMETRY-ADDENDUM-v3-13-AUG-2026.md
```

### Do not touch

Everything in v11 section 4, v1 section 3 and v2 section 3 stands.

**No production file changes. None.** If a test or a measurement cannot be written without
changing `lib/retrieve.ts`, `lib/rerank.ts`, `lib/expand.ts`, `lib/multi-query.ts` or any
store, **stop and report.**

The three pin hazards from v2 section 3 all still apply: the `^(let|var) ` scan over
`lib/` files, the non-exposure walk, and the import scanner reading comments as imports.
`scripts/` is outside the first two. Check the third against the new script anyway.

---

## 4. Item 0. The erratum.

Part IX reads as a general safety claim. It is a single-configuration claim.

Add an erratum to Part IX, in its own numbered section, stating: the invariance proved in
`31424cb` holds for `topK: 4, skipExpand: true, queryEmbedding` set, and `useReranker`
false and true. It does not cover `useSourceWeights`, which production sets and which
contains a sort. It does not cover `topK: 8`. It does not cover the expansion or embedding
calls, which production makes and the test escapes. Name pass 3 as the closure.

Write it as an erratum against v2, not as a defect of the pass-2 build, which built what
it was told to build.

---

## 5. Item 1. The judge server serves embeddings.

Production calls `embedQuery(expanded)` at `lib/retrieve.ts:413`, which is
`llm.embeddings.create({ model: EMBED_MODEL, input: text })` at `lib/llm.ts:600`. That
goes through the same OpenAI client as the judge, so the same local server can serve it.

Add a `POST /v1/embeddings` route to `judge-server-stub.ts`. It must return a response the
SDK parses, with a `data[0].embedding` array of the dimension the corpus uses. Read
`EMBED_MODEL` and the vector dimension from the code rather than assuming, and report both.

The vector must be **deterministic per input string**, because case C runs twice and both
runs must produce byte-identical results. A fixed vector keyed on the input text is enough.
Do not use randomness.

Production also calls `expandQuery` at `lib/retrieve.ts:408`, which is a chat completion
through `governedChat` with `traceId` undefined. The existing chat route serves it. It has
a different system prompt (`lib/expand.ts`), so key the response on the prompt, not on the
assumption that every chat call is a judge call. **Report how you distinguished them.**

---

## 6. Item 2. Test 60 case C, the production shape.

### The opts

Take them from the code, not from this document:

```ts
opdRetrieveOpts(false, { /* no OPD_NORMATIVE_LEG_ENABLED */ })
```

At HEAD that returns `{ topK: 8, useReranker: true, useSourceWeights: true, hybrid: true }`
(`lib/opd-note-audit.ts:638-642`). **Call the real function and use its output**, so the
case tracks production if the function changes. Assert the returned object deep-equals the
four-field shape, and report it, so a future change is loud.

Do **not** add `skipExpand` and do **not** add `queryEmbedding`. The point of this case is
that expansion and embedding run.

### The shape of the test, unchanged from v2

One side with a capture, one side with the argument omitted. Same `opts` object reference
on both calls. **Extend the existing call-form source pin to cover `OPTS_C`.** The pin is
the only thing that caught the vacuous form in pass 2, and it must cover the new case or
case C is unprotected.

### What changes with `useSourceWeights: true`

The block at `lib/retrieve.ts:604-630` now runs and ends in a sort. That is the whole
reason for this case. Design the fixture so the source weights **reorder** the hits
relative to the unweighted order, and assert the reorder happened. A fixture where every
source has the same weight exercises the block and proves nothing about it.

Read `source_quality_weight` handling and the `${sortKey}_weighted` sort key before
choosing the fixture. Report which sources you used and what weights the stub returned.

### What changes with `topK: 8`

`poolSize` becomes `Math.min(30, 8 * 3) = 24`. Assert `meta.pool_size === 24` by value.
The batch count follows from the hydrated count, not from `topK`: assert
`capture.expectedBatchCount === Math.ceil(hydrated / 5)` and report both numbers.

### Non-vacuity

Every requirement from v2 section 6 applies to case C. In addition:

1. **Assert the source-weighted order differs from the unweighted order.** Otherwise the
   block ran and nothing checked it.
2. **Assert the expansion actually happened.** `capture.expansion` is set at
   `lib/expand.ts:36`. Assert it is populated and that the judge server received an
   expansion request.
3. **Assert the embedding call happened.** The server's request list must show it.

### The statement routing

`skipExpand` and `queryEmbedding` are gone, so the escapes are gone, but the seven SQL
statements are unchanged. Re-run the pairwise non-overlap check with the new opts and
report it. `useSourceWeights` does not change any statement text.

---

## 7. Item 3. The canary-gate test.

`CDMSS-RERANK-TELEMETRY-DECISIONS-13-AUG-2026.md` section 3, hazard 1, requires a test that
does not exist and is not among v11's 73.

The hazard: if the `primary` terminal write is rejected and the `normative_channel` write
lands, `primary` stays at revision 0 and is not linkable, and `normative_channel` is. The
audit ends with zero linked `primary` runs and one linked `normative_channel` run.

PRD line 280 makes that a canary gate:

> **Exactly one linked terminal retrieval run with role `primary`. Exactly one with role
> `normative_channel` when that channel was declared.**

So a run that persisted correctly fails the gate. **Write the characterization test.**

It must assert current behaviour, not desired behaviour:

```text
primary revision 0    no audit_id, terminalized from failure evidence
normative revision 1  linked to the audit
consequence           the Stage 0b primary-link gate fails
production behaviour  unchanged by this pass
```

Cover the mirror too: primary linked, normative at revision 0.

State in the test, in a comment, that this is a **characterization** test recording a known
hazard, and that V holds the decision whether to accept it as a hard gate failure or
authorise a behavioural correction. Do not fix it.

`lib/__tests__/retrieval-telemetry-lifecycle.test.ts` already stubs this machinery. Put it
there, or flag a new file.

---

## 8. Item 4. Step 21, the overhead numbers.

### D18, restated verbatim so you do not have to guess

The five are PRD section 6.5's five:

```text
1. Start-write latency        the declaration insert, per note, on the worker's batch
2. Terminal-write latency     per role
3. Manifest size              serialized bytes of the stamped manifest, per role
4. Retrieval wall time        instrumentation on versus off, same injected collaborators
5. Audit completion rate      audits that complete, instrumentation on versus off
```

Three more, **reported separately and not as part of the five**: settlement write latency
per role, the `activeRun('opd')` cost both cold and warm, and the sum of all added writes
per audited note.

Kickoff line 102 fixes the method for the second extra: the added cost is four statements
on the first retrieval of an invocation and one on each later retrieval. Measure both.

### The rules, all of them from D18

- **Every number is synthetic and must be labelled synthetic.** Measure against a local or
  test database with a stubbed clock where the harness allows. State the method for each.
  State plainly that a synthetic number is a floor and not a prediction of production.
- **Do not run anything against the production database. Do not deploy to measure.**
- **Report the distribution, not a mean:** minimum, median, maximum, and the sample size.
  A mean hides the tail, and the tail is what perturbs a throttling boundary.
- **Do not propose thresholds.** V judges start-write latency against the throttling
  behaviour it could perturb, not against a generic budget. Your job is the measurement and
  the method.

### The harness

`scripts/telemetry-overhead-measure.mjs`. Reuse `telemetry-db-stub.ts` and
`judge-server-stub.ts`. Numbers 4 and 5 are the same on-versus-off comparison test 60
already builds, so reuse case C's fixture and say that you did.

Report whether the output is committed. If you commit it, it goes in the file contract and
you must say so. If you do not, Part X carries the numbers.

**Sample size is yours to choose and to justify.** State it and state why.

---

## 9. Two findings for V. Do not act on either.

Both were found while reading the code for this kickoff. Both concern the defect this
whole workstream exists to make visible. Put them in Part X and leave the code alone.

### 9a. `intended_model` does not name the intended judge.

```
lib/rerank.ts:511   intendedProvider: 'vertex', intendedModel: JUDGE_MODEL,
lib/rerank.ts:57    const JUDGE_MODEL = process.env.RERANK_JUDGE_MODEL || 'llama3.1:8b';
lib/rerank.ts:459   { gemini: geminiUtilityModel(), promptRef: 'rerank/JUDGE_SYSTEM' }
lib/llm.ts:78       GEMINI_FLASH_MODEL default 'gemini-2.5-flash'
```

On a normal successful Vertex batch the row records
`intended_model = 'llama3.1:8b'` and `served_model = 'gemini-2.5-flash'`. Detection of the
substitution is unaffected, because that runs off `served_route_class`. But **C0 query 4 is
"actual provider and model", and any query comparing intended to served on this path reads
as a permanent mismatch.** That is a defect in the telemetry, and it should be settled
before C0 rather than discovered inside it.

### 9b. The unseeded property is not captured anywhere.

The finding that started this workstream names an **unseeded** `gemini-2.5-flash` judge.
`capture.retrievalConfig` at `lib/retrieve.ts:426-435` records eleven fields and neither a
seed nor a temperature. The judge's `temperature: 0.0` at `lib/rerank.ts:456` lives in the
source, not in the manifest. Nothing in a persisted row would show a seeding or temperature
change if one were ever made.

---

## 10. Attack your own work

Report every attack, including the ones that broke nothing.

- Give case C's off side a capture. The extended call-form pin must fail.
- Flatten every source weight to the same value. The new reorder assertion must fail.
- Make the embedding server return a different vector on the second call. Case C must fail.
- Route the expansion request to the judge responder by mistake. Report what happens.
- Set `topK` to 4 in case C. `meta.pool_size` must fail at 24.
- Run case C twice in one test body. Both runs must agree.
- For item 3, make the primary write succeed. The characterization test must fail, because
  it is pinning the hazard and not the healthy path.
- For item 4, run the measurement twice. Report the spread between runs alongside the
  distribution within a run.

---

## 11. Amendments and additions, running list

1. **Test 42.** v11 asks for two things this harness cannot execute. Pass 1, Part VIII.
2. **Test 60's wording.** "The same injected collaborators" became "an identical
   environment on both sides". Addendum v1 decision 9.
3. **Test 1's wording.** "Executes nothing" became "executes nothing observable". Addendum
   v2 section 12.
4. **Test 60's coverage.** v2 specified one `opts` shape and it was not production's. This
   pass adds case C. New here.

File-contract additions beyond v11: `instrumentation-off.test.ts`, `judge-server-stub.ts`,
`telemetry-overhead-measure.mjs`.

---

## 12. Gate

Addendum v1 section 9 unchanged, plus v2 section 10's three additions: wall-clock time of
the new and changed test files, confirmation that no socket reached anything but
`127.0.0.1`, and the values of `RERANK_BACKEND` and `OPENROUTER_API_KEY` before deletion.

One more for this pass. **Report the wall-clock time of the measurement script separately**,
and state whether it ran inside `npm test` or standalone.

The final test total is observed and reported, never predeclared.

---

## 13. Report. A new Part X.

Insert **above** Part IX. Update the summary header.

1. Parent SHA and the SHA-256 of this addendum.
2. All nine gate results plus the four additions.
3. Item 0's erratum, quoted.
4. `EMBED_MODEL` and the vector dimension you read from the code, and how you distinguished
   the expansion request from the judge request.
5. Case C: the `opdRetrieveOpts` output you asserted, the sources and weights, the
   unweighted and weighted orders, `meta.pool_size`, the hydrated count and the batch count.
6. The re-run pairwise non-overlap check.
7. The characterization test, and a plain statement that it records a hazard V must rule on.
8. **The five numbers and the three extras**, each named as D18 names it, each with method,
   minimum, median, maximum and sample size, each labelled synthetic, with the sample size
   justified. No proposed thresholds.
9. Every attack from section 10, including the failures.
10. The two findings in section 9, verbatim, flagged not fixed.
11. Anything flagged rather than decided, and any defect found and left alone.

State plainly that no production file changed, nothing was deployed, no migration was run,
and no production database was touched.

---

## 14. Commit

```text
one scoped commit
parent exactly 31424cb45f0cf66606c6d1acf68c96ed121013b4
no amend, no rebase, no push, no git add -f
git status --short clean at the end
git diff --cached --name-only empty at the end
git show --stat contains only the files section 3 authorizes
no socket to anything but 127.0.0.1
```

**Do not push. V pushes.**

---

## 15. Flag, do not improvise

If a test or measurement cannot be written without changing a production file, stop and
report. A seam added to make a measurement work means you measured a different function
from the one that ships.

Do not propose overhead thresholds. Do not recommend a canary date. Do not deploy. Do not
run the migration. Do not start C0.
