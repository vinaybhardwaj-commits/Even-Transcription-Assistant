# CDMSS rerank telemetry — Addendum v19. The recorder and documentary repair

Date: 16 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `76307f0f8ca40b238cdd75ed2dbe286613b282bf`
Authority: **Saul review 30.**

Narrow. It authorizes two commits, carries one erratum against addendum v18, and
does nothing else.

---

## 0. Signature

```text
STATUS: SIGNED by V, 16 August 2026
```

**This section contains exactly one `STATUS:` line, and it is the one above.**
Read it. Do not grep for it.

Only V changes this line. V gave this signature in the orchestration thread on 16
August 2026, over these bytes. The orchestrator typed the line on that
instruction.

---

## 1. What review 30 ruled

### 1.1 Proofs

All six held proofs close. Proof 70 closes technically, with its contradictory
comments to be corrected here.

```text
hard proofs closed     7 of 20     11, 12, 17, 2, 16, 18, 70
judge proofs closed    4 of 4      J1, J2, J3, J4
```

**Administrative pass 2 completion stays on hold** until the corrections in
section 3 land.

### 1.2 Governance

- The no-`git add` command 6 replacement is **approved**. It is no longer the
  orchestrator's unruled construction. It is the protocol.
- The governance-only ungated-tip exception is ratified.
- The `finaliseTelemetry` error is a naming-only erratum, carried here rather
  than in pass 3, because another correction was needed anyway.
- **Do not push `fe59b07` or `76307f0`.** They stay local until the corrections
  land.

---

## 2. The erratum against addendum v18

Addendum v18 section 3.1 reads:

> production assembles it in `lib/opd-note-audit.ts`, in `finaliseTelemetry`

**No such symbol exists.** The symbol is `writeRetrievalTerminals`.

Corrected text:

> production assembles it in `lib/opd-note-audit.ts`, in `writeRetrievalTerminals`

The assembly line v18 quotes is correct and exists verbatim at that site, so no
work built from that instruction is wrong. The error is the function name only,
and it was the orchestrator's.

**Addendum v18 is not edited.** This erratum stands as the correction, as review
30 directed.

---

## 3. The six corrections

### 3.1 Recording state is sampled twice

**Defect.** Acceptance reads `recording`, and completion reads its current value
again. Toggling during a request can produce an observation with `seq: -1`, lose
an accepted observation, or leak in-flight accounting.

**Fix.** Capture the decision once, at acceptance:

```ts
const recordThisRequest = recording;
```

Use that local consistently through the `data` handler, the `end` handler, the
`close` handler, and observation creation. **The module-level `recording` flag is
never read again for a request already accepted.**

### 3.2 Non-enumerable fields survive the snapshot

**Defect.** `snapshot()` clones with object spread, which drops non-enumerable
properties. So `Reflect.ownKeys(judge.snapshot()[0])` cannot see a non-enumerable
stored authorization field, and the section 5.3 no-headers guard is blind to it.

Mutation row 29 adds an **enumerable** symbol, so it does not cover this case.

**Fix.** Clone with own-property descriptors, so symbol-keyed and non-enumerable
fields survive into the snapshot and can be inspected. Continue to copy the body
Buffer defensively.

The defensive-copy contract of addendum v15 section 5.7 is unchanged. This makes
the clone faithful as well as defensive.

### 3.3 Test 5.4 can still hang

**Defect.** The acceptance poll has no timeout and no request-error rejection,
and the release does not cover a failure before the acceptance wait resolves.

**Fix.** A bounded, fail-loud acceptance helper with three properties:

1. A bounded wait. On expiry it **fails by name**, stating what it waited for.
2. Request-error rejection, so a socket error surfaces rather than stalling.
3. An outer `finally` that releases whether or not the acceptance wait resolved.

**Apply the same helper to test 5.6.** Its 30 millisecond sleep was left in place
under addendum v18 because only 5.4 was authorized. It is authorized now.

### 3.4 Proof 17 must be quoted verbatim

The supplemental report quotes proofs 2, 16, 18 and 70 and omits 17. Proof 17
remains closed; this is documentary noncompliance, not a proof defect.

Quote proof 17 verbatim from kickoff v11 in the new supplemental report.

### 3.5 Proof 70's comments contradict v18

The comments still describe review 28's comparison as undefined and declined.
**Review 29 defined it as the repository production-path diff and recorded that
the condition passed.** Addendum v18 section 1.4 carries that resolution.

Correct the comments to state the resolution. Do not leave a test comment
asserting a decline that has been withdrawn.

Also correct the socket-identity and sequence-numbering analogy wherever it
misstates the relationship. **Find it, quote what it said, and say what you
changed it to.** Do not guess at which comment is meant; report the one you
corrected.

### 3.6 Timestamp wording

The gate evidence overstates timestamp completeness. Command 7 carries no
timestamps and the refusal build carries no ending timestamp.

**No gate rerun is required for this.** The ordered log is sufficient. Correct the
wording in the new supplemental report so it claims only what the evidence holds.

---

## 4. Scope. Two commits

```text
7  the recorder and comment repair       test paths
8  the governance supplemental           documents only
```

Commits 1 to 6 stand. Do not amend, revert, squash or rebase any of them.

### 4.1 Commit 7 changes at most these two paths

```text
lib/__tests__/judge-server-stub.ts
lib/__tests__/explicit-judge-equivalence.test.ts
```

Section 3.5 also requires a comment correction in
`lib/__tests__/rerank-pass-2.test.ts`. **That makes three paths.** No production
source changes in the worktree. The mutation sandbox is exempt.

### 4.2 Commit 8 changes exactly these five paths

```text
.gitignore
CDMSS-SAUL-REVIEW-30-16-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v19-16-AUG-2026.md
CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-2-16-AUG-2026.md
CDMSS-PROOF-PASS-2-SUPPLEMENTAL-2-REPORT-FOR-SAUL-16-AUG-2026.md
```

Four negation lines. **No earlier evidence file or report is edited.** The
corrections in sections 3.4 and 3.6 go into the new supplemental report, not into
the old one.

---

## 5. The mutation table

**Thirty-two rows. All of them.**

The thirty from addendum v18, plus two:

| # | Mutate | Must fail |
|---|---|---|
| 31 | store a **non-enumerable** authorization field on the observation | the no-headers check, through the descriptor-faithful snapshot |
| 32 | store a hidden field on the **parsed** `JudgeRequest` | the parsed-API guard of v15 section 5.11 |

Row 31 is the case row 29 misses. Row 29 adds an enumerable symbol; row 31 adds a
non-enumerable field, which only the section 3.2 fix can surface.

All thirty-two run **before** the gate. Every row must fail its named test **by
name**. Record each row's exact unified diff, exact command and exit status.

The full table re-runs because section 3.1 and section 3.2 change the recorder
itself, and rows 1 to 14 all name recorder tests.

---

## 6. The gate

Nine numbered commands and the build pair, per addendum v15 section 6, with
command 6 in the **approved** no-`git add` form from addendum v18 section 4.1.

```bash
npm run architecture:map
cp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"
npm run architecture:map
cmp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"
git diff --exit-code -- lib/architecture/map.generated.ts
```

Review 30 approved this. It is the protocol from here forward.

Command 7 keeps its quotes, by the heredoc method that worked. Run the numbered
commands strictly in order and do not start one before the previous has exited.

Capture to a new directory. Do not overwrite any existing capture.

---

## 7. Order of work

1. The repairs in section 3.
2. `npm run typecheck`, then `npm test`.
3. The thirty-two row mutation table.
4. Repair anything the table finds, then re-run every row naming a changed test.
5. Commit 7.
6. The full gate, once, from commit 7.
7. Write the new supplemental evidence and report.
8. Commit 8.

---

## 8. Recorded, not authorized

The Cohere roadmap carries seven factual corrections from review 30. They are
corrections to an orchestrator document, not to this addendum, and they are
handled separately. **Review 30 authorized the golden A/B and the Cohere
Treatment Protocol design work to begin immediately.** Neither is in scope here.

Review 30 declined to choose between roadmap options A and B, rejected option C,
and set nine eligibility conditions for B. That decision stays open.

---

## 9. What this addendum does not do

- It does not authorize any production source change in the worktree.
- It does not authorize any path outside sections 4.1 and 4.2.
- It does not edit addendum v18, or any earlier evidence file or report.
- It does not amend, revert, squash or rebase commits 1 to 6.
- It does not authorize a push. Review 30 held `fe59b07` and `76307f0`.
- It does not close any proof. Saul closes proofs.
- It does not begin pass 3, the pass 1 retrospective sweep, or the Cohere track.
