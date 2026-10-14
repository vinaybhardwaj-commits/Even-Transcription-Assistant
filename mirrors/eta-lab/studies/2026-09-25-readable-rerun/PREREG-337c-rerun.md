# 337c(2) re-transcription: pre-registration of the before/after comparison (indic-mt, 25 Sep 2026, written BEFORE any label exists)

What is compared: for one audio segment, the OLD stored text (SraVaani / IndicConformer / whisper.cpp from the production route) versus the RE-RUN: faster-whisper large-v3,
language FORCED to split-speaker's `forced_language` (segment tag, else window dominant, else room-month), greedy, no temperature fallback, on eta-lab-l4.
IndicConformer RNNT (production decoding) was also run on 177 flagged segments: EMPTY on 80-100 % per language, so it is not a candidate and its workers were stopped
(its rows stay as data, never shown as a replacement).

Nothing is deleted or overwritten: both texts are kept; annotations kind=retranscription carry text2/engine2/lang2 with `better: null`. `better` becomes true/false ONLY from the
human judgement below. The structural readability score (split-speaker) is stored beside each output as data; it never picks a winner (eta-refuter #1900 point 5).

Sample: N = 96 pairs, both sides non-empty, drawn from the re-run results in their frozen (seeded shuffle) order; cells kn 24, hi 24, bn 12, ta 12, ml 12, other (mr/gu/te/pa) 12
(fewer if a cell has too few results yet; the counts file says so). Seed 20260940 for the draw, the row order and the A/B flip. The sheet shows NO engine, score, flag, or which side is
old; the key is a separate box-only file joined after labelling. Labellers: V or Sandhya only, blind to which side is which.
Labels per row: A_better | B_better | same | both_unreadable | unsure.

Decision rule (per language cell; a cell needs >= 10 labelled rows with `unsure` excluded, else "not enough labels" and NOTHING is replaced there):
  * RE-RUN PREFERRED  if  re-run better >= 60 % of decided rows AND old better <= 20 %  -> the consult view MAY show the re-run as the default line, old text one click away.
  * OLD PREFERRED     if  old better >= 40 %  -> keep old as default, re-run available beside it.
  * otherwise         -> annotate only (both shown side by side, neither default).
  `both_unreadable` and `same` are reported per cell and are not counted for either side; if both_unreadable >= 40 % of a cell the cell is reported as "audio-limited".
Reported per cell FIRST: n, the five label counts, the 95 % Wilson interval of the re-run-better share. Then pooled (weighted by the cell's share of the 5,130 cut segments).
Not decided here: hiding anything, changing the flag threshold, or writing readable text into any production path. The consult view default is the lab-viewer's and Fable's call.
Known limits, stated before the labels: the flagged segments are the low-structural-score ones, so "old" is a biased-bad population (regression to the mean); segments whose audio placement is
off (a window offset) will look bad on both sides (split-speaker #1994: 8 of 12 English controls reproduce; the misses are low-SNR windows); the re-run cannot fix audio that is not speech.
