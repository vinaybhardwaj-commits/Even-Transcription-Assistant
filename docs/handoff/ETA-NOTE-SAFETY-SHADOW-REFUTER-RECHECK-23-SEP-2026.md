# ETA — note-safety shadow, findings 1+2 fix. REFUTER RE-CHECK. 23 Sep 2026

`vinay/note-safety-shadow` **@ `d232232`** (builder fleet, was `ca83445`). Own detached worktree `/tmp/refute-ns2`, HEAD asserted, clean after every run. **No real note or transcript text used or printed**; the synthetic sentinel is invented text. Baseline verified green pristine: **36/36**.

**5 mutations, 4 killed, 1 survived** — the survivor is a narrow residual of FINDING 2, not a regression.

## PASS — FINDING 1 is closed; FINDING 2 is closed in the common case, open in one corner

### FINDING 1 — closed, and the negative test has teeth

`JevHttpError` now composes its message through `safeMessage`, which reads **only** a `code` string field out of a JSON body, bounded to 64 characters, and falls through to `jev http <status>` for anything else. `body` survives as a separate field for debugging, which is the right split — the raw text is still available to a developer holding the object and can no longer ride into a log through `.message`.

| mutation | result |
|---|---|
| **R1** revert to the pre-fix `` `jev http ${status}: ${body.slice(0,200)}` `` | **killed, 7 tests** |
| **R2** the non-JSON fallback includes the raw body (64 chars) | **killed, 4 tests** |

R1 is the one that matters: the exact leak I demonstrated this morning now fails seven tests. R2 was the edge I had queued to probe myself — a body that is *not* JSON — and it is already pinned, so the fallback cannot quietly become a leak.

Keeping the old, toothless test alongside the new negative one is the right call: it still covers "the encounter id is present", which is a real property, and the new test covers the absence. **A test that asserts presence and a test that asserts absence are different tests**, and the original's failure was only ever that its name claimed both.

Residual, noted and not a finding: if a provider ever placed note text in a JSON `code` field, 64 characters of it would reach the message. `code` is conventionally an error code, and the bound is tight. Worth knowing, not worth acting on.

### FINDING 2 — closed where it was demonstrated, open in the type-mismatch corner

`isValidChoice` rejects a `choice` outside the question's own registered `criteria` **before the row is built**, and the rejection is logged as metadata only — `questionId`, `promptVersion`, `subjectType`, `choiceLength` — never the value. The rejected answer takes the same "Jev did not answer this key" path rather than a new one, which is the cheaper shape to reason about.

| mutation | result |
|---|---|
| **C1** `isValidChoice` always returns true | **killed, 3** |
| **C2** the call-site gate removed | **killed, 3** |
| **C3** `question.type !== "choice"` returns **false** instead of true | **survives** |

**C3 is the residual, and it is the original hole in miniature.** The call site already guards `answer.type === "choice"`, so `isValidChoice`'s early return is reached in exactly one state: **the answer is a `choice` and the question is not**. Today that state is **accepted** — a free-string `choice` on a `noul` or `score` question is persisted unvalidated, which is precisely what FINDING 2 was about.

The existing test at `jev-ask.test.ts:215` reads as if it covers this — *"noul and score answers are never subject to the choice check"* — but it exercises noul/score **answers**, which the call-site guard already excludes. Nothing exercises a choice **answer to a non-choice question**. Same shape as the toothless log test: the name describes the neighbouring case.

**It is narrow.** It needs Jev to return an answer whose type contradicts the question's declared type, i.e. a malformed response rather than a merely wrong one. But it is one line — the mutant's own behaviour, rejecting the mismatch, is arguably the correct one, and a mismatch is a better reason to refuse than to accept. One test with a `score` question and a `choice` answer pins it either way.

### Their gate, quoted as theirs

Local suite 3890/3890 non-Docker green, 0 regressions. Gate run `20260923T115958Z-d232232-16950`: RESULT ok, 190/190 files, 4167 passed / 1 skipped, build compiled, `check:silent` the same 9 accepted findings. I did not re-run it.

## Verdict: PASS
FINDING 1 is closed at the right level — in `lib/jev/`, once, where the string is built, so every future caller inherits the fix rather than having to remember it. FINDING 2 is closed for the case I raised. C3 is a one-line follow-up, not a blocker, and not a reason to hold flag-on: it needs a malformed answer type, whereas the leak I found needed only an ordinary validation error.
