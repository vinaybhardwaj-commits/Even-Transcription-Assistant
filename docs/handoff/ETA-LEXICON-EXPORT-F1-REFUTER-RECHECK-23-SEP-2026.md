# ETA — lexicon export, the F1 fix. REFUTER RE-CHECK. 23 Sep 2026

`~/eta-router` `vinay/lexicon-export` **@ `ffbe1c7`** (builder lx), one commit on `90c7178`. Re-check of F1 in my 23 Sep message — the parity test was unsatisfiable on the commit that contained it. Own detached worktree `/tmp/refute-lex2`, HEAD asserted; production `~/eta-router` on `main` untouched. Python `unittest`, run on the Mini (~0.3 s), under neither lock.

## PASS-WITH-FIXES — F1 is properly fixed. A different guard in the same file rewrites the artefact it guards, and its failure erases itself

### F1 is closed, and closed with the better of the two options

The provenance line no longer names the checkout:

```
Source: eta-router router_server.py (NUMBER_WORDS), 772 words, lexicon sha256 08ffdfde64ecc886.
```

The suite now **passes on the commit that contains the file** — 6/6 — and I proved the underlying property independently rather than trusting the green: regenerating at `ffbe1c7` produces a **byte-identical** file (15,266 bytes each way). The self-referential trap is gone.

lx took option 2, which was the right one. The hash is of the **words**, so it is reproducible by anyone and, as the new test's name says, *"the provenance line names the WORDS, so a reader can verify it without the repo"*. A commit sha could never offer that: two commits can carry the same lexicon and one commit can change it.

**An unplanned benefit worth naming.** That same hash — `08ffdfde64ecc886` — is what ETA's `lib/stt/number-words.json` stores. So the cross-repo drift check I recommended on `assembled-collapse` is now a **one-line hash comparison** rather than a set comparison. The mechanism is half-built; nothing yet performs the comparison, and the drift I found there (ETA 772 from an unmerged branch vs router `main` 770) still stands.

### Mutations — 4 of 5 killed; Z1 was my own spec error

Z2 (a hand-edited header hash), Z3 (a router lexicon change without regenerating), Z4 (removing `sorted()` from the generator) and Z5 (the header's word count) all die. **Z1 was a `PATCH-MISS` — my anchor did not match the export's formatting.** That is a defect in my spec, not a result; the property it aimed at (a hand-edited word) is covered by Z2, Z5 and the regenerate-and-compare test.

### FINDING — the parity test rewrites the file it is guarding, and a second run turns the failure green

`test_export_is_what_the_generator_writes` creates a `TemporaryDirectory()` and runs the generator with `cwd=HERE` — but `tools_export_lexicon.py` computes its output path from **its own location**:

```
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "eta_number_words.py")
```

`cwd` has no effect on that. **The temp directory is created and ignored, and the generator overwrites the real, committed `eta_number_words.py` every time the test runs.**

On a consistent tree this is invisible — it rewrites identical bytes, which is why my byte-comparison above passed with a clean worktree. On an inconsistent tree it is destructive, and I measured it. Changing the router's lexicon without regenerating, then running the suite twice:

```
run 1:  FAILED (failures=3)          worktree: M eta_number_words.py  M router_server.py
run 2:  (no failure)                 [shim] export: 773   worktree: M eta_number_words.py
```

**The guard fires once, silently performs the very regenerate it was meant to demand, and passes thereafter.** Re-running a failing test is the most natural thing a developer does, and it turns this one green while leaving a modified committed artefact behind. In CI, a second invocation on the same checkout would be a no-op guard.

This is the same class as F1 — a test whose own mechanics defeat its purpose — but the opposite failure mode: F1 was **permanently red** and therefore ignorable; this is **red once then green**, which is worse, because a self-erasing failure looks like a flake that "fixed itself".

**Fix:** give `tools_export_lexicon.py` an output path (argv or env, defaulting to the current location) and have the test pass its temp path. The test then compares without touching the checkout. Worth also asserting the working tree is unchanged after the suite, so a regression here announces itself.

### Noted, and correct

The shim list is **reported, not asserted** — `[shim] words: 772 | export: 772 | missing from shim: 0`. lx's reasoning holds: MiniBot owns that file, and a test asserting on someone else's artefact fails when they change it. Reporting keeps the information without claiming ownership.

## Gate

- **Mine:** 5 mutations plus a two-run side-effect experiment, on the Mini; worktree restored and verified clean at `ffbe1c7` afterwards.
- **The builder's, quoted as theirs:** the suite as committed.

**My harness caught the side effect only because it asserts the worktree is clean after the run** — the check reported `NO -- M eta_number_words.py`, which is what led me to it. That assertion exists because of this morning's stale-worktree incident; it earned its place here.

**Jev — not run.** A provenance-line change and a test-mechanics finding; a scalar score on the diff sees neither.

**Verdict: PASS-WITH-FIXES.** F1 is closed properly and the hash is now a genuinely portable identifier that makes the cross-repo check cheap. The fix to make is in a different guard in the same file: it must not write to the checkout, and its failure must not erase itself on the next run.
