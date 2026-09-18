# ETA — M6: SCRIPT CENSUS OF THE REPLACE BLOCKS — CC KICKOFF
**14 September 2026 · Session: `scribe3` · Mac Mini · read-only · no Mini service calls · no git, no commit**

## 0. Why this exists

M5 reports 795 characters that whisper produced and route did not, and your manual read found **9 of 20
spans, 625 characters, are Latin-script renderings of the clip's Kannada, Tamil and Telugu passages**.
The obvious reading is that route dropped Indic speech. **That reading is not yet earned**, and the reason
is in your own "Not checked" list: **the 53 `replace` blocks**.

The competing hypothesis, which the alignment cannot distinguish on its own: route transcribed those
passages **in native script**, and a unit-cost Levenshtein with no script-awareness paired some of route's
native-script tokens against whisper's Latin ones as `substitute` while leaving whisper's surplus tokens
unpaired as `whisper_only`. A 9-word Latin span opposite a 6-word native-script span produces exactly the
signature M5 shows: 6 substitutes and 3 deletes.

If route emitted native script, it is transcribing Indic speech **better** than whisper and the 795
characters are largely a spelling difference. If route emitted nothing, it is dropping clinical speech.
Those are opposite verdicts and one short census separates them. No Mini time.

## 1. Goal

Answer one question numerically: **for the clip's non-English passages, did route emit native-script text,
or nothing?**

## 2. Scope

`docs/handoff/scratch/` only. Inputs already on disk:
`M4-INPUT-M3-WHISPER-ALONE-14-SEP-2026.json`, `M4-INPUT-M3-ROUTE-TRANSLATE-FALSE-14-SEP-2026.json`,
`M5-MEASURE-14-SEP-2026.py.txt`, `M5-MEASURE-OUT-14-SEP-2026.json`.
Reuse M5's alignment exactly — same method, same tie-breaks — so the block boundaries are the ones M5
reported. Do not re-tune the aligner.

## 3. What to measure

**M6.1 — script census of both full streams.** Classify every token by dominant Unicode script (Latin,
Devanagari, Kannada, Tamil, Telugu, other/mixed). Report token counts and character counts per script per
engine. State the classification rule you used for a mixed token.

**M6.2 — the 53 `replace` blocks, one line each.** For every block: whisper-side script mix, route-side
script mix, word counts both sides. Then the summary that matters: **how many blocks pair a predominantly
Latin whisper side against a predominantly non-Latin route side**, and how many characters that accounts
for on each side. Those blocks are transliteration pairs, not losses.

**M6.3 — the 20 `whisper_only` spans in context.** For each span, report the script of the nearest route
token before and after it. Then: of the **625 characters** you identified as romanised Indic, how many sit
adjacent to (within 5 route tokens of) a non-Latin route token, and how many sit in a stretch where route's
output is Latin-only or absent. **This is the number the verdict turns on.** Give it plainly.

**M6.4 — did route ever route to the Indic engine?** From the route input JSON's per-segment data, report
for each of the 32 segments which engine produced its text, and the segment's detected language. Then state
how many segments went to IndicConformer and how many to Whisper. **If the answer is zero IndicConformer
segments, say so in the first line of your report** — it explains everything else at once.

**M6.5 — the language timeline.** Print route's `language_timeline` verbatim: every change with its
timestamp. M5 says it holds **4** changes against a clip with **26** non-English passages. Confirm or
correct that count, and state whether the timeline is what drives per-segment engine selection or is
recorded after the fact. Read the router source on the Mini (`~/eta-router`) to answer the second half;
**read only, change nothing there, and do not restart any service.**

## 4. Known facts

- The clip is **synthetic**. Nothing here generalises to room audio, and this kickoff does not ask it to.
- M5's alignment: 2,367 matches, edit distance 447, whisper_only 160 words / 795 chars, route_only 20 words
  / 110 chars, replace 242 whisper words / 220 route words.
- M5's (c) bucket is 14 spans / 521 chars, of which **388** are romanised Indic (spans 4, 12, 14, 15, 16).
- Route's `language_timeline` is the only input rule (b) had, which is why (b) reached only 113 chars.
- Whisper looped **3 times, 51 characters** on this clip. On real room audio on 13 Sep it looped in roughly
  **44% of non-empty jobs** (1,126 jobs, 4,363 repeat segments, 404 in-segment loops). The clip does not
  exercise whisper's known failure mode. Do not draw an engine conclusion from it.

## 5. What NOT to do

No Mini service calls — no `/route`, no `/health`, no transcription. No git, no commit, no branch. Do not
edit anything under `~/eta-router` or restart any service. Do not re-run M3 or M4. Do not re-tune the
aligner or try other tie-breaks. Do not draw the engine verdict — that is the Orchestrator's.
Quoting fragments of this synthetic clip is safe; quoting real room audio is not, and none is in scope.

## 6. Output

`docs/handoff/ETA-M6-SCRIPT-CENSUS-14-SEP-2026.md`, **cap 90 lines**. Per-block and per-span tables go to
`docs/handoff/scratch/M6-MEASURE-OUT-14-SEP-2026.json`; the script to
`docs/handoff/scratch/M6-MEASURE-14-SEP-2026.py.txt` with its self-tests, as you did for M5.

Lead with one sentence answering M6.4, then one sentence answering M6.3. Everything else after.
