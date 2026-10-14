# CDMSS rerank telemetry — Addendum v22. The shared 5.2b cleanup

Date: 17 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `f6e9188`
Authority: **Saul review 33.**

Narrow. One blocking repair, one comment correction, one new mutation row, and
one debt record. Nothing else.

---

## 0. Signature

```text
STATUS: SIGNED by V, 17 August 2026, over digest 25af48ec9ad714dfc97c34fcd2aa10dd69dd074f3f111f29ceb7f47390910806
```

### 0.1 How this document gets signed, and how a reader verifies it

1. The orchestrator writes this document complete and leaves the status line
   reading `UNSIGNED`.
2. The orchestrator computes `shasum -a 256` over those bytes and shows V the
   digest, the byte count and the line count. **One digest only.** The
   post-signature digest is never shown, because showing both caused an approval
   to be given against the wrong number once already.
3. V gives explicit approval in the orchestration thread, naming the digest.
4. The orchestrator changes **the status line and nothing else**.
5. **No other byte changes at signing, before it, or after it.**

**To verify**, replace the single line beginning `STATUS:` with the exact text
`STATUS: UNSIGNED`, hash the result, and require equality with the digest named
in that line. If a verifier has to add, delete or move any other line to make the
digest reproduce, **the signature is invalid and this document is unauthorized.**

---

## 1. The blocking finding, verified against the code

Saul review 33 found that `5.2b-fail` demonstrates a **separate** cleanup
implementation. It does not repair or guard actual test 5.2b.

Actual 5.2b, at HEAD:

```ts
    try {
      await waitForContinue(reqA, "request '/v1/mid-off-on' acceptance");
      judge.setRecording(true);            // ← toggled ON while the request is in flight
    } finally {
      reqA.end('ABCD');   // outer finally — the body, released whether or not the wait resolved
    }
    await aDone;
    await judge.settled();
```

On a rejection the `finally` calls `reqA.end('ABCD')` and nothing else. It does
not destroy the request and it does not await it. `await aDone` sits **outside**
the `try`, so the rejection propagates past it and it never runs. Control reaches
the outer `finally`, which awaits `judge.settled()`.

**Recording was off at acceptance, so recorder `inFlight` never counted this
request.** `judge.settled()` can therefore return while the HTTP request is still
active, and the shared server proceeds with it in flight.

`5.2b-fail` independently destroys and awaits a different request. No shared
helper connects the two. Its own `await aSettled` is unbounded.

**The repair the kickoff asked for was demonstrated, not applied.**

### 1.1 An orchestrator error, recorded

The pass 2 closure package stated that all sixteen surviving `judge.settled()`
awaits "sit on a completed-request path, so none can hang today".

**That is false**, and Saul review 33 says so. The clearest counter-example is
the one in this very finding: line 307's shared cleanup, reached on a path where
the request was never counted.

The orchestrator took a subagent's classification and reported it to the reviewer
as verified fact without testing it. A classification is not a check. This is the
same failure shape as the doctored digest reconstruction recorded in addendum v20
section 1.2: a verification accepted because it produced the desired answer.

---

## 2. The repair

### 2.1 One shared bounded cleanup helper

Extract **one** helper, used by both actual 5.2b and 5.2b-fail. On a
`waitForContinue` rejection it must:

1. **Destroy** the request.
2. **Boundedly await** its termination, response or error.
3. **Rethrow the original wait error**, so the real cause surfaces rather than a
   cleanup error masking it.

Bounded means it fails by name on expiry, stating what it waited for. It does not
poll forever and it does not rely on `judge.settled()`, which cannot see an
unrecorded request.

### 2.2 Actual 5.2b uses it

5.2b's `try` gains that helper on its failure path. `reqA.end('ABCD')` stays for
the success path. The distinction matters: on success the body is released and
the request completes; on rejection the request is destroyed and awaited.

### 2.3 5.2b-fail exercises the same helper

`5.2b-fail` must call the shared helper, not duplicate its logic. Its own
unbounded `await aSettled` goes.

A test that demonstrates a behavior the production path does not use guards
nothing. That is what review 33 found.

---

## 3. Mutation row 35

| # | Mutate | Must fail |
|---|---|---|
| 35 | remove or defeat the shared cleanup helper | `5.2b-fail`, **by name, without timing out** |

A file-level timeout is not a pass. If row 35 times out rather than naming
5.2b-fail, the helper is still unbounded and the repair is incomplete.

### 3.1 The re-run set

**Rows 1 to 14, and rows 31 to 35.** Nineteen rows.

Rows 15 to 30 are production-file and judge-proof mutations this repair does not
touch, and are not re-run. Review 33 set this scope.

Record each row's exact unified diff, exact command and exit status. Row 35 in
isolation by test name, as row 34 was.

The table runs **before** the gate.

---

## 4. The test-file header still calls v19 signed by V

Line 9 of `lib/__tests__/explicit-judge-equivalence.test.ts` reads:

```text
 * key sites (§3.7b), and 5.4's deterministic acceptance signal (§3.7c). Addendum v19 (signed by V,
```

**V never signed v19.** Addendum v20 section 1 records the chronology and review
31 ruled that v19 is preserved unchanged as historical evidence with its false
line intact. That falsehood must not propagate into source comments.

Correct the header to cite v19 without asserting V signed it. Other references to
`v19 §…` elsewhere in the file are citations of section numbers and are correct;
only the signature claim is wrong. Do not rewrite them.

---

## 5. The sixteen waits are test-harness debt, not pass 2 work

Review 33: **do not rewrite all sixteen in pass 2.** Record them as debt.

They are at lines 142, 150, 159, 263, 272, 294, 307, 319, 361, 366, 557, 659,
806, 838, 863 and 870 of the test file. Several are shared cleanup in `finally`
blocks, and the closure package's claim that all follow a completed request is
withdrawn by section 1.1.

**A separate bounded-settlement hardening task is required before the next
mutation campaign that can leak recorder accounting.** It is not authorized here
and it does not block pass 2 closure.

---

## 6. Scope. Two commits

```text
11  the shared cleanup repair    one test path
12  governance and evidence      five paths
```

Commits 1 to 10 stand. Do not amend, revert, squash or rebase any of them.

### 6.1 Commit 11 changes exactly one path

```text
lib/__tests__/explicit-judge-equivalence.test.ts
```

No production source. No other test file. `judge-server-stub.ts` is not changed.

### 6.2 Commit 12 changes exactly these five paths

```text
.gitignore
CDMSS-SAUL-REVIEW-33-17-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v22-17-AUG-2026.md
CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-4-17-AUG-2026.md
CDMSS-PROOF-PASS-2-SUPPLEMENTAL-4-REPORT-FOR-SAUL-17-AUG-2026.md
```

**Four negation lines**, one per document. `.gitignore` takes none.

No earlier evidence file, report, addendum or review is edited. Addendum v19
stays untouched. The supplemental-3 report's stale wording is **accepted as
documentary errata by review 33** and is not rewritten.

---

## 7. The gate

Nine numbered commands and the build pair, per addendum v15 section 6, with
command 6 in the approved no-`git add` form.

Start and end timestamps on every command, including command 7 and both builds.
Command 7 keeps its quotes by the heredoc method. Run the numbered commands
strictly in order and do not start one before the previous has exited.

Capture to a new directory. Overwrite nothing.

The six pinned evidence digests of addendum v20 section 6.1 are verified again,
plus the supplemental-3 evidence file, making seven.

---

## 8. Order of work

1. The orchestrator computes this document's digest and shows V.
2. **V approves explicitly, naming the digest.**
3. The orchestrator changes the status line and nothing else.
4. The builder verifies the signature by the one-line substitution, before any
   other work.
5. The repair in section 2, and the header correction in section 4.
6. `npm run typecheck`, then `npm test`.
7. The nineteen-row re-run set, with the byte-equality proof.
8. Commit 11.
9. The full gate, once, from commit 11.
10. The supplemental evidence and report.
11. Commit 12.
12. The orchestrator verifies against the tree and reports to Saul.
13. **Saul administratively closes pass 2.** Then, separately, he releases pass 3
    and the push.

---

## 9. What this addendum does not do

- It does not reopen any closed proof. Review 33: pass 2 can close without
  revisiting them.
- It does not authorize rewriting the sixteen waits.
- It does not edit addendum v19, v20 or v21, or any earlier evidence file,
  report or review.
- It does not authorize any production source change.
- It does not amend, revert, squash or rebase commits 1 to 10.
- It does not authorize a push. Six commits are local; commit 12 makes eight.
- It does not close pass 2. Saul closes it.
- It does not release pass 3, the pass 1 retrospective sweep, or the Cohere track.
