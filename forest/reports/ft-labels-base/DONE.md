# ft-labels-base DONE (2026-10-19 17:36 IST). Served by Opus 5.5 (global.anthropic.claude-opus-5-5) on Bedrock.
## FT2 labels: labels.parquet v2 (sha 0aefc00f425b), labels.DONE, code/ft2_labels.py
- 1,622 flagged-Rx episodes since 1 Dec 2025 (D 1,233, H 389), from 1,909 flagged Rx. h14 final at age >= 18 d; h90 final at age >= 94 d (forest-lead rulings).
- D: h14 n 1,101 / pos 189; h90 n 659 / pos 150. H (labelled only, sealed): h14 361 / 82; h90 224 / 64.
- FT1 reconciliation: 978 matured Rx -> 883 matured episodes, 214 h90 positives (identical); 51/214 = 23.8% convert after day 14 (the H14 false-negative estimate).
- consult_uid from 10.tsv; the "108 differ" are empty in both files (0 real conflicts). has_uhid 1,914/1,914, so excluded_no_uhid = 0.
## FT3 Pulse baseline (D only): FT3-REPORT.md, ft3_tables.md, ft3_results.json; code/ft3_features.py, ft3_model.py, ft3_tables.py; features_D.parquet
- H14 temporal (train Dec-May n 441 / pos 78; test Jun-Sep n 651 / pos 110): AUC 0.60 (0.54-0.65), PR-AUC 0.21, Brier 0.14 (no-skill 0.140). The doctor rate alone gives AUC 0.58.
- H14 5x5 grouped CV, n 1,101 / pos 189: AUC 0.63 (0.60-0.67), PR-AUC 0.23 (0.19-0.27).
- H90 temporal (test 1 Jun-17 Jul, n 218 / pos 53): AUC 0.72 (0.65-0.80), PR-AUC 0.39, Brier 0.17 (no-skill 0.185). CV n 659 / pos 150: AUC 0.69 (0.64-0.73).
- Top drivers (CV permutation AUC drop): doctor +0.035 (H14) / +0.073 (H90); procedure class +0.023 / +0.047; specialty +0.016 / +0.006. Age, patient sex, investigations and payer are about 0.
- Within-specialty AUC, H14: GS 0.54 (n 436 / 103), Gyn 0.57 (189 / 30), Ortho 0.52 (156 / 28), Uro 0.55 (109 / 12). DIRECTIONAL.
- Same-day payer is leaky (forest-lead agreed) and is excluded; the leaky run is in ft3_results_withpayer.json. The no-payer run (without prior-visit payer) is ft3_results_nopayer.json.
- New SQL (run by gating-lead): sql/ft3b-features.sql, ft3c-has-uhid.sql, ft3d-payer-prior.sql. Reused ft-doctors' ft5a-casemix.sql.
