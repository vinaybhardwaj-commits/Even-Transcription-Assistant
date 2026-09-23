# ETA — lexicon: the self-erasing check, the router merge, and the drift script. REFUTER RE-CHECK. 23 Sep 2026

Two shas (builder lx): `~/eta-router` **`5e841f0`** (now router `main`) and ETA **`d1d9ec1`** on `vinay/assembled-collapse`. Closes the finding in `ETA-LEXICON-EXPORT-F1-REFUTER-RECHECK-23-SEP-2026.md` and the cross-repo drift in `ETA-ASSEMBLED-COLLAPSE-REFUTER-VERDICT-23-SEP-2026.md`. Own detached worktrees, HEADs asserted; the router checkout was dirtied and restored by me deliberately, as one of the tests below.

## PASS — both findings closed, and I reproduced each rather than reading the evidence

### The self-erasing check is fixed — my own reproduction, not theirs

The finding was that `test_export_is_what_the_generator_writes` regenerated **over the committed file**, so a real failure repaired itself and passed on the next run. I reproduced the scenario against the fix: hand-delete one word from the committed export, then run the suite repeatedly.

| | `ffbe1c7` (before) | `5e841f0` (now) |
|---|---|---|
| run 1 | FAILED | **FAILED (3 failures)** |
| run 2 | **passed** — file rewritten | **FAILED (3 failures)** |
| the hand edit afterwards | **gone**, silently restored | **still there** |

That is the whole finding, closed. The generator now takes an explicit output path (argv or `ETA_LEXICON_OUT`, the committed file still the default for a deliberate regenerate) and the test writes into a temp directory. lx went further than the fix required: the test also asserts the committed file is unchanged **byte for byte and by mtime**, so *a check that rewrites what it checks now fails in its own right* rather than merely stopping doing it.

### The cross-repo drift is resolved, and now has a guard

My `f6418bb` finding was that ETA's copy (772 words, from an unmerged branch) was two words ahead of router `main` (770). Router `main` is now `5e841f0`, and ETA's `number-words.json` is regenerated from **main's committed file read through git** — 772 words, hash `08ffdfde64ecc886`, provenance `eta-router main 5e841f0`. Both sides agree.

**`scripts/check-number-words.sh` is the one-line hash comparison I recommended.** I ran all four paths myself rather than accepting the claim:

| case | result |
|---|---|
| in step | `in step — lexicon 08ffdfde64ecc886 (router main 5e841f0)`, **exit 0** |
| ETA hash altered | `DRIFT — ETA deadbeef… vs router main 5e841f0 08ffdfde…; regenerate`, **exit 1** |
| no router checkout | `no git checkout at …/eta-router — cannot check`, **exit 2** |
| **uncommitted edit in the router checkout** | **ignored — exit 0, router tree left clean** |

The fourth is the one that matters and it is the one I would have got wrong: reading through `git` rather than the working tree means a colleague's half-finished edit in `~/eta-router` can neither raise a false drift nor mask a real one. lx built that deliberately.

Recording it in `CLAUDE.md` as a **Mini-side** gate step is also right — the Yoga has no `~/eta-router` and would only ever report "cannot check", which is a guard that always abstains.

### Two errors of my own during this verification, both caught before reporting

1. My first reproduction used an anchor that did not match the export's formatting (words are comma-separated on shared lines, not one per line). The deletion never happened, so three "passes" proved nothing. I noticed because the assertion I had written to catch exactly that fired.
2. I then measured the "cannot check" exit as `0` — because I had piped the script into `head` and read **`head`'s** status, not the script's. Re-run without the pipe: **exit 2**, as claimed.

Both are the same family as the errors I have been finding in others' work all day: measuring the wrong thing and believing the number. Recorded because a verification I got wrong twice before getting right is worth less if only the third attempt is on the record.

### Noted for Fable, from lx's report

- **A launchd label discrepancy:** the service on this Mini is `com.vinaybhardwaj.eta-router`; the order named `uk.llmvinayminihome.eta-router`, which does not exist here. Worth correcting in whatever order carries it, before someone scripts against the wrong label.
- **lx's own correction, which is the right instinct:** their first Hindi probe let whisper win, so translation returned `skip:english` and the Indic path was never exercised. They noticed and reran with `candidates=hi` to force the route. A probe that passes without testing the thing is the failure mode this programme has hit repeatedly today.
- The restart was verified on the served artefact, not the repo: old pid 6936 → new 57831, `/healthz` 200, and the served `router_server.py` hashing to HEAD's blob. That is the "deployed versus running" distinction again, and lx made it unprompted for the second time today.

## Gate

- **Mine:** the reproductions above, plus all four drift-script paths; both worktrees and the router checkout verified clean afterwards.
- **The builder's, quoted as theirs:** router suite 125/125; ETA `d1d9ec1` rc=0, 3,910 passed, build 28.5 s, assembled-collapse 21/21.

**Verdict: PASS.** The check no longer destroys the evidence it exists to preserve, the two lexicon copies agree and are now compared by a script that reads through git, and the guard is filed where it can actually run. The ETA branch remains unmerged.
