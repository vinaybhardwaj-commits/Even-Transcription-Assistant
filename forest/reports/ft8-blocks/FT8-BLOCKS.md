# FT8-BLOCKS: which parts of the medical history (FT8, layer 1) lowered AUC at the Rx? POST HOC, DESCRIPTIVE, D split only (20 Oct 2026, tables 11:33 IST; wording fixed 11:46 IST after ft8-blocks-ref PASS-WITH-FIXES)
**Summary (plain English; post hoc, nothing here is a finding):**
1. No single block is to blame. When one block is added to M0 on its own, labs (-0.011 to -0.019), vitals (-0.004 to -0.009) and utilisation (-0.008 to -0.009 for h14 and h90) cost the most. Comorbidity costs a little. Admissions and medicines are neutral.
2. When one block is taken out of M1, AUC moves by 0.005 or less in every case. Taking out labs gets back only +0.004 to +0.005 of the -0.015 to -0.024 loss. The loss is spread across the blocks and they overlap.
3. "New to Even" alone does not explain the drop. One yes/no flag (has_prior_rx, or any history) is neutral for h14 and h90 (-0.001 to +0.001). For Ale it shows a small nominal gain (+0.004 [+0.000, +0.008], P = 0.03, uncorrected). Converters have history less often (32% vs 43% for h14). It was not tested whether the base layer already carries this.
4. Dilution control: the 42 FT8 columns with rows shuffled (no link to the label) cost about as much as real FT8 for h90 and Ale (-0.019 / -0.016 vs -0.019 / -0.015). For h14 the shipped seed cost less than half as much (-0.009 vs -0.024). The refuter's 5-seed check gives a mean of -0.014 / -0.018 / -0.012, with a spread of about ±0.02-0.03; one seed even has a positive sign. A single-seed (d) value, including h14 real-minus-shuffled -0.015, means nothing on its own.
5. The loss is consistent with dilution, but (d) cannot separate dilution from a weak harmful signal at this n. The hypothesis is as follows. About 60% of rows have no FT8 history. The non-flag FT8 columns are -1 for a median of about 77% of rows. Under max_features=sqrt, M1 tries about 8 of 71 columns per split (about 3.3 of them base columns), against 5 of 29 base columns in M0.

- Status: POST HOC and DESCRIPTIVE. 54 paired comparisons were made (18 per label x 3; listed below). No multiplicity correction was applied, and no test is claimed. The pre-registered result is still FOREST-TABLES F-primary. H (ft8/H, ft-h1shot/sealed) was never read, loaded or touched.
- Method: ft-forest design A code imported unchanged (forest_build.build('rx', include_l8=False), forest_lib, forest_run.Runner). Learner RF(400, min_samples_leaf=5, sqrt, random_state=0); in-fold doctor rate m=10; NaN -1 plus has_ flags; 5x5 StratifiedGroupKFold (seed 20261019 + rep) on cluster_key. AUC on the repeat-averaged OOF; paired delta with a 1,000-draw cluster bootstrap (seed 20261019, the same draws for every pair), percentile 95% CI. P(Δ<=0) is bootstrap. Blocks follow FT-MODEL-SPEC-20OCT section 10; each block carries its own has_ flag(s).
- Parity: the M0 and M1 OOF arrays equal the frozen ft-forest model_frozen_rx_{h14,h90,ale}.json exactly (max|diff| 0 for all 6), so the AUCs and the M1-M0 delta reproduce FOREST-TABLES.
- (d) was added after the (a)-(c) run had been seen, as a check for dilution. It uses one joint row permutation of all 42 ft8 columns over all D rows of the label, with numpy default_rng(20261019), one seed. Extra seeds 1-4 are in ~/wt/ft8-blocks-ref/scratch/shuf_*.json (refuter). A first run without (d) (in v1/) gave identical numbers for all 16 shared comparisons.

| label | n / conv | M0 AUC | M1 AUC | M1 - M0 [95% CI] | P(Δ<=0) |
|---|---|---|---|---|---|
| h14 | 1101 / 189 | 0.634 | 0.610 | -0.024 [-0.043, -0.003] | 0.99 |
| h90 | 659 / 150 | 0.690 | 0.670 | -0.019 [-0.039, +0.001] | 0.96 |
| ale | 1144 / 213 | 0.661 | 0.646 | -0.015 [-0.034, +0.003] | 0.94 |


**(a) M0 + one block: Δ vs M0**

| block | n cols | h14 Δ [95% CI] | h14 P(Δ<=0) | h90 Δ [95% CI] | h90 P(Δ<=0) | ale Δ [95% CI] | ale P(Δ<=0) |
|---|---|---|---|---|---|---|---|
| utilisation | 5 | -0.009 [-0.020, +0.000] | 0.97 | -0.008 [-0.016, +0.000] | 0.97 | -0.000 [-0.010, +0.009] | 0.49 |
| comorbidity | 10 | -0.005 [-0.014, +0.004] | 0.87 | -0.006 [-0.014, +0.002] | 0.93 | -0.002 [-0.010, +0.007] | 0.66 |
| admissions | 1 | -0.001 [-0.004, +0.002] | 0.66 | -0.001 [-0.004, +0.002] | 0.78 | +0.002 [-0.001, +0.005] | 0.17 |
| vitals | 4 | -0.009 [-0.016, -0.002] | 0.99 | -0.004 [-0.009, +0.000] | 0.96 | -0.005 [-0.013, +0.004] | 0.89 |
| labs | 20 | -0.013 [-0.030, +0.004] | 0.93 | -0.019 [-0.035, -0.002] | 0.99 | -0.011 [-0.027, +0.004] | 0.92 |
| medicines | 2 | -0.001 [-0.007, +0.004] | 0.66 | -0.003 [-0.008, +0.001] | 0.95 | +0.002 [-0.004, +0.008] | 0.25 |

**(b) M1 minus one block: Δ vs M1 (negative = removing it hurts, positive = removing it helps)**

| block | n cols | h14 Δ [95% CI] | h14 P(Δ<=0) | h90 Δ [95% CI] | h90 P(Δ<=0) | ale Δ [95% CI] | ale P(Δ<=0) |
|---|---|---|---|---|---|---|---|
| utilisation | 5 | +0.001 [-0.004, +0.007] | 0.29 | -0.000 [-0.005, +0.004] | 0.53 | -0.003 [-0.007, +0.001] | 0.92 |
| comorbidity | 10 | +0.002 [-0.003, +0.006] | 0.20 | +0.001 [-0.004, +0.005] | 0.39 | -0.000 [-0.004, +0.004] | 0.59 |
| admissions | 1 | -0.000 [-0.004, +0.003] | 0.60 | -0.000 [-0.004, +0.003] | 0.57 | -0.000 [-0.003, +0.003] | 0.48 |
| vitals | 4 | +0.000 [-0.005, +0.005] | 0.49 | -0.002 [-0.006, +0.002] | 0.78 | +0.001 [-0.005, +0.006] | 0.36 |
| labs | 20 | +0.004 [-0.010, +0.019] | 0.28 | +0.005 [-0.012, +0.022] | 0.31 | +0.004 [-0.008, +0.017] | 0.26 |
| medicines | 2 | -0.000 [-0.004, +0.003] | 0.55 | -0.001 [-0.005, +0.002] | 0.78 | -0.003 [-0.006, +0.000] | 0.96 |

**(c) M0 + flags only, and (d) the shuffled-FT8 dilution control: Δ vs the model named**

| added | n cols | h14 Δ [95% CI] | h14 P(Δ<=0) | h90 Δ [95% CI] | h90 P(Δ<=0) | ale Δ [95% CI] | ale P(Δ<=0) |
|---|---|---|---|---|---|---|---|
| has_flags | 9 | -0.008 [-0.018, +0.004] | 0.91 | -0.003 [-0.014, +0.008] | 0.71 | -0.002 [-0.013, +0.008] | 0.67 |
| any_history | 1 | +0.001 [-0.003, +0.005] | 0.26 | -0.001 [-0.005, +0.003] | 0.72 | +0.004 [+0.000, +0.008] | 0.03 |
| has_prior_rx | 1 | -0.000 [-0.004, +0.004] | 0.50 | -0.001 [-0.004, +0.003] | 0.64 | +0.004 [-0.000, +0.008] | 0.03 |
| (d) ft8 shuffled vs M0 | 42 | -0.009 [-0.034, +0.017] | 0.74 | -0.019 [-0.034, -0.002] | 0.98 | -0.016 [-0.042, +0.007] | 0.91 |
| (d) M1 vs ft8 shuffled | 42 | -0.015 [-0.045, +0.016] | 0.86 | -0.001 [-0.024, +0.025] | 0.50 | +0.001 [-0.028, +0.029] | 0.47 |

**Coverage: rows with any data in the block, converters vs non-converters, n (share)**

| block | h14 conv | h14 non-conv | h90 conv | h90 non-conv | ale conv | ale non-conv |
|---|---|---|---|---|---|---|
| utilisation | 56 (0.30) | 358 (0.39) | 44 (0.29) | 209 (0.41) | 67 (0.31) | 365 (0.39) |
| comorbidity | 55 (0.29) | 350 (0.38) | 43 (0.29) | 209 (0.41) | 64 (0.30) | 357 (0.38) |
| admissions | 4 (0.02) | 12 (0.01) | 1 (0.01) | 4 (0.01) | 6 (0.03) | 13 (0.01) |
| vitals | 21 (0.11) | 99 (0.11) | 5 (0.03) | 27 (0.05) | 28 (0.13) | 104 (0.11) |
| labs | 34 (0.18) | 245 (0.27) | 25 (0.17) | 158 (0.31) | 37 (0.17) | 248 (0.27) |
| medicines | 25 (0.13) | 162 (0.18) | 20 (0.13) | 86 (0.17) | 32 (0.15) | 168 (0.18) |
| any_history | 61 (0.32) | 390 (0.43) | 46 (0.31) | 226 (0.44) | 72 (0.34) | 397 (0.43) |


Coverage notes: any_history means any block has data (it includes admissions, so it is +7 rows over the FOREST-TABLES L1 count of 444 for h14). Admissions = at least 1 prior IP event.
Comparisons (54 in total, 18 per label): M1-M0 (1, reproduces FOREST-TABLES); (a) 6; (b) 6; (c) 3 (9 has_ flags, any_history, has_prior_rx); (d) 2 (shuffled vs M0, M1 vs shuffled).
Refute: ft8-blocks-ref (Opus) PASS-WITH-FIXES, ~/wt/ft8-blocks-ref/REFUTE.md. All 5 wording fixes are applied; no number changed.
Files: code/ft8_blocks.py, code/ft8_blocks_tables.py; blocks_{h14,h90,ale}.json (deltas, coverage, OOF); logs/; SHA256SUMS. Run: PYTHONHASHSEED=0 NJ=4 ~/.venv-forest/bin/python -I code/ft8_blocks.py <lab> --out .
