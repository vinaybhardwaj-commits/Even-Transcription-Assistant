# ETA — drift guard: block comments (G2). REFUTER VERDICT. 23 Sep 2026

`vinay/sql-comment-strip` **@ `3a4ef78`** (builder lx), one commit on `68fb60d`, **tests only**: `tests/support/sql-check.ts` and a new `tests/unit/sql-check.test.ts`. No production code, no migration. Closes the residual G2 from `ETA-E5-F1-REFUTER-RECHECK-23-SEP-2026.md`. Own detached worktree `/tmp/refute-sc`; nothing pushed. Mini kept out — every run on the Yoga fast runner.

Cutting a new branch rather than amending `68fb60d` is right: that sha has a PASS and is queued to merge, and this keeps the reviewed artefact untouched.

## PASS — 5 of 5 killed, including two attacks the builder did not name

- **H1 — G2 closed.** A `/* */` decoy quoting the five-value clause above a narrowed real clause now **dies**. The hole I found is shut.
- **H2 — nesting.** A **nested** decoy (`/* outer /* inner */ CONSTRAINT … */`) dies. This is the one that would have bitten a naive fix: strip to the *first* `*/` and the rest of the decoy becomes live text again, reopening G2 in a form that looks fixed. Handled Postgres-style, closing once.
- **H3 — the repo's `/** */` doc form**, which `0074` actually uses: dies.
- **H4 — regression control.** Disabling the quoted-string tracking is **caught**, so adding block stripping did not cost the `--`-in-a-value property that G6 pinned last round. A fix that quietly broke the previous fix is the thing worth checking, and it did not.
- **H5 — a block comment *inside* the `IN` list** (`/* 'tape_off', */`): dies. Postgres and the parser now agree that the value is gone, so the sets diverge from `CLOSED_BY` and the drift test fires. Before stripping, the parser would have counted a commented-out value as present — the inverse of G2 and, as far as I can tell, not previously considered by either of us.

### The disclosed caveat, checked and agreed

lx wrote into the header that this is **not a SQL parser**: dollar-quoted bodies (`$$ … $$`) are not treated as strings, so a comment marker inside one is still stripped. I checked reachability rather than accepting the framing: the guard only resolves `CONSTRAINT <name> CHECK` followed by `<column> IN (...)`, and every constraint it guards — 0113's `voice_centroid_domain_chk`, 0114's two — lives in a `CREATE TABLE`, not a `DO $$` block. 0115 *does* add a constraint inside a `DO $$` block, but it is not one the guard parses, and its text carries a newline between the name and `CHECK`, so the literal search would not match it anyway. **Correctly disclosed and correctly scoped**: a latent constraint on future shape, not a live hole.

The other disclosure — an unterminated block comment swallows the rest of the file, so the guard reports the constraint *missing* rather than guessing — is the right behaviour, and throwing loudly is the only honest option when the text runs out mid-comment.

### On the builder's own mutation run

lx reported that one of their five mutations first came back `NOAPPLY` from a mangled shell escape, and re-injected it through a file patch before counting it. That is the distinction this programme has had to learn twice — once on `yoga-test.sh --mutate`'s `patch_missing`, once on scribe3's exit-code contract — and it matters because **an unnoticed NOAPPLY row reads exactly like a passing mutation**. Reporting it unprompted is the behaviour that keeps a mutation table meaning what it says.

## Gate

- **Mine:** 5 mutations through the Yoga fast runner, 0 runner errors, worktree verified clean at `3a4ef78` afterwards.
- **The builder's, quoted as theirs:** `rc=0`, 174/174 files, 3,889 passed, build 14.5 s; sql-check 9/9, encounter-hypotheses 32/32, voice-centroid 26/26; `typecheck` and `typecheck:tests` clean locally first.

**Jev — not run.** A tests-only change to a helper Jev has never scored, whose correctness is established by mutation rather than by design judgement. Said plainly so the standing rule's exception is on the record.

**Verdict: PASS.** G2 is closed, the nesting case that would have made a naive fix look right is handled, the previous round's property survived the change, and the one thing this is not — a SQL parser — is written down where the next person will read it.
