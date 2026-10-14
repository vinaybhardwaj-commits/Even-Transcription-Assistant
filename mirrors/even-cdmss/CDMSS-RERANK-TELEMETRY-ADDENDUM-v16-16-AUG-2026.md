# CDMSS rerank telemetry — Addendum v16. The pass 2 corrective commit

Date: 16 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `21f11944402675e4d1aab3518d632e3329d2eef7`
Authority: **V, in the orchestration thread, 16 August 2026.**

This addendum is narrow. It amends addendum v15 in three named places and does
nothing else. v15 governs everything it does not touch.

**This is a deviation from v15 as Saul released it.** Section 8 discloses it for
his retrospective ruling. He is not asked to approve it in advance, because v15
already forbade both available repair routes and the pass cannot move without a
decision.

---

## 0. Signature

```text
STATUS: SIGNED by V, 16 August 2026
```

**This section contains exactly one `STATUS:` line, and it is the one above.** It
is the live state of the document, not an example. Read it. Do not grep for it.

Only V changes this line. If it does not name V, the builder stops and reports.

V gave this signature in the orchestration thread on 16 August 2026, choosing a
forward-only third commit over amending commit 1. The orchestrator typed the
line on that instruction.

---

## 1. What happened

The builder made commit 1 at `21f11944402675e4d1aab3518d632e3329d2eef7`, exactly
the four paths in v15 section 2.1. The test count went from 3178 to 3212, plus
34, all green.

The gate then failed at numbered command 2.

```text
lib/__tests__/explicit-judge-retrieve.test.ts(272,75):  TS18048: 'o' is possibly 'undefined'.
lib/__tests__/explicit-judge-retrieve.test.ts(272,105): TS18048: 'o' is possibly 'undefined'.
lib/__tests__/rerank-pass-2.test.ts(243,16):            TS2531: Object is possibly 'null'.
```

`npm run typecheck` exited 2. Commands 6 to 9 and the build pair did not run.

The builder stopped, did not amend, did not revert, and reported. That is what
v15 section 7.2 requires and it was followed exactly.

**The cause, as the builder reported it.** `tsx` transpiles without
type-checking, so all 34 new tests ran green at runtime while `tsc` refused three
lines. The builder ran `tsc --noEmit` against the stub during construction but
never against the three test files before committing.

**The gate caught exactly what it exists to catch.** No production file is
involved. No behavior is wrong. Three positions need a type guard.

---

## 2. Amendment one. A third commit is authorized

Addendum v15 section 2 states two commits. Section 7.5 states "Do not make a
third commit."

**Amended.** Pass 2 has three commits, in this order.

```text
1  commit 1              implementation           EXISTS at 21f11944
2  the corrective commit type guards only         authorized here
3  commit 2              evidence and report      v15 section 2.2, unchanged name
```

The evidence and report commit keeps the name "commit 2" from v15 section 2.2.
Nothing is renumbered. The corrective commit sits between them and has no number.

**Commit 1 stays.** Do not amend it. Do not revert it. Do not squash it. Do not
rebase. Every prior Saul ruling on this workstream preserves existing commits,
and reviews 25, 26 and 28 each say so.

---

## 3. Amendment two. What the corrective commit contains

Exactly these two paths, and nothing else.

```text
lib/__tests__/explicit-judge-retrieve.test.ts
lib/__tests__/rerank-pass-2.test.ts
```

`lib/__tests__/judge-server-stub.ts` and
`lib/__tests__/explicit-judge-equivalence.test.ts` are not in this commit. They
typecheck clean.

Constraints.

1. **Type guards only.** Add the narrowing that `tsc` requires at the three named
   positions. Change no assertion, no fixture, no test title, no control flow
   that alters what a test proves.
2. **No behavior change.** The tests already pass at runtime. They must pass
   identically afterwards.
3. **The test count must stay 3212.** If it moves, the change was not a type
   guard. Stop and report.
4. **Do not silence the compiler.** No `any`, no `as` cast that erases the
   nullability, no `!` non-null assertion, no `@ts-ignore`, no
   `@ts-expect-error`. Narrow with a real check that would fail loudly if the
   value were absent. A cast hides the same defect the gate just found.
5. **Do not change `tsconfig.json`.** Loosening strictness to pass the gate
   defeats the gate.

Run `npm run typecheck` before staging. It must exit zero.

---

## 4. Amendment three. The gate restarts from command 1

Addendum v15 section 7.2 runs the gate from commit 1. That run is void.

**The gate restarts at the corrective commit, from numbered command 1.** It is
not resumed at command 2. A gate certifies the tree it ran against, and the tree
has changed.

All nine numbered commands, then the build pair, exactly as v15 section 6 states.

**Capture to a new directory.** The aborted run's raw output is in
`$HOME/cdmss-pass2-gate-16-aug-2026`, with its `99-STOP.txt` marker. **Do not
overwrite it and do not delete it.** Capture the new run to
`$HOME/cdmss-pass2-gate-corrected-16-aug-2026`.

Both runs go into the evidence file. Section 6 says how.

---

## 5. A standing rule, from this failure

**Run `npm run typecheck` before every commit in this workstream, not only as
numbered gate command 2.**

`tsx` transpiles without type-checking. A suite that is green under `node --test`
proves nothing about types. The two facts are independent and both are required.

This applies to pass 3, pass 4, pass 5 and every corrective commit. The builder
identified it and it is adopted.

---

## 6. The evidence file records both runs

`CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md` records, in this order:

1. **The aborted run at commit 1.** Its commit SHA, commands 1 to 5 with their
   raw output and exit statuses, the three `tsc` errors verbatim, and the stop.
   State plainly that commands 6 to 9 and the build pair did not run.
2. **The corrective commit.** Its SHA, its diff, and the `npm run typecheck` exit
   status before staging.
3. **The full gate at the corrective commit.** All nine numbered commands and the
   build pair, with raw output and exit statuses, per v15 section 6.

A failed gate run is evidence. It is not hidden and it is not summarized away.

---

## 7. Commit 2 gains one path

Addendum v15 section 2.2 lists six paths for commit 2. **It now lists seven.**
This addendum is the seventh.

```text
.gitignore
CDMSS-SAUL-REVIEW-27-16-AUG-2026.md
CDMSS-SAUL-REVIEW-28-16-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v15-16-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v16-16-AUG-2026.md
CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
CDMSS-PROOF-PASS-2-REPORT-FOR-SAUL-16-AUG-2026.md
```

The `.gitignore` change is **six** negation lines, one per new root document.

The ignored-document check in v15 section 8.1 now expects **four** lines, not
three, from the corrective commit onward.

```text
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v15-16-AUG-2026.md
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v16-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-27-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-28-16-AUG-2026.md
```

After commit 2, v15 section 8.2 is unchanged: no CDMSS root document may remain
ignored.

---

## 8. Disclosed to Saul

Two items for his ruling with the pass 2 report.

**8.1 A third commit, against v15 section 7.5.** V chose forward-only repair over
amending commit 1. The reasoning is that every ruling on this workstream
preserves existing commits, and pass 1a already split into two commits and was
ratified retrospectively rather than squashed. Saul rules on whether the shape
was right.

**8.2 This addendum was signed by V without prospective review.** v15 forbade both
repair routes, so no authorized path existed. Waiting for a review round would
have held a committed but ungated tree. Saul rules on whether that was the right
call and whether he wants a different rule for the next occurrence.

---

## 9. Two defects the new tests found before commit 1

Recorded because both are real and both were caught by the tests rather than by
review. The builder reported them and they are already fixed in commit 1.

1. **The recorder's in-flight decrement hung on `finish`.** Node 22 does not emit
   `finish` when the client closes first, only `close`, so `settled()` waited
   forever. Found by the in-flight test, which is the guard v15 section 5.6
   requires.
2. **The connection guard's first draft read `servername: ""` as a TLS signal**
   and refused loopback. Found by the guard's own probe test.

Item 2 is the trap v15 section 10.2 warned about, in a form the warning did not
name. The warning said the argument shape is not uniform between `http` and
`tls`. The actual failure was an empty `servername` present on the `http`
options. **v15 section 10.2 should say so when it is next revised.** It is not
revised here, because this addendum is narrow.

---

## 10. What this addendum does not do

- It does not authorize any production source change.
- It does not authorize any path outside sections 3 and 7.
- It does not authorize amending, reverting, squashing or rebasing commit 1.
- It does not change the gate. Nine numbered commands, then the build pair.
- It does not change any J1 to J4 claim, any proof definition, or the recorder
  contract.
- It does not change the mutation table. It still runs after the gate passes.
- It does not close any proof. Saul closes proofs.
- It does not change v15 section 10.2, though section 9 records that it should
  be corrected later.
