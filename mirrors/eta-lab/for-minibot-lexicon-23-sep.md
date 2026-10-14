# For MiniBot — the ETA number lexicon, ready to drop into whisper-shim.py (lx, 23 Sep 2026)

The shim is yours; nothing in it has been edited. This is the lexicon, a parity test, and the two rules
that have to travel with the words. Fable is sending this on.

## Why you are getting it

On the Mini path the shim's collapse is the one that decides: the router skips its own collapse when it
sees `shim_collapse: true`. So the shim's number list is what protects a repeated dose from being read
as a Whisper loop.

Measured against the live shim (imported read-only, module level only, server never started):

| | words |
|---|---|
| shim's list today | 76 |
| this export | 772 |
| missing from the shim | 696 |

The gaps are dose numbers: Hindi 21–99 (`pachchis` 25, `pachhattar` 75, `saath` 60, `sattar` 70, `assi`
80, `nabbe` 90), Kannada 13–19 and 40–90 (`hadinaidu` 15, `aivattu` 50), the spoken fractions (`dedh`,
`dhai`, `sawa`, `saade`, `paune`, `kaalu`, `mukkalu`), and the whole native-script half in both
languages. What that costs: with the narrow list, `पचास milligram` three times collapses to one while
`pachas milligram` three times survives — whether a repeated 50 mg lives depends on which script the
engine wrote it in.

One word went the other way: your list held `million` and the router's did not. I added `million` and
`billion` to the router rather than let this export remove a word you already protect. Nothing you
currently cover is dropped by adopting it — the delta is now 696 to 0 in that direction.

## The files

- `for-minibot/eta_number_words.py` — the drop-in. A plain `frozenset` named `NUMBER_WORDS`, 772 words,
  sorted, no imports, no logic. Generated from the router's own lexicon at `be40365`.
- `for-minibot/test_lexicon_export.py.txt` — the parity test as it runs in the router checkout. It also
  imports your shim read-only and prints the delta; it never asserts on your file.

Source of truth is `eta-router` branch `vinay/lexicon-export` (`90c7178`): `tools_export_lexicon.py`
regenerates the export, and the test fails if the file and the router's set ever disagree, or if the
committed file is not exactly what the generator writes.

## What the words alone do NOT give you

The lexicon is data. Three behaviours decide whether it works, and the export's header repeats all three:

1. **Any character with a Unicode numeric value counts as a number.**
   `any(unicodedata.numeric(c, None) is not None for c in word)` — this catches `½ ¼ ¾` and the digits of
   every script. `str.isdigit()` returns False for `½`, so a `.isdigit()` test beside these words still
   collapses `½ tablet` ×3.
2. **A hyphen- or slash-joined token counts if any part does.** Split on `[-/]` and test each part:
   `ek-ek`, `1-0-1`, `one/two` are numbers; `follow-up`, `and/or`, `x-ray` are not.
3. **The exemption applies to phrases, not only single words.** A repeated *phrase* containing a number
   must not collapse either: `one tablet one tablet one tablet` and `saade teen` ×3 stay as spoken. In the
   router this is `not any(is_number_token(w) for w in phrase)` in the phrase branch of the collapse.

Words with only rule 1 missing is the case worth naming: it looks correct on every spelled number and
still eats `½` and `२५`.

## Parity test in your context

```python
import eta_number_words
missing = set(eta_number_words.NUMBER_WORDS) - {w.lower() for w in YOUR_NUMBER_WORDS}
extra   = {w.lower() for w in YOUR_NUMBER_WORDS} - set(eta_number_words.NUMBER_WORDS)
assert not missing, f"{len(missing)} words missing, e.g. {sorted(w for w in missing if w.isascii())[:5]}"
assert not extra, f"{len(extra)} words only here: {sorted(extra)[:5]}"
```

Importing the file rather than pasting the words is what keeps them equal; pasted, the two halves drift,
which is the defect this whole exercise started from.

## Provenance

Hindi and Kannada cardinals 0–100 are generated from tables in the router source — Hindi one row per
number (the numbers are irregular), Kannada 0–20 and the tens with 21–99 built by sandhi — so the
romanised and native-script halves cover the same numbers by construction, pinned by a test. The
spellings are mine, from common usage, and have not been checked by a native speaker; an extra spelling
costs nothing (a loop stays in place), a missing one is the real risk. That review is still open.
