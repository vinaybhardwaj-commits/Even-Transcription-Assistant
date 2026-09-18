# ETA — M5: ALIGN THE TWO TRANSCRIPTS — REPORT
**14 Sep 2026 · Builder · read-only · no Mini request · no git, no commit**

## Files (`docs/handoff/scratch/`)
- The M4 inputs, unchanged.
- M4's script and output, kept.
- New: `M5-MEASURE-14-SEP-2026.py.txt` (self-tests before measuring) and `M5-MEASURE-OUT-14-SEP-2026.json`.

## Correction to §1.3
Newlines: route **311**, whisper **295** (not 31 and 0). My M4 flag was wrong. Without newlines the totals are 14,873 and 13,891, so **966 becomes 982**.

## Rules A, B and C, M4 → M5
| | whisper | route |
|---|---|---|
| A loops / ratio | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| B identical runs, chars | 3, 53 → **3, 51** | 0 → 0 |
| B near-identical runs | — → **0** | — → 0 |
| C, route only | — | 0/32 → 0/32 |

Only B's newlines changed. C has no whisper counterpart.

## Alignment
**Method: global word-level Levenshtein**, unit costs. On ties it prefers a match, then delete, then insert, then substitute. Result: 2,367 matches, edit distance 447.

**difflib was rejected.** `SequenceMatcher(autojunk=False)` scored 0.30. It matched whisper tokens 244–710 to a later repeat of the clip's paragraphs, giving 1,705 false route-only words. Figures kept in the JSON.

| Class | whisper words / chars | route words / chars |
|---|---|---|
| equal | 2,367 / 9,969 | 2,367 / 9,969 |
| whisper_only | 160 / **795** | — |
| route_only | — | 20 / 110 |
| replace | 242 / 1,024 | 220 / 962 |

Characters are counted on normalised tokens. **982 =** 795 (whisper_only) − 110 (route_only) + 62 (replace delta) + 0 (equal) + 235 (punctuation and spaces).

## The whisper_only split
- **(a) at a rule-B run: 161 chars**
- **(b) at a language switch: 113 chars**
- **(c) neither: 521 chars**

Precedence is a, then b, then c; "adjacent" means a zero-token gap. (b) can only use route's timeline, which has **4** language changes, against the clip's 26 non-English passages.

**Manual reading, not a rule** (synthetic clip, so fragments are safe; spans numbered in transcript order). **9 of 20 spans, 625 of 795 chars**, are Latin-script renderings of the clip's Kannada, Tamil and Telugu passages, for example `ninne bengalurinalli tumba malle`. 388 of those chars are in (c): spans 4, 12, 14, 15 and 16. The other 11 spans (170 chars) are English. Route has one such rendering of its own, 12 words.

## Flags
- M4's `\w` dropped Indic vowel signs. M5 treats Unicode category P* as punctuation and keeps them.
- A B run counts as near-identical if any link in it is near-identical.
- C checks identical segments only.

## Not checked
- Quality.
- The `replace` blocks.
- Other tie-breaks or costs.
- Real room audio.
