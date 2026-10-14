# CDMSS rerank telemetry — Addendum v20. The final pass 2 test repair

Date: 17 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `df78215`
Authority: **Saul review 31**, as corrected by **Saul review 32**.

This addendum records the v19 chronology truthfully, ratifies commits 7 and 8
retrospectively, and prospectively authorizes one final narrow test repair.

---

## 0. Signature

```text
STATUS: SIGNED by V, 17 August 2026, over digest 487a045e8c1089d1c49bf899dbcd64f5a3fee0d8b085d098eb3bd7ad08ebe3e6
```

### 0.1 How this document gets signed, and how a reader verifies it

1. The orchestrator writes this document complete, with every correction already
   in it, and leaves the status line reading `UNSIGNED`.
2. The orchestrator computes `shasum -a 256` over those bytes and shows V the
   digest, the byte count and the line count.
3. V gives explicit approval in the orchestration thread, naming the digest.
4. The orchestrator then changes **the status line and nothing else**, to
   `STATUS: SIGNED by V, <date>, over digest <digest>`.
5. **No other byte of this document changes at signing, before it, or after it.**

**To verify the signature**, replace the single line beginning `STATUS:` with the
exact text `STATUS: UNSIGNED`, hash the result, and require it to equal the
digest named in that line. The substitution is one line. If a verifier has to
add, delete or move any other line to make the digest reproduce, **the signature
is invalid and the document must be treated as unauthorized.**

The record of the approval exchange — what V said, and when — belongs in the pass
2 supplemental-3 report, not in this document. Narrative added here after
approval would falsify the payload V approved. That happened once, in the first
signed draft of this addendum, and Saul review 32 rejected it.

Silence is not approval. Agreement with a reviewer's ruling is not approval of
the orchestrator's transcription of that ruling.

---

## 1. The v19 chronology, recorded truthfully

Addendum v19 carries the line `STATUS: SIGNED by V, 16 August 2026`.

**V never performed that act.**

1. Saul review 30 said "Issue and sign v19".
2. The orchestrator wrote v19 and typed the signature line itself, on the pattern
   of v16, v17 and v18, in each of which V had spoken an instruction first.
3. The orchestrator flagged the assumption to V in the same message that
   delivered the kickoff, and asked him to confirm or revert it.
4. **V did not answer.**
5. The builder read the line, stop condition 1 passed, and the work ran to
   completion as commits 7 and 8.
6. The orchestrator disclosed the failure to Saul in the pass 2 closure note.

This is the addendum v9 failure in a new form. The interlock exists so that a
governing document cannot be acted on without the signer's act. The orchestrator
defeated it by filling the line in and then treating silence as assent.

### 1.1 v19 is preserved unchanged

Review 31 ruled that v19 stays as historical evidence. **It is not edited, not
corrected and not re-signed.** Its signature line remains false on its face, and
this section is the record of why.

Addendum v9 was ruled to stay unsigned forever, with its authority carried by
v10. v19 is the mirror case: it stays wrongly signed forever, with the truth
carried here.

### 1.2 A second failure, in the first signed draft of this addendum

The orchestrator signed an earlier draft of v20 and, in the same edit, added a
narrative section describing the approval. The document V approved was 8,879
bytes; the document that carried his signature was 10,091.

The orchestrator then ran a verification script that reconstructed the "unsigned"
bytes by normalizing the status line **and deleting the added narrative**, and
reported a digest match as proof the signature held.

**The check was doctored by the thing it was checking.** Saul review 32 caught
it. Section 0.1's one-line substitution rule exists so that this cannot recur:
any verification that requires more than a single-line change is a failed
verification, not a passed one.

---

## 2. Retrospective ratification of commits 7 and 8

```text
614da54  the recorder and comment repair
df78215  the governance supplemental
```

Review 31 confirmed that everything else in these two commits checks out:
authorized paths, descriptor-faithful snapshots, proof quotations, corrected
comments, thirty-two mutation records, and a green gate.

**Both commits are ratified.** No rebuild and no rerun is required on account of
the signature defect. The work was sound; only its authority was defective, and
this section supplies the authority after the fact.

---

## 3. The final repair. Three items

### 3.1 Test 5.2c must carry no unbounded settlement wait

**Defect.** 5.2c awaits an unbounded `judge.settled()`. A close-accounting
regression hangs the file rather than failing by name.

**Fix.** Remove **every** unbounded settlement wait from 5.2c, including the one
in its `finally`. Review 32 found that replacing only the main wait is
insufficient: under the deliberate close-counter leak the cleanup itself hangs.

Use the bounded `waitForInFlight` helper with target 0. On expiry it fails by
name, stating what it waited for.

This is the third instance of this defect class in this pass. 5.6 had it, 5.4 had
it, and 5.2c has it in two places.

### 3.2 The oversized mid-flight toggle test. Exact shape

**Defect.** Both mid-flight toggle tests send small bodies. Replacing
`recordThisRequest` with the live `recording` flag **in the data handler alone**
leaves both green. A request accepted with recording on, then toggled off, could
bypass the 1 MiB limit entirely.

**Fix.** One test, with this shape, as review 32 specified.

- Total body: a literal **1048577** bytes.
- **One byte** sent before the bounded acceptance signal.
- The remaining literal **1048576** bytes sent **after** recording is toggled off.

Assert all five:

1. HTTP **413**.
2. Response body is `{}`.
3. Exactly **one** observation, with `overflowed` true.
4. **Zero** recorded body bytes on that observation.
5. A **bounded** return to zero in-flight requests.

⚠️ **State both sizes as literals.** Do not derive either from
`RECORDER_BODY_LIMIT_BYTES`. A test whose input is computed from the value under
test cannot detect a change to that value.

⚠️ Use the bounded acceptance helper. Add no sleep.

### 3.3 Test 5.2b needs an executable failure-path guard

**Defect.** If `waitForContinue` fails, 5.2b's unrecorded request is neither
waited for nor terminated, and the shared server proceeds with it still in
flight. Review 32 found the repair had no test proving the cleanup works.

**Fix.** A deterministic subcase that:

1. Makes `waitForContinue` **reject**.
2. Destroys the request.
3. Awaits its completion or rejection.
4. Proves the **next** shared-server request succeeds.
5. **Preserves the original wait error**, so the real cause is what surfaces.

A cleanup path with no test is a claim, not a guard.

---

## 4. The mutation table

Two new rows.

| # | Mutate | Must fail |
|---|---|---|
| 33 | the **data handler** rereads the live `recording` flag instead of `recordThisRequest` | the oversized mid-flight toggle test of section 3.2 |
| 34 | the **close callback** rereads the live `recording` flag | 5.2c's bounded zero-in-flight assertion |

Row 34's mutation is exactly this, per review 32:

```diff
- if (recordThisRequest) res.once('close', () => { inFlight -= 1; });
+ if (recordThisRequest) res.once('close', () => {
+   if (recording) inFlight -= 1;
+ });
```

**Run row 34 in isolation, by test name.** Under a deliberate close-counter leak
a whole-file run can stall on an unrelated test's cleanup and hide the named
failure.

### 4.1 The re-run set

**Rows 1 to 14, and rows 31 to 34.** Eighteen rows. Neither more nor fewer.

Rows 1 to 14 name recorder tests and this repair changes recorder tests. Rows 31
and 32 name the descriptor-faithful snapshot and the parsed-API guard. Rows 33
and 34 are new. Rows 15 to 30 are production-file and judge-proof mutations this
repair does not touch.

Record each row's exact unified diff, exact command and exit status. Every row
must fail its named test **by name**. A file-level timeout is not a pass.

The table runs **before** the gate.

### 4.2 Prove the mutation-tested bytes equal commit 9

Review 32 requires this, and nothing in the table means anything without it.

1. Record the repaired test file's `shasum -a 256` **before** the table runs.
2. Verify the sandbox baseline copy matches that hash.
3. Verify the worktree file's hash is **unchanged** after the table finishes.
4. After commit 9, verify it against the committed bytes:

```bash
git show HEAD:lib/__tests__/explicit-judge-equivalence.test.ts | shasum -a 256
```

All four must agree. If any differs, the table tested something other than what
shipped. Stop and report.

---

## 5. Scope. Two commits

```text
9   the final test repair          one test path
10  the governance and evidence    five paths
```

Commits 1 to 8 stand. Do not amend, revert, squash or rebase any of them.

### 5.1 Commit 9 changes exactly one path

```text
lib/__tests__/explicit-judge-equivalence.test.ts
```

No production source. No other test file. `judge-server-stub.ts` is **not**
changed: the stub already captures the decision correctly, and the gap is that no
test guards it.

### 5.2 Commit 10 changes exactly these five paths

```text
.gitignore
CDMSS-SAUL-REVIEW-32-17-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v20-17-AUG-2026.md
CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-3-17-AUG-2026.md
CDMSS-PROOF-PASS-2-SUPPLEMENTAL-3-REPORT-FOR-SAUL-17-AUG-2026.md
```

Four negation lines.

Saul review 31 is tracked already, inside commit 8's supplemental documents by
reference; review 32 is new and is tracked here. No earlier evidence file,
report, addendum or review is edited.

---

## 6. The gate

Nine numbered commands and the build pair, per addendum v15 section 6, with
command 6 in the approved no-`git add` form.

Start and end timestamps on every command, including command 7 and both builds.
Command 7 keeps its quotes by the heredoc method. Run the numbered commands
strictly in order and do not start one before the previous has exited.

Capture to a new directory. Overwrite nothing.

### 6.1 All six prior evidence digests are pinned

Review 32 supplied the three that were missing. All six must be verified before
commit 10, and none may differ.

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
db0df1afa205535422220d250895b0d0202d0f52ed1f28858b147abb357f9e15  CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
d6a94ec9cf71b0093fa56b2432ec6c7f3668f9884f39feebb349b5c3839added  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md
716bd5cd8ada6091c6b1efead83554e6ebf639dbc7e62f2b1319fca6fdb32be3  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-2-16-AUG-2026.md
```

---

## 7. Order of work

1. The orchestrator computes this document's digest and shows V the digest, the
   byte count and the line count.
2. **V approves explicitly, naming the digest.**
3. The orchestrator changes the status line, and nothing else.
4. The builder verifies the signature by the one-line substitution in section
   0.1, before any other work.
5. The repair in section 3.
6. `npm run typecheck`, then `npm test`.
7. The eighteen-row re-run set, with the byte-equality proof of section 4.2.
8. Commit 9.
9. The full gate, once, from commit 9.
10. The supplemental evidence and report, including the record of the approval
    exchange.
11. Commit 10.
12. The orchestrator verifies against the tree and reports to Saul.
13. **Saul administratively closes pass 2.** Then, separately, he releases pass 3
    and the push.

---

## 8. What this addendum does not do

- It does not edit addendum v19. Review 31 preserves it unchanged.
- It does not authorize any production source change.
- It does not authorize any path outside sections 5.1 and 5.2.
- It does not amend, revert, squash or rebase commits 1 to 8.
- It does not authorize a push. Four commits stay local, and the two from this
  pass will make six.
- It does not close pass 2. Saul closes it.
- It does not release pass 3, the pass 1 retrospective sweep, or the Cohere track.
