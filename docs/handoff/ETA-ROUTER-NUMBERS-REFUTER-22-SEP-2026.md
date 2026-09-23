# ETA — router number words (round-2 low findings). REFUTER VERDICT. 22 Sep 2026

`~/eta-router` `vinay/router-numbers` **@ `f7f1954`** (builder lx), one commit on `main` `fe2fca3`: `router_server.py`, `test_stt_hygiene.py`. Contract (`weekA-2230b.md` §lx): **(1)** complete the number-word list — English, Hindi and Kannada ordinals/cardinals commonly spoken, and the spoken fractions (dedh, dhai, saade …); **(2)** a repeated phrase that contains a number must not collapse. Own detached worktree `/tmp/refute-rn`; production `~/eta-router` on `main` untouched; nothing pushed. No transcript text was read — every probe below uses synthetic phrases.

## PASS-WITH-FIXES — the mechanism is right and fully tested; the list is not complete, in the dangerous direction

### (2) The phrase exemption — CONFIRMED, and mutation-tight

A repeated phrase holding any number token no longer collapses (`long_enough … and not any(is_number_token(w) for w in phrase)`); a single number word still never collapses; a hyphen- or slash-joined token (`ek-ek`, `1-0-1`, `one/two`) counts as a number if any part is. **Router tests: 114 pass. Mutations: 13 of 13 killed** — both exemption paths, the joiner split, the digit rule, and every sampled word (saade, dedh, dhai, kaalu/mukkalu, first/second, lakh/crore, Devanagari saadhe, the Hindi teens). Everything that *is* in the list is pinned.

### FIX — (1) the list is not complete, and the gaps are dose numbers

Mutation testing cannot find a word that was never added, so I measured coverage directly against the branch's own `is_number_token`:

| band | covered |
|---|---|
| the named fractions (dedh, dhai, saade, paune, kaalu, mukkalu) and 1–3 in all three languages | **9 / 9** |
| Hindi 21–99 dose numbers — `pachchis` (25), `pachhattar` (75), `saath` (60), `sattar` (70), `assi` (80), `nabbe` (90), … | **0 / 11** |
| Kannada 13–19 — incl. `hadinaidu` (15) | **0 / 7** |
| Kannada tens 40–90 — incl. `aivattu` (50) | **0 / 6** |
| `½` (a Unicode fraction; `'½'.isdigit()` is False) | missing |

**And the native-script half has drifted from the romanised half.** Of 18 Hindi numbers the romanised list carries, **9 are missing in Devanagari** — `तीस` (30), `चालीस` (40), `पचास` (50), `तेरह` … `उन्नीस` (13–19, incl. 15 `पंद्रह`), `चौथा`. The list carries native-script entries at all because transcripts contain native script — the author's own premise — so the same number is protected in one script and not the other.

**What a missing word does**, on the branch's own `_collapse_line` (threshold `COLLAPSE_MIN_REPEATS = 3`), synthetic phrases:

```
covered   'ek goli' x3                  6 -> 6  kept
covered   'one one one'                 3 -> 3  kept
covered   'pachas milligram' x3         6 -> 6  kept      (50, romanised)
MISSING   'पचास milligram' x3           6 -> 2  COLLAPSED (50, Devanagari)
MISSING   'पंद्रह milligram' x3          6 -> 2  COLLAPSED (15, Devanagari)
MISSING   'pachhattar milligram' x3     6 -> 2  COLLAPSED (75)
MISSING   'aivattu milligram' x3        6 -> 2  COLLAPSED (50, Kannada)
```

The value survives once; what is lost is the repetition — and the design's own rule, in its own comment, is that *"a missing word could change a dose"*, the reason exact repeats of dose phrases are exempt at all. The patterns most likely to encode a regimen (`one one one`, `ek ek ek`) use 1–3, which *are* covered, so this is a gap in coverage rather than a live failure of the common case. But the order said *complete*, and over-inclusion is free by the design's own reasoning.

**Fix (additive, zero-risk by the design's own logic):** add the Hindi 21–99 tens and the common dose compounds (25, 75 at minimum), Kannada 13–19 and 40–90, and bring the Devanagari and Kannada-script lists up to the romanised ones; add a test that asserts every romanised entry has its native-script counterpart, so the two halves cannot drift again. Consider `½` via `unicodedata.numeric`.

### Process note — `ETA_JOBS_DIR`

The test header asks for `ETA_JOBS_DIR=$(mktemp -d)`. My **first** test run and two import probes omitted it. I checked rather than assumed: importing `router_server` only does `os.makedirs(JOBS_DIR, exist_ok=True)` (a no-op on the existing store); the only thing that deletes job files, `_cleanup_old_jobs`, runs solely from the `/route/job` submit handler (`:1644`), and no test reaches that handler. Production's job store (9 files) was untouched. Every run after that used an isolated `ETA_JOBS_DIR`.

**Runner:** these are Python `unittest` runs, not vitest, typecheck or a Next build, and the Yoga runner is wired to the ETA app's suite — so they ran on the Mini, lightweight (~9 s), under neither lock.

## Jev (V's standing rule) — after my read, rerun and mutations; neutral context

Task, source diff and neutral context; none of my findings. Scores **5.1–7.0**, all `low`.

- **correctness 5.1** ("requested behaviour appears missing or incomplete") → **CONFIRMED independently**: I gave Jev no coverage information; the measured gaps above are the missing behaviour.
- **duplication 6.5** ("knowledge that should change together is represented independently") → **CONFIRMED, concretely**: the romanised and native-script lists encode the same numbers separately, and **9 of 18** have drifted — the sharpest part of the FIX, and a lead I would not have measured without it.
- **changeability 6.8** ("a domain rule scattered across locations") → **CONFIRMED, minor**: `EN_FUNCTION_WORDS` (the router's guard list) and `NUMBER_WORDS` both carry English number words.
- **maintainability 6.3, cognitiveComplexity 6.8, consistency 6.6** → **no action**; nothing named that survives inspection.

**Verdict: PASS-WITH-FIXES.** The exemption logic is correct and every word in the list is test-pinned. The list is not complete, the missing words are dose numbers, and the native-script half has fallen behind the romanised half — so whether a repeated 50 mg survives depends on which script the engine wrote it in.
