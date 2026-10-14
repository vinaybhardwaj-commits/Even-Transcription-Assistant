# CDMSS rerank telemetry — Addendum v21. Two corrections to v20

Date: 17 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `0e0503b` (commit 9)
Authority: **Saul review 31**, as corrected by **Saul review 32**.

Narrow. It corrects one false statement in addendum v20, authorizes the path that
statement wrongly assumed was covered, and supplies the one item the builder
cannot author. It changes nothing else.

The builder stopped before commit 10 rather than work around either item. That
was correct.

---

## 0. Signature

```text
STATUS: SIGNED by V, 17 August 2026, over digest a10e18a33539857ff0ddc06dfb067a652c1d39ff3b65efe1e62681b31bf6f88e
```

### 0.1 How this document gets signed, and how a reader verifies it

Identical to addendum v20 section 0.1, and repeated here so this document is
self-contained.

1. The orchestrator writes this document complete and leaves the status line
   reading `UNSIGNED`.
2. The orchestrator computes `shasum -a 256` over those bytes and shows V the
   digest, the byte count and the line count.
3. V gives explicit approval in the orchestration thread, naming the digest.
4. The orchestrator then changes **the status line and nothing else**, to
   `STATUS: SIGNED by V, <date>, over digest <digest>`.
5. **No other byte changes at signing, before it, or after it.**

**To verify**, replace the single line beginning `STATUS:` with the exact text
`STATUS: UNSIGNED`, hash the result, and require equality with the digest named
in that line. If a verifier has to add, delete or move any other line to make the
digest reproduce, **the signature is invalid and this document is unauthorized.**

---

## 1. Erratum. v20 section 5.2 states a falsehood

Addendum v20 section 5.2 reads:

> Saul review 31 is tracked already, inside commit 8's supplemental documents by
> reference; review 32 is new and is tracked here.

**The first clause is false.** A citation inside a report is not a tracked file.

```console
$ git ls-files --error-unmatch CDMSS-SAUL-REVIEW-31-17-AUG-2026.md
error: pathspec 'CDMSS-SAUL-REVIEW-31-17-AUG-2026.md' did not match any file(s) known to git

$ git log --oneline --all -- CDMSS-SAUL-REVIEW-31-17-AUG-2026.md
                                   (no output — the file is in no commit)
```

The file sits in the worktree root, ignored and untracked, exactly as v13 and
review 24 did before addendum v14 caught the same class of error. **This is the
orchestrator's error**, and it is the second time in this programme that a
governance document was assumed tracked because it had been mentioned somewhere.

Two consequences the builder observed and reported rather than worked around:

1. The commit 9 ignored check showed **three** `!! CDMSS-` lines. Kickoff v2
   section 6 predicted two.
2. The post-commit-10 check `! git status --porcelain --ignored | grep -q
   '^!! CDMSS-'` would **exit non-zero** even after a correct commit 10, because
   review 31 would still be ignored.

---

## 2. Correction one. Commit 10 carries seven paths

Addendum v20 section 5.2 is superseded. Commit 10 changes exactly these seven
paths:

```text
.gitignore
CDMSS-SAUL-REVIEW-31-17-AUG-2026.md
CDMSS-SAUL-REVIEW-32-17-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v20-17-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v21-17-AUG-2026.md
CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-3-17-AUG-2026.md
CDMSS-PROOF-PASS-2-SUPPLEMENTAL-3-REPORT-FOR-SAUL-17-AUG-2026.md
```

**Six negation lines**, one for each document above. `.gitignore` itself takes no
negation.

That set is exactly the five documents currently ignored, plus this addendum.
After commit 10, no CDMSS root document remains ignored, and the section 8 check
exits zero.

Nothing else about commit 10 changes. It is still governance and evidence only,
still edits no earlier evidence file, report, addendum or review, and still
leaves addendum v19 untouched.

---

## 3. Correction two. The commit 9 ignored expectation was wrong

Kickoff v2 section 6 stated that the check would show two lines at that phase. It
showed three. The third was review 31.

The builder was right to report the discrepancy rather than proceed. **Commit 9
is not affected** — it is a test-only commit at `0e0503b`, its authorized path
set is unchanged, and the ignored check is an observation, not a gate on its
content.

No rerun of commit 9, the mutation table or the gate is required.

---

## 4. The v20 approval exchange, for section 7 of the supplemental-3 report

Addendum v20 section 0.1 places this record in the report rather than in v20
itself, because narrative added to v20 after approval would falsify the payload V
approved. The builder cannot author it. **Reproduce this section verbatim as
section 7 of the report.**

> **The approval of addendum v20.**
>
> The orchestrator wrote addendum v20 complete, with every correction from Saul
> review 32 already in it, and left the status line reading `UNSIGNED`. It
> computed the digest of those bytes and showed V, in the orchestration thread on
> 17 August 2026:
>
> ```text
> 487a045e8c1089d1c49bf899dbcd64f5a3fee0d8b085d098eb3bd7ad08ebe3e6
> 12439 bytes, 321 lines, one STATUS: line reading UNSIGNED
> ```
>
> V replied:
>
> > ok. its approved
>
> **That reply did not name the digest**, which addendum v20 section 0.1 step 3
> requires. The orchestrator declined to treat it as a signature and put two
> options to V: name the digest, or instruct the orchestrator to sign and record
> the deviation in this report.
>
> V replied:
>
> > 487a045e
>
> The orchestrator then changed the status line and nothing else. Verification,
> by the one-line substitution rule:
>
> ```text
> lines differing from the reconstructed unsigned document : 1
> reconstructed digest : 487a045e8c1089d1c49bf899dbcd64f5a3fee0d8b085d098eb3bd7ad08ebe3e6
> reconstructed bytes  : 12439
> VERDICT              : VALID
> ```
>
> An earlier draft of v20 was approved at digest `6d6c370b…` and then signed
> together with an added narrative section, so the signed bytes were not the
> approved bytes. Saul review 32 rejected it. Addendum v20 section 1.2 records
> that failure. This exchange is the corrected process, and it held: the builder's
> first run of the signature script exited 1 against an unsigned v20 and it
> stopped, doing no work.

---

## 5. What this addendum does not do

- It does not edit addendum v19 or addendum v20. v20's section 5.2 is superseded
  by section 2 above, not rewritten in place.
- It does not authorize any production or test source change. Commit 9 stands as
  built.
- It does not require any rerun of the repair, the mutation table or the gate.
- It does not amend, revert, squash or rebase commits 1 to 9.
- It does not authorize a push. Five commits are local, and commit 10 makes six.
- It does not close pass 2. Saul closes it.
- It does not release pass 3, the pass 1 retrospective sweep, or the Cohere track.
