# CDMSS — Pass 4 forward correction: gate evidence and governance record

**Date:** 21 August 2026 (IST)
**Kickoff:** `CDMSS-TELEMETRY-PASS4-CORRECTION-KICKOFF-21-AUG-2026.md` (Saul Rep 43, A1 and A3).
**Base:** branch `t4b` @ `1295e05`. **Forward commits only** — `12a4565` and `1295e05` are unrewritten.
**Correction commit:** `c1d7490`.
**Ledger at the time of writing:** proof 24 **closed** at `t4a` `5994922`; official count **14/20 hard, 4/4 judge**. Proofs 21, 22 and 23 remain **held** pending Saul's review of this correction.
**Pushed:** **No.**

---

## 1. What was wrong, accepted

The primary fixture deviation was **not ratified**. Rep 43: *"It is a material deviation, not a
harmless reduction in production change."* Our pass-4b reading — that running production's own
retrieval strengthened the proofs — was wrong. The reasons:

1. The private plan carried `primaryHits`, but the code **always** called the real `defaultRetrieve`.
2. That call **can reach expansion and embedding providers**. The database stub does not contain the
   OpenAI SDK's captured transport, so the isolation pass 4b claimed **did not hold**.
3. Test 23.6 therefore depended on **missing local provider configuration** producing
   `retrieval_failure` — an environmental accident, not a controlled input.
4. The primary fixture was **empty in practice**, so proof 23 never established that **both**
   primary and normative material reach the combined-context HMAC. That is the substance of proof
   23, and it was unproven.
5. `4B-SEAM.3` was **source-only** where a behavioural plan-free equality check was required.
6. Test 22.3 **inferred** a null retrieval outcome from revisions and absent terminal writes.
7. The gate count is **3,598** at `12a4565`. The ask to Saul said 3,599 — an **Orchestrator
   transcription error**, from a screenshot rather than from the evidence document on the branch.

The pass-4b gate was green for its bytes. Those bytes did not satisfy the authorized seam contract.

## 2. The production change, verbatim

```ts
    const hits = faultPlan
      ? lifecycleFixtureHits(primaryCapture, faultPlan.primaryHits)
      : await defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend, primaryCapture);
```

**One formatting difference from §2.1's snippet, reported rather than absorbed.** §2.1 breaks the
false arm across six lines. `lib/__tests__/rerank-backend.test.ts:337` and `:339` pin that call as a
**single-line literal**, and §2.2 requires that file to stay unchanged and instructs a stop if it
must change. The one-line form is also what §2.1's own sentence requires — *"the plan-free arm must
remain the five-argument production call, unchanged"* — since the six-line form **changes** it.
The one-line reading is therefore the one under which §2.1 and §2.2 are both true, and it is what
is built. **`rerank-backend.test.ts` is untouched and green.** Rep 43 governs if he reads it
otherwise.

`lib/__tests__/citation-support.test.ts` is re-pinned to the **production false arm**, as §2.2
authorizes:

```ts
const retrieveIdx = src.indexOf(': await defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend, primaryCapture);');
```

## 3. The seven §3 requirements, each mapped to its named test

| § | Requirement | Named test |
|---|---|---|
| 3.1 | non-empty primary **and** normative fixtures both consumed | `4C-1` — the role manifest carries exactly the planned ids on **both** legs, and both texts appear in the combined context |
| 3.2 | removing only the primary contribution fails proof 23 | `4C-2` (assertion) **and mutation row M6** (executable) |
| 3.3 | planned calls reach no provider, socket, corpus database, embedding or reranker | `4C-3` — every outbound `fetch` recorded and asserted; named negatives for openai / ollama / embed / rerank / cohere / openrouter / generativelanguage / bedrock |
| 3.4 | plan-free path behaviourally equal to the pre-seam baseline | `4C-4` — deep-equal against a baseline **captured by running `5994922`'s own code**; `4C-4b` keeps the source pin as supporting evidence only |
| 3.5 | the first four proof-22 cases **observe** the null retrieval outcome at declaration | `4C-5` — the declaration INSERT's fourteen columns contain no outcome column and no bound parameter is an outcome value |
| 3.6 | production callers and `AuditOpdOpts` unchanged | `4C-6` |
| 3.7 | no mutable global state | `4C-7` — source **and** behavioural: the plan-free path is unchanged after two planned runs |

`4B-SEAM.3` was **removed as superseded** by §3.4, with a comment recording why.

Assertions now read the role manifest **by name** (`retrieval_outcome`, `ordered_final_candidate_ids`,
`scorer_context_hmac`) rather than by bound-parameter index, so a column reordering cannot silently
satisfy them.

### 3.4's baseline, and how it was obtained

The plan-free `auditOpdNote` was run under `installDbStub` in the `t4a` worktree at `5994922` — the
last commit before the seam existed — and again in this worktree, dumping the returned audit
(`traceId` removed), the handle publications in order, and the statement sequence. **The two outputs
were byte-identical.** That observation is embedded as `PRESEAM_BASELINE` so the equality is
re-checked on every run rather than claimed once.

`4C-4` excludes statements whose presence depends on module-level cache warmth (`lvc_recommendations`,
`quieting_policy_log`, the suppression cache, and `CREATE TABLE IF NOT EXISTS` warm-up), because a
standalone run issues them and a run after other tests in the same file does not. The test asserts
the filter is not vacuous: the declaration and **both** terminal writes are still compared.

## 4. Governance record for the soft reset (Rep 43 §4)

```
discarded object:
6892a27c497928df8c43751e05b37a10ec9124d2

commands:
git reset --soft HEAD~1
git reset -q
```

The discarded object is **reflog-addressable but unreachable from refs**. **Production bytes were
unchanged** by the reset. The **final test delta was eleven lines**. The **final mutation table and
gate ran against `12a4565`**.

Rep 43: *"The reset was a history rewrite in substance, even though it was not `commit --amend`,
rebase, squash, or force-push."* **It is recorded that way here — as a history rewrite in
substance — and not as a technicality that fell outside a list.** Rep 43 retrospectively ratifies it
subject to this record. **No rerun is required solely because of the reset.**

## 5. Evidence accuracy (Rep 43 §5)

The first, defective run of mutation row M2 in pass 4b was **disclosed but not fully archived**. Its
summary line and its named-test outcome were captured; its complete TAP output was not retained.
**The two runs were not captured equivalently, and pass 4b's evidence should not be read as saying
they were.** The table in §6 below is a fresh run in full; nothing in it is carried forward.

## 6. The mutation table — fresh, and run BEFORE the gate

Sandbox outside the worktree, `.git` and `.next` absent, `node_modules` symlinked, **shape verified
before use**, **no git command inside the sandbox**, restore by `cp` from a pristine copy held
outside it, verified by `cmp`. Command for every row:
`node --test --import tsx lib/__tests__/retrieval-telemetry-lifecycle.test.ts`, cwd = the sandbox,
the named test file only.

| Row | Proof | Mutation | STARTED | ENDED | exit | pass/fail | Named test failed |
|---|---|---|---|---|---|---|---|
| M1 | 21 | publication after the primary terminal removed | 20:34:28 | 20:34:32 | 1 | 38/4 | ✓ `21.2` |
| M2 | 22 | the `during_generation` fault deleted | 20:34:32 | 20:34:36 | 1 | 36/6 | ✓ `22.2` |
| M3 | 23 | the primary terminal hashes an empty scorer context | 20:34:36 | 20:34:40 | 1 | 39/3 | ✓ `23.6` |
| M4 | 23 (Rep 42's named row) | an early terminal write before assembly | 20:34:40 | 20:34:44 | 1 | 30/12 | ✓ `23.4` |
| M5 | the seam | plan attachment replaced with a no-op | 20:34:44 | 20:34:48 | 1 | 27/15 | ✓ `21.1` |
| **M6** | **§3.2 — Rep 43's named row** | **only the primary contribution removed from the combined context** | 20:34:48 | 20:34:51 | 1 | 38/4 | **✓ `23.6`** |
| M7 | §3.1 | the primary fixture arm falls back to the real provider call | 20:34:51 | 20:34:55 | 1 | 37/5 | ✓ `4C-1` |

Exact diffs for the two new rows:

```diff
### M6 — §3.2: remove ONLY the primary contribution
@@ -1746,2 +1746,3 @@
     lifecycleFault(faultPlan, 'during_context_assembly');
+    /* MUTANT M6: the primary contribution is dropped from the combined context */
-    const { sources, citedContext } = assembleAuditContext(hits, normHits);
+    const { sources, citedContext } = assembleAuditContext([], normHits);

### M7 — §3.1: the primary fixture arm falls back to the real provider
@@ -1731,4 +1731,2 @@
-    const hits = faultPlan
-      ? lifecycleFixtureHits(primaryCapture, faultPlan.primaryHits)
-      : await defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend, primaryCapture);
+    const hits = await defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend, primaryCapture);
```

M1–M5 use the same diffs recorded in `CDMSS-GATE-EVIDENCE-PASS-4B-21-AUG-2026.md` §5.2, re-run here
against the corrected bytes.

The named failing lines, quoted:

```
not ok - 21.2 — the primary terminal publishes [1,0]: the primary advanced and the normative has not
not ok - 22.2 — during_generation settles retrieval_complete → audit_generation_failed
not ok - 23.6 — the primary payload HMAC is over the COMBINED assembled context, computed by the real run
not ok - 23.4 — A CONTEXT-ASSEMBLY FAULT PRODUCES ZERO TERMINAL WRITES, driven through the real auditOpdNote
not ok - 21.1 — declaration publishes both roles at revisions [0,0], through the real auditOpdNote
not ok - 4C-1 (§3.1) — NON-EMPTY primary AND normative fixtures are both consumed, and both reach the combined context
```

Every row restored with `cmp exit=0`. **No row timed out**; every row failed by assertion.

Worth recording: **M2 also failed `4C-3`.** Deleting the generation fault lets the run proceed to
generation, which reaches a provider — so §3.3's guard is not decorative, and it fires exactly when
a planned call stops being isolated.

### 6.1 Four-hash byte equality

```
lib/opd-note-audit.ts                                f0498276212cc36998cfa8a4498449c8d6d1a02f1100ad3d98b2a48d5faa268e
lib/__tests__/retrieval-telemetry-lifecycle.test.ts  21b5a19a95d601a3f69e910845e9a7079570536e01ad70b4eec5677f1bd9b303
lib/__tests__/citation-support.test.ts               fd31c27d05845500c5c07c32f476c3289034912e34c6668c21f0774cfdaa776d
```

worktree-before, sandbox-baseline, worktree-after and `git show HEAD:<path>` agree on all three.
Sandbox deleted.

## 7. The gate — nine commands plus the build pair, against `c1d7490`

```
### Command 1 — npm test                       STARTED 20:35:14  exit=0  ENDED 20:35:29
# tests 3605 / # suites 0 / # pass 3605 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0

### Command 2 — npm run typecheck              STARTED 20:35:29  exit=0  ENDED 20:35:32
> tsc --noEmit                                 (no diagnostics)

### Command 3 — npm run build                  STARTED 20:35:32  exit=0  ENDED 20:36:03
 ✓ Compiled successfully in 8.1s

### Command 4 — npm run architecture:check     STARTED 20:36:03  exit=0  ENDED 20:36:03
rule 1 · GREEN · 26 files scanned · pure clinical cores must not reach up into the app
rule 2 · GREEN · 4 files scanned · advisory must not import score arithmetic (finding types/identity from opd-note-audit-core ARE allowed)
rule 3 · GREEN · 24 files scanned · the spine runs no audit/score logic (VALUE imports; `import type` is allowed)
rule 4 · GREEN · 24 files scanned · the spine must not couple to a prediction layer
rule 5 · GREEN · 8 files scanned · inquiry (advisory) and the scored cores never value-import each other
rule 6 · GREEN · 24 files scanned · the spine must not value-import the IPD audit module
rule 7 · GREEN · 24 files scanned · the frozen spine must not import EpisodeState
rule 8 · GREEN · 24 files scanned · the frozen spine must not import the admission adapter
coverage · GREEN · 39 subsystems · 16 registered, 23 explicitly unregistered
architecture:check — all 8 rules + coverage green.

### Command 5 — npm run architecture:map       STARTED 20:36:03  exit=0  ENDED 20:36:04
architecture:map — wrote lib/architecture/map.generated.ts (90409 bytes).

### Command 6 — determinism + currency, NO git add form   STARTED 20:36:19  ENDED 20:36:19
precondition  git diff --exit-code lib/architecture/map.generated.ts          → exit 0
precondition  git diff --cached --exit-code lib/architecture/map.generated.ts → exit 0
generate twice, cmp generation A vs generation B                              → identical
post          git diff --exit-code lib/architecture/map.generated.ts          → exit 0
                                                (0 dirty paths; no git write performed)

### Command 7 — npm run reasoning:registry + diff   STARTED 20:36:19  exit=0  ENDED 20:36:20
reasoning:registry — wrote data/reasoning-registry/prompts.generated.json (88737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features).
git diff --exit-code data/reasoning-registry/prompts.generated.json → exit 0

### Command 8 — npm run reasoning:governance   STARTED 20:36:20  exit=0  ENDED 20:36:20
reasoning:governance — GREEN: 0 ungoverned model calls; parallel stores folded.

### Command 9 — npm run changelog:coverage     STARTED 20:36:20  exit=0  ENDED 20:36:20
changelog:coverage — GREEN: all 19 shipped engine versions documented (30 versioned entries).

### Build arm A — unkeyed production           STARTED 20:36:20  exit=1  ENDED 20:36:20
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). Set it in Vercel Production before deploying.
    at <unknown> (next.config.mjs:14:9)

### Build arm B — keyed production             STARTED 20:36:20  exit=0  ENDED 20:36:53
 ✓ Compiled successfully in 9.3s
```

**OBSERVED test count: 3605.** Read from this run's output, not rounded, not estimated, not carried
forward from any earlier document. **OBSERVED map size: 90409 bytes** — the required value; the map
did not move.

## 8. Deviations and flags

1. **§2.1 formatting** — the plan-free arm is one line, not six. Reasoned in §2 above; the
   alternative would have forced a change to `rerank-backend.test.ts`, which §2.2 forbids without a
   stop. **Flagged for Rep 43.**
2. **`4B-SEAM.3` removed**, superseded by §3.4's behavioural check. A comment in the test file
   records the removal and why, so the deletion is not silent.
3. **`4C-4` filters cache-warmth statements** from the baseline comparison, with a non-vacuity
   assertion. Described in §3.4 above.
4. **No stop condition was reached.** No fourth file was needed, the map did not move, no provider
   or socket was reached under a plan, and the gate is green for this change alone.
5. Nothing pushed. No engine bump, no changelog entry, no migration, no deployment.
