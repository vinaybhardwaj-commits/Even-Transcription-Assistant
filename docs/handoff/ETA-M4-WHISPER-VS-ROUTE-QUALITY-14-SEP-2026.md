# ETA — M4 (REVISED): DOES route's 8.3x BUY QUALITY? — REPORT
**14 September 2026 · Builder · read-only · no request to the Mini · no git, no commit**

## Inputs
I reused M3's two transcripts; nothing was regenerated. I copied them first; the copies are byte-identical (sha256):
- Whisper alone: `docs/handoff/scratch/M4-INPUT-M3-WHISPER-ALONE-14-SEP-2026.json` (`21cedac6…`)
- Route, `translate=false`: `docs/handoff/scratch/M4-INPUT-M3-ROUTE-TRANSLATE-FALSE-14-SEP-2026.json` (`28eafe26…`)

Raw joined text is `text` for whisper and `transcript_native` for route, both stripped. The definitions are kickoff §1 A, B and C, with no threshold.
- Script: `scratch/M4-MEASURE-14-SEP-2026.py.txt`. It self-tests before it measures.
- Output, numbers only: `scratch/M4-MEASURE-OUT-14-SEP-2026.json`.

## Results
| Measure | whisper alone | route |
|---|---|---|
| total chars | 15,168 | 14,202 |
| A: loops | **0** | **0** |
| A: redundant_words | 0 | 0 |
| A: redundant_chars | 0 | 0 |
| A: **repeat_ratio** | **0.000** | **0.000** |
| chars after collapsing (A) | 15,168 | 14,202 |
| B: repeated-sentence runs | 3 | 0 |
| B: chars beyond the first occurrence | 53 | 0 |
| chars after A and B | 15,115 | 14,202 |
| C: consecutive identical segments (**route only**) | — | 0 runs of 32 segments (0.000); 0 empty |

C has no counterpart on the whisper side, because whisper alone returns one joined `text`.

**Null result on A.** There are zero phrase loops on either side. As §4 anticipates, this clip cannot settle whether route's guard suppresses whisper loops. That comparison needs real room audio.

**B's 3 runs** (synthetic `say` output, so quoting fragments is safe): `Namaskaram.` twice, `I am the name of the house.` twice, `Namaskara.` twice. They sit at 29%, 30% and 48% of the text. The build script's source text has no consecutive identical sentences.

## The 966 extra characters
- **53** fall inside text that rule A or B removes.
- **913** survive collapsing.

Method: 53 = whisper's removed chars minus route's removed chars (53 − 0). 913 = whisper's post-collapse count minus route's (15,115 − 14,202). This is a split of the counts. I did not align the two texts, so the 913 is not shown to be content at positions where route produced nothing.

## Choices the kickoff did not settle
1. **Overlapping loops.** At each token the smallest n in 3–12 with 3 or more back-to-back repeats wins, scanning greedily left to right. With zero loops, this did not affect the result.
2. **`redundant_chars` span.** From the first character of the second occurrence to the last character of the loop, so inner spaces count. Also moot here.
3. **Normalisation keeps `.`, `?` and `!` on tokens.** So `you.` ≠ `you`: a repeat that differs only in end punctuation is not a loop, and the same goes for segments in C. The self-test was corrected to follow this.
4. **B splitting.** B splits the raw text on `.`, `?` and `!` and skips empty sentences. Abbreviations and decimals would split too.
5. **Newlines.** Route's `transcript_native` joins 32 segments with newlines, so its total includes 31 newline characters.

## Not checked
- Clinical or linguistic quality.
- "Near-identical" repeats, which §1 no longer defines.
- Where the 913 characters come from, by text alignment.
- Any other clip or real audio.
