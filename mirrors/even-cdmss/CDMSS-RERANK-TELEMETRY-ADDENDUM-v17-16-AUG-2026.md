# CDMSS rerank telemetry — Addendum v17. The second pass 2 corrective commit

Date: 16 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `fe0eedb26d4ea40a2f763a885321eae67bb557d0`
Authority: **V, in the orchestration thread, 16 August 2026.**

Narrow. It amends addendum v16 and addendum v15 in named places and does nothing
else. Section 7 adds one process change that applies from pass 3 onward.

---

## 0. Signature

```text
STATUS: SIGNED by V, 16 August 2026
```

**This section contains exactly one `STATUS:` line, and it is the one above.**
Read it. Do not grep for it.

Only V changes this line. If it does not name V, the builder stops and reports.

V authorized this in the orchestration thread on 16 August 2026, on the same
standing as addendum v16: forward-only repair, no amendment of any existing
commit. The orchestrator typed the line on that instruction.

---

## 1. What the mutation table found

The full gate passed at `fe0eedb`. The builder then ran the twenty-two row
mutation table in the sandbox. Nineteen rows discriminated cleanly. Three did
not, and they name two real defects **in the tests**, not in the recorder.

### 1.1 Row 1. A derived boundary is not a boundary test

Mutation: `RECORDER_BODY_LIMIT_BYTES` from 1048576 to 1048577. Named test: 5.5b,
the 1048577 rejection test.

**5.5b did not fail. 5.5a failed instead.**

5.5b builds its oversized body as `Buffer.alloc(RECORDER_BODY_LIMIT_BYTES + 1)`.
When the constant moves, the body moves with it. The test sent 1048578 bytes,
which the mutated limit still rejects, so it passed. The only thing that caught
the mutation was 5.5a's `assert.equal(RECORDER_BODY_LIMIT_BYTES, 1048576)`, which
is a source pin, not a boundary observation.

**This is the exact distinction addendum v15 section 5.5 draws:** "Both boundary
values must be tested." One boundary was derived from the constant instead of
stated. A test whose input is computed from the value under test cannot detect a
change to that value.

Rows 2 and 10 passed for the same structural reason in reverse. Which side the
derived value fell on was luck.

### 1.2 Rows 6 and 7. A test that hangs instead of failing

Mutation: remove the in-flight refusal from `snapshot` (row 6) and from
`resetObservations` (row 7). Named test: 5.6.

**The file timed out at 60 seconds after 6 tests passed. 5.6 never reported.**

5.6 holds a request open, then asserts that `snapshot` throws. With the refusal
removed the assertion fails, but it sits inside a `recorded()` wrapper whose
`finally` awaits `judge.settled()`, and the held request is released only after
the assertions. The failure is swallowed by an unbounded wait.

The mutation is not vacuous. The run visibly breaks. But the table requires a
**named** test to fail, and a file-level timeout names nothing.

### 1.3 The nineteen clean rows

All nineteen discriminated as required, including every one of the eight
production-file rows, 15 to 22. Those mutations were confined to the sandbox. The
worktree copies of `rerank.ts`, `retrieve.ts`, `multi-query.ts` and the stub were
verified byte-identical to `fe0eedb` with `cmp`. The sandbox shape was verified
before use and the sandbox is deleted.

---

## 2. Amendment. A second corrective commit is authorized

Addendum v16 section 2 states three commits. **Amended.** Pass 2 has four.

```text
1  commit 1                     implementation      EXISTS at 21f11944
2  the first corrective commit  type guards         EXISTS at fe0eedb
3  the second corrective commit test repairs        authorized here
4  commit 2                     evidence and report name unchanged
```

**Both existing commits stay.** Do not amend, revert, squash or rebase either.

---

## 3. What the second corrective commit contains

Exactly one path.

```text
lib/__tests__/explicit-judge-equivalence.test.ts
```

Two changes, and no others.

### 3.1 State both boundaries as literals

5.5a sends exactly **1048576** bytes. 5.5b sends exactly **1048577** bytes. Both
written as number literals in the test body.

Do not derive either from `RECORDER_BODY_LIMIT_BYTES`. Do not write
`LIMIT`, `LIMIT + 1`, or any expression that reads the constant.

Keep 5.5a's `assert.equal(RECORDER_BODY_LIMIT_BYTES, 1048576)` as a separate
source pin. It is a useful check. It is not the boundary test and must not be
relied on as one.

Add a comment saying why the literals are literals, so a later reader does not
"tidy" them back into an expression.

### 3.2 Release the held request in a `finally`

In 5.6, move `release()` into a `finally` so a failed assertion still lets the
held request complete. 5.6 must report `not ok` by name when the in-flight
refusal is removed, rather than hanging the file.

Check every other test in the four pass 2 files for the same shape: an assertion
that runs while a request is held open, with the release after it. If any other
test has it, fix it in this commit and name it in the report. That is within
scope, because it is the same defect.

### 3.3 Constraints

1. **The test count must stay 3212.** If it moves, stop and report.
2. **No assertion may change meaning.** The tests prove what they proved before.
3. No cast, no non-null assertion, no `@ts-ignore`, no `@ts-expect-error`.
4. Do not change `tsconfig.json`.
5. Do not touch `judge-server-stub.ts`, `rerank-pass-2.test.ts` or
   `explicit-judge-retrieve.test.ts`, unless 3.2's sweep finds the held-request
   shape in one of them. If it does, name the file in the report.
6. **Run `npm run typecheck` before staging.** It must exit zero. That is the
   standing rule from addendum v16 section 5.

---

## 4. Re-run five rows, not three

The builder proposed re-running rows 1, 6 and 7. **Run five.** Rows 2 and 10 name
the same two tests this commit edits, and a repair can break a row that passed.

```text
row 1   limit → 1048577          must fail 5.5b
row 2   limit → 1048575          must fail 5.5a
row 6   snapshot refusal removed  must fail 5.6, by name
row 7   reset refusal removed     must fail 5.6, by name
row 10  200 instead of 413        must fail 5.5b
```

Build a **fresh** sandbox. Verify its shape. Delete it afterwards.

For rows 6 and 7 the failure must be a named `not ok` for 5.6. **A file-level
timeout is not a pass.** If the file times out again, the repair in section 3.2
is incomplete. Stop and report.

The other seventeen rows are not re-run. They discriminated against test code
this commit does not change.

---

## 5. The gate restarts from command 1, again

The full gate at `fe0eedb` stands as a record of that tree. It does not certify
the new tree.

Run all nine numbered commands and the build pair from the second corrective
commit, per addendum v15 section 6. **Do not resume.**

**Capture to a third directory**,
`$HOME/cdmss-pass2-gate-corrected-2-16-aug-2026`.

⚠️ **Do not overwrite or delete either existing capture directory.** All three
gate runs are evidence.

---

## 6. Commit 2 grows again

Commit 2 now carries **eight** paths. Addendum v17 is the eighth.

```text
.gitignore
CDMSS-SAUL-REVIEW-27-16-AUG-2026.md
CDMSS-SAUL-REVIEW-28-16-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v15-16-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v16-16-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v17-16-AUG-2026.md
CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
CDMSS-PROOF-PASS-2-REPORT-FOR-SAUL-16-AUG-2026.md
```

The `.gitignore` change is **seven** negation lines.

From the second corrective commit onward, the ignored-document check expects
**five** lines:

```text
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v15-16-AUG-2026.md
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v16-16-AUG-2026.md
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v17-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-27-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-28-16-AUG-2026.md
```

### 6.1 The evidence file records three gate runs and two mutation runs

In this order:

1. The aborted gate at commit 1, with its three `tsc` errors, and the statement
   that commands 6 to 9 and the build pair did not run.
2. The first corrective commit and its pre-staging typecheck.
3. The full gate at `fe0eedb`, all nine commands and the build pair.
4. The first mutation table run: all twenty-two rows, the nineteen that passed,
   and rows 1, 6 and 7 with what actually happened.
5. The second corrective commit and its pre-staging typecheck.
6. The five re-run rows.
7. The full gate at the second corrective commit.

A failed gate run and a failed mutation row are both evidence. Neither is hidden
and neither is summarized away.

---

## 7. A process change, from pass 3 onward

**The mutation table runs before the gate, not after.**

The table tests the tests. A defect it finds requires a code change, and a code
change invalidates any gate already run. Running the gate first guarantees rework
every time the table finds anything. It has now cost two gate runs in one pass.

From pass 3 the order is: write the tests, run `npm run typecheck` and
`npm test`, run the full mutation table, repair anything it finds, then commit,
then run the gate once against the committed tree.

This does not change pass 2, which is mid-flight under v15, v16 and this
addendum.

---

## 8. Disclosed to Saul

**8.1 A fourth commit.** v15 authorized two, v16 three, this makes four. All
forward, none amended. Saul rules on the shape.

**8.2 v16 and v17 were both signed by V without prospective review.** No
authorized path existed in either case and waiting would have held a committed
tree. Saul rules on whether he wants a standing rule for this.

**8.3 The derived-boundary defect is a class, not an instance.** Addendum v15
section 5.5 said "both boundary values must be tested" and the test derived one.
Saul may want the same sweep applied to pass 1's tests, which were never
mutation-tested against their own constants.

**8.4 The process change in section 7** takes effect at pass 3 without his prior
approval. He may reverse it.

---

## 9. What the builder got right, recorded

The builder pre-checked rows 5 and 13 before commit 1 because it doubted them,
and both passed. It did not pre-check row 1, because it was confident about the
boundary tests.

It reported that confidence as the error, unprompted, and stopped rather than
editing frozen files without authorization.

Nineteen of twenty-two rows discriminating on a first full run is a good result.
The three that did not are the reason the table exists.

---

## 10. What this addendum does not do

- It does not authorize any production source change.
- It does not authorize any path outside sections 3 and 6.
- It does not authorize amending, reverting, squashing or rebasing `21f11944` or
  `fe0eedb`.
- It does not change the gate. Nine numbered commands, then the build pair.
- It does not change any J1 to J4 claim, any proof definition, or the recorder
  contract.
- It does not change the seventeen mutation rows it does not re-run.
- It does not close any proof. Saul closes proofs.
