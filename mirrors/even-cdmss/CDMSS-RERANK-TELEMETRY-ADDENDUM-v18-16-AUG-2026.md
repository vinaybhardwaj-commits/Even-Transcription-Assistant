# CDMSS rerank telemetry — Addendum v18. The pass 2 proof repairs

Date: 16 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `d69a11d7c57c18157b371b9079ffd2a00f466ce6`
Authority: **Saul review 29.**

---

## 0. Signature

```text
STATUS: SIGNED by V, 16 August 2026
```

**This section contains exactly one `STATUS:` line, and it is the one above.**
Read it. Do not grep for it.

Only V changes this line. If it does not name V, the builder stops and reports.

V gave this signature in the orchestration thread on 16 August 2026, over these
bytes. The orchestrator typed the line on that instruction.

---

## 1. What review 29 ruled

### 1.1 Closed

**Proof 17. Judge proof J3. Judge proof J4**, with the arm-count assertion as a
follow-up carried into this addendum.

```text
hard proofs closed     3 of 20     11, 12, 17
judge proofs closed    2 of 4      J3, J4
```

### 1.2 Held

**Proofs 2, 16, 18, 70. Judge proofs J1, J2.** Section 3 carries the repair for
each.

### 1.3 Ratified

- The four forward-only commits, and addenda v16 and v17, retrospectively.
- The governance-only ungated-tip exception. Commit 2 carries the evidence of the
  gate and cannot itself be gated. That is a permanent property of the shape.
- Existing casts and non-null assertions in commit 1 are non-blocking.
- Mutation-before-gate, from pass 3 onward.

### 1.4 Resolved

**Review 28's "base-to-commit production byte comparison" is defined as the
repository production-path diff, and that condition passed.** Addendum v15
section 4.3 declined it as undefined. It is now defined and satisfied. The
decline is withdrawn.

### 1.5 New requirements

- **`git add` is removed from future command 6 protocols.** Section 4.1 states
  the replacement.
- **Exact proof quotations and command transcripts are required** in supplemental
  evidence.

---

## 2. Scope. Two commits

```text
5  the corrective implementation commit   four test paths   this addendum
6  the supplemental evidence commit       evidence, report, governance
```

Pass 2 reaches six commits. Commits 1 to 4 stand. Do not amend, revert, squash or
rebase any of them.

### 2.1 The corrective implementation commit changes exactly these four paths

```text
lib/__tests__/judge-server-stub.ts
lib/__tests__/explicit-judge-equivalence.test.ts
lib/__tests__/rerank-pass-2.test.ts
lib/__tests__/explicit-judge-retrieve.test.ts
```

No production source changes **in the worktree**. No fifth path.

⚠️ The mutation sandbox of v15 section 7.3 is exempt, as it was in v17. Six of
the mutation rows in section 5 edit production files inside that copy. The
worktree copies are never edited.

### 2.2 The supplemental evidence commit changes exactly these five paths

```text
.gitignore
CDMSS-SAUL-REVIEW-29-16-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v18-16-AUG-2026.md
CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md
CDMSS-PROOF-PASS-2-SUPPLEMENTAL-REPORT-FOR-SAUL-16-AUG-2026.md
```

Four negation lines. The existing pass 2 evidence file and report are **not**
edited. The supplemental documents are new files.

---

## 3. The seven repairs, and one follow-up

Sections 3.1 to 3.7 are the seven blocking findings. Section 3.8 is the J4
arm-count follow-up, which review 29 carried alongside a closure.

Each states the defect, then the mechanism, grounded in the code at `d69a11d`.

### 3.1 Proofs 16 and 70. Real manifest validation, not a stipulated list

**Defect.** Both tests supply `verdictForRun({ primary: [] }, 'primary', true)`.
The defect list is stipulated. Proof 70.3 additionally computes real defects,
filters one, then discards the result and supplies `{ primary: [] }` anyway. That
is state mapping without validation, and addendum v15 section 4.4 required both.

**Mechanism.** Call the real validator and feed its output.

```text
validateManifest(input: unknown): string[]      lib/retrieval-telemetry-core.ts
```

One positional argument. It returns a plain array of defect codes, and
`['manifest_absent']` when the input is not an object.

The input is the built payload **plus** the operational block, exactly as
production assembles it in `lib/opd-note-audit.ts`, in `finaliseTelemetry`:

```ts
defectsByRole.primary = validateManifest({ ...primaryPayload, operational: primaryOperational });
```

Then feed that array through the real chain.

```ts
const defects = validateManifest({ ...payload, operational });
const verdict = verdictForRun({ primary: defects }, 'primary', true);
const outcome = upgradeForDefects(outcomeForSaveResult('inserted'), verdict);
assert.equal(stateForSettlement(outcome), /* clean or partial, see below */);
```

⚠️ **`{ primary: [] }` is not a stipulation-free stand-in.** `verdictForRun` uses
an own-key test. A provided map missing an own key for a linkable role returns
`MISSING_ROLE_VERDICT`, so the key must be present and its value must be what
`validateManifest` actually returned. Never write `?? {}`.

### 3.1a The fixture is incomplete, and that is why the filter existed

The current fixtures are built by `createTelemetryCapture` and never pass through
`retrieve()`, so `indexVersion` stays null. Real `validateManifest` therefore
returns `['index_version_absent']` on them. That is a genuine defect code, it
drives `upgradeForDefects` to `persisted_dirty`, and `stateForSettlement` maps
that to `persisted_partial`.

**So feeding real output into the current fixture makes `persisted_complete`
unreachable.** That is why proof 70.3 filtered the code out. The filter was the
symptom. The fixture is the defect.

**Set `indexVersion` in the fixture** to a realistic value, so the manifest is
clean because it is complete, not because a code was removed. A fixture that does
not look like production hides real behavior.

Neither test may filter, mask, or subtract any defect code. If any code other
than `index_version_absent` appears, stop and report.

### 3.1b Both directions, or the guard is one-sided

A test that only ever sees an empty defect list cannot tell real validation from
a stub that always returns empty.

Each of proofs 16 and 70 asserts **two arms** through the same real chain:

```text
clean arm   indexVersion set, validateManifest returns []
            → verdict []   → persisted_complete
dirty arm   one field deliberately broken in the payload
            → validateManifest returns a non-empty array
            → verdict non-empty → persisted_partial
```

Assert the actual array contents on both arms, not just its length. The dirty arm
is what makes mutation row 23 able to discriminate.

### 3.2 J1. The comparator must preserve method, path and body as one tuple

**Defect.** `sameWireObservations` in `judge-server-stub.ts` groups bodies by
marker set and compares method and path **separately**, as a global sorted
multiset. Two observations can swap their method or path between marker groups
and still compare equal. Test 5.9 mutates only a body, so nothing guards it.

**Mechanism.** Make the group value the tuple, not the body.

Key stays the marker set. Value becomes a single Buffer built as
`method` + `path` + a NUL byte + `body`. Sort within each group with
`Buffer.compare`. Delete the separate method-path multiset entirely.

⚠️ **Change `sameWireObservations` only. Do not change `groupByMarkerSet`.** Two
existing tests assert on that helper's output as body bytes, and they would break.
Build the tuple inside the comparator.

⚠️ Compare with `Buffer.compare`, not string comparison on UTF-8. Bodies may hold
lone surrogates and a string compare is not byte-exact.

Add a test that swaps the path between two marker groups and shows the comparator
reports a difference. Without it the repair is unguarded.

### 3.3 Proof 18. The Cohere arm must run the real `rerankCohere`

**Defect.** The Cohere arm uses a fake `cohereFn` that writes `servedBackend` and
`expectedBatchCount`, then asserts those values. The test asserts what the fake
wrote.

**Mechanism.** Delegate to the real function with an injected fetch.

```ts
rerankCohere(query, candidates, fetchImpl, recordCost, capture)
//                              ^ position 3
```

The injected fetch returns:

```ts
new Response(JSON.stringify({
  results: docs.map((_, i) => ({ index: i, relevance_score: /* … */ })),
  usage: { cost: 0.001 },
}), { status: 200 })
```

Pass `async () => {}` as `recordCost` so no cost sink is touched.

⚠️ `OPENROUTER_API_KEY` must be **set before the call and restored in a
`finally`**. Without it the function throws `RerankBackendUnreachable` before it
ever calls fetch. Status 404 gives `RerankBackendMissing`.

The same file already does this correctly in the proof 2 arm, which saves the
previous value and either deletes or restores it. Use that shape.

### 3.4 Proof 2.2. The discriminator is invalid

**Defect.** The test claims that passing the capture as `fetchImpl` would surface
a `TypeError`. It would not. `cohereRelevanceScores` wraps **any** error from the
fetch call:

```ts
} catch (e) {
  throw new RerankBackendUnreachable('cohere', RERANK_API_MODEL, String((e as Error).message).slice(0, 140));
}
```

So `instanceof RerankBackendUnreachable` is true in both the correct and the
swapped case. It discriminates nothing.

**Mechanism.** Two assertions together.

1. On the failure variant, assert the wrapped message does **not** match
   `/is not a function/`. That is what a capture-in-the-fetch-slot would produce
   inside the wrap.
2. On a success variant with `deps.cohereFn` **omitted**, so the default adapter
   runs, assert `capture.servedBackend === 'cohere'` and
   `capture.batches.length === 1`. If the capture had gone into the fetch slot,
   `rerankCohere` never reaches its `if (capture)` block and both stay untouched.

⚠️ **There is no seam to inject a fetch through the default adapter.** It is
`rerankCohere(q, c, undefined, undefined, cap)`, so `fetchImpl` is fixed
`undefined` and `rerankCohere`'s default parameter resolves the global at call
time. The success variant must therefore **replace `globalThis.fetch` for the
duration of the call and restore it in a `finally`**.

That is safe here: the connection guard patches `net.Socket.prototype.connect`,
not fetch, so a replaced global fetch dials nothing. Restore it unconditionally.

**Keep** the existing source-text check. Relabel it in a comment as a source pin.
It is not a behavioral discriminator and must not be described as one, in a test
name, a comment, or the report.

### 3.5 Proof 70. Observe the order during the call, not after it

**Defect.** The test records `judge:served` after `rerank()` returns and infers
the judge from a snapshot length. Bookkeeping after the fact cannot prove that
judge acceptance followed the health failure.

**Mechanism.** Both collaborators are injectable on `RerankDeps`. Give both a
shared ordered log and have each push at the moment it is invoked.

```ts
const order: string[] = [];
const deps = {
  envBackend: 'cohere' as const,
  checkHealthy: async () => { order.push('checkHealthy'); throw new RerankBackendUnreachable(/* … */); },
  judgeFn: async (q, c, cap) => { order.push('judgeFn'); return realJudge(q, c, cap); },
};
// …
assert.deepEqual(order, ['checkHealthy', 'judgeFn']);
```

⚠️ **The backend argument to `rerank()` must be `undefined`.** The branch is
`const explicit = backend !== undefined;` then
`if (chosen === 'cohere' && !explicit)`. Passing `'cohere'` explicitly takes the
strict arm, which never downgrades, and proof 70 would test the wrong path.

⚠️ Call `_resetRerankHealth()` before the call and restore health state in
`finally`. A passing probe is memoized for ten minutes and would skip the
downgrade.

⚠️ An inline arrow assigned to `RerankDeps['judgeFn']` may not typecheck without
an explicit annotation, and casts are forbidden. Annotate the parameters rather
than casting the function.

### 3.6 J2. The hostile-default failure arms must prove the failure happened

**Defect.** Both arms assert only that the Cohere counters are zero. Neither
proves the named failure occurred, so an arm that silently succeeded would pass.

**Mechanism.** Pin the outcome on each arm.

Real batch parse failure, with the real `rerankJudge` and
`judge.setRawContent(() => 'not json')`:

```text
capture.servedBackend         'judge'
capture.rerankSoftFailed      false
every batch outcome           'parse_failure'
evidence                      non-null, real servedProvider and servedModel
finiteScoreKeys               0
missingScoreKeys              the slice length
promptTokens, completionTokens  numeric, a completion arrived
```

Generic outer judge failure, with an injected `judgeFn` that throws:

```text
capture.rerankSoftFailed      true
every batch outcome           'terminal_failure'
evidence                      servedProvider null, servedModel null,
                              attempts null, provenNotServed false
promptTokens, completionTokens  null
result rows                   rerank_backend === 'none'
```

Also assert a nonzero judge-call count on each arm, so a zero-Cohere pass cannot
be a no-call pass.

⚠️ **The two arms count the judge differently.** The parse-failure arm runs the
real `rerankJudge`, so no `judgeFn` is injected and the injected counters cannot
see it. Count that arm from the stub's recorded request list. The generic-failure
arm injects `judgeFn`, so its counter works.

⚠️ Both arms currently discard the capture. They must keep it to assert any of
the above.

### 3.7 The recorder guards

**3.7a Socket reuse.** The current test issues another request. That does not
prove the same undestroyed socket carried both.

`req.socket` is live at the hook point. Record a socket identity through a
module-level `WeakMap<net.Socket, number>` and a counter, assigned at acceptance
beside `seq`. Two observations with different `seq` and the same socket identity
prove reuse.

⚠️ This adds a field to the observation. **Addendum v15 section 5.3 is amended**
to permit one optional socket-identity field, recorded only while socket
recording is enabled. `JudgeRequest` still gains no field, so section 5.11 is
untouched.

⚠️ **Test 5.3 asserts the exact observation field set with a `deepEqual` on
`Object.keys`.** A sixth field breaks it. Update that expected list in the same
commit. Do not leave it failing and do not delete the assertion.

**3.7b Exhaustive own keys.** Replace `Object.keys` with `Reflect.ownKeys` at
**all four sites**: the two regex loops **and** the two exhaustive field-set
`deepEqual` checks. `Object.keys` sees only enumerable string keys, so a
non-enumerable or symbol-keyed field passes both.

Replacing only the regex loops leaves the actual hole open, because the field-set
comparison is what would notice an extra key at all.

⚠️ Wrap each key in `String(k)` before any regex. A symbol throws on implicit
string coercion. `deepEqual` on a key list containing symbols needs the same
treatment.

**3.7c The timing assumption in 5.4.** Replace
`await new Promise((r) => setTimeout(r, 30));` with a deterministic acceptance
signal. The stub exposes a per-request acceptance hook, or the test awaits the
server's first `data` event for `/v1/a`, and only then sends B. `seq` is assigned
at acceptance, so awaiting acceptance removes the race rather than hiding it.

State in a comment that the previous version carried an unacknowledged 30
millisecond assumption.

### 3.8 J4's follow-up. The arm count

This is not a recorder guard and it was not a blocking finding. Review 29 closed
J4 and carried the arm count as a follow-up. It is repaired here because the file
is open.

`retrieveMultiQuery` builds `allQueries = [expandedQuery, ...variants]`. With the
test's two deterministic variants there are **three** arms.

⚠️ In the current test, `armCaptures` **is** the collection its own `retrieveFn`
pushes to, so its length counts calls. The production array is
`capture.children`, assigned inside `retrieveMultiQuery`.

Assert both, and say in a comment which is which:

```ts
assert.equal(armCaptures.length, 3);        // calls observed at the seam
assert.equal(capture.children.length, 3);   // the array production built
```

---

## 4. Amendments to addendum v15

### 4.1 Command 6 loses `git add`

Review 29 removes `git add` from future command 6 protocols. It was the one
mutating git command inside the gate.

The replacement proves both properties with no git write:

```bash
npm run architecture:map
cp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"
npm run architecture:map
cmp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"
git diff --exit-code -- lib/architecture/map.generated.ts
```

`cmp` proves generation two equals generation one, which is determinism.
`git diff --exit-code` proves the committed map is current. Both must exit zero,
as must both generator runs. That is five commands, all exiting zero.

⚠️ **This replacement is the orchestrator's construction.** Review 29 said to
remove `git add` and did not name a replacement. Saul rules on it. It is
disclosed in section 8.

The preconditions in v15 section 6.2 are unchanged.

### 4.2 The observation may carry a socket identity

Addendum v15 section 5.3 is amended per section 3.7a. One optional field,
recorded only while socket recording is enabled.

### 4.3 The mutation table runs before the gate, here

Review 29 approved mutation-before-gate from pass 3 onward, and its repair plan
applies it to this corrective. This addendum adopts it now.

Order: write the repairs, `npm run typecheck`, `npm test`, run the **complete**
mutation table, repair anything it finds, then commit, then run the gate once.

---

## 5. The mutation table

**Run all twenty-two existing rows**, not a subset. Row 5 was never re-run after
test 5.4 changed in `9344cdb`, and the report claimed otherwise. That was an
error in addendum v17 section 4, which named five rows to re-run and should have
named six.

Then add **eight new rows**. Each must fail its named test, by name.

| # | Mutate | Must fail |
|---|---|---|
| 23 | `validateManifest` returns `[]` unconditionally | the **dirty arm** of proofs 16 and 70 |
| 24 | `sameWireObservations` drops `path` from the tuple | the new J1 path-swap test |
| 25 | `rerankCohere` stamps `expectedBatchCount = 2` | proof 18's Cohere arm |
| 26 | the default adapter passes the capture as `fetchImpl` | proof 2.2 |
| 27 | the parse-failure path records `success` | J2's parse-failure arm |
| 28 | each request is given a fresh socket identity | the socket-reuse test |
| 29 | a symbol-keyed field whose description matches the header regex | the no-headers check |
| 30 | `allQueries` drops one variant | J4's arm count |

**Thirty rows.** Build a fresh sandbox, verify its shape, delete it after.

Three notes on the design.

- **Row 23 only discriminates against the dirty arm.** A clean fixture makes
  `validateManifest` return `[]` legitimately, so the mutation is invisible there.
  That is why section 3.1b requires both arms.
- **No row is added for proof 70's order assertion.** Existing row 17 already
  mutates the env-default arm to call the judge before the probe, and it names
  70.1, which is where the order assertion now lives. Re-running row 17 covers it.
- **Row 29's symbol needs a description that the no-headers regex matches.** A
  symbol with a neutral description trips nothing even after the `Reflect.ownKeys`
  repair, so the row would not discriminate.

**Record the exact mutation diff and the exact command for every row.** Review 29
found the committed mutation evidence unreproducible without them.

---

## 6. The gate

Nine numbered commands and the build pair, as addendum v15 section 6 states, with
command 6 replaced per section 4.1.

**Command 7 must be recorded with its quotes.** This has now failed twice.

```bash
bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'
```

Record the command line exactly as executed, including the single quotes. If the
capture mechanism strips them, capture it a different way and say how.

Run the numbered commands strictly in order and **do not start a later command
until the previous one has exited**. During the aborted gate at commit 1,
commands 3 to 5 had already started when command 2 failed.

---

## 7. Pass 1. A narrow retrospective sweep, not in this pass

Review 29 requires a retrospective proof 11 mutation sweep **before pass 1 is
relied on for deployment**.

Two named defects to test for:

- **Proof 11.7 derives valid inputs from the production constant.** Same class as
  pass 2's row 1.
- **Proof 11.3 proves syntax rather than executable success writes.**

Proof 12's fixtures are behaviorally independent. Its sweep is optional.

**This is not part of pass 2.** It needs its own authorization and its own
kickoff. It is recorded here so it is not lost.

---

## 8. Disclosed to Saul

1. **The command 6 replacement in section 4.1 is the orchestrator's
   construction.** Review 29 removed `git add` and named no replacement.
2. **Addendum v17 section 4 named five rows to re-run and should have named
   six.** Row 5 names test 5.4, which the sweep changed. The orchestrator wrote
   that section and missed it, then verified the pass without catching it.
3. **The orchestrator's pre-push verification checked topology, paths, secrets
   and compliance, and did not read the tests for validity.** Review 29's seven
   blocking findings were all reachable by reading the tests. The verification
   brief was wrong in kind, not in execution. Future verification must include an
   adversarial read of what each test actually proves.

---

## 9. What this addendum does not do

- It does not authorize any production source change.
- It does not authorize any path outside sections 2.1 and 2.2.
- It does not amend, revert, squash or rebase commits 1 to 4.
- It does not begin the pass 1 retrospective sweep.
- It does not begin pass 3.
- It does not close any proof. Saul closes proofs.
