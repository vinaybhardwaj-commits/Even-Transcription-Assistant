# Timbre baselines

Locked, aggregates-only metric snapshots. Each file is one labelled gold batch scored with
`python -m tools.timbre.evaluate`. **Never** commit the labels CSV, rater notes, audio, or any
window / clip id here; those stay on the analysis box.

## 2026-10-11.json: gold batch 1 (locked)

- 198 items = 180 patient windows + 18 hidden repeats, one rater; 154 usable primaries after
  excluding not-patient (13) and unusable (13).
- Intra-rater (14 repeat pairs): arousal Spearman 0.52 / CCC 0.51; valence Spearman 0.73 / CCC 0.67.
- Best arousal: Odyssey WavLM-dim (Spearman 0.51) and audEERING MSP-dim (0.48), both direct.
  CCC is low (0.12-0.15) because outputs are not calibrated to the 1-5 scale; the eGeMAPS
  ridge head (`--scalar-ridge`) has the best arousal CCC (0.28) at Spearman 0.36.
- Valence: no voice model is useful (best Spearman 0.27, Whisper-encoder ridge). Decision:
  valence goes to text+voice fusion per the PRD.
- Flags: every model is near chance (macro-F1 0.41-0.43).
- Old WavLM Aniemore baseline retired.

`purity_validation_batch1` records how well the frame-level patient-purity score
(`tools/timbre/purity.py`) separates windows the rater flagged as not-patient or as containing
another voice (AUROC about 0.7) and the recommended keep rule (purity >= 0.6, >= 3 s pure
patient speech, mean patient cosine >= 0.30). Label batch 2 is selected with that rule.
`PurityRule.judge` applies it to the worse of the embedding score and the Nemotron
probability score. Candidate windows can be cut from Nemotron timelines with
`python -m tools.timbre.nemotron_windows` (see the harness README). The thresholds
are unchanged.

Re-run (on the box, with the labels file that is not in git):

```bash
python -m tools.timbre.evaluate --labels LABELS.csv --features results/features.parquet \
    --out results/eval/ --scalar-ridge
```
