# Do the loops reach the FINAL stored transcript? (Fable ruling 116; split-speaker, 24 Sep)

Counts, window ids and categories only; transcript text was handled in memory and is not in this file. Measure = the canonical repeat
ratio v2, measure A (repeat_ratio_v2.py). "Today" = windows transcribed since 04:40 IST (VAD off), latest run per window: 168 windows.

## Answer
**All 13 loop windows (it was 11 at 14:05; more windows have been transcribed since) still carry loop text in the FINAL stored transcript.**
The run row's `transcription_run.transcript_original` is what remains AFTER the whisper-shim, the router's collapse AND the app's own
`collapseAssembled` (lib/stt/assembled-collapse.ts, room-drain.ts ~1251). The real guard leaves the stored text unchanged (0 of 158 windows), so
nothing further downstream removes them.
- The guard IS working elsewhere: it changed 57 of 167 windows today (54 units collapsed). Its metrics_json says it ran on all 13 loop windows and
  changed 5 of them (3 units, 3 lines), and every one of the 13 still holds a loop.
- The loops are not small: 1,476 redundant characters across the 13, per-window ratio 1%-28%, 7 windows at or above 10%.

## Why the guard cannot remove them (all 13 loops classified; a loop can fail several rules)
| rule in assembled-collapse.ts | loops it blocks |
|---|---:|
| a unit containing a "number token" is NEVER collapsed | **13 of 13** (12 via the number-WORD lexicon only, 1 via a digit) |
| loop crosses a line break (the guard works line by line; the router joins segments with newlines) | 12 of 13 |
| unit longer than MAX_PHRASE_WORDS = 8 | 5 of 13 (n = 9 or 12) |
The number exemption is the load-bearing one. In 12 of 13 loops the "number" is one everyday word in a unit of 4-12 words (8-25 % of
its tokens): lexicon entries `do` (6 loops), `one` (4), `half` (1), a Kannada word for "one" (1). Only 1 loop is genuinely numeric. The
exemption exists so a regimen read aloud is not collapsed ("1-0-1", "ek ek ek goli"), a real safety concern; it is applied here to unit
words that merely CONTAIN a lexicon word.

## The turn layer (timed turns from whisper's own segments: `cue` type stt_turn)
- 909 turns in the 13 windows; **7 of 13 windows' turn text carries a canonical loop** too. No guard touches turns.
- **`room_turn_repeat_run` (the mark-only loop flag) has ZERO rows for every window transcribed today.** Its only writer is the offline backfill
  (repeat-runs-backfill.ts); nothing on the live room path calls it. So "0 turns flagged" means never measured, not clean.

## Offline test of a text-side fix (REAL guard code, bundled with esbuild, one rule changed at a time, applied to today's stored texts)
| variant | loop windows left (of 13) | words removed inside the 13 | words removed in OTHER windows | number tokens removed |
|---|---:|---:|---:|---|
| the guard as it is (fixed-point check) | 13 | 0 | 0 | 0 |
| F1: unit up to 12 words | 13 | 0 | 0 | 0 |
| F1 + F2: loops may cross line breaks | 13 | 0 | 21 words in 8 windows | 0 |
| **F1 + F2 + F3: number exemption only when >= half the unit is number tokens** | **1** | 303 | 27 words in 9 windows | 47 (44 lexicon words, 3 digits) |
- F1 and F2 alone fix nothing: every loop is also number-exempt. F3 is what clears them: 12 of 13, keeping one copy of each loop.
- The remaining 1 loop is the numeric one, correctly left alone.
- The 27 words outside the 13 are shorter (1-2 word) repeats that span line breaks, which measure A does not count; whether they are
  loops or legitimate repeated speech has NOT been checked by anyone reading or listening.
- The 47 removed number tokens are duplicate copies (one copy stays). The 3 DIGIT ones are the clinical-safety question and need a human look.

## Proposed fix (a decision for Fable, and for V on the number exemption; NOT built)
1. Narrow the exemption in `collapseLine` from "any number token in the unit" to "number tokens are at least half of the unit", keeping the
   single-word rule as it is. Raise MAX_PHRASE_WORDS 8 to 12 and let a loop cross a line break (collapse the joined text before the line
   drop). Tests: the regimen cases the current suite pins ("1-0-1", "ek ek ek goli", "पचास milligram") must still pass; plus a mutation
   control per rule; then the normal gate and an eta-refuter review (product code).
2. Wire the mark-only flag (`writeRepeatRuns`) into the live room path, so turn-layer loops are at least MARKED. Today they are neither
   removed nor flagged.
3. Do not revert VAD for this: the loops are a text-side gap that exists with VAD on too (yesterday 1 of 45 windows).

## Not established
- Whether the 13 are true hallucination loops or repeated real speech: no one has read or listened (I don't read patient text). The 3
  worst by ratio, for a listen: bw_7s275tba_1790226900000_primary (6-word unit x10), bw_ekewxt9t_1790235900000_primary (9 x6),
  bw_7s275tba_1790220600000_primary (12 x4).
- The offline test ran on text the guard had already processed; it cannot show what the guard removed before storage.
- My first prototype (a Python port of the guard) was WRONG (it changed 116 windows the real guard leaves alone) and is discarded; every
  number above comes from running the actual TypeScript.

Loop window ids: bw_6vz3rvcg_1790233200000, bw_6vz3rvcg_1790238600000, bw_7s275tba_1790219700000, bw_7s275tba_1790220600000,
bw_7s275tba_1790222400000, bw_7s275tba_1790226900000, bw_7s275tba_1790234100000, bw_ayd5y9w5_1790234100000, bw_ekewxt9t_1790235900000,
bw_kmbn52gk_1790073000000, bw_m6nq7upz_1790077500000, bw_w69nttr7_1790229600000, bw_w69nttr7_1790239500000 (all `_primary`).
