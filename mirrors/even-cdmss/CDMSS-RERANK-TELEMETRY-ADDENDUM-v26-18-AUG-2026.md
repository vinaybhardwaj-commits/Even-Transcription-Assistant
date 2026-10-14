# CDMSS rerank telemetry — Addendum v26. The second pass 3 repair

Date: 18 August 2026
Branch: `exp/rerank-telemetry`
HEAD: `fb5e9d5`
Authority: **Saul review 37.**

Narrow. Seven scope items, all prospectively authorized by review 37.

---

## 0. Authorization

```text
STATUS: AUTHORIZED by the orchestrator on V's delegation, ratified by Saul review 35
```

Review 37 does not withdraw the delegation. No digest, no personal signature.
Saul reviews after the fact.

---

## 1. Where pass 3 stands

Review 37 closes proof 35 and holds three.

```text
hard proofs closed     10 of 20    11, 12, 17, 2, 16, 18, 70, 46, 49, 35
judge proofs closed     4 of 4
held                    45, 47, 56
```

Commits `f391973` and `fb5e9d5` stand locally and **must not be amended**.
Nothing is pushed.

---

## 2. A false claim I relayed, withdrawn

My pass 3 repair closure package told Saul that D17 coverage had reached
**54 of 54 fields and 20 of 20 nullable fields**.

**Review 37: those claims must be withdrawn.** They are false.

I took the numbers from the builder's report and passed them to the reviewer as
verified fact. I did not check them. **This is the second time in this programme
I have done exactly that** — the first was telling Saul that all sixteen
`judge.settled()` waits sat on completed-request paths, which review 33 also had
to correct.

A count in a builder's report is a claim. Relaying it is not verification. From
here, any coverage number I put in front of Saul is one I have counted myself or
labelled as unverified.

---

## 3. The seven repairs

Review 37's scope, item by item. Nothing outside it.

### 3.1 Complete D17 validation from an explicit matrix

Build validation from an explicit **field / null / type matrix**, not from
ad-hoc per-field code. The matrix is the source of truth for which fields exist,
which may be null, and what type each carries.

It must include **malformed array members** and **stable, non-throwing validation
of `unknown` input**.

### 3.2 `batches: [null]` must not throw

Today a null array member can throw rather than returning a stable defect code.

**A validator that throws on malformed input is a defect, not a guard.** Its whole
job is to classify bad input. Anything that reaches it must return codes.

### 3.3 `candidate_start` needs its own discrimination

Both boundary rows currently mutate only `candidate_end`, so `candidate_start`
has no independent invalid-or-absent test. Add one, and a mutation row that
proves it.

### 3.4 The HMAC-absent licence's fields must be validated

Missing `hmac_key_version` validates clean while the HMAC-absent licence is
active. The licence permits the HMAC to be absent. **It does not permit its
accompanying fields to be absent or wrongly typed.** Validate them as present and
correctly typed.

### 3.5 Variant-generation usage fields

Review 37 accepts this as a real known defect and folds it into this repair. The
per-batch pair was fixed in the last round; the variant-generation pair was not.

### 3.6 An executable seam for proof 47

**The source pin is insufficient.** Review 37 is explicit: proof 47 requires
executable evidence.

Add a **narrow, default-preserving** seam so that real `assembleAuditContext`
output runs through the production terminal-payload path in
`lib/opd-note-audit.ts`.

Narrow and default-preserving means: no production caller passes it, the default
path is byte-identical to today, and the seam exists only so a test can drive
what production drives. This is the same shape addendum v11 section 8 authorized
in principle for pass 4's lifecycle work.

The source pin **may remain as supporting evidence** but cannot substitute for
execution.

### 3.7 PostgreSQL lifecycle must be bounded and fail-loud

Proof 56's round trip is real. Its **teardown is not**, so "disposable" is not
established.

Four defects: `pg_ctl stop` failures are swallowed; the data directory is deleted
regardless of whether the server stopped; subprocesses have no timeout; and a
failed startup can bypass teardown entirely.

**Startup, every command, shutdown, status verification and cleanup must each be
bounded and fail loudly.** A swallowed stop failure followed by a directory
deletion is how an orphaned process outlives its data directory.

Deletion must follow **verified** shutdown, not assumed shutdown.

---

## 4. Scope

**Production**, forward-only:

```text
lib/retrieval-telemetry-core.ts
lib/opd-note-audit.ts          section 3.6 only, the seam and nothing else
```

**Tests**, the three pass 3 files:

```text
lib/__tests__/retrieval-telemetry-core.test.ts
lib/__tests__/retrieval-telemetry-validation.test.ts
lib/__tests__/retrieval-telemetry-canonicalization.test.ts
```

`lib/retrieval-capture.ts` is not reopened. No other production file changes.

---

## 5. Mutations and the gate

**One mutation row per repaired weakness**, per review 37 item 7. At minimum:
the D17 matrix, the null array member, `candidate_start`, the licence fields, the
variant-generation fields, the executable seam, and the PostgreSQL teardown.

Every row fails its named test **by name**. A file-level timeout is not a pass.
Record each row's exact unified diff, exact command and exit status. Prove the
tested bytes equal the committed bytes.

No row may alter judge lifecycle or recorder counting, per review 34's standing
condition.

Then one fresh full gate: nine numbered commands and the build pair, command 6 in
the no-`git add` form, command 7 quoted, timestamps on everything.

⚠️ `lib/opd-note-audit.ts` is in the import graph and is a larger module than
anything pass 3 has touched. **If the architecture map moves, stop and report.**

---

## 6. Two commits

```text
17  the repair                    production and tests
18  evidence, report, governance
```

Commits 1 to 16 stand. Do not amend, revert, squash, rebase or discard any.

Commit 18 tracks `CDMSS-SAUL-REVIEW-37-18-AUG-2026.md` and this addendum, plus
the evidence and report. Nothing else is edited.

---

## 7. Corrected counts, stated once

Review 37: *"future documents must use corrected counts."*

Every count in this addendum and its kickoff has been checked against the list it
labels. Section 4 names two production files and three test files. Section 3
carries seven repairs. Section 6 authorizes two commits.

Eight of my documents have previously stated a count that disagreed with the list
beneath it.

---

## 8. What this addendum does not do

- It does not close proofs 45, 47 or 56. Saul closes proofs.
- It does not authorize a push, pass 4, deployment, migration, the pass 1
  retrospective sweep, or Cohere activation.
- It does not authorize any production change outside section 4.
- It does not reopen `lib/retrieval-capture.ts`.
- It does not amend or discard any commit.
