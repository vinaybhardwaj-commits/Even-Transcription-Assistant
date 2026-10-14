# CDMSS — Stage 0a final repair: proofs 11 and 14. Evidence

**Date:** 22 August 2026 (IST)
**Kickoff:** `CDMSS-TELEMETRY-STAGE0A-FINAL-REPAIR-KICKOFF-22-AUG-2026.md` (Saul Rep 44 B4/B5, transcribed).
**Base:** `t4b` @ **`ddeff1c`**, pushed. Forward commits only — nothing amended, reset, squashed or rebased.
**Implementation commit:** **`4989fcb`** — three test files.
**Evidence commit:** this document **plus one `.gitignore` negation line** (see §8; the phrasing matters).
**Pushed:** **No.**

---

## 0. RESULT

**Proofs 11 and 14 are repaired and every mutation row discriminates.** 22 counted rows, all failing
their named test by a named assertion; both proof-11 routing controls retained and still firing; the
gate green on all nine commands plus both build arms.

**No production file was changed, and none needed to be.** Rep 44 §1: *"No production defect was
found. This is a proof defect."* Stated plainly, as required. What the repair changed is what the
tests can see, not what the system does.

Two things were found on the way that were NOT in the kickoff, and both were real:

- **The Cohere arm was making zero requests** — not merely asserting vacuously over an empty array,
  but genuinely never reaching fetch, because `cohereRelevanceScores` throws on a missing
  `OPENROUTER_API_KEY` before it calls out. Rep 44 predicted the vacuity; the cause is one layer
  further down than the `every()` line.
- **Fixing that would have sent a synthetic key to a real host.** `RERANK_API_URL` defaults to
  `https://openrouter.ai/api/v1/rerank`, and it is read at MODULE SCOPE so no test can override it.
  The interceptor is widened to the rerank endpoint itself as an egress guard. §6 row N2 pins it.

And one row is recorded as NOT discriminating **by design, in §6.4** — N3b, which is not one of the
22 and is reported rather than counted.

---

## 1. Pinned before execution

```
base            ddeff1c7b326e4c013ebbdedb169da0e9bff70bf   (= origin/t4b, worktree clean)
implementation  4989fcbbe57232b569000f673418338b8644eba6
```

The five files Rep 44 §2 forbids, at base and unchanged at the end:

| File | blob at `ddeff1c` | blob now |
|---|---|---|
| `lib/llm.ts` | `006be6d6` | `006be6d6` |
| `lib/transport-attribution-core.ts` | `f0b148bc` | `f0b148bc` |
| `lib/retrieval-telemetry-core.ts` | `d8432b58` | `d8432b58` |
| `lib/mcp-tools.ts` | `83f81d29` | `83f81d29` |
| `lib/multi-query.ts` | `d5792ac5` | `d5792ac5` |

## 2. `git show --stat` — acceptance 1

```
commit 4989fcb  test(telemetry): Stage 0a final repair — proofs 11 and 14 close, tests only

 lib/__tests__/attempt-taxonomy.test.ts             | 271 +++++++++++++++++++--
 lib/__tests__/retrieval-outcome-discrimination.test.ts | 185 ++++++++++++--
 lib/__tests__/telemetry-non-exposure.test.ts       |   8 +
 3 files changed, 427 insertions(+), 37 deletions(-)
```

**Three test files. No production file.** The evidence commit adds this document and the
`.gitignore` negation it requires, and nothing else.

## 3. Proof 11

### 3.1 The literal oracle, quoted verbatim as committed

```ts
const COMMITTED_ATTEMPT_OUTCOMES = Object.freeze([
  'http_429',
  'http_other',
  'timeout',
  'transport_error',
  'bad_response',
  'success',
] as const);
```

Not imported, not spread, not mapped, not sliced, not filtered from `TRANSPORT_ATTEMPT_OUTCOMES`.
11.7 iterates **this** list. Row P1 proves it: substituting one production literal now fails 11.7 on
`expansion attempts: timeout is committed and must be accepted`, where before 22 August no
substitution of any literal could fail it at all.

11.7 also pins `COMMITTED_ATTEMPT_OUTCOMES.length === 6` and that production declares the same
count — so an oracle that silently emptied, or a production constant that grew a seventh value the
oracle does not know about, is visible rather than passing as "every outcome was accepted".

### 3.2 The four execution paths, each mapped to its assertion

All four run inside the single named test **`11.3`**. Interception is
`OpenAI.Chat.Completions.prototype.create` — verified against the installed **openai 4.104.0**: a
`Completions` instance carries **no own `create`** and its prototype **is**
`OpenAI.Chat.Completions.prototype`, so one patch reaches every client including the module-scope
`llm` that `lib/llm.ts` constructs at import time. `lib/llm.ts` is imported only after the synthetic
environment is set, because it reads `OLLAMA_BASE_URL`, `GCP_PROJECT` and `GCP_LOCATION` at module
scope (pass 5's finding). The Vertex token mint goes through `globalThis.fetch` — a different
mechanism from the SDK transport — and is stubbed there against a loopback `token_uri`, with an
RSA key generated in-process. Every base URL is a **closed loopback port**, so a failed interception
takes ECONNREFUSED rather than reaching a provider. The prototype method, `globalThis.fetch` and all
eight environment values are restored in `finally`, absent-back-to-absent.

| # | Path | Asserted attribution | Exact call count | Row that kills it |
|---|---|---|---|---|
| 1 | intended-local Ollama | `dispatched_provider: 'ollama'`, `cloud_response_received: false`, attempts `[{ollama, 1, success, 200}]` | **1** | P2 |
| 2 | OpenRouter | `openrouter`, model `openai/gpt-4o-mini`, `cloud_response_received: true`, attempts `[{openrouter, 1, success, 200}]` | **1** | P3 |
| 3 | Vertex | `vertex`, model `gemini-2.5-flash`, `cloud_response_received: true`, attempts `[{vertex, 1, success, 200}]` | **1** | P4 |
| 4 | ladder exhausted → local | `ollama`, `cloud_response_received: false`, attempts `[{vertex,1,transport_error,null}, {openrouter,1,transport_error,null}, {ollama,1,success,200}]` | **3** | P5 |

Path 4 asserts **ordering**, not merely membership: the local success must be **last**, after the
full ladder history that led to it. Across the four, 11.3 also asserts the providers are four
distinct dispatches and that exactly four executed `success` records exist, every one attempt 1 with
status 200.

The AST census is **retained**. It still closes the commented-out attack it was written for, and
control C1 proves it is live. What it never closed — the *disabled* attack — is now closed by
execution, which is what rows P2–P5 demonstrate.

## 4. Proof 14 — the five assertions, mapped

| Rep 44 §4 assertion | Named test | How it is asserted | Row that kills it |
|---|---|---|---|
| 1. Multi-query failure returns the expected normal external result, not an error `ToolResult` | `14.12` | the failed arm's payload has the **same key set** as the successful arm's, `isError` not true, `mode: 'multi_query'`, `count: 0`, `hits: []`, and no error text | **N1** |
| 2. The Cohere typed-error arm performs **exactly one** intercepted synthetic request | `14.10` | `r.external.length === 1` — replacing `every()`, which was true on an empty array | **N2** |
| 3. That request reaches the intended synthetic 404 responder | `14.10` | `responder404Hits === 1`, counted at the responder, **and** `retrieval_error_class === 'RerankBackendMissing'`, which only the `res.status === 404` branch can raise | **N2** |
| 4. The typed error remains the existing returned form | `14.10` | an `isError` ToolResult with the existing `content` array, returned not thrown, naming the backend | **M10** |
| 5. Generic-error behaviour preserves the original error **object**, not merely its message | `14.11` | the original is branded with a unique `name`; `retrieval_error_class` (which `errorClassOf` derives from `e.name`) is asserted to be that brand | **N3** |

### 4.1 Why assertion 5 needed a different channel

`callLabTool` formats a rethrow as `err(String((e as Error).message))` — **the message alone**. At
that boundary the original error and a freshly built `new Error(sameMessage)` are indistinguishable
*by construction*, so no assertion on the returned text can separate them, however exact. The
channel that does carry object identity is `retrieval_error_class` ($4 on the terminal write), which
`errorClassOf` (`lib/retrieval-capture.ts:71`) derives from `e.name`. The original is therefore
branded via the same test-only prototype technique 11.3 uses — `OpenAI.Embeddings.prototype.create`
— because the HTTP-500 arm yields an SDK error whose `name` is the useless inherited `"Error"`
(proof 11.5's finding), which any replacement reproduces exactly. 14.11 asserts both: the brand in
the row, and `"Error"` in the unbranded arm, so the assertion cannot pass by coincidence.

### 4.2 The two defects found while implementing assertions 2 and 3

**The arm made zero requests.** `cohereRelevanceScores` (`lib/rerank.ts:214`) throws
`RerankBackendUnreachable` on a missing `OPENROUTER_API_KEY` **before** it calls fetch. Under test
the key is unset, so no request was ever made, `every()` passed over an empty array, and the file's
own comment — that a cohere rerank "gets a local 404, which is what raises the NAMED
RerankBackendMissing" — was false: the 404 branch had never executed. `retrieval_error_class`
recorded `RerankBackendUnreachable` and 14.10's regex accepted it. A synthetic key is now supplied so
the call gets past the key check.

**And the URL never matched the interceptor.** `RERANK_API_URL` defaults to
`https://openrouter.ai/api/v1/rerank` — the cohere backend is OpenRouter-**hosted**, so there is no
`cohere` in the URL and the `/cohere/i` filter would not have recorded the request even if one had
been made. It is read at **module scope** (`lib/rerank.ts:73`), so a test cannot override it by env.
The interceptor is therefore widened from `/cohere/i` to the **rerank endpoint by path**. That is an
**egress guard, not a convenience**: supplying the key means the call now reaches fetch, and without
the widening a synthetic key would have gone to a real host. 14.10 asserts the request was answered
locally at the known endpoint.

## 5. Non-exposure repair (§5)

`'lib/__tests__/retrieval-outcome-discrimination.test.ts'` added to `ALLOWED` by exact path, and the
split string literal `'opd_audit' + '_retrieval_telemetry'` — which existed for exactly one reason,
to stop the scanner matching — replaced by the literal `'opd_audit_retrieval_telemetry'`. The DDL
still verifies the name; the direction is reversed, **declared and checked** rather than extracted
and obscured. This closes pass 5's deviation 2, which was owed and unassigned.

`telemetry-non-exposure.test.ts` is green on all four of its own tests, including
*"the scan can actually fail — it is not passing because the matcher never matches"*.

## 6. The mutation campaign — one finalized blob, before the gate

**Sandbox:** a full copy of the worktree taken outside it, `.git` / `.next` / `node_modules` removed
and `node_modules` symlinked back. **Shape verified before use:** `.git` absent · `.next` absent ·
`node_modules` a symlink · `lib/__tests__` present · dotfiles present · path outside the worktree.
**No git command was run inside the sandbox.** Pristine copies of all thirteen files were held
**outside** it; every restore is a `cp` from there, verified by `cmp` against both the pristine copy
and the worktree original. `git checkout --` was never used.

Every row ran against the **same finalized blob**, `4989fcb`, in one pass.

**Command per row:** `node --test --import tsx --test-name-pattern '^<named> ' <test file>`,
cwd = the sandbox. Every run reports `# tests 1`, so the named test ran **alone** — a filtered-away
test cannot be miscounted as a pass.

**22 counted rows: five for proof 11 (§6 items 1–5), the fourteen original pass-5 rows re-run
against the final test bytes, and the three new ones. Both routing controls retained. Every counted
row failed its named test by a named assertion. NO row timed out; no row failed on import, setup,
typecheck, or a collateral test.**

| Row | Proof | File | Mutation | Named | STARTED | ENDED | exit | pass/fail | Discriminates |
|---|---|---|---|---|---|---|---|---|---|
| P1 | 11 | `transport-attribution-core.ts` | substitute one committed taxonomy literal | `11.7` | 09:36:40 | 09:36:40 | 1 | 0/1 | YES |
| P2 | 11 | `llm.ts` | disable intended-local success, RETAIN its AST call | `11.3` | 09:36:40 | 09:36:41 | 1 | 0/1 | YES |
| P3 | 11 | `llm.ts` | disable OpenRouter success, RETAIN its AST push | `11.3` | 09:36:41 | 09:36:41 | 1 | 0/1 | YES |
| P4 | 11 | `llm.ts` | disable Vertex success, RETAIN its AST push | `11.3` | 09:36:41 | 09:36:42 | 1 | 0/1 | YES |
| P5 | 11 | `llm.ts` | disable fallback-local success, RETAIN its AST call | `11.3` | 09:36:42 | 09:36:42 | 1 | 0/1 | YES |
| C1 | 11 control | `llm.ts` | delete the OpenRouter push OUTRIGHT (AST node removed) | `11.3` | 09:36:42 | 09:36:42 | 1 | 0/1 | YES |
| C2 | 11 control | `transport-attribution-core.ts` | change what localAttemptSuccess() RETURNS | `11.3` | 09:36:42 | 09:36:43 | 1 | 0/1 | YES |
| M1 | 10 | `retrieval-telemetry-core.ts` | the outcome CHECK stops requiring a null on `started` | `10.3b` | 09:36:43 | 09:36:45 | 1 | 0/1 | YES |
| M2 | 10 | `retrieval-telemetry-core.ts` | the CHECK stops requiring an outcome on terminal states | `10.2` | 09:36:45 | 09:36:46 | 1 | 0/1 | YES |
| M3 | 14 | `retrieve.ts` | a successful retrieval is recorded as `zero_hits` | `14.1` | 09:36:46 | 09:36:48 | 1 | 0/1 | YES |
| M4 | 14 | `retrieve.ts` | the empty fusion stops recording `zero_hits` | `14.2` | 09:36:48 | 09:36:50 | 1 | 0/1 | YES |
| M5 | 14 | `lvc.ts` | the LVC semantic swallow stops recording the failure | `14.3` | 09:36:50 | 09:36:52 | 1 | 0/1 | YES |
| M6 | 14 | `lvc.ts` | the outer SQL branch stops recording the failure | `14.4` | 09:36:52 | 09:36:53 | 1 | 0/1 | YES |
| M7 | 14 | `lvc.ts` | the outer SQL branch swallows instead of rethrowing | `14.4` | 09:36:53 | 09:36:55 | 1 | 0/1 | YES |
| M8 | 14 | `mcp-tools.ts` | `labRetrieve` stops recording the failure | `14.10` | 09:36:55 | 09:36:57 | 1 | 0/1 | YES |
| M9 | 14 | `mcp-tools.ts` | a generic error becomes the typed result form | `14.11` | 09:36:57 | 09:36:59 | 1 | 0/1 | YES |
| M10 | 14 | `mcp-tools.ts` | the typed error throws instead of returning its form | `14.10` | 09:36:59 | 09:37:01 | 1 | 0/1 | YES |
| M11 | 14 | `multi-query.ts` | every-arm-failed is recorded as success | `14.12` | 09:37:01 | 09:37:03 | 1 | 0/1 | YES |
| M12 | 14 | `opd-note-audit.ts` | the normative payload is built from `primaryCapture` | `14.8` | 09:37:03 | 09:37:08 | 1 | 0/1 | YES |
| M13 | 44 | `opd-note-audit.ts` | idle is reported as three nulls | `44.2` | 09:37:08 | 09:37:10 | 1 | 0/1 | YES |
| M14 | 44 | `opd-note-audit.ts` | `activeRun` is asked for the `ipd` worker | `44.4` | 09:37:10 | 09:37:13 | 1 | 0/1 | YES |
| N1 | 14 new | `mcp-tools.ts` | a multi-query failure is converted into an EXTERNAL ERROR result | `14.12` | 09:37:13 | 09:37:14 | 1 | 0/1 | YES |
| N2 | 14 new | `rerank.ts` | the Cohere arm makes ZERO requests (the pre-fetch key check fires) | `14.10` | 09:37:14 | 09:37:16 | 1 | 0/1 | YES |
| N3 | 14 new | `mcp-tools.ts` | the original generic error is REPLACED by a same-message error | `14.11` | 09:37:16 | 09:37:18 | 1 | 0/1 | YES |
| N3b | 14 recorded | `mcp-tools.ts` | same-message replacement at the THROW POINT ONLY (post-telemetry) | `14.11` | 09:37:18 | 09:37:20 | 0 | 1/0 | **NO** |

### The named failure, quoted from each run

```
P1   not ok 1 - 11.7 — an outcome INSIDE the six is not a defect, in all three locations
     └ expansion attempts: timeout is committed and must be accepted 1 !== 0 code: 'ERR_ASSERTION'
P2   not ok 1 - 11.3 — all four success sites record `success`, EXECUTED end to end
     └ site 1 must record ONE ollama attempt, numbered 1, success, status 200 + actual - expected + [] - [ -   { -     attempt: 1, -     outcome: 'success', 
P3   not ok 1 - 11.3 — all four success sites record `success`, EXECUTED end to end
     └ site 2 must record ONE openrouter attempt, numbered 1, success, status 200 + actual - expected + [] - [ -   { -     attempt: 1, -     outcome: 'succes
P4   not ok 1 - 11.3 — all four success sites record `success`, EXECUTED end to end
     └ site 3 must record ONE vertex attempt, numbered 1, success, status 200 + actual - expected + [] - [ -   { -     attempt: 1, -     outcome: 'success', 
P5   not ok 1 - 11.3 — all four success sites record `success`, EXECUTED end to end
     └ site 4 must record the ordered ladder history and END with the local success + actual - expected ... Skipped lines [ { attempt: 1, outcome: 'transport
C1   not ok 1 - 11.3 — all four success sites record `success`, EXECUTED end to end
     └ exactly two LIVE cloud success pushes 1 !== 2 code: 'ERR_ASSERTION'
C2   not ok 1 - 11.3 — all four success sites record `success`, EXECUTED end to end
     └ Expected values to be strictly deep-equal: + actual - expected { attempt: 1, +   outcome: 'transport_error', -   outcome: 'success', status: 200, tier
M1   not ok 1 - 10.3b — the mirror: an outcome-required state WITH an outcome inserts, so the CHECK is not simply ref
     └ Expected "actual" to be strictly unequal to: 0
M2   not ok 1 - 10.2 — `retrieval_complete` WITH A NULL outcome is REJECTED BY THE NAMED CHECK
     └ psql exited non-zero — PostgreSQL refused the row
M3   not ok 1 - 14.1 — LVC semantic swallow, SUCCESS: the row records `success` and the recall returns
     └ Expected values to be strictly equal: + actual - expected + 'zero_hits' - 'success' code: 'ERR_ASSERTION'
M4   not ok 1 - 14.2 — LVC semantic swallow, ZERO HITS: `zero_hits`, and it is NOT `retrieval_failure`
     └ a SUCCESSFUL retrieval that found nothing + actual - expected + 'success' - 'zero_hits' code: 'ERR_ASSERTION'
M5   not ok 1 - 14.3 — LVC semantic swallow, RETRIEVAL FAILURE: the exception is swallowed, the OUTCOME is not
     └ but the row says it FAILED — which is the only thing distinguishing it from 14.2's empty result + actual - expected + 'success' - 'retrieval_failure' 
M6   not ok 1 - 14.4 — outer defaultRecall SQL branch (NO region filter): records `retrieval_failure` and RETHROWS
     └ Expected values to be strictly equal: + actual - expected + 'success' - 'retrieval_failure' code: 'ERR_ASSERTION'
M7   not ok 1 - 14.4 — outer defaultRecall SQL branch (NO region filter): records `retrieval_failure` and RETHROWS
     └ "the error RETHROWS — this branch sits outside the semantic leg's try"
M8   not ok 1 - 14.10 — labRetrieve TYPED error: a RerankBackendError still returns the EXISTING result form, never a
     └ Expected values to be strictly equal: + actual - expected + 'success' - 'retrieval_failure' code: 'ERR_ASSERTION'
M9   not ok 1 - 14.11 — labRetrieve GENERIC error: the ORIGINAL error still throws, unchanged
     └ the dispatcher's rethrow format, with no err()-added name prefix + actual - expected + 'Error: Error: 500 embeddings unavailable (proof 14 stub)' - 'E
M10  not ok 1 - 14.10 — labRetrieve TYPED error: a RerankBackendError still returns the EXISTING result form, never a
     └ and it names the backend failure — surfaced, never a silent fallback
M11  not ok 1 - 14.12 — MULTI-QUERY variant swallow, all three arms: success · zero hits · retrieval failure
     └ Expected values to be strictly equal: + actual - expected + 'zero_hits' - 'retrieval_failure' code: 'ERR_ASSERTION'
M12  not ok 1 - 14.8 — NORMATIVE swallow, all three arms: success · zero hits · retrieval failure
     └ the normative capture, by its own expansion status + actual - expected + 'expanded' - 'skipped' code: 'ERR_ASSERTION'
M13  not ok 1 - 44.2 — IDLE: a null ID, a null target, and exactly `idle` — never an absent field
     └ idle is a MEASUREMENT: without it an overlap analysis cannot tell 360 route invocations from 360 backfills null !== 'idle' code: 'ERR_ASSERTION'
M14  not ok 1 - 44.4 — activeRun BINDS WORKER `opd`, not ipd and not a default
     └ worker is bound as opd — this is the OPD audit path 'ipd' !== 'opd' code: 'ERR_ASSERTION'
N1   not ok 1 - 14.12 — MULTI-QUERY variant swallow, all three arms: success · zero hits · retrieval failure
     └ and it is NOT a dispatcher-generated error ToolResult
N2   not ok 1 - 14.10 — labRetrieve TYPED error: a RerankBackendError still returns the EXISTING result form, never a
     └ EXACTLY one intercepted external request, never zero 0 !== 1 code: 'ERR_ASSERTION'
N3   not ok 1 - 14.11 — labRetrieve GENERIC error: the ORIGINAL error still throws, unchanged
     └ the recorded error class is the BRAND — the object thrown is the object that reached telemetry, not a same-message replacement, which would have recor
N3b  ok 1 - 14.11 — labRetrieve GENERIC error: the ORIGINAL error still throws, unchanged
```

### 6.1 Count, stated exactly

| Group | Rows | All discriminate |
|---|---|---|
| Proof 11, Rep 44 §6 items 1–5 | P1–P5 (5) | yes |
| The fourteen original pass-5 rows, re-run | M1–M14 (14) | yes |
| The three new rows Rep 44 §6 requires | N1, N2, N3 (3) | yes |
| **Counted total** | **22** | **yes — minimum met** |
| Routing controls, retained from the 22 Aug sweep | C1, C2 (2) | yes, still firing |
| Recorded, **not counted** — see §6.4 | N3b (1) | **no, and reported** |

### 6.2 What P1–P5 prove, against the 22 August baseline

All five of these mutations **survived** the retrospective sweep of 22 August; the same five now
fail their named test. That contrast is the proof the repair worked, and it is the reason the rows
were re-run unchanged rather than re-specified:

| Row | 22 Aug (`ddeff1c` evidence) | Now |
|---|---|---|
| P1 | `ok` — 11.7 could not fail for any literal | `not ok` — the literal oracle rejects it |
| P2 | `ok` — AST node retained, test blind | `not ok` — site 1 records no ollama success |
| P3 | `ok` | `not ok` — site 2 records no openrouter success |
| P4 | `ok` | `not ok` — site 3 records no vertex success |
| P5 | `ok` | `not ok` — site 4's ladder history loses its final local success |

### 6.3 The two routing controls, retained

Neither is one of the 22. They exist because rows that all *pass* and rows that are all *misrouted*
look identical without them, and they are kept now for the mirror reason — to show the harness is
still reaching the sandbox files and not the worktree.

- **C1** deletes the OpenRouter push outright, removing the AST node: fails 11.3 on
  `exactly two LIVE cloud success pushes 1 !== 2` — the AST census is live.
- **C2** changes what `localAttemptSuccess()` returns: fails 11.3 on the deep-equal — the import
  resolves to the sandbox file.

### 6.4 ONE ROW DID NOT DISCRIMINATE, AND IT IS REPORTED RATHER THAN REPAIRED

**N3b — the same-message replacement applied at the THROW POINT ONLY.**

```diff
     if (e instanceof RerankBackendError) return err(`${e.name}: ${e.message}`);
-    throw e;
+    throw new Error((e as Error).message);
```

`14.11` **passes** under this. The reason is not a hole in the test:

`telemetryErrorClassOf(e)` runs earlier in the same catch, on the **original** object, so telemetry
records the brand either way. `callLabTool` then flattens whatever is thrown to
`err(String(e.message))`, so the caller sees the same text either way. **The two behaviours are
observationally equivalent through every exported channel** — telemetry and the returned result
both. A test cannot detect a difference that no consumer of this seam can observe.

**How this was handled, stated plainly.** N3 as first written was this mutation, and it did not
discriminate. Per pass 5 §5.1's precedent — *"the row is a defect in the test, not in the table"* —
the question was which. Here it was neither: the row was **mis-specified by me**, because
"replacing the original generic error" means replacing the error the catch then uses, not shadowing
the object at the throw. N3 was rewritten to replace `e` at the head of the catch, which is the
faithful reading and which telemetry does see; it discriminates. **The throw-point variant is kept
and reported as N3b rather than deleted**, because deleting it would hide a real finding: this seam
has an unobservable region, and Saul should know its shape rather than read a table of 22 greens.

**Flagged for Saul.** If Rep 44 intends assertion 5 to cover a post-telemetry replacement as well,
that needs a production-observable channel and therefore a production change — which §2 does not
authorize and which I have not made.

### 6.5 Exact diffs, per row

**P1 — substitute one committed taxonomy literal** (`lib/transport-attribution-core.ts`, named test `11.7`)

```diff
@@ -43,7 +43,7 @@
  * unchanged; the type is derived from the array so the two can never disagree.
  */
 export const TRANSPORT_ATTEMPT_OUTCOMES = [
-  'http_429', 'http_other', 'timeout', 'transport_error', 'bad_response', 'success',
+  'http_429', 'http_other', 'MUTANT_not_timeout', 'transport_error', 'bad_response', 'success',
 ] as const;
 
 export type TransportAttemptOutcome = typeof TRANSPORT_ATTEMPT_OUTCOMES[number];
```

**P2 — disable intended-local success, RETAIN its AST call** (`lib/llm.ts`, named test `11.3`)

```diff
@@ -357,7 +357,7 @@
     try {
       return attachTransportAttribution(await llm.chat.completions.create(params, reqOpts), {
         dispatched_provider: 'ollama', dispatched_model: (params as { model?: string }).model ?? null,
-        cloud_response_received: false, attempts: [...attempts, localAttemptSuccess()],
+        cloud_response_received: false, attempts: [...attempts, ...(false ? [localAttemptSuccess()] : [])],
       });
     } catch (e) {
       const { outcome, status } = classifyLocalAttempt(e);
```

**P3 — disable OpenRouter success, RETAIN its AST push** (`lib/llm.ts`, named test `11.3`)

```diff
@@ -432,7 +432,7 @@
               },
             });
         endProviderCall('openrouter');
-        attempts.push({ tier: 'openrouter', attempt: attempts.filter((a) => a.tier === 'openrouter').length + 1, outcome: 'success', status: 200 });
+        if (false) attempts.push({ tier: 'openrouter', attempt: attempts.filter((a) => a.tier === 'openrouter').length + 1, outcome: 'success', status: 200 });
         return attachTransportAttribution(res, {
           dispatched_provider: 'openrouter', dispatched_model: slug, cloud_response_received: true, attempts: [...attempts],
         });
```

**P4 — disable Vertex success, RETAIN its AST push** (`lib/llm.ts`, named test `11.3`)

```diff
@@ -502,7 +502,7 @@
         },
       );
       endProviderCall('gemini');
-      attempts.push({ tier: 'vertex', attempt: attempts.filter((a) => a.tier === 'vertex').length + 1, outcome: 'success', status: 200 });
+      if (false) attempts.push({ tier: 'vertex', attempt: attempts.filter((a) => a.tier === 'vertex').length + 1, outcome: 'success', status: 200 });
       return attachTransportAttribution(res, {
         dispatched_provider: 'vertex', dispatched_model: geminiModel as string, cloud_response_received: true, attempts: [...attempts],
       });
```

**P5 — disable fallback-local success, RETAIN its AST call** (`lib/llm.ts`, named test `11.3`)

```diff
@@ -560,7 +560,7 @@
   try {
     return attachTransportAttribution(await llm.chat.completions.create(params, reqOpts), {
       dispatched_provider: 'ollama', dispatched_model: (params as { model?: string }).model ?? null,
-      cloud_response_received: false, attempts: [...attempts, localAttemptSuccess()],
+      cloud_response_received: false, attempts: [...attempts, ...(false ? [localAttemptSuccess()] : [])],
     });
   } catch (e) {
     // Every route failed INCLUDING the local one. Before D14 this threw a bare SDK error carrying
```

**C1 — delete the OpenRouter push OUTRIGHT (AST node removed)** (`lib/llm.ts`, named test `11.3`)

```diff
@@ -432,7 +432,6 @@
               },
             });
         endProviderCall('openrouter');
-        attempts.push({ tier: 'openrouter', attempt: attempts.filter((a) => a.tier === 'openrouter').length + 1, outcome: 'success', status: 200 });
         return attachTransportAttribution(res, {
           dispatched_provider: 'openrouter', dispatched_model: slug, cloud_response_received: true, attempts: [...attempts],
         });
```

**C2 — change what localAttemptSuccess() RETURNS** (`lib/transport-attribution-core.ts`, named test `11.3`)

```diff
@@ -269,7 +269,7 @@
  * one out in every census that groups by status.
  */
 export function localAttemptSuccess(): TransportAttempt {
-  return { tier: 'ollama', attempt: 1, outcome: 'success', status: 200 };
+  return { tier: 'ollama', attempt: 1, outcome: 'transport_error', status: 200 };
 }
 
 /** Read failure evidence back off a thrown error. `undefined` means the transport left none. */
```

**M1 — the outcome CHECK stops requiring a null on `started`** (`lib/retrieval-telemetry-core.ts`, named test `10.3b`)

```diff
@@ -1422,7 +1422,7 @@
   ADD CONSTRAINT opd_audit_retrieval_telemetry_persistence_state_chk CHECK (persistence_state IN (${q(RETRIEVAL_PERSISTENCE_STATES)})),
   ADD CONSTRAINT opd_audit_retrieval_telemetry_role_chk CHECK (retrieval_role IN (${q(RETRIEVAL_ROLES)})),
   ADD CONSTRAINT opd_audit_retrieval_telemetry_outcome_chk CHECK (
-  (persistence_state = 'started' AND retrieval_outcome IS NULL)
+  (persistence_state = 'started')
   OR (persistence_state IN (${q(OUTCOME_REQUIRED_STATES)}) AND retrieval_outcome IS NOT NULL)
   OR persistence_state IN (${q(OUTCOME_EITHER_STATES)})
 )`,
```

**M2 — the CHECK stops requiring an outcome on terminal states** (`lib/retrieval-telemetry-core.ts`, named test `10.2`)

```diff
@@ -1423,7 +1423,7 @@
   ADD CONSTRAINT opd_audit_retrieval_telemetry_role_chk CHECK (retrieval_role IN (${q(RETRIEVAL_ROLES)})),
   ADD CONSTRAINT opd_audit_retrieval_telemetry_outcome_chk CHECK (
   (persistence_state = 'started' AND retrieval_outcome IS NULL)
-  OR (persistence_state IN (${q(OUTCOME_REQUIRED_STATES)}) AND retrieval_outcome IS NOT NULL)
+  OR (persistence_state IN (${q(OUTCOME_REQUIRED_STATES)}))
   OR persistence_state IN (${q(OUTCOME_EITHER_STATES)})
 )`,
     },
```

**M3 — a successful retrieval is recorded as `zero_hits`** (`lib/retrieve.ts`, named test `14.1`)

```diff
@@ -647,7 +647,7 @@
   // reaches the scorer. `zero_hits` here is the hydrate-emptied shape: fused > 0, hydrated 0.
   if (capture) {
     capture.orderedFinalCandidateIds = hits.map((h) => h.id);
-    capture.retrievalOutcome = hits.length > 0 ? 'success' : 'zero_hits';
+    capture.retrievalOutcome = 'zero_hits';
   }
 
   return {
```

**M4 — the empty fusion stops recording `zero_hits`** (`lib/retrieve.ts`, named test `14.2`)

```diff
@@ -536,7 +536,7 @@
     // recorded 0. The createTelemetryCapture defaults already say exactly this, so only the
     // outcome moves. `zero_hits` is a SUCCESSFUL retrieval that found nothing, which §4.3 requires
     // be distinguishable from a failed one.
-    if (capture) capture.retrievalOutcome = 'zero_hits';
+    if (capture) { /* mutation: the empty fusion records nothing */ }
     return { hits: [], expandedQuery: expanded, meta: {
       vector_pool: vecRows.length, bm25_pool: bm25Rows.length, fused: 0,
       bm25_query: bm25Query, pool_size: 0, reranked: false, source_weighted: false,
```

**M5 — the LVC semantic swallow stops recording the failure** (`lib/lvc.ts`, named test `14.3`)

```diff
@@ -286,6 +286,7 @@
     sem = recs.filter((x) => itemNos.has(x.id));
   } catch (e) {
     console.warn('[lvc] semantic recall failed', (e as Error).message);
+    if (capture) { await finishRecall(); return core.dedupeById(kw, sem); }
     // A swallowed retrieval exception and a retrieval that found nothing produce the SAME empty
     // result here. Only one of them is a defect, and this is what tells them apart.
     if (capture) {
```

**M6 — the outer SQL branch stops recording the failure** (`lib/lvc.ts`, named test `14.4`)

```diff
@@ -268,8 +268,6 @@
       : await sql2(`SELECT ${REC_COLS} FROM lvc_recommendations WHERE status = 'active'`, []);
   } catch (e) {
     if (capture) {
-      capture.retrievalOutcome = 'retrieval_failure';
-      capture.retrievalErrorClass = errorClassOf(e);
       await finishRecall();
     }
     throw e;
```

**M7 — the outer SQL branch swallows instead of rethrowing** (`lib/lvc.ts`, named test `14.4`)

```diff
@@ -272,7 +272,7 @@
       capture.retrievalErrorClass = errorClassOf(e);
       await finishRecall();
     }
-    throw e;
+    rows = [];
   }
   const recs = rows.map(rowToRec);
   const kw = core.keywordRecall(input.scenario, candidates, recs);
```

**M8 — `labRetrieve` stops recording the failure** (`lib/mcp-tools.ts`, named test `14.10`)

```diff
@@ -1227,7 +1227,6 @@
     // §4.3's whole point is that a retrieval that found nothing and a retrieval that failed are two
     // facts, and until now this seam produced the same empty answer for both.
     if (capture) {
-      capture.retrievalOutcome = 'retrieval_failure';
       capture.retrievalErrorClass = capture.retrievalErrorClass ?? telemetryErrorClassOf(e);
     }
     await finish();
```

**M9 — a generic error becomes the typed result form** (`lib/mcp-tools.ts`, named test `14.11`)

```diff
@@ -1233,8 +1233,7 @@
     await finish();
     // D3: a requested cohere ruler that is unreachable/missing/unhealthy fails LOUD — surfaced named
     // (RerankBackendUnreachable/Missing/Unhealthy, all RerankBackendError), never a silent fallback.
-    if (e instanceof RerankBackendError) return err(`${e.name}: ${e.message}`);
-    throw e;
+    return err(`${(e as Error).name}: ${(e as Error).message}`);
   }
 }
 
```

**M10 — the typed error throws instead of returning its form** (`lib/mcp-tools.ts`, named test `14.10`)

```diff
@@ -1233,7 +1233,6 @@
     await finish();
     // D3: a requested cohere ruler that is unreachable/missing/unhealthy fails LOUD — surfaced named
     // (RerankBackendUnreachable/Missing/Unhealthy, all RerankBackendError), never a silent fallback.
-    if (e instanceof RerankBackendError) return err(`${e.name}: ${e.message}`);
     throw e;
   }
 }
```

**M11 — every-arm-failed is recorded as success** (`lib/multi-query.ts`, named test `14.12`)

```diff
@@ -387,8 +387,7 @@
     // and the rest returning nothing is `zero_hits`: the retrieval worked and found nothing.
     const everyArmFailed = capture.variants!.length > 0
       && capture.variants!.every((v) => v.outcome === 'retrieval_failure');
-    capture.retrievalOutcome = everyArmFailed ? 'retrieval_failure'
-      : hits.length > 0 ? 'success' : 'zero_hits';
+    capture.retrievalOutcome = hits.length > 0 ? 'success' : 'zero_hits';
     if (capture.retrievalOutcome !== 'retrieval_failure') capture.retrievalErrorClass = null;
   }
 
```

**M12 — the normative payload is built from `primaryCapture`** (`lib/opd-note-audit.ts`, named test `14.8`)

```diff
@@ -802,7 +802,7 @@
       // always `skipped` (normativeChannelOpts sets skipExpand unconditionally), which is why the
       // validator accepts a null served class on a skipped stage — otherwise every one of these
       // rows would be partial by construction.
-      const normPayload = buildRetrievalPayload(args.normativeCapture, { hmacKey, scorerContext: null });
+      const normPayload = buildRetrievalPayload(args.primaryCapture, { hmacKey, scorerContext: null });
       const normOperational = operationalFor('normative_channel');
       defectsByRole.normative_channel = validateManifest({ ...normPayload, operational: normOperational });
       handle = await writeRetrievalTerminal(handle, 'normative_channel', {
```

**M13 — idle is reported as three nulls** (`lib/opd-note-audit.ts`, named test `44.2`)

```diff
@@ -733,7 +733,7 @@
       // ⚠️ `idle` IS A MEASUREMENT, NOT AN ABSENCE. §2 forbids twice reporting a cron tick as a
       // workload; without this value an overlap analysis cannot tell 360 route invocations from
       // 360 backfills, which is the exact error the evidence boundary names.
-      : { runId: null, target: null, state: 'idle' };
+      : { runId: null, target: null, state: null };
   } catch {
     return { runId: null, target: null, state: null };
   }
```

**M14 — `activeRun` is asked for the `ipd` worker** (`lib/opd-note-audit.ts`, named test `44.4`)

```diff
@@ -723,7 +723,7 @@
 async function readBackfillActivity(): Promise<{ runId: string | null; target: string | null; state: BackfillActivity | null }> {
   try {
     // 'opd' is required — BackfillWorker is 'opd' | 'ipd', and this is the OPD audit path.
-    const run = await activeRun('opd');
+    const run = await activeRun('ipd');
     // ⚠️ `target` IS THE RUN'S MODEL. `BackfillRun` has no field called `target`; what a backfill
     // run targets is the `bedrock:<id>` / `vertex:<id>` string it is grading against, and that is
     // the value an overlap analysis needs — "which backfill was running" is answered by the model,
```

**N1 — a multi-query failure is converted into an EXTERNAL ERROR result** (`lib/mcp-tools.ts`, named test `14.12`)

```diff
@@ -1193,6 +1193,7 @@
       });
       const hits = scoresOnly ? full.map(pickScoreFields) : full;
       await finish();
+      if (capture?.retrievalOutcome === 'retrieval_failure') return err('multi-query retrieval failed');
       return ok({
         query, mode: 'multi_query', expandedQuery: res.expandedQuery, includeQuarantined: includeQuarantined ?? null,
         restrictSources: restrictSources ?? null,
```

**N2 — the Cohere arm makes ZERO requests (the pre-fetch key check fires)** (`lib/rerank.ts`, named test `14.10`)

```diff
@@ -211,7 +211,7 @@
  *  Response: { results: [{ index, relevance_score∈[0,1] }], usage: { cost } } — mapped back by index. */
 async function cohereRelevanceScores(query: string, documents: string[], fetchImpl: typeof fetch = fetch): Promise<{ scores: number[]; usageCost: number | null }> {
   const key = process.env.OPENROUTER_API_KEY;
-  if (!key) throw new RerankBackendUnreachable('cohere', RERANK_API_MODEL, 'OPENROUTER_API_KEY not set');
+  throw new RerankBackendUnreachable('cohere', RERANK_API_MODEL, 'OPENROUTER_API_KEY not set');
   let res: Response;
   try {
     res = await fetchImpl(RERANK_API_URL, {
```

**N3 — the original generic error is REPLACED by a same-message error** (`lib/mcp-tools.ts`, named test `14.11`)

```diff
@@ -1226,6 +1226,7 @@
     // RerankBackendError still becomes the same error RESULT and every other error still THROWS —
     // §4.3's whole point is that a retrieval that found nothing and a retrieval that failed are two
     // facts, and until now this seam produced the same empty answer for both.
+    e = new Error((e as Error).message);
     if (capture) {
       capture.retrievalOutcome = 'retrieval_failure';
       capture.retrievalErrorClass = capture.retrievalErrorClass ?? telemetryErrorClassOf(e);
```

**N3b — same-message replacement at the THROW POINT ONLY (post-telemetry)** (`lib/mcp-tools.ts`, named test `14.11`)

```diff
@@ -1234,7 +1234,7 @@
     // D3: a requested cohere ruler that is unreachable/missing/unhealthy fails LOUD — surfaced named
     // (RerankBackendUnreachable/Missing/Unhealthy, all RerankBackendError), never a silent fallback.
     if (e instanceof RerankBackendError) return err(`${e.name}: ${e.message}`);
-    throw e;
+    throw new Error((e as Error).message);
   }
 }
 
```


### 6.6 Four-hash byte equality, thirteen files

`worktree-before` (the pristine copies) · `sandbox-baseline` · `worktree-after` · `git show HEAD:<path>`
agree on every file the campaign mutated or read:

```
lib/transport-attribution-core.ts                       f0b148bc73715e9f35f1f5b93c431579aa36b3d6
lib/llm.ts                                              006be6d6a5f9f001dff85c2ac43133e0715346bc
lib/retrieval-telemetry-core.ts                         d8432b58a4386edef559c788915ed15af550f0d8
lib/retrieve.ts                                         27fdc034619e9bcaaa7578b442a8994afed68ff1
lib/lvc.ts                                              e481f44786b7485363b3e4000f485877f4fd1b3a
lib/mcp-tools.ts                                        83f81d294677784a117c921dedf7d74d4ba8798a
lib/multi-query.ts                                      d5792ac5bad1b568ec7ecdee4625ecc775b91d0a
lib/opd-note-audit.ts                                   99c01fd744242d90c86370a81a6b76c0ccab5125
lib/rerank.ts                                           6e6b2502f3de2d9c99585b26b5c41cf9b4e2d622
lib/__tests__/attempt-taxonomy.test.ts                  0e5af7594b70fdbfd0b969ee7bc0709a1e52b732
lib/__tests__/retrieval-outcome-discrimination.test.ts  a048ceb3406b7abee941da75b493a299d7df8676
lib/__tests__/telemetry-non-exposure.test.ts            aece25be353c1aec1e8480dba33073384bc570ae
lib/__tests__/retrieval-telemetry-lifecycle.test.ts     04584e2d6585e26bc12ed94fe99c0cab3f8baa2b
```

ALL FOUR-HASH EQUAL ACROSS 13 FILES: **YES**. `git status` clean, `HEAD` at `4989fcb`.
**Sandbox and pristine copies deleted**, confirmed absent.

## 7. The gate — nine commands plus the build pair, against `4989fcb`

Raw results, as run, not summarised.

```
### Command 1 — npm test                       STARTED 09:38:01  exit=0  ENDED 09:38:24
# tests 3633
# suites 0
# pass 3633
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 22107.970125

### Command 2 — npm run typecheck              STARTED 09:38:24  exit=0  ENDED 09:38:28

### Command 3 — npm run build                  STARTED 09:38:28  exit=0  ENDED 09:38:59
 ✓ Compiled successfully in 8.5s

### Command 4 — npm run architecture:check     STARTED 09:38:59  exit=0  ENDED 09:39:00
coverage · GREEN · 39 subsystems · 16 registered, 23 explicitly unregistered
architecture:check — all 8 rules + coverage green.

### Command 5 — npm run architecture:map       STARTED 09:39:00  exit=0  ENDED 09:39:00
architecture:map — wrote lib/architecture/map.generated.ts (90409 bytes).

### Command 6 — determinism + currency, NO git add form   STARTED 09:39:14  ENDED 09:39:14
precondition  git diff --exit-code            → exit 0
precondition  git diff --cached --exit-code   → exit 0
generate twice, cmp A vs B                    → identical
post          git diff --exit-code            → exit 0
                                              (0 dirty paths; no git write performed)

### Command 7 — EXACT FORM REQUIRED BY §7      STARTED 09:39:14  exit=0  ENDED 09:39:15
bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'
reasoning:registry — wrote data/reasoning-registry/prompts.generated.json (88737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features).

### Command 8 — npm run reasoning:governance   STARTED 09:39:23  exit=0  ENDED 09:39:23
reasoning:governance — GREEN: 0 ungoverned model calls; parallel stores folded.

### Command 9 — npm run changelog:coverage     STARTED 09:39:23  exit=0  ENDED 09:39:23
changelog:coverage — GREEN: all 19 shipped engine versions documented (30 versioned entries).

### Build arm A — unkeyed production           STARTED 09:41:02  exit=1  ENDED 09:41:03
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every
patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3).
Set it in Vercel Production before deploying.

### Build arm B — keyed production             STARTED 09:41:03  exit=0  ENDED 09:41:36
 ✓ Compiled successfully in 8.6s
```

**OBSERVED test count: 3633** — unmoved from pass 5, which is correct: 11.3 was rebuilt in place and
the proof-14 work extended existing tests rather than adding new ones.

### 7.1 Generator units and actual UTF-8 bytes, recorded SEPARATELY

Per §7 these are two figures, not one with a caveat. The generator counts **UTF-16 code units**;
`wc -c` counts **UTF-8 bytes**.

| Artefact | Generator (UTF-16 code units) | `wc -c` (UTF-8 bytes) | Offset |
|---|---|---|---|
| `lib/architecture/map.generated.ts` | **90409** | **90411** | +2 |
| `data/reasoning-registry/prompts.generated.json` | **88737** | **89301** | +564 |

The map's two-unit offset is the one noted in earlier passes. **The registry's offset is 564 and has
not been stated before** — recorded here as its own figure so a future reader comparing "88737"
against a byte count does not read a drift where there is none.

### 7.2 A deviation in how the build arms were first run — mine, corrected

Build arm A was **first run with `NODE_ENV=production` and exited 0**, which would have been a false
green. `telemetryKeyMissingInProduction` (`lib/telemetry-key-guard.ts:24`) keys off
**`VERCEL === '1'` and `VERCEL_ENV === 'production'`**, not `NODE_ENV`. Both arms were re-run with
the correct environment and are recorded above from that run. The first run is disclosed rather than
dropped; nothing in the table above comes from it.

## 8. Documentary corrections required by B5

Both are corrections of wording. Neither changes code, and neither is being made by editing the
already-committed documents — those stand as the record of what was said, and this is the correction
of it.

### 8.1 The failed pre-commit typecheck was a PROCESS BREACH

Pass 5's §7 deviation 1 recorded that `487d807` was committed before its typecheck was read, that
`classedError` takes one argument and four call sites passed a second, and that `820bddd` is the
forward fix. What that wording did **not** say, and what B5 requires it to say:

> **This was a process breach.** The standing rule is typecheck before every commit. It was not
> followed. The forward `classedError` correction and the later green gate preserve the *technical*
> validity of the result — the tree that was gated is correct — but they do not make the sequence
> compliant, and describing it only as "a third commit where §9 specifies two" understated it as a
> counting deviation when it was a discipline failure.

The rule was followed in this pass: `npx tsc --noEmit` exited 0 against the working tree **before**
`4989fcb` was created, and Command 2 confirms it against the commit.

### 8.2 "Documentation only" and "evidence commit only" were INACCURATE

Both claims are quoted and corrected:

| Where | What it said | What is true |
|---|---|---|
| `cb46330` commit message (pass 5) | *"Documentation only. No code change."* | The commit carried **`.gitignore` (+1)** as well as the document. `.gitignore` is not code, but it is not documentation either — it is a tracked repository control file, and "documentation only" describes the commit's contents inaccurately. |
| `CDMSS-PROOF-11-MUTATION-SWEEP-22-AUG-2026.md:6` (the sweep) | *"**Commit:** this document only."* | The commit carried **`.gitignore` (+1)** as well. The sweep's §7 body did name the negation, but this headline line did not, and the headline is what gets read. |

`git show --name-only` on both, as the record:

```
cb46330   .gitignore   CDMSS-GATE-EVIDENCE-PASS-5-22-AUG-2026.md
ddeff1c   .gitignore   CDMSS-PROOF-11-MUTATION-SWEEP-22-AUG-2026.md
```

**The cause is structural, not careless.** `.gitignore:73` carries `/*.md`, so every tracked
root-level evidence document REQUIRES a `!/CDMSS-…` negation in the same commit. The honest phrasing
is therefore *"this document plus the `.gitignore` negation it requires"*, which is what the header
of this document says and what future evidence commits should say. Rep 44 B5 notes the Orchestrator
used the same loose phrasing in its asks; the correction applies to the phrasing wherever it appears,
not only to these two commits.

## 9. Acceptance, item by item

| # | Requirement | Status |
|---|---|---|
| 1 | Three test files and evidence only; no production file; `git show --stat` proves it | **met** — §2 |
| 2 | 11.7 uses the literal oracle, not derived, spread or mapped | **met** — §3.1, proven by P1 |
| 3 | 11.3 executes all four paths, asserting provider, attempt, success, status, ordering, exact call count | **met** — §3.2, proven by P2–P5 |
| 4 | All five proof-11 rows discriminate; both controls retained and firing | **met** — §6.2, §6.3 |
| 5 | Proof 14's five assertions present; the Cohere arm asserts exactly one request | **met** — §4 |
| 6 | `ALLOWED` carries the exact path; literal table name replaces the derived identifier | **met** — §5 |
| 7 | ≥22 mutation rows, each failing a named assertion, before the gate, against one finalized blob | **met** — 22 counted, all by name, against `4989fcb`; plus 2 controls and 1 reported non-row (§6.4) |
| 8 | Gate green, command 7 in the exact form, raw results archived, units and bytes separate | **met** — §7, §7.1 |
| 9 | Documentary corrections in §8 made | **met** — §8 |

## 10. Deviations and flags

1. **N3 was re-specified after its first form did not discriminate.** Full disclosure in §6.4,
   including the original diff, kept as N3b. The row was mis-specified by me, not adjusted to make
   it fail: the throw-point variant is observationally equivalent through every exported channel, so
   no test could have caught it. **Flagged for Saul** — if assertion 5 is meant to cover a
   post-telemetry replacement, that needs a production change §2 does not authorize.
2. **Two live test defects were found beyond the kickoff's list** (§4.2): the Cohere arm made zero
   requests because of the pre-fetch key check, and its URL never matched the interceptor because
   the backend is OpenRouter-hosted. Rep 44 predicted the vacuity; the causes are one layer further
   down.
3. **An egress risk was created and closed inside this pass** (§4.2). Supplying the synthetic key
   made the cohere call reach `fetch` for the first time, against the real default
   `https://openrouter.ai/api/v1/rerank`. The interceptor widening is what stops it. Recorded
   because the intermediate state existed, briefly, in my working tree.
4. **A fourth test file was RUN but not modified** — `retrieval-telemetry-lifecycle.test.ts`, the
   home of proofs 44.2 and 44.4, which rows M13 and M14 name. Running is not changing; its blob is
   in §6.6's four-hash proof, unmoved.
5. **Build arm A was first run with the wrong environment** and produced a false green. Disclosed
   and corrected in §7.2; the recorded run is the correct one.
6. **`P5`'s anchor needed widening** during harness construction: the six-space and eight-space forms
   of the same line nest as substrings, so the narrow anchor matched twice. A harness fix, not a
   change to the mutation — the diff in §6.5 is the mutation Rep 44 specifies.
7. **No production file was edited and no production seam was added.** Interception is confined to
   the two SDK prototypes, inside the two test files, restored in `finally`.
8. **Nothing pushed.** Two forward commits on `t4b`; no amend, reset, squash, rebase or force-push.

---

**Ledger effect, if Saul accepts:** proofs 11 and 14 close, returning the hard ledger to **20/20**
with 4/4 judge, for final review. No integration, deployment, migration, bootstrap, measurement
execution, PR 2, ranking change or Cohere action is authorized by Rep 44, and none was taken.
