# ft-refute-base REPORT: FT3 Pulse baseline (lane ft-labels-base), independent recompute. Opus 5.5 (global.anthropic.claude-opus-5-5), Bedrock
My own pipeline is work/labels.py (a copy of ft-refute-labels recompute.py with h14 NaN when age < 18 d), then work/feats.py, work/model.py and work/spec_gsonly.py. Outputs: work/mine.json, model.log, spec_gsonly.log.
Labels: D h14 1,101/189 and h90 659/150, with 0 row mismatches against labels.parquet (sha 0aefc00f425b, which matches). D only; H was never read.
I wrote my numbers down before reading the lane code. My features are my own procedure-class regex, specialty, the in-fold smoothed doctor rate, doctor and patient sex, age, ICD count and first chapter, investigations, n_prior_rx, prior payer, weekday and hour.
Model: RF with 500 trees and leaf size 5, no tuning, and 5 seeds averaged on the temporal split. Cluster bootstrap B=2000.

| Claim (lane) | Lane | Mine | Result |
|---|---|---|---|
| H14 temporal train / test n/pos | 441/78 ; 651/110 | 441/78 ; 651/110 | PASS |
| H14 temporal AUC; PR-AUC | 0.60 (0.54-0.65); 0.21 | 0.604 (0.55-0.66); 0.223 | PASS |
| H14 Brier vs no-skill | 0.139 vs 0.140 | 0.138 vs 0.1405 (in-fold sigmoid: 0.138) | PASS |
| H14 doctor rate alone | 0.58 | 0.575 (0.52-0.63) | PASS |
| H14 5x5 grouped CV, n 1,101/189 | 0.63 (0.60-0.67) | 0.652 (0.61-0.69); repeats 0.63-0.66 | PASS |
| H90 temporal, test 1 Jun-17 Jul, n 218/53: AUC; Brier vs no-skill | 0.72 (0.65-0.80); 0.172 vs 0.185 | 0.687 (0.61-0.76); 0.174 vs 0.1845 | PASS (fragile, see 5) |
| H90 CV, n 659/150 | 0.69 (0.64-0.73) | 0.679 (0.63-0.72) | PASS |
| Driver: doctor, H14 / H90 | +0.035 / +0.073 | +0.035 / +0.049 (CV permutation) | PASS |
| Driver: procedure class | +0.023 / +0.047 | +0.013 / +0.028 | PASS (same sign, smaller) |
| Driver: specialty | +0.016 / +0.006 | +0.013 / +0.008 | PASS |
| Age, sex, investigations, payer about 0 | yes | H14 all within ±0.003; H90 age +0.009 (CI excl. 0) | PASS-ish; doctor_gender, ICD omitted (issue 4) |
| Within-spec H14 CV, GS (General Surgery only) | 0.54, n 436/103 | 0.56 (0.50-0.63), n 436/103 | PASS (n exact) |
| Within-spec H14 CV, Gyn | 0.57 (0.49-0.65), n 189/30 | 0.65 (0.55-0.75), n 189/30 | PASS (CIs overlap) |
| Within-spec H14 CV, Ortho | 0.52 (0.38-0.65), n 156/28 | 0.59 (0.48-0.70), n 156/28 | PASS (CIs overlap) |
| Within-spec H14 CV, Uro | 0.55 (0.36-0.75), n 109/12 | 0.49 (0.31-0.67), n 109/12 | PASS (CIs overlap) |

## forest-lead checks
(1) Aug-Sep D Rx in the H14 temporal test: PASS.
- ft3_model.py has a fixed RF (400 trees, leaf 5, sqrt) and no search. The model trains on Dec-May only, and the Jun-Sep test is scored once per run.
- Three runs were scored on the same Jun-Sep test: withpayer 0.650, nopayer 0.600 and final 0.597.
- The one feature-set change was the payer-leak ruling, not a choice made on test AUC. The final run scores below the no-payer run, so nothing was selected upward.
- The H90 seal is intact: Aug-Sep rows have no final h90 (age < 94 d) and appear in no H90 fit.
- Caveat: the H14 CV, permutation drivers and doctor rates use Aug-Sep H14 outcomes. If these FT findings steer the H90 v1 feature list, the v1 test is softly contaminated (see 2).
(2) Payer: PASS.
- Same-day payer is dropped by default (COLS filter, PAYER!=1), and 'payer' is absent from the ft3_results.json permutation keys.
- ft3d prior payer is the last appointment strictly before the Rx day (SQL `< rx.d`). Fill is 5%, and its importance is about 0 (slightly negative in mine too).
- ft3_results.json is the no-leak run with prior payer; _nopayer has no payer at all. The leak was real: withpayer H14 temporal AUC 0.650 vs 0.597.
(3) Brier equals no-skill: PASS, and there is no target leakage.
- No calibration is fitted anywhere (raw RF probabilities), so nothing can leak through calibration. This deviates from the brief, which asked for sigmoid out-of-fold.
- The doctor rate is in-fold. Training rows get an inner 5-fold GroupKFold out-of-fold rate; test rows get the train-only rate; it is recomputed inside every CV fold, with m=10 smoothing.
- My in-fold sigmoid gives the same Brier (0.138). Brier sits near no-skill because the model is weak, not because of leakage.
(4) Within-specialty: n/pos reproduce exactly, and all lane CIs exist in ft3_results.json. Every lane CI contains 0.5.
- Mine differ by 0.02-0.09, inside each other's CIs.
- Mine also show that the pooled AUC partly comes from mix between specialties: the "other" group reaches 0.75 within itself.

## Issues (fixes before FT7)
1. FIX: DONE.md gives within-specialty AUCs without CIs.
   - Use: GS 0.54 (0.48-0.60), Gyn 0.57 (0.49-0.65), Ortho 0.52 (0.38-0.65), Uro 0.55 (0.36-0.75; only 12 positives).
   - Say plainly that the model does not discriminate reliably within any big-4 specialty.
2. FIX: add an H14 Jun-Jul-only test as the seal-safe sensitivity (mine: n 278/46, AUC 0.63 (0.55-0.72)).
   - State that drivers and doctor rates learned from Aug-Sep H14 outcomes must not select H90 v1 features, or recompute them without Aug-Sep.
3. FIX (doc): say "uncalibrated RF". The brief asked for out-of-fold sigmoid calibration; it is not needed, because my out-of-fold sigmoid version changes nothing.
4. FIX (doc): the drivers line leaves out doctor_gender and ICD.
   - Lane H14 CV: doctor_gender +0.011, ICD +0.008. Mine: +0.017 each.
   - Doctor gender is a proxy for the doctor (81 doctors).
5. NOTE: H90 temporal AUC moves between 0.69 and 0.74 across runs and seeds (lane single seed 0.724, nopayer 0.735, mine averaged over 5 seeds 0.687). Quote it as "about 0.7 (n 218/53)".
6. NOTE: month_idx is a feature. In the temporal test it falls outside the training range (permutation importance 0); drop it or say so.
   - The S5 data is read from the raw ~/wt/forest-funnel-join exports, not s5-clean. They are equivalent here: 1,233/1,233 D rows, 0 bad, and the JSON quoting matches the lane regex. Minor: the lane's 'anal' procedure term can match unrelated names.

## Verdict: PASS-WITH-FIXES
Every headline number reproduces within its CI on an independent pipeline: n/pos exact, H14 AUC 0.60 vs 0.60, CV 0.63 vs 0.65, H90 0.72 vs 0.69. The doctor is confirmed as the top driver.
There is no leakage on payer, calibration or the doctor rate, and the Aug-Sep use is clean for the H14 test. The fixes are about wording: within-specialty CIs, a Jun-Jul sensitivity, and the drivers list.
