# CDMSS rerank telemetry — Addendum v25. Pass 3 partial closure, and the repair

Date: 18 August 2026
Branch: `exp/rerank-telemetry`
HEAD: `a4ef66e`
Authority: **Saul review 36.**

**This addendum supersedes addendum v23 in full.** It replaces addendum v24,
which Saul review 36 rejected and which is not committed anywhere.

---

## 0. Authorization

```text
STATUS: AUTHORIZED by the orchestrator on V's delegation, ratified by Saul review 35
```

Saul review 35 decision 2: *"V ratifies the orchestrator's delegated authority for
pass 3."* Review 36 does not withdraw it.

The digest ritual introduced in v20 and withdrawn in v23 stays withdrawn. **v23
section 12 steps 1 to 3 still prescribed it while v23 section 0 abolished it.**
That contradiction is void along with the rest of v23, which this document
supersedes.

---

## 1. Three errors in v24, recorded

Review 36: *"v24 must not be committed unchanged."* All three grounds are correct
and all three are the orchestrator's.

**1.1 v24 said pass 3 was complete before review 35 was written. It was not.**

Review 35 instructed a freeze. The builder continued and finished. Review 36
rules: *"The continuation after the review's freeze instruction is accepted for
preservation and audit, but it does not release the commits or push."*

The orchestrator framed the sequence as Saul having reviewed a stale snapshot.
The truth is the reverse: Saul reviewed the live state, said stop, and the work
continued past it. **The orchestrator never relayed the freeze to the builder** —
review 35 and the builder's completed report arrived together — so the
continuation was not defiance. But v24's framing exonerated it by making the
reviewer look out of date, and that framing was wrong.

**1.2 v24 was an erratum and did not supersede v23.** Review 35 item 3 asked for a
superseding addendum. v24 corrected one line of v23 and left the rest standing.
This document supersedes it.

**1.3 v24 cited a review that is not durably tracked.** Saul reviews 35 and 36
existed only in the orchestration thread. Both are now written to the worktree
root and are tracked by section 6 of this addendum.

**1.4 One more, on Cohere.** v24 said the operational framing is "position C: the
rationale was never ranking quality." Review 36 corrects it: **the rationale is
operational now.** What it was historically is not something this addendum
asserts. Section 7 carries the corrected wording.

**1.5 And one on wording.** v24 called the amended-away commit "reachable by hash
and on no branch." Review 36: it is *"addressable by object ID/reflog but
unreachable from refs."* That is the accurate phrasing.

---

## 2. Pass 3 partial closure

Review 36 closes two proofs and holds four.

| Proof | Ruling | Reason |
|---|---|---|
| 35 | **Hold** | Test 35.8 uses one judge batch, so it does not discriminate "one record per planned boundary". |
| 45 | **Hold** | Required nullable batch fields can be absent and still validate clean. |
| 46 | **Close** | Skipped expansion and null route-class behaviour adequately discriminated. |
| 47 | **Hold** | The exact `assembleAuditContext` caller handoff is untested; non-primary non-null HMACs validate clean. |
| 49 | **Close** | The four edge shapes and distinct zero-candidate counts adequately covered. |
| 56 | **Hold** | The claimed JSONB round trip is an in-memory simulation, not a real PostgreSQL round trip. |

```text
hard proofs closed     9 of 20     11, 12, 17, 2, 16, 18, 70, 46, 49
judge proofs closed    4 of 4
```

**Not 13 of 20.** The orchestrator's closure package claimed six proofs would
close. Four did not.

Commits `8404029` and `a4ef66e` **stand locally**. Do not amend or discard them.
Nothing is pushed.

---

## 3. The four repairs, prospectively authorized

Narrow. Each addresses one held proof and nothing else.

### 3.1 Proof 35. Multiple planned boundaries

**Defect.** Test 35.8 uses three candidates, which produce **one** judge batch. An
implementation that always synthesised exactly one record would pass.

**Repair.** Use a candidate count that spans **more than one** planned boundary,
and assert the exact boundaries — not merely that a record exists per boundary,
but which boundaries. `JUDGE_BATCH` is read from source text, per proof 18's
standing rule, and is not imported or hard-coded.

### 3.2 Proof 45. A validator defect, not only a test gap

**Defect.** D17 requires own-property validation for nullable fields.
`prompt_tokens` and `completion_tokens` receive **no validation at all** in
`lib/retrieval-telemetry-core.ts`. **A malformed manifest can therefore be
classified as complete.**

**Repair.** Two parts.

1. **Production.** Add own-property validation for both fields in
   `lib/retrieval-telemetry-core.ts`, matching the pattern D17 already applies to
   its other nullable fields: distinguish missing, null, empty and invalid.
2. **Tests.** Exhaustive per-field coverage, one absent-or-invalid case each.

⚠️ **This is a production defect that shipped in commit 13 and the pass 3 gate did
not catch it, because no test asked.** It is the most consequential finding in
review 36.

### 3.3 Proof 47. The production caller, and non-primary HMACs

**Defect, two parts.** The test hands `validateManifest` a handcrafted context
rather than exercising `assembleAuditContext`'s real output through the
production caller. And `lib/retrieval-telemetry-core.ts` **fails to reject
non-null HMACs on the four non-primary roles**.

**Repair.**

1. **Production.** Reject a non-null scorer-context HMAC on any of the four
   non-primary roles. Today it validates clean.
2. **Tests.** Drive the assertion through `assembleAuditContext` and the
   production caller, not a handcrafted object. Keep the empty-string case.

### 3.4 Proof 56. A real PostgreSQL JSONB round trip

**Defect.** The test file says in terms that no database is used, and its helper
approximates PostgreSQL key ordering rather than executing a round trip. Proof
56's literal wording requires the round trip.

**Repair.** Run the round trip against a **disposable, non-production**
PostgreSQL. Add an **array-order mutation**, since array reorder not being equal
is one of proof 56's five claims.

⚠️ **No production database is touched.** The instance is disposable, is not the
Neon production branch, and carries no patient-derived value. If no such instance
can be stood up, **stop and report** — do not re-simulate and re-title.

### 3.5 Scope

Production changes are limited to `lib/retrieval-telemetry-core.ts`, for 3.2 and
3.3 only. Test changes are limited to the three pass 3 test files. Nothing else
in production changes.

---

## 4. Disclosure 5.5, accurately

Review 36 did not accept the orchestrator's version. The production diff in
commit 13 contains **one edited citation comment and three new explanatory comment
blocks**, not one edited comment. All four are behaviour-free.

Review 36: they *"may be ratified once accurately disclosed."* They are now
accurately disclosed, and this section is that disclosure.

The builder reported one; the orchestrator relayed one without counting the diff.

---

## 5. Ratified without change

Review 36 ratified four of the builder's five disclosures outright.

- **5.1, the amend before the gate.** Accepted. The amended bytes received a
  complete fresh mutation run and gate. No rerun is required on account of the
  amend.
- **5.2, proof 35's home.** Ratified. It stays in
  `retrieval-telemetry-core.test.ts`.
- **5.3, sixteen rows rather than eight.** Normal compliance with the instruction
  to add rows. No exception needed.
- **5.4, test 35.8 importing `lib/rerank.ts`.** Ratified. It touches no
  judge-stub or recorder lifecycle machinery. Its defect is insufficient
  discrimination, which section 3.1 repairs.

---

## 6. Documents this addendum tracks

The repair commit's governance half tracks:

```text
CDMSS-SAUL-REVIEW-35-18-AUG-2026.md
CDMSS-SAUL-REVIEW-36-18-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v25-18-AUG-2026.md
```

Review 34 is already tracked in commit 14. **Addendum v24 is not tracked and will
not be** — it was rejected before commit and is superseded by this document. Its
three errors are recorded in section 1 so the rejection is not lost.

---

## 7. Cohere, in the corrected wording

**The rationale for evaluating Cohere is operational, now.** This addendum makes
no claim about what the rationale was historically.

Per review 35, accepted by review 36:

- Cohere is evaluated on operational value, not clinical-score superiority.
- **No flip and no golden clinical A/B is authorized.**
- The judge backend stays unchanged during evaluation.
- A preregistered **operational** benchmark replaces the withdrawn A/B: latency
  distribution and throughput, cost per request and per candidate, failure and
  timeout and fallback and rate-limit rates, quota and capacity headroom, vendor
  concentration and failover value, and data-handling and operational-complexity
  cost.
- Thresholds are set **before** any comparison data is collected.
- Identical archived inputs may isolate backend performance, but the benchmark
  **is not evidence of clinical ranking equivalence**.
- Telemetry continues independently, because intended backend, served backend,
  downgrade and failure visibility remain valuable.

The Treatment Protocol stays a reviewed draft, with review 35's eight revisions to
be folded in before any implementation addendum.

---

## 8. What this addendum does not do

- It does not close proofs 35, 45, 47 or 56. Saul closes proofs.
- It does not authorize a push. Review 36 withholds it explicitly.
- It does not amend, revert, squash or discard any commit.
- It does not authorize any production change beyond section 3.5.
- It does not begin pass 4, the pass 1 retrospective sweep, deployment,
  migration, Cohere activation, or the operational benchmark.
