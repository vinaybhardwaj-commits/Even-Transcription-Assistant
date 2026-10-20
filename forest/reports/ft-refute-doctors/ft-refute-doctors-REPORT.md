# ft-refute-doctors REPORT: FT5 claim (out/ft-doctors/DONE.md, v2 17:05). Opus 5.5 (Bedrock), 19 Oct 2026
I recomputed everything independently in work/ (labels_D.py, cohort2.py, feats.py, glmm.py, a2.py, a3.py, scen.py, derm.py, pitches.py, pairs.py, obs.py). My numbers were written to work/MY-NUMBERS.md before I opened any lane output. I never read the lane code (*.py) or results.json; after that point I opened only pairs.tsv and pitches_by_doctor.tsv, to diagnose the pitch counts. D split only. H rows were dropped at split assignment, and no H features or text were read.
Labels: I applied ft-refute-labels' logic with H14 final at >= 18 d. labels.parquet v2 (sha 0aefc00f425b) matches 1,233 of 1,233 D rows, with 0 mismatches on h14, h90, lag, cluster, age, doctor or specialty. D h14 is n 1,101 / pos 189 and h90 is 659 / 150. PASS.

| Claim | Lane | Mine | Result |
|---|---|---|---|
| H14 cohort n/conv/docs/specs | 833/163/18/4 | 833/163/18/4 | PASS |
| H90 cohort | 425/125/12/3 | 425/125/12/3 | PASS |
| Inclusion rule (derived) | - | doctor >= 10 final eps; specialty with >= 2 such doctors; specialty with >= 1 conversion (drops Derm at H14; with Derm: 871/163/20/5) | PASS (not stated in DONE.md) |
| ICC unadjusted H14 / H90 | 5.6% / 13.7% | VB 5.6% (3.0-10.3) / 13.7% (6.7-26.0); ML 3.4% (0-19.8) / 14.6% (1.4-45.2) | PASS |
| ICC adj H14 | 4.0% (2.1-7.5) | VB 3.9% (2.0-7.2); ML 0.0% (profile 95% 0-11.7) | PASS on value, FAIL on CI |
| ICC adj H90 | 3.5% (1.6-7.7) | VB 5.2% (2.4-11.1); ML 0.0% (0-10.3) | PASS (overlaps), CI as above |
| Obstetric-excluded ICC H14 / H90 | 3.8% / 2.7% | VB 3.1% (1.6-5.9) / 4.0% (1.8-8.6); ML 0 / 0 | PASS (directional) |
| LR doctor after case mix H14 | p 0.014 (df 14) | 27.8, df 14, p 0.015; parametric bootstrap p 0.037 | PASS (chi2 anti-conservative) |
| LR H90 | p 0.11 (df 9) | 18.8, df 9, p 0.027; bootstrap p 0.043 | FAIL (covariate-set dependent) |
| Median OR | ~1.4 | VB 1.4; ML 1.00 (upper 1.88) | PASS-ish |
| CV AUC gain H14 | +0.016 (-0.016 to +0.063) | +0.011 (-0.027 to +0.023), 5x20 CV | PASS (n.s.) |
| Top-4 non-converted (H14) | GS 333/436, Gyn 159/189, Ortho 128/156, Uro 97/109; 717/798 | identical | PASS |
| Lost conv: to median / +20% / best | 18 / 35 / 127 | 17.8 / 34.6 (= 0.2 x 173 top-4 H14 pos) / 121.6 | PASS |
| Dermatology | 50 eps, 0 conv, 5 docs (H90 34) | 50 / 0 / 5 (H90 34) | PASS; cause below |
| Listening pairs | 3 pairs (GS H14, Ortho H14, GS H90); 160 ids / 20 doctors | GS H14 + GS H90 only; Ortho H14 not reproducible in D | FAIL |
| GS H14 low O/E | 0.34 (0.09-0.87) | 0.37 (0.10-0.95), the same doctor (n 47, 4 conv) | PASS |
| ANOVA check, Shapley 43-46% | - | not recomputed | n/a |

## Issues
1. **SEAL (must fix).** 15 of the 160 listening ids in pitches_by_doctor.tsv are H-split consults. Both the patient key and the cluster key are in the lock list as H. All 15 come from the haiku_f01 source (unflagged consults, h14_episode = no_flagged_episode) and span 10 doctors. 3 of them belong to Ortho cohort doctors. They lift the Ortho H14 "high" doctor from 4 to 6 pitches, so that **pair exists only because of H consults**. Fix: assign the split to every pitch via 10b consult -> patient_key -> split_guard. Drop the 15 ids and the Ortho pair, leaving 145 ids. Nobody should listen to the 15. FT4 should check its recorded cohort for the same leak.
2. **The ICC CIs are overconfident.** The variational-Bayes CrI never reaches 0 (the lower bound 2.1% is a prior/VB artefact). An ML random-intercept fit (adaptive GH-30) puts sigma at the boundary after case mix (ICC 0%). Profile 95% upper bounds are 11.7% at H14 and 10.3% at H90; the likelihood is flat, and an ICC of 7% costs only 1.1 log-lik. Report the point estimate as "0-4%, upper bound ~12%".
3. **The adjusted ICC depends on the covariates chosen.** ICD-chapter dummies take the H90 VB ICC from 14.9% to 7.0%, and the ML estimate to 0. Within a specialty, a diagnosis chapter may itself reflect a doctor's mix or coding style. DONE.md should list its case-mix columns.
4. **Separation.** At H14, 3 cohort doctors have 0 conversions (n 12/14/16), and one GS doctor holds 276 of 833 episodes (33%). The fixed-effect chi-square p values overstate the evidence (bootstrap p 0.037 vs 0.015).
5. **Dermatology is not a regex or label bug. It is a gap in outcome coverage.** All 64 D Derm Rx have 0 OT dates, 0 bills and 0 admissions in raw S5; other top specialties show 25-31% with any event. The flagged procedures are OPD-type (PRP, cautery, laser, small excisions), and 38 of 64 have an empty flag_proc. S5 cannot observe OPD-procedure billing. Treat Derm (and probably ENT, 8% any-event) as unmeasurable, not 0% converting; excluding it from the GLMM is correct.
6. **The pair-selection rule is not stated.** The lane picks the GS high doctor by raw rate (n 276, O/E 1.06); by O/E the high doctor would be the n 68 doctor (O/E 1.19). Neither has an O/E CI that excludes 1.
7. The lane does say DIRECTIONAL, gives CIs and states n/pos. The cohort inclusion rule is not stated in DONE.md.

## Verdict
**"~80% of variance is the doctor" is NOT supported. CONFIRMED.**
- Every estimator I ran puts the doctor share within specialty after case mix at 0-5%, with upper 95% bounds around 10-12%.
- Even with no case-mix adjustment, the top of any CI is 45% (H90 ML).
- The doctor effect is at most modest. The median OR is about 1.0-1.4 and the CV AUC gain is not significant.

ft-refute-doctors: **PASS-WITH-FIXES**. Required fix: remove the 15 H consult ids and the Ortho H14 pair from the listening list. Should fix: report the ML/profile CI, list the case-mix columns, and relabel Derm as unmeasured.
