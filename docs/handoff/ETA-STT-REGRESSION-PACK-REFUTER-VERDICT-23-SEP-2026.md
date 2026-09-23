# ETA — STT hallucination regression pack. REFUTER VERDICT. 23 Sep 2026

`vinay/stt-regression-pack` **@ `750d476`** (builder scribe3), one commit: `lib/stt/hallucination-collapse.ts` (new, 225 lines) and `tests/unit/stt-hallucination-regression-pack.test.ts` (27 tests). Own detached worktree `/tmp/refute-rp`, HEAD asserted. Nothing pushed. Mutations ran locally (415 ms baseline); the differential below read `~/eta-router` read-only, synthetic inputs only.

## PASS-WITH-FIXES — the rule it pins is pinned well. It diverges from the router on exactly the cases the rule exists for

### What is pinned, and pinned properly — 4 of 4 killed

- **P1 — the round-2 rule.** Replacing `identicalAfterFold` with a word-set comparison — i.e. reinstating round 1's Jaccard-on-sets rule, the one that **failed** review by merging a swapped-dose pair — **dies**. That is the single most important thing in the file and it is protected.
- **P4 — the folding set.** Widening `foldText` beyond case/punctuation/danda/whitespace dies.
- **P3 — `COLLAPSE_MIN_REPEATS = 3`**, so two repeats do not collapse.
- **P5 — `DEDUPE_MAX_GAP_S = 1.5`.**

The module is honest about itself in ways I would otherwise have had to find: it declares it is a **port, not the source of truth**, that the router is what runs in production, and that its `NUMBER_WORDS` is *"a small representative subset for these fixtures, not the 0-100 lexicon"*. It is test-only — the sole importer is its own test. All three statements are true; I checked each.

### FINDING — the port and the router disagree, on dose phrases

The header's stated purpose is that *"the SAME behaviour this repo depends on for clinical safety is pinned by this repo's own test suite, not only by a different repo's Python tests."* I tested that directly — the differential nobody inside either repo can run — feeding identical synthetic lines through the TS port and the router's live `_collapse_line` on `main`:

| input, ×3 | TS port | router `main` (production) |
|---|---|---|
| `pachas milligram` | **collapsed to one** | kept |
| `पचास milligram` | **collapsed** | kept |
| `aivattu milligram` | **collapsed** | kept |
| `pachhattar goli` | **collapsed** | kept |
| `half half half` | **collapsed** | kept |
| `the patient sat` | **collapsed** | kept |
| `one one one`, `ek ek ek` | kept | kept |
| `thank you doctor` | collapsed | collapsed |

**Six of eleven disagree, and every disagreement is a dose phrase the router protects and the port destroys.**

The cause is the declared subset: the port's lexicon is **24 words** against the router's **770**, and contains none of `pachas`, `पचास`, `aivattu`, `pachhattar`, `half` or `sat`. Within its own fixtures the pack is self-consistent — 27/27 — because those fixtures use only words the subset covers.

**So the pack is internally valid and its header claims more than it delivers.** It pins *a* collapse rule; it does not pin *the* behaviour this repo depends on for clinical safety, because on Indic and spelled-out dose numbers — the cases the number exemption was built for, and the ones I measured on this very rule at router r3 — the two implementations take opposite decisions. A regression pack that would stay green while the router's Indic dose protection regressed is not pinning the thing its header names.

**The fix is now available and was not when this was written.** lx's `assembled-collapse` branch adds `lib/stt/number-words.json` — the full 772-word lexicon with a reproducible hash — to this repo. `collapsePhraseLoops` already takes `numberWords` as a parameter, so the pack can consume the real lexicon with no change to the rule. That closes the divergence at its cause and makes the header's claim true. Failing that, narrow the header to say what it actually pins.

**Second-order, and worth a decision rather than a fix:** when both branches merge, `lib/stt/` will hold **two** collapse implementations — lx's `assembled-collapse.ts` (wired into `room-drain.ts`) and this one (test-only) — written the same day by different builders, both ported from the same router rule. That is defensible if the second is explicitly a pinned reference and consumes the same lexicon. It is not defensible if they drift, and today they already do.

## Gate

- **Mine:** 4 mutations locally, 0 errors, worktree asserted clean at `750d476`; the differential used synthetic phrases only and read the router read-only.
- **The builder's, quoted as theirs:** Yoga green before push, 174 files / 3,911 passed / 1 skipped; 27 tests; 12/12 hand-written mutants killed.

**Jev — not run.** The substance is a cross-implementation differential; a scalar score on one diff cannot see the other implementation.

**Verdict: PASS-WITH-FIXES.** The round-2 rule — the one whose round-1 predecessor failed review on a swapped dose — is correctly ported and well pinned, and the module is unusually honest about its own limits. The fix is to make it consume the real lexicon now that this repo has one, so that the behaviour it pins is the behaviour production actually runs.
