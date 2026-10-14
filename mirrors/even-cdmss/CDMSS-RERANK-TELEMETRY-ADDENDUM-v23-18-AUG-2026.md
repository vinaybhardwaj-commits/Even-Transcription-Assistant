# CDMSS rerank telemetry — Addendum v23. Pass 3

Date: 18 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `01c2375`
Authority: **Saul review 34**, which closed pass 2 and released pass 3 for its
own prospective signed authorization.

---

## 0. Authorization

```text
STATUS: AUTHORIZED by the orchestrator on V's explicit delegation, 18 August 2026
```

### 0.1 The digest ritual is withdrawn

Addenda v20, v21 and v22 required V to approve a SHA-256 digest before signing.
**That process is withdrawn from this addendum forward.**

It existed because the orchestrator signed addendum v19 without V's act, was
caught by Saul review 32, and then built a verification ritual that made V carry
the remedy for the orchestrator's failure. Saul review 31 had said plainly that
explicit verbal approval was enough and that no cryptographic process was needed.
The orchestrator built one anyway. V then had to type digests three times, twice
naming the wrong hex string because the orchestrator had shown him more than one.

A 64-character hash is not something a reader can inspect. Asking a person to
attest to one is a ceremony, not a control.

### 0.2 What replaces it

V said, in the orchestration thread on 18 August 2026:

> do it

in direct answer to the orchestrator's proposal to "hand pass 3 to the builder on
my authority with Saul reviewing after, no signature from you."

So: **the orchestrator authorizes this pass. Saul reviews it after the fact, as
he has reviewed every pass.** V's delegation is recorded above in his own words,
not paraphrased.

### 0.3 The control that remains

Saul is the control. He has rejected orchestrator work in reviews 25, 26, 28, 29,
30, 31, 32 and 33, including two authorization failures the orchestrator did not
catch itself. That record is the reason this delegation is safe enough to act on,
and it is a stronger control than a hash V cannot read.

**If Saul rules that pass 3 needed V's own signature, this pass is the one to
revisit.** Commits 1 to 12 are unaffected.

---

## 1. State

```text
HEAD                 01c2375
pass 2               CLOSED by Saul review 34
hard proofs closed   7 of 20     11, 12, 17, 2, 16, 18, 70
judge proofs closed  4 of 4
test count           3217
deployed             nothing
migrated             nothing
```

---

## 2. Scope

Proofs **35, 45, 46, 47, 49, 56**.

Closing all six brings hard proofs to **13 of 20**. Pass 4 carries 21, 22, 23 and
24. Pass 5 carries 10, 14 and 44.

---

## 3. Pass 3 is not test-only. Read this before anything else

Every pass since pass 1 has been test-only. **Pass 3 is not.**

Addendum v11 section 6 prospectively authorized two D16 payload corrections and
pinned them here:

> ## 6. Prospectively authorised. The two D16 payload corrections.
>
> Both are durable telemetry changes. Neither affects ranking or provider
> behaviour. **Both land in pass 3, before proof 35, not before.**

> **6.1 A skipped stage records `attempts: []`, not `null`.** Today
> `lib/retrieval-capture.ts:309` emits `null` when `expansionSkipped`, and
> `manifestAttempts` itself returns `null` for absent evidence at `:122-123`.

> **6.2 A variant-generation stage that ran and failed without transport proof
> records `unattributed`.** Today `lib/retrieval-capture.ts:364` reads
> `vg && ev ? servedClassOf(ev) : null`, and `ev` is null on that path because
> `evidenceFromError` returns null without attribution. So a stage that genuinely
> ran is recorded identically to a stage that never ran. **Only a stage that did
> not run records stage-level `null`.**

So `lib/retrieval-capture.ts` **changes in the worktree**, and it changes **before
proof 35 is written**. That ordering is v11's, not this addendum's.

The line numbers above are v11's and have rotted. **Locate both sites by symbol
and behavior, not by line.** Quote what you found and what you changed.

### 3.1 What this does and does not permit

Permitted: exactly the two corrections above, in `lib/retrieval-capture.ts`.

Not permitted: any other production change; any change to ranking, provider
selection, fallback order, or backend resolution; any change to
`lib/rerank.ts`, `lib/retrieve.ts`, `lib/multi-query.ts`, `lib/llm.ts` or
`lib/trace.ts`.

Both corrections are **durable telemetry shape changes**. Neither affects what a
doctor sees or which model reads evidence.

---

## 4. The six proofs, verbatim

From kickoff v11, the numbering authority for tests 1 to 73. Flat ordered list,
arabic numeral, period, one space.

> 35. Every row of the D16 stage mapping table, including `parse_failure` preserving provider, model, attempts and token usage, and `failed_open` mapping to `unattributed` without proof.

> 45. Every required field in D17, one absent-or-invalid test each, with own-property checks distinguishing missing, null, empty array, empty string and invalid number.

> 46. `expansion.served_route_class` null with status `skipped` is valid, so a `normative_channel` row is not partial.

> 47. The scorer-context HMAC by role: required on `primary`, null on the other four, and those nulls not partial. Computed over the exact `citedContext`, including the empty-string case.

> 49. All four edge cases in D17, including the two zero-candidate shapes producing different `fused_candidate_count` and `hydrated_candidate_count`.

> 56. Recursive canonicalization, nested-key permutation, JSONB round trip, array reorder not equal, undefined array element rejected.

**Confirm these against kickoff v11 before writing.** Compare the words, ignoring
emphasis and wrapping. Do not cite a line number for any proof.

---

## 5. D16 row 6 is dead text. Two signed amendments govern

Proof 35 tests "every row of the D16 stage mapping table". **Row 6 as written is
superseded and must not be built from.**

Row 6, as the kickoff writes it:

```text
Cohere entered and soft-failed        one synthesised batch record per planned boundary,
                                      each outcome 'terminal_failure',
                                      served_route_class 'not_served',
                                      rerank_not_served_batches += that count,
                                      rerank_soft_failed = true
```

Addendum v7 section 6:

> **Decision. The proof rule governs. A generic Cohere failure without transport
> proof records `unattributed`, never an inferred `not_served`.**
>
> D16's mapping table is amended to that extent and only that extent. Where
> transport proof exists, `not_served` stands.

Addendum v8 section 2:

> **Ruling. The same rule governs both arms. A generic judge failure without
> transport proof records `provenNotServed: false`, and its class is
> `unattributed`.**
>
> Where transport proof exists, `not_served` stands and is unchanged, on either
> arm.

**Build proof 35 from the amendments.** Row 6's `not_served` survives only where
transport proof exists. v7 governs the Cohere arm, v8 extends the identical rule
to the judge arm, and both are signed.

This is the same trap addendum v14 named for pass 2 and it has not been removed
from the kickoff, because kickoffs are not edited after the fact.

---

## 6. Two test files the code claims exist and never has

`lib/__tests__/retrieval-telemetry-core.test.ts` carries this header:

> // Exhaustive per-field validation lives in retrieval-telemetry-validation.test.ts, transitions in
> // retrieval-telemetry-transitions.test.ts, canonicalization in
> // retrieval-telemetry-canonicalization.test.ts. This file owns the vocabulary, the HMAC, the
> // counters, the cost aggregation and the privacy pin.

`retrieval-telemetry-transitions.test.ts` exists. The other two **have never
existed**, on disk or in any commit.

Pass 3 creates both:

```text
lib/__tests__/retrieval-telemetry-validation.test.ts        proofs 45, 46, 47, 49
lib/__tests__/retrieval-telemetry-canonicalization.test.ts  proof 56
```

The header becomes true rather than aspirational. **Do not edit the header** —
creating the files is the correction.

---

## 7. Existing coverage, and why titles matter

The 11 August build report section 12 records proof **35 written and green**, **45
written but partial**, **46 written and green**, and **47, 49 and 56 absent**.

But **none of the six is discoverable by title today.** Only pass 1 and pass 2
proofs use the numbered-title convention. A functional test that nobody can find
by proof number is not evidence a reviewer can check.

So pass 3 does two different jobs:

1. **Consolidate and retitle** the existing coverage for 35, 45 and 46 to the
   `'<proof>.<n> — <sentence>'` convention, and complete 45, which is partial.
2. **Write 47, 49 and 56 from scratch.**

Say in the report which tests were pre-existing, which were retitled, which were
completed, and which are new. A retitled test is not a new proof and must not be
reported as one.

---

## 8. Review 34's debt condition is not triggered

Review 34: complete bounded-settlement hardening "before the next mutation
campaign that can deliberately leak recorder accounting."

**Pass 3's campaign cannot.** The recorder — `inFlight()`, `settled()`,
`setRecording`, `resetObservations` — lives in `lib/__tests__/judge-server-stub.ts`
and is imported only by pass 2 and pre-existing work. All six pass 3 proofs are
retrieval-telemetry and manifest concerns: proof 35 is the D16 stage mapping in
`lib/retrieval-capture.ts`; 45, 46, 47 and 49 are `validateManifest` and D17 field
semantics in `lib/retrieval-telemetry-core.ts`; 56 is `canonicalJson`. None issues
an outbound judge request and none can move `inFlight`.

**The sixteen unbounded waits stay untouched debt and pass 3 proceeds without the
hardening.**

⚠️ **One guardrail.** Pass 3's mutation table must contain **no mutation that
alters judge request lifecycle or recorder counting**. A mutation reaching
`lib/rerank.ts` or `lib/multi-query.ts` would execute judge-stub-importing tests
as collateral and could trigger the condition. State in the report that no row
does this.

---

## 9. The mutation table

Runs **before** the gate, per review 30 and the practice since v18.

At minimum, one discriminating row per proof — 35, 45, 46, 47, 49, 56 — plus one
each for the two payload corrections in section 3. Eight rows minimum. The
kickoff carries the exact rows, diffs and named targets.

Every row fails its named test **by name**. A file-level timeout is not a pass.
Record each row's exact unified diff, exact command and exit status. Prove the
tested bytes equal the committed bytes with the four-hash check.

⚠️ **Do not derive any fixture input from the constant it tests.** That defect was
found in pass 2 row 1 and again in the boundary literals. State sizes and values
as literals.

---

## 10. Commits

```text
13  implementation   two payload corrections, then the six proofs
14  evidence, report, governance
```

Commits 1 to 12 stand. Do not amend, revert, squash or rebase any of them.

### 10.1 Commit 13

```text
lib/retrieval-capture.ts                                     the two corrections
lib/__tests__/retrieval-telemetry-validation.test.ts         new
lib/__tests__/retrieval-telemetry-canonicalization.test.ts   new
```

Plus whichever existing test files carry the consolidated 35, 45 and 46 coverage.
**The kickoff names them exactly**, after locating the current coverage. No file
outside that list changes.

### 10.2 Commit 14

```text
.gitignore
CDMSS-SAUL-REVIEW-34-18-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v23-18-AUG-2026.md
CDMSS-GATE-EVIDENCE-PASS-3-18-AUG-2026.md
CDMSS-PROOF-PASS-3-REPORT-FOR-SAUL-18-AUG-2026.md
```

Four negation lines. No earlier evidence file, report, addendum or review is
edited. Addendum v19 stays untouched.

---

## 11. The gate

Nine numbered commands and the build pair, per addendum v15 section 6, with
command 6 in the approved no-`git add` form from addendum v18 section 4.1:

```bash
npm run architecture:map
cp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"
npm run architecture:map
cmp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"
git diff --exit-code -- lib/architecture/map.generated.ts
```

Start and end timestamps on every command including command 7 and both builds.
Command 7 quoted via the heredoc method. Strict order.

⚠️ **Pass 3 changes production source and adds two test files.** If the
architecture map moves, command 6 will fail. That is a real possibility here in a
way it was not for pass 2, because `lib/retrieval-capture.ts` is in the import
graph. **If the map changes, stop and report.** Do not regenerate and commit.

Test count at HEAD is 3217. Report the observed count; do not require it.

Verify the seven pinned evidence digests plus the supplemental-4 evidence file,
making eight.

---

## 12. Order of work

1. The orchestrator computes this document's digest and shows V.
2. **V approves explicitly, naming the digest.**
3. The orchestrator changes the status line and nothing else.
4. The orchestrator issues the kickoff, written after this signature.
5. The builder verifies the signature, then the two payload corrections, then the
   six proofs.
6. `npm run typecheck`, then `npm test`.
7. The mutation table.
8. Commit 13.
9. The full gate, once, from commit 13.
10. Evidence and report.
11. Commit 14.
12. The orchestrator verifies against the tree and reports to Saul.

---

## 13. What this addendum does not do

- It does not authorize any production change beyond the two corrections in
  section 3.
- It does not authorize editing the `retrieval-telemetry-core.test.ts` header.
- It does not authorize bounded-settlement hardening or touching the sixteen
  waits.
- It does not amend, revert, squash or rebase commits 1 to 12.
- It does not authorize a push. Saul releases pushes.
- It does not close any proof. Saul closes proofs.
- It does not authorize deployment, migration, Cohere activation, or the pass 1
  retrospective sweep. Review 34 withheld all four.
