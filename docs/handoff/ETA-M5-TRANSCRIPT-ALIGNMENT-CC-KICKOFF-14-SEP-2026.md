# ETA — M5: ALIGN THE TWO TRANSCRIPTS — CC KICKOFF
**14 September 2026 · Session: `scribe3` · Mini only. READ-ONLY. This order sends NO request to any Mini service.**

## 0. What M4 settled, and the one thing it did not

M4's result, on the 900 s synthetic clip:

| | whisper alone | route |
|---|---|---|
| phrase loops (rule A, ≥3 repeats) | 0 | 0 |
| repeated sentences (rule B) | **3** | 0 |
| consecutive identical segments (rule C) | n/a | 0 of 32 |

**Route produced no repeats of any kind. Whisper alone produced three doubled sentences that are not in
the source text — and all three sit at Telugu/Kannada greetings**, i.e. exactly at language switches.
Your insight is the finding: whisper's failure mode there is a **2× doubling**, which rule A cannot see by
construction, and only rule B caught. That makes B the sensitive rule, not the supplementary one.

**What is still open is the 966.** You were right to flag it: 53 removable + 913 surviving is
*subtraction of totals*, not evidence. Nobody has lined the two texts up. The 913 could be content route
dropped, or more whisper output that is not in the source and is not a repeat. Those are opposite
conclusions. **Alignment answers it; arithmetic cannot.**

## 1. Corrected definitions — three defects you exposed

Apply these, and re-run A, B and C with them so we can see whether the counts move:

1. **Punctuation-insensitive matching.** You are right that keeping `.` `?` `!` on words made `you.` and
   `you` different tokens, so a repeat differing only in end punctuation never matched. **For matching in
   A, B and C, compare tokens with ALL punctuation stripped.** Keep punctuation only to split sentences.
2. **Near-identical, which I dropped and PR #1 named.** Two sentences are near-identical when, after
   normalisation and punctuation stripping, `difflib.SequenceMatcher(None, a, b).ratio() >= 0.90` **and**
   both are ≥ 3 words. Rule B counts identical **and** near-identical consecutive runs; report the two
   counts separately.
3. **Newlines.** Route's text carries 31 of them, one per segment boundary; whisper's has none. **Exclude
   newlines from every character count on both sides**, and say what that does to the 966.

## 2. The measurement — alignment, not subtraction

Align the two **normalised, punctuation-stripped token streams** (`difflib.SequenceMatcher` is fine; name
whatever you use). Walk the opcodes and classify every block:

- `equal` — in both
- `whisper_only` — present in whisper alone, absent from route
- `route_only` — present in route, absent from whisper alone
- `replace` — both have text, differing

Report characters and word counts per class. **The 966 must now decompose into
`whisper_only` + (`replace` delta) rather than into a subtraction.**

### Then the question that matters

For every `whisper_only` span, classify it into exactly one of:
- **(a) inside or adjacent to a rule-B repeat run**
- **(b) at a language switch** — map the span's position onto `route`'s own `language_timeline` and mark it
  (b) if it falls within 10 words of a segment boundary where the timeline's `lang` changes
- **(c) neither**

Report the three counts and their characters. **This is the whole point of the order:** if `whisper_only`
text clusters in (a) and (b), whisper is inventing text at language switches and route is right to suppress
it. If most of it is (c), route is dropping real content and its 8.3× is buying a loss.

## 3. Inputs and housekeeping

The two transcripts you copied to `docs/handoff/scratch/`. **Keep** `M4-MEASURE-14-SEP-2026.py.txt` and
`M4-MEASURE-OUT-14-SEP-2026.json` — they are evidence and a Refuter should be able to rerun them. Save this
order's script and numbers-only output beside them under the same naming pattern.

## 4. Do not

Send any request to any Mini service · judge clinical or linguistic quality · recommend an engine, setting
or architecture · change code, env, models or config · restart anything · run git in the app repo ·
extrapolate to real room audio — this clip is synthetic and cannot speak for it.
Quoting short fragments is safe (synthetic clip); say so when you do.

## 5. Report

`docs/handoff/ETA-M5-TRANSCRIPT-ALIGNMENT-14-SEP-2026.md` (file only, no commit), at most 450 words:
the re-run A/B/C table under the corrected definitions, alongside M4's numbers so the change is visible ·
the four alignment classes with characters and words · **the (a)/(b)/(c) split as three plain numbers** ·
the newline-corrected 966 · what you did not check.
