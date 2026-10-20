# ft-refute-forest REPORT (20 Oct 2026 11:25 IST). Independent Opus refuter, served by Claude Opus 5.5 (claude-opus-5-5). D only; H never read.
- Spec sha256 704c50dffbefa9d4… VERIFIED. Read: spec, SWARM, LANE-CLAIM, FOREST-TABLES, BENCH-C-FOREST, CALIB-*. My own numbers were written (work/res_*.json, work/oof_*.npz, 10:18) BEFORE I opened any ft-forest output. I never read ft-forest code or logs.
- Own code: ~/wt/ft-refute-forest/work/{guard,rf_refute,analyze}.py (0700 dir; outputs 0600). RF(400, leaf 5, sqrt, random_state=0), NaN -1, my own in-fold doctor rate (m=10, inner GroupKFold), SGKF folds (A/B: RS+rep x5; C: rep x20), 1,000-draw cluster bootstrap seed 20261019, p = 2·min(P≤0, P≥0) floored at 1/1000, Holm per family.

## Seal (split_guard, pins list 52959278edd8 / seed 3b10cbf1f278, seed file verified): PASS
- 16 inputs (features_D, ft8, calls_D, episodes_D, tags_D_jev, rlfeat_tags_jev, bolna, engine calls/consults, layer8 B/C, designC, features_ale, bench_scores frozen/C, rl calls_basic): require_dev passed, 0 H keys.
- Notes: labels.parquet holds 389 H rows (it is the shared file; the lane and I both filter to split==D). 12 engine-consult rows have no episode and are not in design C, so they enter no model.

## Claims, with mine beside them
| # | claim (lane) | mine | verdict |
|---|---|---|---|
| 1a | L0 = cols.json order minus payer (29); L1 = 42 ft8_*; L2 6; L3 48 (16 summary + 16 STT + 16 Bolna); L5 26; L6 34; L7 19; L8 2 | identical names and order; my independently built layers have the same counts | PASS |
| 1b | L4 = 15 | mine 14: lane adds `roles_ok` (= n_calls_roleok_tT>0), a QC flag not in the spec's L4 field list | NOTE |
| 1c | No consult layer 3 (A M2 = M1 + C4..C8, 161 cols; C = C0,C1,C4..C8); no *_lex2; no wavlm | confirmed (0 lex2, 0 wavlm, no layer-3 key); C L1 = 42 + `has_ft8_row` (43) | PASS (note flag) |
| 1d | Role columns masked when n_calls_roleok_tT==0 | needed: the engine file leaves 8 role count columns (n_win/n) at 0 on 87 (T3) / 96 (T7) such rows; no role VALUE is present there | PASS |
| 1e | Ruling 4: layers 4-8 missing on Jev-added revealing rows: lm3 2/1/2, lm7 2/1/3 | mine 2/1/2, 2/1/3 | PASS |
| 2 | No leakage: A before Rx; B before T; at-risk surgery > T | ft8 *_age_d min 1 and source max date = Rx−1; engine-eligible calls max day 2 (T3) / 6 (T7), 0 revealing, 0 post-event; L8 keyed by T; at-risk asserted; B n 976/572/1005/926/545/947 = lane | PASS |
| 3a | F-primary h14 M1−M0 −0.024 [−0.043, −0.003], Holm 0.048 (2) | −0.0239 [−0.0432, −0.0030], Holm 0.048 | PASS |
| 3b | h90 M1−M0 −0.019 [−0.039, +0.001], Holm 0.072 | −0.0192 [−0.0386, +0.0014], Holm 0.072 | PASS |
| 3c | A AUCs M0/M1/M2 h14 .634/.610/.607, h90 .690/.670/.664 | identical (max |Δdelta| over A tests 0.0004) | PASS |
| 3d | Bench survivor FULL>Jev h90 T7 +0.120, Holm 0.024 (24) | +0.1205 [+0.044, +0.191], p 0.001, Holm 0.024; my FULL AUC 0.668 vs lane 0.667 | PASS |
| 3e | 6 random F-calls (rng 20261020) | lm7 h90 L1−L0 −0.031 vs −0.031; lm3 ale L6−L5 −0.011 vs −0.005; lm3 ale L5−L4 −0.006 vs −0.013; lm7 h14 L5−L4 +0.000 vs +0.006; lm7 h14 L7−L6 +0.010 vs +0.006; lm3 h90 L6−L5 +0.001 vs −0.001. All Holm ≥ 0.1 in both | PASS |
| 3f | All 73: 0 Holm gains, 1 Holm loss | 0 gains, 1 loss (same test). F-calls max |Δdelta| 0.012 (engine layers L4+: 1-column and has-flag differences); C max 0.037 (h14_ge18, 12 positives). Holm<0.2 disagreements: lm3 h14 L5−L4 lane 0.054 / mine 0.98; lm3 h90 L4−L3 lane 0.50 / mine 0.054. Neither below 0.05 | PASS |
| 4 | Families 2+3+54+14 = 73 here; F-bench 24 | the same membership as spec s9 (pre-registered; spec frozen 08:22, run 08:23) | PASS |
| 5a | Raw RF calibration (A): h14 M0 Brier 0.138/no-skill 0.142, slope 0.876, int −0.211; M1 0.140, 0.726, −0.439; h90 M0 0.163/0.176, 1.024; M1 0.165, 0.982 | identical to 3 dp | PASS |
| 5b | Sigmoid = cross-fitted on OOF, "approximate"; nested Platt NOT run (disclosed) | I ran the spec's nested in-fold Platt for A M0/M1: Brier 0.139/0.140 (h14), 0.163/0.166 (h90), same as raw ±0.001; slope 1.19/1.06 (h14), 1.22/1.24 (h90). The lane's cross-fit slopes (0.94-1.06) look better than the true nested ones. The cross-fit also changes AUC (h14 M0 0.634→0.626), against spec s6 "calibration does not change AUC" | LIMITATION CONFIRMED |
| 6 | SELECTED optimistic; not tests | FOREST-TABLES l.6 + "not a test" rows; LANE-CLAIM and FT7-REPORT l.292 say optimistic; none in a Holm family. I did not refit the SELECTED paths | PASS |

## Issues
1. **FIX (BENCH-C-FOREST, design C benchmark (a))**: the lane's "all"-population a_intent_raw AUC is 0.500 for both consult cohorts, i.e. scored as a constant. ft-bench's own BENCH-TABLES-C and my recompute on bench_scores_c (values −1/1/2, 13 covered) give 0.550 (ale_strict) and 0.461 (h14_ge18). The corrected FULL−a values: ale_strict +0.142 [−0.019, +0.293], p 0.096 (lane +0.191, p 0.006, Holm 0.138); h14_ge18 +0.109 [−0.063, +0.285], p 0.23 (lane +0.074). Holm survivors are unchanged: still only FULL>Jev h90 T7 (Holm 0.024). The C7−a column is affected the same way.
2. **FIX (FT7 calibration wording)**: report the nested-Platt slopes from point 5b, or keep "approximate, optimistic" next to the cross-fit numbers. Raw RF is the defensible calibration claim. Brier skill is small (h14 0.002-0.004, h90 0.011-0.013 absolute Brier).
3. NOTE: disclose the extra flags `roles_ok` (B L4) and `has_ft8_row` (C L1) in FT7. Both are has-type flags allowed by spec s3, but they are not in the s4 field list. They have no effect on any test conclusion (my build without roles_ok gives the same Holm outcomes).
4. NOTE: my bench (b)/(c) "all" use the median fill per ft-bench DONE. My B-bench deltas match ft-bench json within 0.005.

## Verdict: PASS-WITH-FIXES
The primary result (FT8 lowers the at-Rx AUC: h14 Holm loss, h90 directional), the 73-test outcome (0 gains / 1 loss), the single bench survivor and the raw calibration all reproduce independently. Fix 1 (design C (a) numbers) and fix 2 (nested-Platt wording) before FT7 quotes them. Neither changes a Holm conclusion.
