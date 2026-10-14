# Ruling 337c: readability flag, PRE-REGISTRATION (split-speaker, 25 Sep 2026, ~08:10 IST; before any label exists)
Frozen code: `readability.py` (sha256 `ba60b24555105b114de85215d5cd01bdf960b945dcac753a2debdca3493cb255`), `score_all.py`, `sample_draw.py` (design and estimator in its docstring). Tests on invented text: `test_readability.py` (18 OK).
Population: one record per window_id from the raw run records on this box (hist/runs, hist/out, lab-vault/staged/runs): 4588 windows, 74412 segments, 29673 refused (no text, not scored), **44739 scored**.

## What the flag is and is not
Structural signals only: script vs language-label mismatch, two Indic scripts mixed, Latin text from an Indic engine (romanised output), non-word rate against an English vocabulary built from the whisper segments on the box, repeat loops (measure A + one-word runs + low variety), giant tokens. Score = 1 - capped sum of penalties; **flag = score < 0.60**.
It cannot call a correct-script Kannada line garbled unless the garble is structural. Precision and recall need HUMAN labels (no model reader is authorised on real text): the 200-row sample below. **The flag hides NOTHING until those labels give precision and recall; until then it only annotates.**

## Counts on all 44739 scored segments (flag at 0.60; counts only)
Flagged 5352; at other thresholds: {'0.3': 449, '0.4': 956, '0.5': 2645, '0.6': 5352, '0.7': 5957, '0.8': 5972}. Short segments (< 2 tokens, not penalised): 550.
| engine/language | scored | flagged | share | reasons (a segment can have several) |
|---|---:|---:|---:|---|
| indicconformer/bn | 80 | 7 | 0.087 | token_run 7, loop 2 |
| indicconformer/hi | 334 | 3 | 0.009 | low_variety 3, loop 2, token_run 3 |
| indicconformer/kn | 259 | 4 | 0.015 | token_run 4, loop 2, low_variety 1 |
| indicconformer/ml | 83 | 0 | 0.000 |  |
| indicconformer/ta | 170 | 5 | 0.029 | low_variety 2, token_run 5 |
| indicconformer/te | 61 | 0 | 0.000 |  |
| sravaani/bn | 652 | 63 | 0.097 | script_mismatch 55, indic_engine_latin 55, token_run 8, loop 1 |
| sravaani/gu | 428 | 7 | 0.016 | script_mismatch 6, mixed_indic 7, token_run 1 |
| sravaani/hi | 2947 | 33 | 0.011 | script_mismatch 21, indic_engine_latin 21, mixed_indic 10, token_run 12, loop 2, low_variety 2 |
| sravaani/kn | 5900 | 109 | 0.018 | script_mismatch 81, indic_engine_latin 80, token_run 28, mixed_indic 16 |
| sravaani/ml | 1098 | 7 | 0.006 | mixed_indic 5, giant_token 1, script_mismatch 3, indic_engine_latin 3, token_run 4, loop 1 |
| sravaani/other-indic | 19 | 1 | 0.053 | mixed_indic 1, loop 1, token_run 1, low_variety 1 |
| sravaani/ta | 1070 | 10 | 0.009 | script_mismatch 9, indic_engine_latin 9, mixed_indic 6, token_run 1 |
| sravaani/te | 335 | 3 | 0.009 | script_mismatch 2, indic_engine_latin 2, mixed_indic 1, token_run 1 |
| sravaani/und | 4321 | 4220 | 0.977 | indic_engine_latin 4220, low_variety 1, token_run 7 |
| whisper/en | 26982 | 880 | 0.033 | non_words 1311, low_variety 129, loop 51, token_run 10 |
Reading: the flags concentrate in `sravaani/und` (Latin-script output from the Indic engine: the romanised group Fable named) and in `whisper/en` non-words. Native-script Indic segments are flagged at 0.6-10 % (mostly one-token runs and script mix). Whether the romanised group is 'garble' or readable romanised Hindi/Kannada is exactly what the labels decide.

## Sample and estimator (frozen in `sample_draw.py`)
200 rows, stratified by engine/language cell x flagged/unflagged, fixed allocation, seed 20260935, written once. Label per row: readable | garbled | wrong_language | unsure. Per-cell precision (flagged rows labelled garbled) and per-cell miss rate (unflagged rows labelled garbled), combined with the cell sizes as weights into overall precision and recall; 'unsure' excluded and bounded both ways.
The text-free ids and strata are `sample200_ids.json`; the box-only sheet with text is for V/Sandhya. Nothing is hidden by the flag; re-transcription (337c part 2) uses the flagged list and the same score.
## What it cannot show
Semantic garble in the right script (fluent-looking nonsense) is invisible to these features; labels will tell how much that is. The English vocabulary is corpus-derived (frequent whisper words), so rare real words count as non-words.
