# FOREST-TABLES (ft-forest, 2026-10-20 09:10 IST). Served by Claude Opus 5.5 on Bedrock. D split only; H never read.
- Spec FT-MODEL-SPEC-20OCT. Learner RF(400, min_samples_leaf=5, sqrt, random_state=0); NaN -> -1 plus has_ flags; in-fold doctor rate (m = 10) in A and B.
- AUC on the repeat-averaged OOF score, 1,000-draw cluster bootstrap, percentile 95% CI. Delta = paired, same rows and folds, same draws. p = two-sided bootstrap 2 min(P(d<=0), P(d>=0)), floor 1/1000; Holm within each spec s9 family. A gain is claimed only if Holm p < 0.05 (CI excludes 0 after Holm); everything else DIRECTIONAL.
- Doctor rate: designs A and B use the in-fold doctor prior rate (m = 10, FT3); design C uses FT4 pulse_only with its time-respecting doc_prior_rate (ruling 5, 07:24).
- Tree seed: random_state = 0 for every model (spec s3, ruling 1); fold seeds are FTR v2 (RS + rep) for A/B and FT4 (rep) for C. FTR v2 used RS + rep as the tree seed too, so L0 differs slightly from the FTR v2 base: shown per B design.
- SELECTED is chosen on the same data: its AUC is optimistic and its deltas are not tests. FULL = every layer in (identical to the last cumulative model).

## Tests made (two-sided; a gain is claimed only if Holm p < 0.05 and Δ > 0; Holm p < 0.05 with Δ < 0 = the layer made the model WORSE)
| family | tests | Holm p < 0.05, gain (Δ > 0) | Holm p < 0.05, loss (Δ < 0) |
|---|---|---|---|
| F-primary | 2 | 0 | 1 |
| F-Ale-Rx | 3 | 0 | 0 |
| F-calls | 54 | 0 | 0 |
| F-consults | 14 | 0 | 0 |
| total here | 73 | 0 | 1 |

F-bench (24) is scored by the ft-bench harness (run_frozen.sh) on these files; F-H (2) by ft-h1shot.

## rx / h14: n 1101, positives 189 (base rate 0.172), clusters 1097, 5 repeats x 5 folds (seed RS + rep, RS = 20261019)

- consult layer 8 = ft-bench opus_screen2_p14 (consult text, T = 0), 79 rows
- consult rows with engine audio: 63; consult layer 3 dropped (ruling 08:20)

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| M0 | L0 | 29 | 0.634 [0.594, 0.673] | 0.226 [0.188, 0.273] | 0.1385 | 0.613-0.640 |
| M1 | L0+L1 | 71 | 0.610 [0.567, 0.651] | 0.216 [0.180, 0.261] | 0.1402 | 0.590-0.610 |
| M2 | L0+L1+C4+C5+C6+C7+C8 | 161 | 0.607 [0.563, 0.651] | 0.216 [0.180, 0.262] | 0.1401 | 0.589-0.607 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| M1-M0 | -0.024 [-0.043, -0.003] | 0.988 / 1.00 | 0.024 | F-primary | 0.048 (2) |
| M2-M1 | -0.003 [-0.015, +0.009] | 0.730 / 0.80 | 0.540 | F-Ale-Rx | 0.540 (3) |
| M2-M0 | -0.027 [-0.049, -0.005] | 0.991 / 1.00 | 0.018 | not a test | - |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 1101 | 1.000 | 189 | 1.000 | 912 | 1.000 | - |
| L1 | 444 | 0.403 | 60 | 0.317 | 384 | 0.421 | - |
| C4 | 63 | 0.057 | 11 | 0.058 | 52 | 0.057 | 52 |
| C5 | 51 | 0.046 | 9 | 0.048 | 42 | 0.046 | 86 |
| C6 | 51 | 0.046 | 9 | 0.048 | 42 | 0.046 | 86 |
| C7 | 51 | 0.046 | 9 | 0.048 | 42 | 0.046 | 86 |
| C8 | 79 | 0.072 | 12 | 0.063 | 67 | 0.073 | - |

Grouped permutation importance in M2 (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L0 | 29 | +0.0875 | -0.0102 | +0.2013 |
| L1 | 42 | +0.0041 | -0.0794 | +0.0700 |
| C6 | 34 | +0.0015 | -0.0260 | +0.0121 |
| C6:role | 22 | +0.0012 | -0.0122 | +0.0104 |
| C8 | 2 | +0.0000 | -0.0044 | +0.0048 |
| C5:role_free | 9 | -0.0001 | -0.0038 | +0.0029 |
| C6:role_free | 12 | -0.0002 | -0.0067 | +0.0038 |
| C7:role | 12 | -0.0002 | -0.0053 | +0.0033 |
| C4:role | 5 | -0.0005 | -0.0041 | +0.0012 |
| C5:role | 16 | -0.0005 | -0.0070 | +0.0049 |
| C4:role_free | 5 | -0.0006 | -0.0086 | +0.0039 |
| C4 | 10 | -0.0007 | -0.0098 | +0.0036 |
| C7:role_free | 7 | -0.0008 | -0.0046 | +0.0017 |
| C5 | 25 | -0.0010 | -0.0097 | +0.0053 |
| C7 | 19 | -0.0013 | -0.0098 | +0.0051 |

## rx / h90: n 659, positives 150 (base rate 0.228), clusters 657, 5 repeats x 5 folds (seed RS + rep, RS = 20261019)

- consult layer 8 = ft-bench opus_screen2_p90 (consult text, T = 0), 0 rows
- consult rows with engine audio: 0; consult layer 3 dropped (ruling 08:20)

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| M0 | L0 | 29 | 0.690 [0.642, 0.736] | 0.362 [0.299, 0.440] | 0.1626 | 0.673-0.688 |
| M1 | L0+L1 | 71 | 0.670 [0.619, 0.717] | 0.344 [0.287, 0.421] | 0.1650 | 0.660-0.665 |
| M2 | L0+L1+C4+C5+C6+C7+C8 | 161 | 0.664 [0.613, 0.712] | 0.331 [0.274, 0.401] | 0.1658 | 0.654-0.665 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| M1-M0 | -0.019 [-0.039, +0.001] | 0.964 / 1.00 | 0.072 | F-primary | 0.072 (2) |
| M2-M1 | -0.007 [-0.013, -0.000] | 0.978 / 0.80 | 0.044 | F-Ale-Rx | 0.132 (3) |
| M2-M0 | -0.026 [-0.048, -0.002] | 0.987 / 1.00 | 0.026 | not a test | - |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 659 | 1.000 | 150 | 1.000 | 509 | 1.000 | - |
| L1 | 269 | 0.408 | 46 | 0.307 | 223 | 0.438 | - |
| C4 | 0 | 0.000 | 0 | 0.000 | 0 | 0.000 | 0 |
| C5 | 0 | 0.000 | 0 | 0.000 | 0 | 0.000 | 0 |
| C6 | 0 | 0.000 | 0 | 0.000 | 0 | 0.000 | 0 |
| C7 | 0 | 0.000 | 0 | 0.000 | 0 | 0.000 | 0 |
| C8 | 0 | 0.000 | 0 | 0.000 | 0 | 0.000 | - |

Grouped permutation importance in M2 (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L0 | 29 | +0.1373 | +0.0249 | +0.2449 |
| L1 | 42 | +0.0164 | -0.0455 | +0.0909 |
| C4 | 10 | +0.0000 | +0.0000 | +0.0000 |
| C5 | 25 | +0.0000 | +0.0000 | +0.0000 |
| C6 | 34 | +0.0000 | +0.0000 | +0.0000 |
| C7 | 19 | +0.0000 | +0.0000 | +0.0000 |
| C8 | 2 | +0.0000 | +0.0000 | +0.0000 |
| C4:role | 5 | +0.0000 | +0.0000 | +0.0000 |
| C4:role_free | 5 | +0.0000 | +0.0000 | +0.0000 |
| C5:role | 16 | +0.0000 | +0.0000 | +0.0000 |
| C5:role_free | 9 | +0.0000 | +0.0000 | +0.0000 |
| C6:role | 22 | +0.0000 | +0.0000 | +0.0000 |
| C6:role_free | 12 | +0.0000 | +0.0000 | +0.0000 |
| C7:role | 12 | +0.0000 | +0.0000 | +0.0000 |
| C7:role_free | 7 | +0.0000 | +0.0000 | +0.0000 |

## rx / ale: n 1144, positives 213 (base rate 0.186), clusters 1140, 5 repeats x 5 folds (seed RS + rep, RS = 20261019)

- consult layer 8 = ft-bench opus_screen2_p14 (consult text, T = 0), 92 rows
- consult rows with engine audio: 76; consult layer 3 dropped (ruling 08:20)

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| M0 | L0 | 29 | 0.661 [0.623, 0.696] | 0.300 [0.251, 0.361] | 0.1438 | 0.644-0.667 |
| M1 | L0+L1 | 71 | 0.646 [0.609, 0.685] | 0.290 [0.245, 0.354] | 0.1453 | 0.627-0.653 |
| M2 | L0+L1+C4+C5+C6+C7+C8 | 161 | 0.643 [0.605, 0.681] | 0.283 [0.237, 0.343] | 0.1456 | 0.625-0.649 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| M1-M0 | -0.015 [-0.034, +0.003] | 0.943 / 1.00 | 0.114 | F-Ale-Rx | 0.228 (3) |
| M2-M1 | -0.003 [-0.016, +0.011] | 0.674 / 1.00 | 0.652 | not a test | - |
| M2-M0 | -0.019 [-0.041, +0.003] | 0.954 / 1.00 | 0.092 | not a test | - |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 1144 | 1.000 | 213 | 1.000 | 931 | 1.000 | - |
| L1 | 462 | 0.404 | 71 | 0.333 | 391 | 0.420 | - |
| C4 | 76 | 0.066 | 18 | 0.085 | 58 | 0.062 | 65 |
| C5 | 64 | 0.056 | 16 | 0.075 | 48 | 0.052 | 99 |
| C6 | 64 | 0.056 | 16 | 0.075 | 48 | 0.052 | 99 |
| C7 | 64 | 0.056 | 16 | 0.075 | 48 | 0.052 | 99 |
| C8 | 92 | 0.080 | 19 | 0.089 | 73 | 0.078 | - |

Grouped permutation importance in M2 (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L0 | 29 | +0.1104 | +0.0044 | +0.2034 |
| L1 | 42 | +0.0100 | -0.0412 | +0.0543 |
| C6 | 34 | +0.0032 | -0.0224 | +0.0239 |
| C6:role_free | 12 | +0.0011 | -0.0082 | +0.0103 |
| C6:role | 22 | +0.0010 | -0.0142 | +0.0155 |
| C5 | 25 | +0.0005 | -0.0052 | +0.0051 |
| C8 | 2 | +0.0002 | -0.0043 | +0.0037 |
| C5:role_free | 9 | +0.0000 | -0.0034 | +0.0048 |
| C4:role | 5 | -0.0001 | -0.0020 | +0.0021 |
| C5:role | 16 | -0.0003 | -0.0049 | +0.0041 |
| C4:role_free | 5 | -0.0007 | -0.0052 | +0.0036 |
| C7:role_free | 7 | -0.0009 | -0.0047 | +0.0021 |
| C4 | 10 | -0.0013 | -0.0073 | +0.0035 |
| C7:role | 12 | -0.0013 | -0.0080 | +0.0045 |
| C7 | 19 | -0.0016 | -0.0147 | +0.0061 |

## lm3 / h14: n 976, positives 92 (base rate 0.094), clusters 976, 5 repeats x 5 folds (seed RS + rep, RS = 20261019)

- engine audio rows 197, role columns masked (all-fallback) 70; outcome-revealing Runo calls dropped (all days) 490
- layer 8 = ft-bench opus_screen2_p14, 175 rows with text
- ruling 4: layers 4-8 set missing on 2 rows with a Jev-added outcome-revealing call before T (S1 2 rows / 6 calls, S2 0 rows / 7 calls)
- L0 (tree seed 0) AUC 0.646 vs FTR v2 base (tree seed RS + rep, same rows and folds) 0.644: difference +0.002

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| L0 | L0 | 29 | 0.646 [0.595, 0.698] | 0.135 [0.106, 0.180] | 0.0842 | 0.619-0.667 |
| L1 | L0+L1 | 71 | 0.617 [0.562, 0.669] | 0.125 [0.097, 0.169] | 0.0849 | 0.585-0.640 |
| L2 | L0+L1+L2 | 77 | 0.631 [0.575, 0.682] | 0.133 [0.104, 0.185] | 0.0849 | 0.589-0.651 |
| L3 | L0+L1+L2+L3 | 125 | 0.627 [0.570, 0.682] | 0.139 [0.106, 0.197] | 0.0847 | 0.598-0.651 |
| L4 | L0+L1+L2+L3+L4 | 140 | 0.625 [0.568, 0.678] | 0.132 [0.102, 0.178] | 0.0847 | 0.592-0.649 |
| L5 | L0+L1+L2+L3+L4+L5 | 166 | 0.610 [0.555, 0.664] | 0.122 [0.096, 0.163] | 0.0853 | 0.585-0.636 |
| L6 | L0+L1+L2+L3+L4+L5+L6 | 200 | 0.604 [0.548, 0.657] | 0.119 [0.094, 0.157] | 0.0854 | 0.582-0.626 |
| L7 | L0+L1+L2+L3+L4+L5+L6+L7 | 219 | 0.611 [0.556, 0.664] | 0.123 [0.096, 0.165] | 0.0850 | 0.586-0.631 |
| L8 | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.609 [0.551, 0.664] | 0.122 [0.096, 0.162] | 0.0852 | 0.583-0.631 |
| FULL | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.609 [0.551, 0.664] | 0.122 [0.096, 0.162] | 0.0852 | 0.583-0.631 |
| SELECTED | L0 | 29 | 0.646 [0.595, 0.698] | 0.135 [0.106, 0.180] | 0.0842 | 0.619-0.667 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| L1-L0 | -0.030 [-0.053, -0.007] | 0.996 / 1.00 | 0.008 | F-calls | 0.408 (54) |
| L2-L1 | +0.014 [-0.021, +0.052] | 0.235 / 0.00 | 0.470 | F-calls | 1.000 (54) |
| L3-L2 | -0.004 [-0.020, +0.013] | 0.665 / 0.40 | 0.670 | F-calls | 1.000 (54) |
| L4-L3 | -0.002 [-0.012, +0.007] | 0.693 / 0.80 | 0.616 | F-calls | 1.000 (54) |
| L5-L4 | -0.015 [-0.025, -0.006] | 1.000 / 1.00 | 0.001 | F-calls | 0.054 (54) |
| L6-L5 | -0.006 [-0.014, +0.002] | 0.936 / 0.80 | 0.128 | F-calls | 1.000 (54) |
| L7-L6 | +0.007 [+0.000, +0.014] | 0.022 / 0.00 | 0.044 | F-calls | 1.000 (54) |
| L8-L7 | -0.002 [-0.009, +0.004] | 0.769 / 0.80 | 0.462 | F-calls | 1.000 (54) |
| FULL-L0 | -0.038 [-0.083, +0.007] | 0.947 / 1.00 | 0.106 | F-calls | 1.000 (54) |
| SELECTED-L0 | +0.000 [+0.000, +0.000] | 1.000 / 1.00 | 1.000 | not a test | - |

SELECTED forward pass (keep if Δ > 0 and P(Δ<=0) <= 0.20): final L0

| layer | over | ΔAUC [95% CI] | P(Δ<=0) | kept |
|---|---|---|---|---|
| L1 Pre-Rx history (FT8) | L0 | -0.030 [-0.053, -0.007] | 0.996 | no |
| L2 Call activity | L0 | -0.015 [-0.050, +0.020] | 0.805 | no |
| L3 Haiku tags, Jev cross-checked | L0 | -0.006 [-0.036, +0.022] | 0.651 | no |
| L4 Nemotron turns | L0 | -0.029 [-0.047, -0.010] | 0.998 | no |
| L5 Odyssey | L0 | -0.039 [-0.060, -0.020] | 1.000 | no |
| L6 emotion2vec | L0 | -0.035 [-0.055, -0.015] | 1.000 | no |
| L7 Clef-omni | L0 | -0.018 [-0.038, +0.004] | 0.932 | no |
| L8 Opus transcript score | L0 | -0.007 [-0.015, +0.002] | 0.939 | no |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 976 | 1.000 | 92 | 1.000 | 884 | 1.000 | - |
| L1 | 406 | 0.416 | 30 | 0.326 | 376 | 0.425 | - |
| L2 | 534 | 0.547 | 60 | 0.652 | 474 | 0.536 | - |
| L3 | 412 | 0.422 | 45 | 0.489 | 367 | 0.415 | - | sources: {'runo_summary': 337, 'runo_stt': 197, 'bolna': 18}
| L4 | 196 | 0.201 | 19 | 0.207 | 177 | 0.200 | 126 |
| L5 | 195 | 0.200 | 19 | 0.207 | 176 | 0.199 | 126 |
| L6 | 195 | 0.200 | 19 | 0.207 | 176 | 0.199 | 126 |
| L7 | 195 | 0.200 | 19 | 0.207 | 176 | 0.199 | 126 |
| L8 | 173 | 0.177 | 14 | 0.152 | 159 | 0.180 | - |

Grouped permutation importance in FULL (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L0 | 29 | +0.0715 | -0.0791 | +0.1931 |
| L2 | 6 | +0.0489 | -0.0262 | +0.1256 |
| L3 | 48 | +0.0078 | -0.0372 | +0.0470 |
| L3:runo_summary | 16 | +0.0060 | -0.0292 | +0.0404 |
| L7 | 19 | +0.0036 | -0.0288 | +0.0256 |
| L7:role_free | 7 | +0.0015 | -0.0157 | +0.0143 |
| L8 | 2 | +0.0012 | -0.0141 | +0.0133 |
| L3:bolna | 16 | +0.0012 | -0.0324 | +0.0225 |
| L3:runo_stt | 16 | +0.0010 | -0.0320 | +0.0219 |
| L4:role | 6 | +0.0006 | -0.0100 | +0.0110 |
| L7:role | 12 | -0.0011 | -0.0299 | +0.0166 |
| L6:role | 22 | -0.0016 | -0.0212 | +0.0121 |
| L4:role_free | 9 | -0.0022 | -0.0146 | +0.0086 |
| L6:role_free | 12 | -0.0024 | -0.0144 | +0.0105 |
| L4 | 15 | -0.0032 | -0.0234 | +0.0103 |
| L5:role | 17 | -0.0034 | -0.0258 | +0.0102 |
| L5:role_free | 9 | -0.0035 | -0.0287 | +0.0141 |
| L6 | 34 | -0.0044 | -0.0310 | +0.0203 |
| L5 | 26 | -0.0071 | -0.0321 | +0.0130 |
| L1 | 42 | -0.0120 | -0.0685 | +0.0459 |

## lm3 / h90: n 572, positives 90 (base rate 0.157), clusters 572, 5 repeats x 5 folds (seed RS + rep, RS = 20261019)

- engine audio rows 96, role columns masked (all-fallback) 35; outcome-revealing Runo calls dropped (all days) 490
- layer 8 = ft-bench opus_screen2_p90, 50 rows with text
- ruling 4: layers 4-8 set missing on 1 rows with a Jev-added outcome-revealing call before T (S1 1 rows / 6 calls, S2 0 rows / 7 calls)
- L0 (tree seed 0) AUC 0.675 vs FTR v2 base (tree seed RS + rep, same rows and folds) 0.673: difference +0.003

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| L0 | L0 | 29 | 0.675 [0.616, 0.731] | 0.235 [0.184, 0.305] | 0.1269 | 0.653-0.687 |
| L1 | L0+L1 | 71 | 0.645 [0.584, 0.707] | 0.213 [0.168, 0.273] | 0.1289 | 0.629-0.645 |
| L2 | L0+L1+L2 | 77 | 0.657 [0.604, 0.710] | 0.221 [0.170, 0.285] | 0.1279 | 0.639-0.666 |
| L3 | L0+L1+L2+L3 | 125 | 0.651 [0.595, 0.706] | 0.219 [0.170, 0.290] | 0.1282 | 0.628-0.667 |
| L4 | L0+L1+L2+L3+L4 | 140 | 0.636 [0.583, 0.690] | 0.203 [0.160, 0.268] | 0.1295 | 0.616-0.655 |
| L5 | L0+L1+L2+L3+L4+L5 | 166 | 0.645 [0.591, 0.701] | 0.211 [0.166, 0.280] | 0.1286 | 0.628-0.670 |
| L6 | L0+L1+L2+L3+L4+L5+L6 | 200 | 0.644 [0.590, 0.700] | 0.211 [0.166, 0.280] | 0.1289 | 0.622-0.659 |
| L7 | L0+L1+L2+L3+L4+L5+L6+L7 | 219 | 0.650 [0.594, 0.705] | 0.215 [0.168, 0.285] | 0.1285 | 0.632-0.662 |
| L8 | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.648 [0.593, 0.704] | 0.215 [0.169, 0.286] | 0.1283 | 0.628-0.662 |
| FULL | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.648 [0.593, 0.704] | 0.215 [0.169, 0.286] | 0.1283 | 0.628-0.662 |
| SELECTED | L0 | 29 | 0.675 [0.616, 0.731] | 0.235 [0.184, 0.305] | 0.1269 | 0.653-0.687 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| L1-L0 | -0.030 [-0.053, -0.010] | 0.999 / 1.00 | 0.002 | F-calls | 0.106 (54) |
| L2-L1 | +0.012 [-0.027, +0.054] | 0.284 / 0.00 | 0.568 | F-calls | 1.000 (54) |
| L3-L2 | -0.007 [-0.021, +0.010] | 0.762 / 0.60 | 0.478 | F-calls | 1.000 (54) |
| L4-L3 | -0.014 [-0.025, -0.003] | 0.995 / 1.00 | 0.010 | F-calls | 0.500 (54) |
| L5-L4 | +0.009 [-0.003, +0.023] | 0.083 / 0.00 | 0.166 | F-calls | 1.000 (54) |
| L6-L5 | -0.001 [-0.010, +0.008] | 0.578 / 0.60 | 0.844 | F-calls | 1.000 (54) |
| L7-L6 | +0.006 [-0.003, +0.013] | 0.091 / 0.20 | 0.182 | F-calls | 1.000 (54) |
| L8-L7 | -0.001 [-0.007, +0.005] | 0.689 / 0.80 | 0.624 | F-calls | 1.000 (54) |
| FULL-L0 | -0.027 [-0.076, +0.023] | 0.868 / 0.80 | 0.264 | F-calls | 1.000 (54) |
| SELECTED-L0 | +0.000 [+0.000, +0.000] | 1.000 / 1.00 | 1.000 | not a test | - |

SELECTED forward pass (keep if Δ > 0 and P(Δ<=0) <= 0.20): final L0

| layer | over | ΔAUC [95% CI] | P(Δ<=0) | kept |
|---|---|---|---|---|
| L1 Pre-Rx history (FT8) | L0 | -0.030 [-0.053, -0.010] | 0.999 | no |
| L2 Call activity | L0 | -0.000 [-0.037, +0.037] | 0.520 | no |
| L3 Haiku tags, Jev cross-checked | L0 | -0.005 [-0.029, +0.023] | 0.627 | no |
| L4 Nemotron turns | L0 | -0.028 [-0.044, -0.010] | 1.000 | no |
| L5 Odyssey | L0 | -0.007 [-0.030, +0.020] | 0.710 | no |
| L6 emotion2vec | L0 | -0.019 [-0.042, +0.009] | 0.909 | no |
| L7 Clef-omni | L0 | -0.006 [-0.027, +0.019] | 0.710 | no |
| L8 Opus transcript score | L0 | +0.005 [-0.009, +0.020] | 0.261 | no |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 572 | 1.000 | 90 | 1.000 | 482 | 1.000 | - |
| L1 | 242 | 0.423 | 27 | 0.300 | 215 | 0.446 | - |
| L2 | 305 | 0.533 | 67 | 0.744 | 238 | 0.494 | - |
| L3 | 208 | 0.364 | 47 | 0.522 | 161 | 0.334 | - | sources: {'runo_summary': 151, 'runo_stt': 96, 'bolna': 18}
| L4 | 95 | 0.166 | 21 | 0.233 | 74 | 0.154 | 60 |
| L5 | 95 | 0.166 | 21 | 0.233 | 74 | 0.154 | 60 |
| L6 | 95 | 0.166 | 21 | 0.233 | 74 | 0.154 | 60 |
| L7 | 95 | 0.166 | 21 | 0.233 | 74 | 0.154 | 60 |
| L8 | 49 | 0.086 | 12 | 0.133 | 37 | 0.077 | - |

Grouped permutation importance in FULL (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L2 | 6 | +0.0589 | -0.0192 | +0.1463 |
| L0 | 29 | +0.0468 | -0.0468 | +0.1273 |
| L7 | 19 | +0.0051 | -0.0260 | +0.0294 |
| L7:role | 12 | +0.0043 | -0.0054 | +0.0160 |
| L5:role | 17 | +0.0039 | -0.0324 | +0.0326 |
| L3:runo_stt | 16 | +0.0024 | -0.0159 | +0.0167 |
| L6:role | 22 | +0.0016 | -0.0225 | +0.0236 |
| L8 | 2 | +0.0012 | -0.0072 | +0.0070 |
| L5 | 26 | +0.0011 | -0.0364 | +0.0225 |
| L3:bolna | 16 | -0.0002 | -0.0084 | +0.0048 |
| L7:role_free | 7 | -0.0002 | -0.0188 | +0.0161 |
| L4:role | 6 | -0.0011 | -0.0139 | +0.0041 |
| L6 | 34 | -0.0012 | -0.0377 | +0.0290 |
| L3 | 48 | -0.0021 | -0.0272 | +0.0233 |
| L4:role_free | 9 | -0.0022 | -0.0127 | +0.0077 |
| L4 | 15 | -0.0032 | -0.0225 | +0.0098 |
| L6:role_free | 12 | -0.0036 | -0.0383 | +0.0195 |
| L5:role_free | 9 | -0.0043 | -0.0258 | +0.0078 |
| L3:runo_summary | 16 | -0.0048 | -0.0284 | +0.0185 |
| L1 | 42 | -0.0192 | -0.0625 | +0.0176 |

## lm3 / ale: n 1005, positives 102 (base rate 0.101), clusters 1005, 5 repeats x 5 folds (seed RS + rep, RS = 20261019)

- engine audio rows 209, role columns masked (all-fallback) 73; outcome-revealing Runo calls dropped (all days) 490
- layer 8 = ft-bench opus_screen2_p14, 190 rows with text
- ruling 4: layers 4-8 set missing on 2 rows with a Jev-added outcome-revealing call before T (S1 2 rows / 6 calls, S2 0 rows / 7 calls)
- L0 (tree seed 0) AUC 0.634 vs FTR v2 base (tree seed RS + rep, same rows and folds) 0.634: difference +0.000

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| L0 | L0 | 29 | 0.634 [0.582, 0.682] | 0.136 [0.110, 0.176] | 0.0902 | 0.609-0.641 |
| L1 | L0+L1 | 71 | 0.612 [0.560, 0.663] | 0.126 [0.101, 0.164] | 0.0909 | 0.591-0.621 |
| L2 | L0+L1+L2 | 77 | 0.623 [0.565, 0.672] | 0.133 [0.105, 0.173] | 0.0908 | 0.608-0.631 |
| L3 | L0+L1+L2+L3 | 125 | 0.631 [0.573, 0.682] | 0.147 [0.114, 0.203] | 0.0900 | 0.608-0.637 |
| L4 | L0+L1+L2+L3+L4 | 140 | 0.626 [0.567, 0.677] | 0.140 [0.109, 0.186] | 0.0903 | 0.601-0.637 |
| L5 | L0+L1+L2+L3+L4+L5 | 166 | 0.613 [0.555, 0.665] | 0.130 [0.103, 0.171] | 0.0908 | 0.591-0.623 |
| L6 | L0+L1+L2+L3+L4+L5+L6 | 200 | 0.608 [0.553, 0.659] | 0.128 [0.102, 0.170] | 0.0909 | 0.588-0.617 |
| L7 | L0+L1+L2+L3+L4+L5+L6+L7 | 219 | 0.616 [0.560, 0.668] | 0.132 [0.105, 0.175] | 0.0905 | 0.594-0.625 |
| L8 | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.616 [0.556, 0.668] | 0.133 [0.106, 0.179] | 0.0905 | 0.595-0.623 |
| FULL | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.616 [0.556, 0.668] | 0.133 [0.106, 0.179] | 0.0905 | 0.595-0.623 |
| SELECTED | L0 | 29 | 0.634 [0.582, 0.682] | 0.136 [0.110, 0.176] | 0.0902 | 0.609-0.641 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| L1-L0 | -0.023 [-0.051, +0.003] | 0.949 / 1.00 | 0.102 | F-calls | 1.000 (54) |
| L2-L1 | +0.011 [-0.028, +0.051] | 0.274 / 0.00 | 0.548 | F-calls | 1.000 (54) |
| L3-L2 | +0.008 [-0.011, +0.028] | 0.198 / 0.20 | 0.396 | F-calls | 1.000 (54) |
| L4-L3 | -0.005 [-0.015, +0.005] | 0.820 / 0.60 | 0.360 | F-calls | 1.000 (54) |
| L5-L4 | -0.013 [-0.023, -0.004] | 0.999 / 1.00 | 0.002 | F-calls | 0.106 (54) |
| L6-L5 | -0.005 [-0.015, +0.004] | 0.862 / 0.80 | 0.278 | F-calls | 1.000 (54) |
| L7-L6 | +0.008 [+0.000, +0.017] | 0.023 / 0.00 | 0.046 | F-calls | 1.000 (54) |
| L8-L7 | -0.001 [-0.008, +0.008] | 0.596 / 0.40 | 0.808 | F-calls | 1.000 (54) |
| FULL-L0 | -0.019 [-0.066, +0.030] | 0.786 / 0.80 | 0.428 | F-calls | 1.000 (54) |
| SELECTED-L0 | +0.000 [+0.000, +0.000] | 1.000 / 1.00 | 1.000 | not a test | - |

SELECTED forward pass (keep if Δ > 0 and P(Δ<=0) <= 0.20): final L0

| layer | over | ΔAUC [95% CI] | P(Δ<=0) | kept |
|---|---|---|---|---|
| L1 Pre-Rx history (FT8) | L0 | -0.023 [-0.051, +0.003] | 0.949 | no |
| L2 Call activity | L0 | -0.011 [-0.048, +0.027] | 0.734 | no |
| L3 Haiku tags, Jev cross-checked | L0 | -0.000 [-0.032, +0.034] | 0.505 | no |
| L4 Nemotron turns | L0 | -0.026 [-0.049, -0.004] | 0.990 | no |
| L5 Odyssey | L0 | -0.034 [-0.057, -0.009] | 0.998 | no |
| L6 emotion2vec | L0 | -0.034 [-0.057, -0.009] | 0.997 | no |
| L7 Clef-omni | L0 | -0.014 [-0.042, +0.015] | 0.825 | no |
| L8 Opus transcript score | L0 | +0.000 [-0.014, +0.018] | 0.473 | no |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 1005 | 1.000 | 102 | 1.000 | 903 | 1.000 | - |
| L1 | 419 | 0.417 | 36 | 0.353 | 383 | 0.424 | - |
| L2 | 558 | 0.555 | 67 | 0.657 | 491 | 0.544 | - |
| L3 | 433 | 0.431 | 51 | 0.500 | 382 | 0.423 | - | sources: {'runo_summary': 355, 'runo_stt': 209, 'bolna': 18}
| L4 | 208 | 0.207 | 23 | 0.225 | 185 | 0.205 | 135 |
| L5 | 206 | 0.205 | 23 | 0.225 | 183 | 0.203 | 135 |
| L6 | 206 | 0.205 | 23 | 0.225 | 183 | 0.203 | 135 |
| L7 | 206 | 0.205 | 23 | 0.225 | 183 | 0.203 | 135 |
| L8 | 188 | 0.187 | 19 | 0.186 | 169 | 0.187 | - |

Grouped permutation importance in FULL (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L0 | 29 | +0.0679 | -0.0318 | +0.1784 |
| L2 | 6 | +0.0440 | -0.0393 | +0.1308 |
| L1 | 42 | +0.0053 | -0.0870 | +0.0658 |
| L3:runo_summary | 16 | +0.0039 | -0.0442 | +0.0326 |
| L8 | 2 | +0.0032 | -0.0222 | +0.0164 |
| L3:bolna | 16 | +0.0027 | -0.0235 | +0.0191 |
| L3 | 48 | +0.0026 | -0.0503 | +0.0395 |
| L7:role_free | 7 | +0.0019 | -0.0153 | +0.0182 |
| L7 | 19 | +0.0011 | -0.0327 | +0.0202 |
| L3:runo_stt | 16 | +0.0003 | -0.0196 | +0.0109 |
| L6:role | 22 | +0.0002 | -0.0188 | +0.0120 |
| L6:role_free | 12 | -0.0002 | -0.0150 | +0.0153 |
| L5:role_free | 9 | -0.0005 | -0.0124 | +0.0126 |
| L6 | 34 | -0.0006 | -0.0164 | +0.0196 |
| L4 | 15 | -0.0008 | -0.0126 | +0.0148 |
| L4:role_free | 9 | -0.0009 | -0.0131 | +0.0134 |
| L7:role | 12 | -0.0010 | -0.0206 | +0.0127 |
| L4:role | 6 | -0.0011 | -0.0115 | +0.0084 |
| L5:role | 17 | -0.0019 | -0.0206 | +0.0119 |
| L5 | 26 | -0.0022 | -0.0191 | +0.0134 |

## lm7 / h14: n 926, positives 42 (base rate 0.045), clusters 926, 5 repeats x 5 folds (seed RS + rep, RS = 20261019)

- engine audio rows 235, role columns masked (all-fallback) 78; outcome-revealing Runo calls dropped (all days) 490
- layer 8 = ft-bench opus_screen2_p14, 204 rows with text
- ruling 4: layers 4-8 set missing on 2 rows with a Jev-added outcome-revealing call before T (S1 2 rows / 6 calls, S2 0 rows / 7 calls)
- L0 (tree seed 0) AUC 0.614 vs FTR v2 base (tree seed RS + rep, same rows and folds) 0.612: difference +0.002

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| L0 | L0 | 29 | 0.614 [0.537, 0.688] | 0.059 [0.041, 0.088] | 0.0435 | 0.581-0.629 |
| L1 | L0+L1 | 71 | 0.589 [0.511, 0.667] | 0.057 [0.040, 0.095] | 0.0436 | 0.527-0.627 |
| L2 | L0+L1+L2 | 77 | 0.639 [0.553, 0.726] | 0.080 [0.050, 0.139] | 0.0431 | 0.533-0.664 |
| L3 | L0+L1+L2+L3 | 125 | 0.654 [0.577, 0.737] | 0.082 [0.053, 0.141] | 0.0429 | 0.594-0.651 |
| L4 | L0+L1+L2+L3+L4 | 140 | 0.645 [0.567, 0.728] | 0.079 [0.052, 0.132] | 0.0430 | 0.575-0.652 |
| L5 | L0+L1+L2+L3+L4+L5 | 166 | 0.650 [0.571, 0.731] | 0.077 [0.051, 0.122] | 0.0431 | 0.580-0.657 |
| L6 | L0+L1+L2+L3+L4+L5+L6 | 200 | 0.650 [0.573, 0.730] | 0.074 [0.050, 0.117] | 0.0432 | 0.582-0.667 |
| L7 | L0+L1+L2+L3+L4+L5+L6+L7 | 219 | 0.655 [0.574, 0.734] | 0.079 [0.053, 0.133] | 0.0430 | 0.591-0.675 |
| L8 | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.658 [0.575, 0.744] | 0.087 [0.056, 0.153] | 0.0428 | 0.600-0.666 |
| FULL | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.658 [0.575, 0.744] | 0.087 [0.056, 0.153] | 0.0428 | 0.600-0.666 |
| SELECTED | L0+L3 | 77 | 0.651 [0.571, 0.733] | 0.079 [0.051, 0.135] | 0.0429 | 0.627-0.648 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| L1-L0 | -0.025 [-0.078, +0.033] | 0.794 / 1.00 | 0.412 | F-calls | 1.000 (54) |
| L2-L1 | +0.050 [-0.028, +0.128] | 0.122 / 0.00 | 0.244 | F-calls | 1.000 (54) |
| L3-L2 | +0.015 [-0.016, +0.048] | 0.175 / 0.20 | 0.350 | F-calls | 1.000 (54) |
| L4-L3 | -0.009 [-0.026, +0.009] | 0.836 / 0.80 | 0.330 | F-calls | 1.000 (54) |
| L5-L4 | +0.006 [-0.015, +0.025] | 0.290 / 0.20 | 0.580 | F-calls | 1.000 (54) |
| L6-L5 | -0.000 [-0.011, +0.011] | 0.543 / 0.40 | 0.914 | F-calls | 1.000 (54) |
| L7-L6 | +0.006 [-0.008, +0.022] | 0.249 / 0.20 | 0.498 | F-calls | 1.000 (54) |
| L8-L7 | +0.003 [-0.009, +0.015] | 0.338 / 0.20 | 0.676 | F-calls | 1.000 (54) |
| FULL-L0 | +0.044 [-0.040, +0.132] | 0.160 / 0.00 | 0.320 | F-calls | 1.000 (54) |
| SELECTED-L0 | +0.037 [-0.036, +0.105] | 0.166 / 0.00 | 0.332 | not a test | - |

SELECTED forward pass (keep if Δ > 0 and P(Δ<=0) <= 0.20): final L0+L3

| layer | over | ΔAUC [95% CI] | P(Δ<=0) | kept |
|---|---|---|---|---|
| L1 Pre-Rx history (FT8) | L0 | -0.025 [-0.078, +0.033] | 0.794 | no |
| L2 Call activity | L0 | +0.018 [-0.061, +0.091] | 0.360 | no |
| L3 Haiku tags, Jev cross-checked | L0 | +0.037 [-0.036, +0.105] | 0.166 | yes |
| L4 Nemotron turns | L0+L3 | -0.007 [-0.028, +0.016] | 0.745 | no |
| L5 Odyssey | L0+L3 | -0.005 [-0.032, +0.018] | 0.674 | no |
| L6 emotion2vec | L0+L3 | -0.011 [-0.033, +0.007] | 0.883 | no |
| L7 Clef-omni | L0+L3 | +0.001 [-0.020, +0.021] | 0.491 | no |
| L8 Opus transcript score | L0+L3 | +0.008 [-0.017, +0.041] | 0.273 | no |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 926 | 1.000 | 42 | 1.000 | 884 | 1.000 | - |
| L1 | 393 | 0.424 | 17 | 0.405 | 376 | 0.425 | - |
| L2 | 571 | 0.617 | 33 | 0.786 | 538 | 0.609 | - |
| L3 | 455 | 0.491 | 22 | 0.524 | 433 | 0.490 | - | sources: {'runo_summary': 376, 'runo_stt': 235, 'bolna': 18}
| L4 | 234 | 0.253 | 11 | 0.262 | 223 | 0.252 | 156 |
| L5 | 231 | 0.249 | 10 | 0.238 | 221 | 0.250 | 156 |
| L6 | 231 | 0.249 | 10 | 0.238 | 221 | 0.250 | 156 |
| L7 | 231 | 0.249 | 10 | 0.238 | 221 | 0.250 | 156 |
| L8 | 202 | 0.218 | 11 | 0.262 | 191 | 0.216 | - |

Grouped permutation importance in FULL (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L2 | 6 | +0.0369 | -0.0921 | +0.1428 |
| L3 | 48 | +0.0357 | -0.0480 | +0.0960 |
| L3:runo_summary | 16 | +0.0303 | -0.0588 | +0.0828 |
| L0 | 29 | +0.0206 | -0.1323 | +0.2273 |
| L1 | 42 | +0.0105 | -0.0719 | +0.0832 |
| L3:runo_stt | 16 | +0.0076 | -0.0426 | +0.0392 |
| L7 | 19 | +0.0058 | -0.0336 | +0.0419 |
| L5:role_free | 9 | +0.0041 | -0.0281 | +0.0326 |
| L7:role_free | 7 | +0.0025 | -0.0411 | +0.0362 |
| L8 | 2 | +0.0018 | -0.0269 | +0.0205 |
| L7:role | 12 | +0.0002 | -0.0274 | +0.0170 |
| L6:role_free | 12 | -0.0001 | -0.0262 | +0.0257 |
| L5:role | 17 | -0.0009 | -0.0351 | +0.0194 |
| L3:bolna | 16 | -0.0010 | -0.0126 | +0.0014 |
| L4:role_free | 9 | -0.0021 | -0.0286 | +0.0141 |
| L4 | 15 | -0.0025 | -0.0351 | +0.0194 |
| L4:role | 6 | -0.0029 | -0.0442 | +0.0099 |
| L6 | 34 | -0.0030 | -0.0408 | +0.0325 |
| L5 | 26 | -0.0035 | -0.0784 | +0.0366 |
| L6:role | 22 | -0.0046 | -0.0410 | +0.0174 |

## lm7 / h90: n 545, positives 63 (base rate 0.116), clusters 545, 5 repeats x 5 folds (seed RS + rep, RS = 20261019)

- engine audio rows 110, role columns masked (all-fallback) 40; outcome-revealing Runo calls dropped (all days) 490
- layer 8 = ft-bench opus_screen2_p90, 65 rows with text
- ruling 4: layers 4-8 set missing on 1 rows with a Jev-added outcome-revealing call before T (S1 1 rows / 6 calls, S2 0 rows / 7 calls)
- L0 (tree seed 0) AUC 0.640 vs FTR v2 base (tree seed RS + rep, same rows and folds) 0.637: difference +0.003

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| L0 | L0 | 29 | 0.640 [0.566, 0.705] | 0.175 [0.124, 0.258] | 0.1003 | 0.606-0.679 |
| L1 | L0+L1 | 71 | 0.609 [0.528, 0.673] | 0.156 [0.114, 0.225] | 0.1014 | 0.580-0.643 |
| L2 | L0+L1+L2 | 77 | 0.651 [0.591, 0.706] | 0.159 [0.116, 0.220] | 0.1007 | 0.622-0.666 |
| L3 | L0+L1+L2+L3 | 125 | 0.648 [0.589, 0.706] | 0.157 [0.118, 0.211] | 0.1006 | 0.617-0.661 |
| L4 | L0+L1+L2+L3+L4 | 140 | 0.633 [0.575, 0.692] | 0.149 [0.110, 0.203] | 0.1013 | 0.617-0.643 |
| L5 | L0+L1+L2+L3+L4+L5 | 166 | 0.654 [0.596, 0.710] | 0.166 [0.121, 0.230] | 0.1002 | 0.631-0.669 |
| L6 | L0+L1+L2+L3+L4+L5+L6 | 200 | 0.660 [0.597, 0.717] | 0.179 [0.126, 0.253] | 0.0996 | 0.643-0.669 |
| L7 | L0+L1+L2+L3+L4+L5+L6+L7 | 219 | 0.663 [0.603, 0.718] | 0.185 [0.130, 0.265] | 0.0992 | 0.646-0.668 |
| L8 | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.667 [0.608, 0.722] | 0.188 [0.131, 0.273] | 0.0990 | 0.648-0.677 |
| FULL | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.667 [0.608, 0.722] | 0.188 [0.131, 0.273] | 0.0990 | 0.648-0.677 |
| SELECTED | L0+L2+L7 | 54 | 0.683 [0.623, 0.738] | 0.182 [0.132, 0.253] | 0.0989 | 0.646-0.705 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| L1-L0 | -0.031 [-0.058, -0.005] | 0.992 / 1.00 | 0.016 | F-calls | 0.784 (54) |
| L2-L1 | +0.042 [-0.014, +0.103] | 0.084 / 0.00 | 0.168 | F-calls | 1.000 (54) |
| L3-L2 | -0.003 [-0.024, +0.019] | 0.610 / 0.60 | 0.780 | F-calls | 1.000 (54) |
| L4-L3 | -0.015 [-0.030, -0.002] | 0.986 / 0.80 | 0.028 | F-calls | 1.000 (54) |
| L5-L4 | +0.021 [+0.001, +0.041] | 0.019 / 0.00 | 0.038 | F-calls | 1.000 (54) |
| L6-L5 | +0.006 [-0.007, +0.018] | 0.189 / 0.20 | 0.378 | F-calls | 1.000 (54) |
| L7-L6 | +0.003 [-0.007, +0.015] | 0.256 / 0.20 | 0.512 | F-calls | 1.000 (54) |
| L8-L7 | +0.004 [-0.003, +0.012] | 0.150 / 0.20 | 0.300 | F-calls | 1.000 (54) |
| FULL-L0 | +0.027 [-0.043, +0.099] | 0.214 / 0.20 | 0.428 | F-calls | 1.000 (54) |
| SELECTED-L0 | +0.043 [-0.021, +0.110] | 0.111 / 0.00 | 0.222 | not a test | - |

SELECTED forward pass (keep if Δ > 0 and P(Δ<=0) <= 0.20): final L0+L2+L7

| layer | over | ΔAUC [95% CI] | P(Δ<=0) | kept |
|---|---|---|---|---|
| L1 Pre-Rx history (FT8) | L0 | -0.031 [-0.058, -0.005] | 0.992 | no |
| L2 Call activity | L0 | +0.025 [-0.030, +0.085] | 0.198 | yes |
| L3 Haiku tags, Jev cross-checked | L0+L2 | -0.004 [-0.024, +0.017] | 0.640 | no |
| L4 Nemotron turns | L0+L2 | -0.030 [-0.046, -0.015] | 1.000 | no |
| L5 Odyssey | L0+L2 | +0.009 [-0.016, +0.035] | 0.273 | no |
| L6 emotion2vec | L0+L2 | +0.003 [-0.026, +0.033] | 0.454 | no |
| L7 Clef-omni | L0+L2 | +0.018 [-0.009, +0.049] | 0.108 | yes |
| L8 Opus transcript score | L0+L2+L7 | -0.003 [-0.012, +0.005] | 0.779 | no |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 545 | 1.000 | 63 | 1.000 | 482 | 1.000 | - |
| L1 | 233 | 0.428 | 18 | 0.286 | 215 | 0.446 | - |
| L2 | 324 | 0.594 | 51 | 0.810 | 273 | 0.566 | - |
| L3 | 227 | 0.417 | 34 | 0.540 | 193 | 0.400 | - | sources: {'runo_summary': 170, 'runo_stt': 110, 'bolna': 17}
| L4 | 109 | 0.200 | 17 | 0.270 | 92 | 0.191 | 69 |
| L5 | 108 | 0.198 | 17 | 0.270 | 91 | 0.189 | 69 |
| L6 | 108 | 0.198 | 17 | 0.270 | 91 | 0.189 | 69 |
| L7 | 108 | 0.198 | 17 | 0.270 | 91 | 0.189 | 69 |
| L8 | 64 | 0.117 | 12 | 0.190 | 52 | 0.108 | - |

Grouped permutation importance in FULL (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L2 | 6 | +0.0786 | -0.0385 | +0.2036 |
| L0 | 29 | +0.0309 | -0.0663 | +0.0939 |
| L6 | 34 | +0.0057 | -0.0441 | +0.0358 |
| L7 | 19 | +0.0050 | -0.0307 | +0.0339 |
| L5 | 26 | +0.0043 | -0.0273 | +0.0226 |
| L6:role_free | 12 | +0.0034 | -0.0491 | +0.0340 |
| L5:role_free | 9 | +0.0031 | -0.0186 | +0.0176 |
| L7:role_free | 7 | +0.0026 | -0.0344 | +0.0313 |
| L5:role | 17 | +0.0025 | -0.0099 | +0.0108 |
| L3:runo_summary | 16 | +0.0021 | -0.0407 | +0.0332 |
| L7:role | 12 | +0.0017 | -0.0119 | +0.0089 |
| L8 | 2 | +0.0015 | -0.0265 | +0.0165 |
| L4:role | 6 | +0.0008 | -0.0038 | +0.0090 |
| L3 | 48 | +0.0008 | -0.0446 | +0.0318 |
| L6:role | 22 | +0.0006 | -0.0088 | +0.0092 |
| L3:runo_stt | 16 | +0.0002 | -0.0194 | +0.0171 |
| L3:bolna | 16 | -0.0001 | -0.0014 | +0.0008 |
| L4 | 15 | -0.0053 | -0.0297 | +0.0107 |
| L4:role_free | 9 | -0.0066 | -0.0344 | +0.0057 |
| L1 | 42 | -0.0117 | -0.0692 | +0.0437 |

## lm7 / ale: n 947, positives 44 (base rate 0.046), clusters 947, 5 repeats x 5 folds (seed RS + rep, RS = 20261019)

- engine audio rows 244, role columns masked (all-fallback) 80; outcome-revealing Runo calls dropped (all days) 490
- layer 8 = ft-bench opus_screen2_p14, 217 rows with text
- ruling 4: layers 4-8 set missing on 3 rows with a Jev-added outcome-revealing call before T (S1 2 rows / 6 calls, S2 1 rows / 7 calls)
- L0 (tree seed 0) AUC 0.592 vs FTR v2 base (tree seed RS + rep, same rows and folds) 0.587: difference +0.004

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| L0 | L0 | 29 | 0.592 [0.508, 0.670] | 0.058 [0.039, 0.084] | 0.0447 | 0.545-0.618 |
| L1 | L0+L1 | 71 | 0.600 [0.521, 0.685] | 0.061 [0.042, 0.092] | 0.0446 | 0.529-0.625 |
| L2 | L0+L1+L2 | 77 | 0.652 [0.569, 0.735] | 0.086 [0.057, 0.153] | 0.0439 | 0.599-0.672 |
| L3 | L0+L1+L2+L3 | 125 | 0.676 [0.597, 0.751] | 0.092 [0.059, 0.158] | 0.0437 | 0.609-0.701 |
| L4 | L0+L1+L2+L3+L4 | 140 | 0.665 [0.590, 0.739] | 0.086 [0.056, 0.144] | 0.0438 | 0.608-0.689 |
| L5 | L0+L1+L2+L3+L4+L5 | 166 | 0.664 [0.586, 0.738] | 0.080 [0.053, 0.129] | 0.0440 | 0.613-0.677 |
| L6 | L0+L1+L2+L3+L4+L5+L6 | 200 | 0.661 [0.584, 0.733] | 0.077 [0.052, 0.120] | 0.0441 | 0.592-0.688 |
| L7 | L0+L1+L2+L3+L4+L5+L6+L7 | 219 | 0.676 [0.600, 0.750] | 0.082 [0.055, 0.129] | 0.0439 | 0.622-0.693 |
| L8 | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.669 [0.589, 0.747] | 0.089 [0.057, 0.152] | 0.0437 | 0.605-0.697 |
| FULL | L0+L1+L2+L3+L4+L5+L6+L7+L8 | 221 | 0.669 [0.589, 0.747] | 0.089 [0.057, 0.152] | 0.0437 | 0.605-0.697 |
| SELECTED | L0+L2+L3+L7 | 102 | 0.663 [0.580, 0.741] | 0.095 [0.058, 0.164] | 0.0436 | 0.630-0.666 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| L1-L0 | +0.008 [-0.053, +0.080] | 0.373 / 0.60 | 0.746 | F-calls | 1.000 (54) |
| L2-L1 | +0.052 [-0.029, +0.128] | 0.097 / 0.00 | 0.194 | F-calls | 1.000 (54) |
| L3-L2 | +0.025 [-0.006, +0.058] | 0.058 / 0.20 | 0.116 | F-calls | 1.000 (54) |
| L4-L3 | -0.012 [-0.024, +0.001] | 0.968 / 0.80 | 0.064 | F-calls | 1.000 (54) |
| L5-L4 | -0.001 [-0.020, +0.016] | 0.549 / 0.60 | 0.904 | F-calls | 1.000 (54) |
| L6-L5 | -0.003 [-0.017, +0.009] | 0.722 / 0.40 | 0.556 | F-calls | 1.000 (54) |
| L7-L6 | +0.016 [-0.002, +0.035] | 0.050 / 0.40 | 0.100 | F-calls | 1.000 (54) |
| L8-L7 | -0.007 [-0.020, +0.007] | 0.840 / 0.40 | 0.320 | F-calls | 1.000 (54) |
| FULL-L0 | +0.078 [-0.005, +0.168] | 0.031 / 0.00 | 0.062 | F-calls | 1.000 (54) |
| SELECTED-L0 | +0.072 [-0.014, +0.157] | 0.053 / 0.00 | 0.106 | not a test | - |

SELECTED forward pass (keep if Δ > 0 and P(Δ<=0) <= 0.20): final L0+L2+L3+L7

| layer | over | ΔAUC [95% CI] | P(Δ<=0) | kept |
|---|---|---|---|---|
| L1 Pre-Rx history (FT8) | L0 | +0.008 [-0.053, +0.080] | 0.373 | no |
| L2 Call activity | L0 | +0.039 [-0.036, +0.117] | 0.166 | yes |
| L3 Haiku tags, Jev cross-checked | L0+L2 | +0.024 [-0.007, +0.057] | 0.063 | yes |
| L4 Nemotron turns | L0+L2+L3 | +0.002 [-0.019, +0.026] | 0.461 | no |
| L5 Odyssey | L0+L2+L3 | -0.016 [-0.042, +0.005] | 0.930 | no |
| L6 emotion2vec | L0+L2+L3 | -0.021 [-0.050, +0.000] | 0.974 | no |
| L7 Clef-omni | L0+L2+L3 | +0.008 [-0.009, +0.024] | 0.177 | yes |
| L8 Opus transcript score | L0+L2+L3+L7 | +0.003 [-0.014, +0.024] | 0.446 | no |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 947 | 1.000 | 44 | 1.000 | 903 | 1.000 | - |
| L1 | 402 | 0.424 | 19 | 0.432 | 383 | 0.424 | - |
| L2 | 590 | 0.623 | 35 | 0.795 | 555 | 0.615 | - |
| L3 | 471 | 0.497 | 23 | 0.523 | 448 | 0.496 | - | sources: {'runo_summary': 391, 'runo_stt': 244, 'bolna': 18}
| L4 | 242 | 0.256 | 11 | 0.250 | 231 | 0.256 | 163 |
| L5 | 238 | 0.251 | 10 | 0.227 | 228 | 0.252 | 163 |
| L6 | 238 | 0.251 | 10 | 0.227 | 228 | 0.252 | 163 |
| L7 | 238 | 0.251 | 10 | 0.227 | 228 | 0.252 | 163 |
| L8 | 214 | 0.226 | 12 | 0.273 | 202 | 0.224 | - |

Grouped permutation importance in FULL (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L2 | 6 | +0.0423 | -0.0926 | +0.1465 |
| L3 | 48 | +0.0335 | -0.0570 | +0.1076 |
| L0 | 29 | +0.0266 | -0.1206 | +0.1768 |
| L1 | 42 | +0.0258 | -0.1151 | +0.1293 |
| L3:runo_summary | 16 | +0.0194 | -0.0556 | +0.0621 |
| L3:runo_stt | 16 | +0.0123 | -0.0204 | +0.0716 |
| L8 | 2 | +0.0067 | -0.0517 | +0.0648 |
| L7 | 19 | +0.0049 | -0.0492 | +0.0286 |
| L4 | 15 | +0.0048 | -0.0250 | +0.0268 |
| L5:role_free | 9 | +0.0045 | -0.0294 | +0.0305 |
| L6:role_free | 12 | +0.0035 | -0.0190 | +0.0238 |
| L5 | 26 | +0.0030 | -0.0549 | +0.0297 |
| L7:role_free | 7 | +0.0017 | -0.0374 | +0.0191 |
| L4:role_free | 9 | +0.0017 | -0.0143 | +0.0235 |
| L4:role | 6 | +0.0010 | -0.0197 | +0.0202 |
| L7:role | 12 | -0.0006 | -0.0236 | +0.0130 |
| L3:bolna | 16 | -0.0018 | -0.0234 | +0.0024 |
| L6 | 34 | -0.0018 | -0.0437 | +0.0407 |
| L6:role | 22 | -0.0031 | -0.0417 | +0.0224 |
| L5:role | 17 | -0.0040 | -0.0502 | +0.0152 |

## consult / ale_strict: n 138, positives 23 (base rate 0.167), clusters 138, 20 repeats x 5 folds (seed rep (FT4))

- FT8 rows linked by episode_id: 99/138
- layer 8 = ft-bench opus_screen2_p14, 131 rows with text

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| C0 | L0 | 3 | 0.718 [0.596, 0.827] | 0.375 [0.242, 0.601] | 0.1243 | 0.632-0.756 |
| C1 | L0+L1 | 46 | 0.642 [0.488, 0.771] | 0.331 [0.206, 0.557] | 0.1325 | 0.585-0.674 |
| C4 | L0+L1+L4 | 56 | 0.677 [0.511, 0.819] | 0.345 [0.215, 0.560] | 0.1293 | 0.632-0.727 |
| C5 | L0+L1+L4+L5 | 81 | 0.692 [0.534, 0.829] | 0.346 [0.203, 0.543] | 0.1293 | 0.609-0.738 |
| C6 | L0+L1+L4+L5+L6 | 115 | 0.681 [0.541, 0.796] | 0.289 [0.181, 0.460] | 0.1326 | 0.610-0.726 |
| C7 | L0+L1+L4+L5+L6+L7 | 134 | 0.670 [0.528, 0.785] | 0.282 [0.171, 0.447] | 0.1330 | 0.614-0.726 |
| C8 | L0+L1+L4+L5+L6+L7+L8 | 136 | 0.691 [0.547, 0.807] | 0.306 [0.189, 0.485] | 0.1310 | 0.619-0.730 |
| FULL | L0+L1+L4+L5+L6+L7+L8 | 136 | 0.691 [0.547, 0.807] | 0.306 [0.189, 0.485] | 0.1310 | 0.619-0.730 |
| SELECTED | L0 | 3 | 0.718 [0.596, 0.827] | 0.375 [0.242, 0.601] | 0.1243 | 0.632-0.756 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| C1-C0 | -0.076 [-0.149, -0.007] | 0.983 / 0.95 | 0.034 | F-consults | 0.442 (14) |
| C4-C1 | +0.035 [-0.073, +0.144] | 0.248 / 0.05 | 0.496 | F-consults | 1.000 (14) |
| C5-C4 | +0.015 [-0.037, +0.066] | 0.284 / 0.35 | 0.568 | F-consults | 1.000 (14) |
| C6-C5 | -0.011 [-0.096, +0.078] | 0.637 / 0.75 | 0.730 | F-consults | 1.000 (14) |
| C7-C6 | -0.011 [-0.044, +0.015] | 0.792 / 0.80 | 0.432 | F-consults | 1.000 (14) |
| C8-C7 | +0.022 [+0.002, +0.041] | 0.019 / 0.00 | 0.038 | F-consults | 0.456 (14) |
| FULL-C0 | -0.026 [-0.150, +0.088] | 0.687 / 0.95 | 0.630 | F-consults | 1.000 (14) |
| SELECTED-C0 | +0.000 [+0.000, +0.000] | 1.000 / 1.00 | 1.000 | not a test | - |

SELECTED forward pass (keep if Δ > 0 and P(Δ<=0) <= 0.20): final L0

| layer | over | ΔAUC [95% CI] | P(Δ<=0) | kept |
|---|---|---|---|---|
| L1 Pre-Rx history (FT8) | L0 | -0.076 [-0.149, -0.007] | 0.983 | no |
| L4 Nemotron turns | L0 | -0.019 [-0.116, +0.072] | 0.621 | no |
| L5 Odyssey | L0 | -0.012 [-0.120, +0.084] | 0.583 | no |
| L6 emotion2vec | L0 | -0.066 [-0.196, +0.063] | 0.873 | no |
| L7 Clef-omni | L0 | -0.041 [-0.156, +0.059] | 0.783 | no |
| L8 Opus transcript score | L0 | +0.018 [-0.062, +0.090] | 0.311 | no |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 138 | 1.000 | 23 | 1.000 | 115 | 1.000 | - |
| L1 | 47 | 0.341 | 7 | 0.304 | 40 | 0.348 | - |
| L4 | 115 | 0.833 | 22 | 0.957 | 93 | 0.809 | 103 |
| L5 | 102 | 0.739 | 20 | 0.870 | 82 | 0.713 | 138 |
| L6 | 102 | 0.739 | 20 | 0.870 | 82 | 0.713 | 138 |
| L7 | 102 | 0.739 | 20 | 0.870 | 82 | 0.713 | 138 |
| L8 | 131 | 0.949 | 23 | 1.000 | 108 | 0.939 | - |

Grouped permutation importance in FULL (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L6 | 34 | +0.0700 | -0.1794 | +0.2767 |
| L0 | 3 | +0.0142 | -0.0630 | +0.0750 |
| L1 | 43 | +0.0113 | -0.0421 | +0.0652 |
| L6:role | 22 | +0.0090 | -0.2144 | +0.1619 |
| L6:role_free | 12 | +0.0021 | -0.1538 | +0.0994 |
| L8 | 2 | -0.0007 | -0.1447 | +0.0691 |
| L7 | 19 | -0.0011 | -0.0974 | +0.0962 |
| L4:role | 5 | -0.0042 | -0.0346 | +0.0196 |
| L7:role_free | 7 | -0.0094 | -0.1062 | +0.0308 |
| L5:role_free | 9 | -0.0114 | -0.1639 | +0.0417 |
| L7:role | 12 | -0.0120 | -0.0852 | +0.0496 |
| L5 | 25 | -0.0126 | -0.1154 | +0.0586 |
| L5:role | 16 | -0.0126 | -0.0769 | +0.0320 |
| L4:role_free | 5 | -0.0140 | -0.1522 | +0.0521 |
| L4 | 10 | -0.0188 | -0.1522 | +0.0381 |

## consult / h14_ge18: n 114, positives 12 (base rate 0.105), clusters 114, 20 repeats x 5 folds (seed rep (FT4))

- FT8 rows linked by episode_id: 86/114
- layer 8 = ft-bench opus_screen2_p14, 107 rows with text

| model | layers | n cols | AUC [95% CI] | PR-AUC [95% CI] | Brier | AUC range over repeats |
|---|---|---|---|---|---|---|
| C0 | L0 | 3 | 0.672 [0.434, 0.877] | 0.240 [0.120, 0.466] | 0.0886 | 0.615-0.720 |
| C1 | L0+L1 | 46 | 0.638 [0.461, 0.789] | 0.160 [0.080, 0.310] | 0.0947 | 0.519-0.685 |
| C4 | L0+L1+L4 | 56 | 0.636 [0.484, 0.791] | 0.160 [0.079, 0.319] | 0.0931 | 0.496-0.725 |
| C5 | L0+L1+L4+L5 | 81 | 0.609 [0.448, 0.765] | 0.153 [0.076, 0.306] | 0.0940 | 0.432-0.704 |
| C6 | L0+L1+L4+L5+L6 | 115 | 0.592 [0.424, 0.756] | 0.154 [0.076, 0.318] | 0.0947 | 0.426-0.666 |
| C7 | L0+L1+L4+L5+L6+L7 | 134 | 0.555 [0.390, 0.719] | 0.135 [0.070, 0.279] | 0.0961 | 0.377-0.630 |
| C8 | L0+L1+L4+L5+L6+L7+L8 | 136 | 0.574 [0.406, 0.742] | 0.146 [0.073, 0.302] | 0.0952 | 0.391-0.657 |
| FULL | L0+L1+L4+L5+L6+L7+L8 | 136 | 0.574 [0.406, 0.742] | 0.146 [0.073, 0.302] | 0.0952 | 0.391-0.657 |
| SELECTED | L0 | 3 | 0.672 [0.434, 0.877] | 0.240 [0.120, 0.466] | 0.0886 | 0.615-0.720 |

| delta | ΔAUC [95% CI] | P(Δ<=0) boot / repeats | p two-sided | family | Holm p (family size) |
|---|---|---|---|---|---|
| C1-C0 | -0.034 [-0.175, +0.098] | 0.709 / 0.90 | 0.582 | F-consults | 1.000 (14) |
| C4-C1 | -0.002 [-0.150, +0.143] | 0.497 / 0.65 | 0.994 | F-consults | 1.000 (14) |
| C5-C4 | -0.027 [-0.111, +0.054] | 0.736 / 0.60 | 0.540 | F-consults | 1.000 (14) |
| C6-C5 | -0.018 [-0.105, +0.063] | 0.656 / 0.60 | 0.694 | F-consults | 1.000 (14) |
| C7-C6 | -0.037 [-0.065, -0.007] | 0.995 / 1.00 | 0.012 | F-consults | 0.168 (14) |
| C8-C7 | +0.019 [-0.013, +0.056] | 0.139 / 0.20 | 0.278 | F-consults | 1.000 (14) |
| FULL-C0 | -0.099 [-0.306, +0.079] | 0.874 / 1.00 | 0.254 | F-consults | 1.000 (14) |
| SELECTED-C0 | +0.000 [+0.000, +0.000] | 1.000 / 1.00 | 1.000 | not a test | - |

SELECTED forward pass (keep if Δ > 0 and P(Δ<=0) <= 0.20): final L0

| layer | over | ΔAUC [95% CI] | P(Δ<=0) | kept |
|---|---|---|---|---|
| L1 Pre-Rx history (FT8) | L0 | -0.034 [-0.175, +0.098] | 0.709 | no |
| L4 Nemotron turns | L0 | -0.073 [-0.240, +0.070] | 0.823 | no |
| L5 Odyssey | L0 | -0.092 [-0.239, +0.038] | 0.899 | no |
| L6 emotion2vec | L0 | -0.100 [-0.268, +0.032] | 0.918 | no |
| L7 Clef-omni | L0 | -0.197 [-0.346, -0.059] | 0.998 | no |
| L8 Opus transcript score | L0 | +0.002 [-0.084, +0.077] | 0.464 | no |

| layer | rows with data | share | positives with data | share of positives | negatives with data | share of negatives | role columns present |
|---|---|---|---|---|---|---|---|
| L0 | 114 | 1.000 | 12 | 1.000 | 102 | 1.000 | - |
| L1 | 42 | 0.368 | 4 | 0.333 | 38 | 0.373 | - |
| L4 | 91 | 0.798 | 11 | 0.917 | 80 | 0.784 | 79 |
| L5 | 78 | 0.684 | 9 | 0.750 | 69 | 0.676 | 114 |
| L6 | 78 | 0.684 | 9 | 0.750 | 69 | 0.676 | 114 |
| L7 | 78 | 0.684 | 9 | 0.750 | 69 | 0.676 | 114 |
| L8 | 107 | 0.939 | 12 | 1.000 | 95 | 0.931 | - |

Grouped permutation importance in FULL (AUC drop; folds of repeats 0-1 x 10 permutations; mean [2.5, 97.5 pct]; descriptive)

| group | cols | mean | 2.5% | 97.5% |
|---|---|---|---|---|
| L6 | 34 | +0.0875 | -0.6159 | +0.5194 |
| L6:role | 22 | +0.0499 | -0.5148 | +0.3162 |
| L1 | 43 | +0.0399 | -0.0944 | +0.1851 |
| L6:role_free | 12 | +0.0081 | -0.2186 | +0.1235 |
| L4 | 10 | +0.0076 | -0.2089 | +0.1353 |
| L5:role_free | 9 | +0.0047 | -0.0714 | +0.0952 |
| L4:role_free | 5 | +0.0039 | -0.2381 | +0.1622 |
| L5 | 25 | +0.0031 | -0.1598 | +0.1905 |
| L7:role | 12 | -0.0053 | -0.0909 | +0.0899 |
| L4:role | 5 | -0.0060 | -0.0714 | +0.0661 |
| L8 | 2 | -0.0189 | -0.2727 | +0.0543 |
| L7:role_free | 7 | -0.0191 | -0.0781 | +0.0444 |
| L5:role | 16 | -0.0281 | -0.1716 | +0.1375 |
| L7 | 19 | -0.0297 | -0.1764 | +0.0714 |
| L0 | 3 | -0.0322 | -0.2727 | +0.0742 |

