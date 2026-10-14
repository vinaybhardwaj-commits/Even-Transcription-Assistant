# CDMSS rerank telemetry: addendum v1, and the pass-1 kickoff

**13 August 2026. Revision 2**, after an adversarial pass over revision 1 found six defects
in this document. Section 14 lists them.

---

## 0. Authority and preflight

This document is the successor kickoff governing all work after
`32f0f79183592b804988113a36b042a8f0458f84` on `exp/rerank-telemetry`.

It **amends** `CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md` at D9, D12,
test 42, the file contract, the order of work, and the report contract, where stated below.

It **does not amend D7.** D7 already names the A/A default-recall pass with route
`lvc_judge_aa` in its own table. Step 13 builds a D7 row that was never built.

It **supersedes** `CDMSS-RERANK-TELEMETRY-DECISIONS-13-AUG-2026.md` where they conflict.
That document is the evidence companion. This one is the instruction.

The PRD is unchanged.

### Preflight. Stop on any mismatch.

```text
branch:  exp/rerank-telemetry
HEAD:    32f0f79183592b804988113a36b042a8f0458f84
tree:    clean
```

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short
```

`git status --short` is empty even though two new markdown files sit in the worktree root.
That is expected. `.gitignore` line 73 is `/*.md`, so root markdown is **ignored, not
untracked**. Section 3 handles it. Do not treat the empty status as proof the two files
are absent.

---

## 1. What this pass is, and what it is not

**Pass 1 is mechanical.** It touches one production file. Everything else is a comment, a
rename, a `.gitignore` line, or one new test.

The reason for the narrow scope: the file-mode assertion makes the suite fail on any
machine whose umask differs from V's Mac. Until that is gone, every test claim in this
workstream comes from one laptop. Fix that, close the one production gap that three
documents have mis-described, and stop.

**Not in this pass, and not to be started:**

- Test 60 and test 1. Their harness is settled in section 10. Their kickoff is not written.
- Per-role manifest defects. Contract settled in section 10. The bug is latent, not live.
- The `retrieval_terminal_rejected` failure phase. Section 10 records why it is deferred.
- Steps 19 and 21.
- Any deploy, migration, canary, or C0 work.

---

## 2. Grounding. Read these before writing anything.

| File | Why |
|---|---|
| `CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md` sections D7, D9, D12, 4, 6, 7 | the contract this amends |
| `CDMSS-RERANK-TELEMETRY-DECISIONS-13-AUG-2026.md` | the evidence for every ruling |
| `app/api/admin/lvc-judge-aa/route.ts`, whole file | the only production file this pass edits |
| `lib/lvc.ts` lines 60 to 70, 200 to 256, and 660 to 675 | the committed seam, `defaultRecall`, and the `deps.recall` fallback |
| `lib/retrieval-telemetry-core.ts` lines 180 to 215, and 251 to 268 | `RETRIEVAL_ROUTES` and `telemetryContextFor` |
| `app/api/admin/lab-batch/route.ts` lines 38 to 47 | a route minting a context for a helper |
| `lib/__tests__/reconciler-races.test.ts` lines 672 to 737 | the cron pin |
| `lib/__tests__/reconciler-route-artifact.test.ts` whole file | the route pin |
| `lib/__tests__/telemetry-db-stub.ts` whole file, header included | the database seam and its limits |

---

## 3. File contract

### Edit, and only these

```text
.gitignore                                        two added lines, section 3.1
lib/__tests__/reconciler-races.test.ts
lib/__tests__/reconciler-route-artifact.test.ts
lib/__tests__/multi-query-telemetry.test.ts
lib/retrieval-settlement.ts                       comments only
lib/retrieval-telemetry-core.ts                   comments only
lib/__tests__/retrieval-telemetry-transitions.test.ts   comment and message text only
lib/__tests__/retrieval-settlement.test.ts        comment only
app/api/admin/lvc-judge-aa/route.ts               the only production edit
CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md
```

`lib/retrieval-telemetry-failure-store.ts` was on revision 1's list. **It is removed.** See
item 2.

### Create, and only this

```text
lib/__tests__/lvc-telemetry-seam.test.ts          test 42
```

### Add to the commit, unedited

```text
CDMSS-RERANK-TELEMETRY-ADDENDUM-v1-13-AUG-2026.md    this file
CDMSS-RERANK-TELEMETRY-DECISIONS-13-AUG-2026.md      the evidence companion
```

### 3.1 The `.gitignore` edit, which the commit cannot happen without

`.gitignore` line 73 is `/*.md`, and the lines under it are explicit `!` exceptions, one
per document. The file's own comment says the exceptions exist "so that `git add` on them
keeps working". Add two lines to the end of that exception list, matching the existing
form exactly:

```text
!/CDMSS-RERANK-TELEMETRY-ADDENDUM-v1-13-AUG-2026.md
!/CDMSS-RERANK-TELEMETRY-DECISIONS-13-AUG-2026.md
```

Do not use `git add -f`. Do not change any other line of `.gitignore`.

### 3.2 Pins that already cover files on the edit list. Read before writing prose.

Three checks watch files this pass edits. None needs a new baseline. Each can be tripped
by careless wording.

1. **`lib/__tests__/retrieval-telemetry-lifecycle.test.ts:209-218`** reads
   `lib/retrieval-settlement.ts` and filters lines matching `/^(let|var) /`. Do not start
   any new comment line with `let ` or `var ` at column 0.
2. **`lib/__tests__/telemetry-non-exposure.test.ts`** walks `app/` and `lib/` and fails on
   `FROM <telemetry table>` or `JOIN <telemetry table>` outside its `ALLOWED` set.
   **`lib/retrieval-settlement.ts` and `lib/retrieval-telemetry-core.ts` are not in that
   set.** Do not quote a SQL statement in any comment you add to those two files.
3. **`lib/architecture/map.generated.ts`.** See item 4, edit 1. The import form you choose
   decides whether the map changes.

**No hash baseline needs re-computing.** `CRON_BASELINE` covers
`provider-switch-unit-d.test.ts` and `ipd-worker-batch-and-model.test.ts`.
`ROUTE_SHA256` and `ROUTE_GIT_BLOB` cover
`app/api/admin/retrieval-telemetry-reconcile/route.ts`. This pass edits none of the three.
Confirm that yourself and report it. If you find otherwise, stop.

### Do not touch

v11 section 4's "Do not touch" list stands unchanged. In addition:

- **`lib/lvc.ts`.** The seam and `defaultRecall` are built. This pass changes neither.
  `startInvocation` is already called at `lib/lvc.ts:212`. Do not add another.
- **`lib/retrieval-telemetry-failure-store.ts`.** Not edited at all in this pass.
- **Any behaviour in `lib/retrieval-settlement.ts` or `lib/retrieval-telemetry-core.ts`.**
  Comments only. One changed character outside a comment is out of scope.
- **`closeInvocation`.** No retrieval route closes. That is by design.
- **`pair_id`, `replicate`, `experimentRunId`.** All stay null. V has not opened A/A.
- **`lib/sql-guard-core.ts`.** Byte-identical.
- **`lib/architecture/map.generated.ts`.** If it changes, stop and report. Do not commit it.

---

## 4. Item 1. Delete the two file-mode assertions.

### The ruling

Both assertions claim that a mode change makes a different committed object. Git records
only the executable bit. `chmod 640` and `chmod 664` leave the blob and the tree entry
unchanged. `chmod 777` flips the tree entry to `100755`, which `git status` reports on its
own. The assertions protect nothing about the committed artifact and they fail on any
checkout with a different umask.

### The edits

Delete exactly these two lines.

```text
lib/__tests__/reconciler-races.test.ts:718
lib/__tests__/reconciler-route-artifact.test.ts:81
```

**Also correct the comment above each one.** Both currently assert the falsehood this
ruling rejects.

```text
reconciler-races.test.ts:712-713        "a mode change gives the same hash and is not the same committed object"
reconciler-route-artifact.test.ts:74-75 "a mode change hashes the same and is not the same committed object"
```

Rewrite each to say three things: git records only the executable bit, a permission change
that leaves that bit alone is not a change to the committed object, and `git status`
reports the executable bit without a test. Leave the symlink and hard-link sentences
alone. They are still true and still load-bearing.

**Change nothing else in either block.** These must still run.

| check | races, test 64 | route artifact |
|---|---|---|
| symlink | 715 | 78 |
| regular file | 716 | 79 |
| `nlink === 1` | 717 | 80 |
| SHA-256 | 733 | 86 |
| git blob id | not present | 94 |

### Item 1b. Write both re-baseline procedures.

**Route artifact pin**, as a comment in `lib/__tests__/reconciler-route-artifact.test.ts`:

1. Confirm the route change is intended and reviewed.
2. `sha256sum app/api/admin/retrieval-telemetry-reconcile/route.ts`
3. `git hash-object app/api/admin/retrieval-telemetry-reconcile/route.ts`
4. Replace `ROUTE_SHA256` and `ROUTE_GIT_BLOB` in this file.
5. State in the build report what changed in the route and why.

**Cron pin**, as a comment in `lib/__tests__/reconciler-races.test.ts`:

1. Confirm the cron-count edit is the only intended change to the file.
2. Take the file **as it now stands**, replace the authorised line with its historical
   form in memory, and hash the result with SHA-256.
3. Replace `sha256At177adc9`, and `line` if the line number moved.
4. State the change and the reason in the build report.

Add one sentence to that comment: after any edit other than the cron count, the constant
name `sha256At177adc9` stops being true, because the baseline is then the file at the later
commit with one line reverted. Rename it when that happens.

### Item 1c. Fix a stale pointer.

`CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md` line 223 says the route baseline is a
two-line edit in `reconciler-races.test.ts`. Part VII moved it. It is in
`reconciler-route-artifact.test.ts`. Correct that line and say in Part VIII that you did.

---

## 5. Item 2. Finish the D9 wording.

### The ruling, which amends D9

D9 line 559 says three states are reachable only by the reconciler. D9 line 563 says a
revision-0 role is settled from the failure evidence, and the only mapping from that
evidence produces two of the three. The code follows the second half.
`lib/retrieval-settlement.ts:104` calls `reconcilerStateFor('started', …)`, which returns
`telemetry_persistence_failed` or `aborted`.

**D9 is amended to read:**

> `aborted`, `persistence_unknown` and `telemetry_persistence_failed` are produced only
> through `reconcilerStateFor`. Settlement may call that function for a revision-0 run.
> The settlement mapping table itself never names those states.

The code does not change. Only prose changes.

### The four sites. Open each one directly.

**Do not rely on a grep to find them.** Revision 1 of this document supplied a grep that
misses two of them: one because the phrase wraps across a line break, one because of an
escaped apostrophe. Open all four by line number.

```text
lib/retrieval-settlement.ts:92-97                       the FLAGGED docstring becomes a decided one, citing this addendum
lib/retrieval-telemetry-core.ts:869-875                 the docstring above SETTLEMENT_STATE
lib/__tests__/retrieval-telemetry-transitions.test.ts:89   the TEST TITLE
lib/__tests__/retrieval-telemetry-transitions.test.ts:98   the assertion MESSAGE
lib/__tests__/retrieval-settlement.test.ts:69           the comment
```

Then search for any site those five miss. Use a multiline search, because the phrase wraps:

```bash
grep -rn -i "only by the reconciler\|reconciler.s alone\|reconciler-only" --include=*.ts lib app
rg -U -i --multiline "reachable only\s*\n?\s*\*?\s*by the reconciler" lib app
```

Scope is `lib/` and `app/`. Not `scripts/`. Not `docs/`. Not the markdown documents, whose
amendment is item 1c and Part VIII.

### Two things you must not change

1. **`lib/retrieval-telemetry-failure-store.ts:66`** says failure phases are read "ONLY by
   the reconciler". That is a claim about who reads them, not about which states are
   producible, and it is **true**. Leave it. Revision 1 listed this file. That was wrong.
2. **The identifier `reconcilerOnly`** in `retrieval-telemetry-transitions.test.ts`. It
   names the set the assertion tests, and that assertion stays true under the amended
   wording, because `SETTLEMENT_STATE` does not name the three states. Leave it.

**No assertion changes.** If you find a site where the stale claim is load-bearing inside
an assertion rather than in prose, stop and report. That is a finding, not an edit.

### The consequence to record

C0 must not read `aborted` as "written by the reconciler". After this amendment it means
"no terminal manifest was ever written, whoever noticed". Put that sentence in Part VIII.

---

## 6. Item 3. Renumber the test 63 case.

Test 63 is substantively satisfied by `lib/__tests__/multi-query-telemetry.test.ts:110-118`,
which asserts a superset of it. The case title carries no number, so the mechanical count
by title prefix still reports it absent. That is the only reason this item exists.

Rename the case so its title starts with `63 — `. Change nothing else in the file. Keep
both assertions, including the once-only count at line 117, which closes the hole in the
older pin at `lib/__tests__/retrieval-llm-determinism.test.ts:34`.

Nothing pins that title. No test reads the test directory, no script counts titles, no
source-text pin covers the file. Confirm this yourself and report it.

### The counts, on one stated basis

Report on the **mechanical basis**, which counts a requirement as written when a case title
carries its number. State the basis in Part VIII so no later reader has to guess.

```text
at 32f0f79, mechanical      23 written, 50 absent
after item 3               24 written, 49 absent
after test 42              25 written, 48 absent
```

The substantive count at `32f0f79` was already 24 and 49, because test 63's subject was
asserted without its number. Item 3 is what makes the two bases agree. Say that.

Do not preregister an `npm test` total. One requirement can produce several cases.

---

## 7. Item 4. Step 13, which is five edits, not one.

### The correction

Three documents say step 13 is "one `telemetry` argument". The route contains zero
occurrences of the string `telemetry`. `runCase(uid, save, experiment)` receives three
primitives. `req.headers` is never read in the file. The context must be minted in `GET`
and threaded down.

### The five edits, all in `app/api/admin/lvc-judge-aa/route.ts`

**1. Import. One statement, this exact form:**

```ts
import { telemetryContextFor, type TelemetryRequestContext } from '@/lib/retrieval-telemetry-core';
```

**Do not split it into a value import plus a separate `import type`.**
`scripts/lib/import-scan.mjs` marks a standalone `import type` as a type-only edge, and
`app/api` has only a `value` edge to `retrieval-telemetry-core` in the committed map. The
split form adds a new `type` edge and changes `lib/architecture/map.generated.ts`, which is
not on the file contract. The inline form leaves the map untouched.

**2. Mint the context in `GET`,** after line 258:

```ts
const ctx = telemetryContextFor('lvc_judge_aa', req.headers, { labExperimentId: experiment });
```

One context per request. Never module-global. Never per pass.

**3. Widen `runCase` at line 177.** Exactly this signature, with the context last and
required:

```ts
async function runCase(uid: string, save: boolean, experiment: string, ctx: TelemetryRequestContext): Promise<CaseResult>
```

Not optional. Not an options bag. `runCase` has one caller.

**4. Pass it** at line 275, in fourth position:

```ts
results.push(await runCase(item.uid, save, experiment, ctx));
```

**5. Instrument pass 0 only,** at line 191, on the first argument, which is already a fresh
object built by spreading `input`:

```ts
await matchLowValueCare({ ...input, trace: false, telemetry: { ctx, route: 'lvc_judge_aa' } }, {
  judge: async (_ctx, recs) => { … },
});
```

### Why the spread, stated correctly

Revision 1 of this document said a field on `input` "would instrument all three passes".
**That was wrong, and the correction matters because a self-attack was built on it.**

`input.telemetry` is read in exactly one place in the codebase, `lib/lvc.ts:204`, inside
`defaultRecall`. `matchLowValueCare` at `lib/lvc.ts:666` does
`const recall = deps.recall ?? defaultRecall;`. Passes A and B at lines 215 and 216 pass
`pinned = { recall: async () => captured }`, so `defaultRecall` never runs on those arms
and `input.telemetry` is never read there.

**What actually keeps the pinned arms clean is the injected `recall`, not the spread.**

Use the spread anyway. It is defence in depth: if a later change removes the pinned
`recall` injection, a field set on `input` would silently start instrumenting arms that
perform no semantic retrieval, which D7 forbids. Write that reason into the code comment.
Do not write the false reason.

### What you must not add

- **No `startInvocation` call.** `defaultRecall` opens the invocation at `lib/lvc.ts:212`,
  idempotently and fail-open, whenever `input.telemetry` is present. Pass 0 supplies it,
  so pass 0 opens it.
- **No `closeInvocation` call.** No retrieval route closes. Retrieval invocations stay
  `closure_unknown` by design.
- **No edit to `lib/lvc.ts`.**
- **No `pairId`, `replicate` or `experimentRunId` on the declare.**

### Confirm before you write, and report each

1. `lib/lvc.ts:64` declares
   `telemetry?: { ctx: TelemetryRequestContext; route: RetrievalRoute };`. Confirm the
   committed shape. If it differs, match the code and report the difference.
2. `'lvc_judge_aa'` is a member of `RETRIEVAL_ROUTES`. Report the line.
3. `telemetryContextFor`'s first parameter is typed `InvocationRoute`, not
   `RetrievalRoute`. `'lvc_judge_aa'` is in both. Confirm it compiles and report it.

---

## 8. Test 42, in two parts, because v11's wording over-promises

New file `lib/__tests__/lvc-telemetry-seam.test.ts`.

v11 item 42 asks for four things in one test:

> A/A default recall captures with route `lvc_judge_aa`, A/A pinned recall captures
> nothing, the appropriateness route captures with `unknown_route`, and both right-care
> scripts write nothing.

**Two of those four cannot be proved by execution with the harness that exists.** That is
a finding about v11, not a licence to skip them. Build part A by execution, build part B as
source assertions, and report the gap.

### Part A. Proved by execution, against `installDbStub`.

1. A/A pass 0 uses default recall and captures with route `lvc_judge_aa`.
2. A/A pinned passes A and B declare nothing and capture nothing.
3. Exactly one `lvc_recall` row per pass-0 recall. Not two. Not zero.
4. **One context per request.** Assert that one request produces exactly one invocation id
   across all its telemetry writes, and that two requests produce different ids. Do **not**
   assert an id "across the three passes": passes A and B never reach `defaultRecall`, so
   they have no id, and requirement 2 says so. Revision 1 asked for both. It could not have
   both.

### Part B. Source assertions, with the reason stated in the test file.

5. The appropriateness route passes `'unknown_route'`. `app/api/appropriateness/route.ts:69`
   already does this. It cannot be driven end to end here: `POST` runs `matchLowValueCare`
   and `analyzeValue` in a `Promise.all`, `analyzeValue` calls a provider over `fetch`, and
   `installDbStub` replaces `globalThis.fetch` and throws
   `UnsupportedStubTransportError` on any body that is not a Neon query.
6. Both right-care probe scripts write nothing. `scripts/right-care-order-probe.mjs` and
   `scripts/right-care-ground-ab.mjs` cannot be driven from a test: the fixture is
   deliberately uncommitted, the script calls `process.exit(0)`, and it makes live provider
   calls.
7. The route's existing response shape, judge count, resume behaviour and lab writes are
   unchanged. Passes A and B run the real `defaultJudge` with no injection seam, and
   `fetchOpdNoteByUid` reaches Metabase over `fetch`. Assert the unchanged surface from the
   diff, not from a driven request.

Write the reason for each Part B item into the test file as a comment. A reader must be
able to see that these are source assertions **by choice and by constraint**, not by
laziness.

### Attack your own test before you claim it holds

For each attack report whether it succeeded or failed. Report the failures too.

- Delete the route string and pass a different one. Case 1 must fail.
- Return a capture from the pinned arms. Case 3 must fail.
- Mint the context inside `runCase` instead of `GET`. Case 4 must fail.
- Revert the production edit entirely. Every Part A case must fail. If any passes, that
  case is worthless.
- **Move the telemetry field from the line-191 spread onto `input`.** Case 2 will **still
  pass**, because the pinned arms inject `recall` and never reach `defaultRecall`. Report
  that it did not fail, and state in Part VIII what actually protects the pinned arms.
  This attack is here to record a true fact, not to be made to fail.

---

## 9. Gate. All nine, unchanged from v11 section 7.

**Before you stage anything, run this and report it:**

```bash
git status --short lib/architecture/map.generated.ts
```

It must be empty. Gate 6 stages the file before diffing it, so a map change introduced by
gate 5 passes gate 6 and lands staged. That would violate section 12 silently. If the map
is modified, stop and report. Do not commit it.

```bash
npm test                       # 1. all green, state the count
npm run typecheck              # 2. clean
npm run build                  # 3. green
npm run architecture:check     # 4.
npm run architecture:map       # 5.
git add lib/architecture/map.generated.ts && npm run architecture:map \
  && git diff --exit-code lib/architecture/map.generated.ts   # 6. determinism
npm run reasoning:registry \
  && git diff --exit-code data/reasoning-registry/prompts.generated.json  # 7.
npm run reasoning:governance   # 8.
npm run changelog:coverage     # 9. read-only regression gate
```

An unkeyed production build must fail and must name `CDMSS_TELEMETRY_HMAC_KEY`. A keyed
build must succeed. Report both. Command 9 is a read-only regression gate. Do not add a
changelog entry to satisfy it. No engine bump is authorized.

The final test total is **observed and reported, never predeclared**.

---

## 10. Decisions already settled. Do not re-open them.

1. **The file-mode assertion.** Delete. Item 1.
2. **D9's contradiction.** Amend the wording, the code stands. Item 2.
3. **Per-role manifest defects. Settled shape, deferred build.**
   `SettlementInput.outcome` narrows to `Exclude<SettlementOutcome, 'persisted_dirty'>`.
   `SettlementInput` gains an optional role-keyed defects map. `persisted_dirty` is derived
   per run inside the settlement loop. `writeRetrievalTerminals` returns a role-keyed map,
   `[]` for clean roles. Owners pass the map and do not derive the upgrade. A handle holds
   at most one run per role, and that invariant gets a test, because `writeRetrievalTerminal`
   takes the first match by `find` and `advance` advances every match.
   **Known cost:** test 52 in `lib/__tests__/retrieval-telemetry-lifecycle.test.ts` is a
   source-text pin requiring literals such as `outcomeForOwnedSave(s, defects), auditId` in
   five named files. Every one changes. Test 51 also changes. Both need a written reason.
   **Why deferred:** the two-role handle is reached in production only through
   `lib/lab-batch.ts`, which settles with a literal `'no_persistence_intended'`. That never
   reaches `persisted_clean`, so the defect merge is never consulted. The bug is latent. It
   is still wrong and still owed.
4. **The reconciler route change-detector.** Keep it. Procedures in item 1b.
5. **The `lib/sql-guard-core.ts` blocklist.** The three telemetry tables are **not** added.
   The list's criterion is raw clinical text. The manifests carry ids, counts and HMACs.
   `opd_note_audits` is not on the list either, and the requirement is controls no weaker
   than `opd_note_audits`. Report item 23 is amended: this decision is **closed**.
6. **Two gaps in the same guard, logged and out of scope.** `pg_read_binary_file` passes,
   because `FORBIDDEN` matches the substring `pg_read_file` and the longer name does not
   contain it. `pg_catalog` and `information_schema` also pass. A live check found the role
   is `neondb_owner`, not a superuser, and
   `has_function_privilege('pg_read_binary_file(text)', 'execute')` is false. Gap one is
   unreachable. Gap two is reachable and bounded by that role's privileges. Neither is
   fixed here.
7. **`PerRunSettlementResult.status` ratified at three members.** D12 amended. `noop` stays
   `settled`. Deferred detail: make it a discriminated union, so `failed` always carries
   `errorClass`, `rejected` always carries `rejection`, and `settled` carries neither.
8. **The rejected terminal write. Deferred, contract incomplete.**
   Settled: replace the `console.warn` at `lib/retrieval-telemetry-store.ts:331` with
   durable evidence naming its own phase.
   Not settled, and blocking: `reconcilerStateFor` at `lib/retrieval-telemetry-core.ts:930`
   tests membership of `'retrieval_terminal'` exactly, so a new sibling phase would
   reconcile as if there were no evidence at all. Also `opd_rtf_phase_chk` and
   `opd_rtf_run_chk` are inline in `CREATE TABLE IF NOT EXISTS` with no DROP and ADD pair,
   and the parity test compares CHECK values set-for-set against the hand-typed `.sql`. The
   table has never been created in production, so adding the phase **before** the first
   migration run avoids the constraint problem entirely. **Do not add the phase now.**
9. **Test 60's harness.** Settled: run the real `retrieve` against `installDbStub`, and the
   real `rerankJudge` against a local HTTP stand-in, on the pattern in
   `lib/__tests__/vertex-primary-ladder.test.ts`. Reason: `retrieve`, `rerankJudge` and
   `expandQuery` have no injection parameter at all, and `retrieve` calls `rerank` with a
   hardcoded `undefined` for deps at `lib/retrieve.ts:589`. A test built only on
   `MultiQueryDeps` and `RerankDeps` replaces every one of those with a stub and proves
   nothing about batch boundaries or prompts.
   **Kickoff wording amended:** test 60 says "identical injected dependencies on both
   sides". For three of the six functions there is no parameter to hold a dependency. It is
   amended to "an identical environment on both sides: the same database stub, the same
   provider stand-in, and the same options object".
   **Known trap for that pass:** judge batches run in `Promise.all`, so the stand-in must
   key responses on request body, and `capture.batches` is pushed in completion order and
   sorted only later in `buildRetrievalPayload`.
10. **The migration ordering.** The migration route and the key guard exist only on this
    branch. `CDMSS_TELEMETRY_HMAC_KEY` in Vercel Production, then deploy, then run the
    migration, then read the response. The legacy-data policy is needed only on a 409.

---

## 11. Report. A new Part VIII.

`CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md` is ordered **newest first**. Part VII
starts at line 23, under a summary header at lines 1 to 22. **Insert Part VIII directly
above Part VII, and update the summary header to name it.** Do not append at end of file.

Part VIII must contain:

1. The parent SHA, the new SHA, and the SHA-256 of this addendum.
2. All nine gate results, with the observed test count, plus the pre-gate map check.
3. Each of the four items, what changed, and the file and line of every edit.
4. Every search you ran for item 2, its full output, and the four sites you opened
   directly. State plainly that you did not rely on a grep.
5. Every attack you ran on test 42, **including the ones that failed to break it**, and
   the `input`-versus-spread finding in particular.
6. The confirmation from section 3.2 that no hash baseline needed re-computing, and that
   nothing pins the renamed test title.
7. The corrected counts from item 3, and the basis you counted on.
8. The three confirmations from item 4, with line numbers.
9. The C0 sentence about `aborted` from item 2.
10. Part A and Part B of test 42, with the reason each Part B item is a source assertion.
    State plainly that v11's item 42 asks for two things this harness cannot execute.
11. **Amendment to report item 23.** The `lib/sql-guard-core.ts` blocklist decision is
    closed: the telemetry tables are not added. The two guard gaps are logged and out of
    scope, with the privilege result from section 10 ruling 6.
12. The `.gitignore` change and why it was needed.
13. Anything flagged rather than decided, and any defect found and left alone.

State plainly that nothing was deployed, no migration was run, and no production database
was touched.

---

## 12. Commit contract

```text
one scoped commit
parent exactly 32f0f79183592b804988113a36b042a8f0458f84
no amend
no rebase
no push
no git add -f
git status --short clean at the end
git diff --cached --name-only empty at the end
git show --stat contains only the files section 3 authorizes
```

**Do not push. V pushes.**

---

## 13. Flag, do not improvise

If this addendum and the v11 kickoff together do not settle something, put it in the report
and leave the code alone. A defect found on the way goes in the list and stays there.

Attack your own tests before you claim they hold. Report the attacks that failed as well as
those that worked. On 12 August that one instruction took a pass from six correction cycles
to one.

The engine is frozen. This pass changes no ranking behaviour and does not consume the
remediation lift. Do not deploy. Do not target a canary. Do not start C0.

---

## 14. What the attack on revision 1 found

An agent was told to break revision 1, not to review it. Six defects, all corrected above.
They belong in the errata register.

| # | Defect | Fixed in |
|---|---|---|
| 1 | `.gitignore` line 73 is `/*.md`, so both new documents are ignored, not untracked. The commit contract could not execute | section 3.1 |
| 2 | Item 4's trap reasoning was false. `input.telemetry` is read only in `defaultRecall`, which the pinned arms never reach, so a field on `input` would not instrument them. A mandated self-attack was built on the false premise and would have returned "did not fail" | item 4, section 8 |
| 3 | Item 2's grep missed two of its own five named sites, one to a line wrap and one to case. It also missed a test title with an escaped apostrophe | item 2 |
| 4 | `lib/retrieval-telemetry-failure-store.ts:66` was listed for correction. Its claim is about who reads failure phases and it is true | item 2, file contract |
| 5 | Test 42 requirement 4 asked for one invocation id across three passes while requirement 2 said two of the three have none. Requirements 5, 6 and 7 are not executable with the harness that exists | section 8 |
| 6 | The test counts contradicted themselves and the companion document, because two counting bases were mixed | item 3 |

Three further hazards the attack surfaced, now written into the document: the
`^(let|var) ` scan and the non-exposure walk both cover edited files, the import form
decides whether `map.generated.ts` changes, and gate 6 cannot fail because it stages before
it diffs.

Everything else held: every file path and line number, the surviving-checks table, the
rename safety, the seam shape and route membership, the `startInvocation` and
`closeInvocation` ruling, the database-stub install instruction, all nine gate scripts, and
the comparison against v11's do-not-touch list.
