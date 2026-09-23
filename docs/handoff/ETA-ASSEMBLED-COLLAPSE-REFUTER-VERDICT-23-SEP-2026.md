# ETA — assembled-transcript collapse. REFUTER VERDICT. 23 Sep 2026

`vinay/assembled-collapse` **@ `f6418bb`** (builder lx), one commit cut from production `c91264e`: `lib/stt/assembled-collapse.ts` (new, pure), `lib/stt/number-words.json` (new), two wiring points in `lib/stt/room-drain.ts`, and 168 lines of test. Own detached worktree `/tmp/refute-ac`, HEAD asserted. Nothing pushed. Mutations ran locally (438 ms baseline, 16 tests); cross-repo checks read `~/eta-router` read-only.

## PASS-WITH-FIXES — both root causes are addressed and the number exemption is pinned. The lexicon copy has already drifted, and one documented invariant is untested

### The two root causes are real and the fixes match them

Both faults were **structural, not decoding** — which is why the router's own guard never caught them:

1. Collapse ran **per segment** while text is stored **assembled**; three short segments each loop-free join into a loop. 13 of 17 residual lines were exactly that.
2. Indic engine output was **never collapsed anywhere** — the router collapses only whisper text, and IndicConformer/SraVaani never pass the whisper-shim. 9 of 14 rows were Indic script.

Wiring at both assembly points, with a fixed-point loop so it is idempotent and a no-op on text the router already cleaned, is the right shape.

### Mutations — 6 run, 4 killed

- **Y3 dies** — a unit containing a number is never collapsed. **The entire safety of fix (2) rests on this**, since Indic text is now collapsed for the first time, and it is pinned.
- **Y2 dies** — `MIN_REPEATS = 3`, so two repeats do not collapse.
- **Y5 dies** — a line identical after folding to its predecessor is dropped.
- **Y6 dies** — the lexicon JSON and its stored hash must agree. I verified the hash independently with their own method (`sha256(sorted(words).join("\n")).slice(0,16)`): **`08ffdfde64ecc886`, matches**.

### Y1 — lx's equivalence claim is correct, verified from the code

`if (words.length < MIN_REPEATS) return current;` survives removal. lx called it equivalent and they are right; I checked rather than accepted it:

```
words.length=2 -> plen starts at Math.min(Math.floor(2/3), 6) = 0  -> `plen >= 1` false, loop never runs
words.length=3 -> plen starts at 1                                  -> loop runs
```

The early return is a fast path, not a behavioural guard. No test should be written for it.

### FINDING — the lexicon copy has ALREADY drifted, and the hash cannot see it

lx asked for judgement on whether the sha256 is "good enough" given the list now lives in three places. It is weaker than they framed, because the drift is not hypothetical — **it exists today**.

**I ran the cross-repo comparison lx said is not possible from inside the ETA repo.** It is not possible *as a unit test in ETA*; it is entirely possible for a reviewer with both checkouts, and it took one command:

```
ETA lib/stt/number-words.json : 772 words
eta-router main (be40365)     : 770 words     <- what production runs
in ETA only: ['billion', 'million']
```

The JSON's own `source` field names the reason: `eta-router vinay/lexicon-export eta_number_words.py` — an **unmerged** branch. `million`/`billion` were added on `vinay/lexicon-export` (now `ffbe1c7`) and router `main` is still `be40365`. So the ETA copy is two words ahead of the shipped router.

**The direction is safe** — ETA exempts two words the router does not, so ETA collapses strictly less, and over-inclusion is the design's accepted direction. **Two words, no clinical impact.** But the structural point is what matters: the hash proves the JSON is internally consistent with itself and nothing more. It cannot detect that the copy was taken from a branch that has not shipped, which is exactly what happened on the first commit that used it.

**Recommendation:** the honest half is not the hash, it is the `source` field — and it is already doing more work than the hash, because it records *which* router state was copied. Make that testable rather than decorative: a CI step (or the Refuter, as here) with both repos checked out can compare the sets directly, and should compare against **router `main`**, not against whatever branch was convenient. Until then the guard's real strength is "a human remembers", and this commit is the case where the human copied from an unmerged branch.

### Y4 survives — a documented invariant nobody tests, in the dangerous direction

Replacing the exact-after-fold comparison with a two-character prefix match leaves the suite green. The header states the invariant plainly — *"identical after folding only, never fuzzy"* — and nothing pins it.

This matters more than a usual missing test because **looser matching collapses more**, and collapsing more is how clinical content is lost. The number exemption (Y3) protects doses; it does not protect a repeated instruction or finding whose words merely share prefixes. One test with two words sharing a prefix in a repeat position.

### On lx's remaining question, and what is still open

- **Indic spellings unreviewed by a native speaker.** The *mechanism* is pinned (Y3), so any word in the lexicon is protected; what cannot be tested from here is whether the lexicon *contains* every native-script dose spelling. That is the same open item as the router work and it is a human check, not a test. lx is right to keep flagging it rather than treat the lexicon as settled.
- **Not done, not ordered:** the collapse runs on the native transcript, not `asr.english`, so a looped translation is still stored as-is. Recorded so it is not lost.

## Gate

- **Mine:** 6 mutations locally, 0 errors, worktree asserted clean at `f6418bb`; cross-repo reads on `~/eta-router` were read-only.
- **The builder's, quoted as theirs:** rc=0, 174/174 files, 3,905 passed, build 15.0 s; assembled-collapse 18/18, room-drain 161/161.

**Jev — not run.** The substance is a cross-repo data comparison and a mutation result; a scalar score on the diff sees neither.

**Verdict: PASS-WITH-FIXES.** The diagnosis was right, both fixes match their causes, and the safety the Indic change depends on is pinned. Two fixes: one test for the never-fuzzy invariant, and a decision about whether "the other half is a human" is acceptable for a lexicon that has already drifted two words on its first use.
