# ETA — router number words round 3. REFUTER RE-CHECK. 23 Sep 2026

`~/eta-router` `vinay/router-numbers` **`f7f1954` → `be40365`** (builder lx), one commit: `router_server.py` (+273/−49) and `test_stt_hygiene.py` (+41). Re-check of the FIX in `ETA-ROUTER-NUMBERS-REFUTER-22-SEP-2026.md` — the list was incomplete in the dangerous direction, and its native-script half had drifted from its romanised half. Own detached worktrees `/tmp/refute-rn3` and `/tmp/refute-rn2`; production `~/eta-router` on `main` untouched; nothing pushed. Every probe below uses synthetic phrases — no transcript text was read. All runs used an isolated `ETA_JOBS_DIR`.

## PASS — the fix is structural: the two scripts can no longer drift, because neither is written by hand

The hand list is replaced by generation. Hindi 0–100 is a full table (the language is irregular); Kannada 0–20 and the round tens are a table with 21–99 derived by sandhi; fractions, ordinals, magnitudes and English remain a short list. **Every row carries both scripts**, so parity is a property of the shape rather than of anyone's diligence. That is the right answer to a finding about drift.

### Every gap I named is closed — checked by running the predicate, not by reading the diff

| | |
|---|---|
| romanised dose numbers | `pachchis` 25, `pachhattar` 75, `saath` 60, `sattar` 70, `assi` 80, `nabbe` 90, `hadinaidu` 15, `aivattu` 50 — **all recognised** |
| the 9 Devanagari entries that had drifted | `पचास` `पंद्रह` `तीस` `चालीस` `तेरह` `चौदह` `सोलह` `सत्रह` `अठारह` `उन्नीस` `चौथा` — **all recognised** |
| Unicode numerics | `½` `¼` `¾`, Devanagari `५०`, Kannada `೫೦` — **all recognised** |

And the collapse behaviour, on the exact synthetic cases from my r2 table — every one that **COLLAPSED** then is **kept** now:

```
'पचास milligram' x3        6 -> 6  kept        'pachhattar milligram' x3  6 -> 6  kept
'पंद्रह milligram' x3       6 -> 6  kept        'aivattu milligram' x3     6 -> 6  kept
'½ tablet' x3              6 -> 6  kept
```

### Parity and completeness verified independently, not taken from their test

```
hi: 0-100 complete=True   numbers with NO romanised form=[]   with NO native form=[]
kn: 0-100 complete=True   numbers with NO romanised form=[]   with NO native form=[]
HINDI_NUMBERS rows: 101   rows missing a script: 0
generated forms NOT recognised by is_number_token: 0
```

The Kannada derivation is linguistically shaped rather than a blind chop — vowel-initial ones join with sandhi, consonant-initial ones take both the clipped and the `-a-` linking forms, and the native branch applies the matching vowel sign. Spot-checked against real Kannada: `ippattondu` 21, `ippattaidu` 25, `aivattondu` 51, `eppattaidu` 75, `tombattombattu` 99 — all correct. The `elif o[0] != "y"` branch skips the `yelu` spelling of 7, which sounded like a gap until I checked: 27 is still covered as `ippattelu` / `ippatteelu` via the `elu`/`eelu` variants, and no number 21–99 is left without a form in either script.

### The check that matters most for a hand-list → generated rewrite: **nothing was lost**

Regenerating is exactly how a hand-maintained list loses entries nobody remembers adding. Diffing the two lexicons directly:

```
ascii lexicon r2: 136 -> r3: 513      added: 377      removed: 0
```

**Zero removals.** Not one word that was protected at `f7f1954` is unprotected at `be40365`. In a change whose whole risk is "the generator doesn't know what the hand list knew", that is the single most important number in this review.

### The cost of the larger vocabulary, measured rather than asserted

Over-inclusion is the design's own accepted direction — *"over-inclusion only leaves a loop in place; a missing word could change a dose"* — but the fix nearly quadrupled the Latin-script lexicon, so the cost deserves a number. Against `/usr/share/dict/words`:

- **6 new** English-dictionary collisions: `aru`, `assi`, `bais`, `bis`, `sat`, `tin`.
- **59 pre-existing** (mostly the English number words themselves, which are intended).

So coverage grew 3.8× while accidental collisions grew by 10%. Demonstrated cost, synthetic:

```
'the patient sat' x3   9 -> 9  kept          'a tin box' x3   9 -> 9  kept
```

`sat` is the one worth naming — *"the patient sat up"* is ordinary OPD English, and a hallucinated loop containing it will now survive into the transcript. That is the correct trade by the design's own rule, and I am not asking for it to be reversed; it should simply be a known and stated consequence rather than a surprise later. `tin` (the `teen`/`tin` spelling of Hindi 3) is the same shape.

**The feature still works** — a repeated phrase with no number still collapses: `'thank you doctor'` 9 → 3, `'please come again'` 9 → 3.

### Mutations — 8 of 8 killed

Six against the new machinery: the Unicode-numeric branch, the native half reaching the lexicon, the romanised half reaching it, the extras being merged, Kannada 21–99 being generated at all, and the vowel-sign sandhi join. Two **regression controls** on the rule this all exists to serve — a repeated phrase holding a number never collapsing, and a single repeated number word never collapsing — both still die, so the rewrite did not weaken the exemption itself.

**Runner:** Python `unittest`, not vitest — the Yoga runner is wired to the ETA app's suite, so these ran on the Mini, lightweight (~9 s per run), under neither lock, as at r2. Full router suite **119 tests, OK**.

### Trivia

`"lakh"` appears twice inside the `NUMBER_WORDS_EXTRA` frozenset literal. Harmless — it is a set — but it is the kind of thing the generated half can no longer suffer from, and worth a glance next time the extras are edited.

## Jev (V's standing rule) — after my read, probes and mutations; neutral context

Task, source diff and neutral context; none of my findings. Scores **6.3–7.0**, all `low`.

- **correctness 6.3, its top priority** ("the implementation appears to rely on an unsafe or incorrect assumption") → **largely REJECTED, and I checked rather than dismissed it.** The load-bearing assumption is `_kn_compound`'s docstring — *"Every Kannada tens word ends in -ttu / ತ್ತು"* — which the `t[:-1]` / `t[:-2]` chops depend on. I tested its consequences directly: all 101 Kannada numbers present, none missing either script, no degenerate forms, every generated form recognised, and the spot checks are real Kannada. Even if a future tens row broke the assumption, the chop would produce a non-word, which is over-inclusion and therefore harmless by design. Real assumption, benign failure mode.
- **duplication 7.0** ("knowledge that should change together is represented independently") → **CONFIRMED but trivial**: the repeated `"lakh"` literal. The substantive duplication — the two scripts as independent hand lists — is exactly what this commit removed.
- **maintainability 6.4 / cognitiveComplexity 6.5** ("special cases add disproportionate mental overhead") → **fair and accepted**: the sandhi branches are genuinely the hardest part of the file. They are commented with worked examples in both scripts, which is the right mitigation for a rule that cannot be made simpler without being made wrong.
- **performance 6.9** ("meaningful computation repeated unnecessarily") → **REJECTED**: `_build_number_words()` runs once at import and the result is a module-level `frozenset`; `is_number_token` does a set lookup.

**Verdict: PASS.** The finding is closed at the level it was raised — not by adding the missing words, but by removing the possibility of a word being missing from one script and not the other. Nothing was lost in the rewrite, the derivation is sound, the exemption it serves is still mutation-pinned, and the one cost — six new English collisions, of which `sat` is the live one — is the direction the design chose on purpose.
