# ETA — M6: SCRIPT CENSUS OF THE REPLACE BLOCKS — REPORT
**14 Sep 2026 · Builder · read-only · no Mini service calls · no git, no commit**

**M6.4: zero of the 32 route segments went to IndicConformer. Whisper produced 30, SraVaani 2.**
**M6.3: 0 of the 625 romanised-Indic characters are within 5 route tokens of a non-Latin route token. All 625 sit where route's output is Latin-only.**

## Files (`docs/handoff/scratch/`)
- `M6-MEASURE-14-SEP-2026.py.txt`. It self-tests first, then runs M5's own script file unchanged, and asserts that its classes and op counts equal `M5-MEASURE-OUT`. So the block boundaries are M5's.
- `M6-MEASURE-OUT-14-SEP-2026.json`: per-script census, 53 blocks, 20 spans, 32 segments, the verbatim timeline.

## M6.1: script census (M5's normalised tokens)
| Script | whisper tokens / chars | route tokens / chars |
|---|---|---|
| Latin | 2,758 / 11,777 | 2,576 / 10,924 |
| Kannada | 0 | **17 / 103** |
| Devanagari, Tamil, Telugu | 0 | 0 |
| mixed | 0 | 0 |
| other (digits only) | 11 / 11 | 14 / 14 |

**Token rule.** Every letter or mark character (Unicode category L* or M*) takes the first word of its Unicode name. One script present gives that script; two or more gives "mixed"; none gives "other". Punctuation is already stripped.

All 17 route Kannada tokens are in segment 5 (SraVaani, `kn`). Neither engine emitted any Devanagari, Tamil or Telugu on this clip.

## M6.2: the 53 `replace` blocks
**5 of 53 blocks pair a predominantly Latin whisper side with a predominantly non-Latin route side.** Together they hold 66 whisper chars against 103 route chars, all Kannada, all inside segment 5 (route tokens 448–512). The other 48 blocks are Latin on both sides.

| Block | whisper words / chars | route words / chars (Kannada) |
|---|---|---|
| 5 | 1 / 7 | 1 / 6 |
| 9 | 1 / 4 | 1 / 4 |
| 10 | 3 / 14 | 1 / 6 |
| 11 | 5 / 30 | 3 / 22 |
| 13 | 3 / 11 | 11 / 65 |

**Predominance rule:** judged by characters of script-bearing tokens; Latin above 50% is "latin", non-Latin above 50% is "non_latin". Every block's two-sided mix is in the JSON.

## M6.3: the 20 `whisper_only` spans in context
- **Nearest route tokens:** Latin on both sides for all 20. Two exceptions: span 7 has a digits-only token before it, and span 20 has no token after it (end of stream).
- **Near non-Latin text:** only **spans 2 and 3** fall within 5 tokens of a non-Latin route token, the Kannada in segment 5. Both are English, 27 chars, and not among the romanised nine.
- **Romanised Indic** (M5's manual nine: spans 1, 4, 6, 10, 11, 12, 14, 15, 16 = 625 chars):
  - **within 5 of a non-Latin route token: 0 chars**
  - **in a Latin-only or empty route stretch: 625 chars**
- **Flag:** span 6 (85 chars) also contains English words, and M5 counted it whole. Taking it out gives 0 and 540.

## M6.4: engine and language per segment
- Segment 5, 141.2–171.1 s: `sravaani`, `kn`. Kannada text plus 54 Latin tokens.
- Segment 11, 313.5–341.1 s: `sravaani`, `und`. **Latin-only text** (43 tokens).
- The other 30 segments are `whisper`, `en`, Latin only (JSON `M6_4_segments`).
- **IndicConformer: 0. Whisper: 30. SraVaani: 2.**
- The segment data records only the **winning** engine. The source (`:386–397`) calls IndicConformer on every segment that has Indic candidates, but its losing output is not kept.

## M6.5: the language timeline
Verbatim, from the route input JSON:
```
{"start_s": 0.5, "end_s": 25.9, "lang": "en", "engine": "whisper", "chars": 434}
{"start_s": 26.1, "end_s": 54.2, "lang": "en", "engine": "whisper", "chars": 514}
{"start_s": 54.6, "end_s": 83.9, "lang": "en", "engine": "whisper", "chars": 519}
{"start_s": 84.0, "end_s": 112.1, "lang": "en", "engine": "whisper", "chars": 501}
{"start_s": 112.2, "end_s": 141.1, "lang": "en", "engine": "whisper", "chars": 404}
{"start_s": 141.2, "end_s": 171.1, "lang": "kn", "engine": "sravaani", "chars": 394}
{"start_s": 171.7, "end_s": 196.5, "lang": "en", "engine": "whisper", "chars": 437}
{"start_s": 197.0, "end_s": 226.7, "lang": "en", "engine": "whisper", "chars": 432}
{"start_s": 226.8, "end_s": 254.9, "lang": "en", "engine": "whisper", "chars": 374}
{"start_s": 255.1, "end_s": 284.8, "lang": "en", "engine": "whisper", "chars": 444}
{"start_s": 285.2, "end_s": 313.3, "lang": "en", "engine": "whisper", "chars": 383}
{"start_s": 313.5, "end_s": 341.1, "lang": "und", "engine": "sravaani", "chars": 232}
{"start_s": 341.7, "end_s": 367.3, "lang": "en", "engine": "whisper", "chars": 450}
... 20 further entries, all "en"/"whisper", 367.9 s to 900.0 s; full list in the JSON (M6_5_timeline.verbatim)
```
**Changes: 4, confirmed.** 141.2 s en→kn, 171.7 s kn→en, 313.5 s en→und, 341.7 s und→en.

**Non-English passages: 26, confirmed.** Counted from the M2 build manifest: 26 Kannada, Tamil, Telugu or Hindi paragraphs start before 900 s.

**The timeline is recorded after the fact; it does not drive engine choice.** From the source, read-only (`~/eta-router/router_server.py`, sha256 `a4700494…`):
- `transcribe_norm_wav` builds `timeline` at `:504–505` from segments that `process_segment` has already returned. Each segment's `lang` is set by whichever engine won.
- The choice itself is at `:439–443`. If whisper's English passes `looks_real_english`, the Indic winner overrides it only when it (1) contains Indic script, (2) is longer than whisper's text, and (3) is at least `max(24, 1.8 × whisper chars)`. Otherwise the result is `english_segment()`.
- Whisper's detected `language` is used only at `:408`, to decide whether to re-call whisper with `language="en"`.
- `:394` stops IndicConformer after the first candidate (`kn`) when English looks real and that candidate returned nothing.
- SraVaani's `lang` comes from `guess_indic_lang` (`:428`), which returns `und` when no Indic script is present.
- **Inferred, not observed:** segment 11's Latin SraVaani text can only win on the path where `eng_real` is false (`:439`).

## Not checked
- IndicConformer's and SraVaani's losing outputs per segment. They are not in the route JSON, and getting them would need Mini calls.
- Whether route's romanised output (for example M5's 12-word route-only Tamil rendering) is a transliteration pair under another rule.
- Real room audio.
