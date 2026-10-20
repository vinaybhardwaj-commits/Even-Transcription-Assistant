# Who converts? Patient, visit, doctor and process characteristics that go with surgical conversion

Lane ft-whoconverts for newcat-orch / V, 20 Oct 2026 12:10 IST. D split only: no H outcome or feature was read (see Limits for the f1 split file). Descriptive and post hoc: these are associations, not causes.
Comparisons: h14 100 (⚑ 15 at BH q < 0.10), h90 86 (⚑ 28), Ale 102 (⚑ 20); BH within each outcome. At q < 0.10, about 1 in 10 flags may be chance.

## Summary (plain English, h14 unless stated; revised after the independent refute, PASS-WITH-FIXES)
1. Overall, 189 of 1,101 advised patients (17%) had surgery within 14 days. The largest differences are by what was advised and by whom. General Surgery converts at 24% and Dermatology at 0% (ENT 0 of 21, not flagged). Anorectal advice converts at 27%. Visits with no procedure coded convert at 10%, and that gap holds within specialty.
2. Doctors differ beyond chance even within the same specialty (p = 0.002; also flagged for h90 and Ale). Among the five General Surgery doctors with 10 or more episodes, shrunk rates run from 11% to 38%. Patients of male doctors convert at 19% and of female doctors at 10%. That gap rests on one or two doctors per specialty: shuffling gender across doctors gives p = 0.40, so it cannot be told apart from individual-doctor differences.
3. Patients with no pincode on file convert at 12%. But the pincode is the value on file today, not at the advice, and it may be filled in at the surgery admission. Missing pincodes are also far more common on older and returning records. So this gap may partly reflect the outcome itself, and it is not evidence about distance (which cannot be computed).
4. New patients convert more than returning ones (19% vs 14%), but the gap shrinks within specialty (OR 1.17, interval crosses 1).
5. Medical history: patients with past labs on file (HbA1c, Hb, creatinine, eGFR, TSH) convert at 9-11%, against 19% without. Within specialty the gap is smaller and clear only for eGFR. The refuter's adjustment for returning status, prior-Rx count and age still gives eGFR an OR of 0.42 [0.20-0.87]. Obesity goes with low conversion (3 of 67, OR 0.24). Among returning patients nothing is flagged: obesity, HbA1c and eGFR have q of about 0.11, Hb and TSH 0.19, creatinine 0.49.
6. No link with age, sex, payer before the advice (95% have none recorded), day of week, month, consult language (only 86 consults have audio) or investigations ordered.
7. Counsellor calls (day-7 rows, 42 conversions on days 8-14): patients not called by day 7 convert at 3%, against 6% for those called 3 or more times. This is not flagged for h14 (q = 0.11) or for Ale; it is flagged for h90. Much of it is likely reverse-driven: 45% of converters, against 12% of non-converters, had a call before day 7 that already revealed the outcome.
8. Inside the frozen forests no single input is clearly needed: every shuffle interval crosses 0. Design A leans on the doctor, doctor gender and specialty. Design B (day 7) leans on call activity (Runo summaries, recorded calls, day of first call), procedure group, age and sex. The consult audio and voice inputs each add about 0.001 AUC or less.
9. A plain logistic regression on the Pulse baseline matches the frozen Pulse-only forest at design A (0.638 vs M0 0.634). It also scores above the full M2 forest (0.607), which is itself below M0. At design B it scores 0.623 against the forest's 0.658 (-0.035, interval -0.134 to +0.059): the two cannot be told apart, and the forest could be up to 0.13 better. The readable directions: General Surgery, anorectal and minor gynae procedures, and an earlier flagged surgery advice go up. Urology, dermatology, ENT, circulatory diagnoses and a missing diagnosis code go down.
10. Bottom line for V: conversion goes with what was advised and by which doctor. The doctor differences are the strongest unexplained pattern and are worth a case review. Nothing here shows that changing any one of these would change conversion.

## How to read this
- Rates are shown with Wilson 95% CIs. "q" is a two-sided Fisher exact test of one level against the rest of its characteristic (levels with n >= 10), BH-adjusted within each outcome. A two-level characteristic counts as one test. The doctor row is one permutation test of spread within specialty (2,000 shuffles).
- "OR within specialty" is the Mantel-Haenszel odds ratio of that level against the rest, stratified by specialty group. It asks whether the gap survives inside a specialty. It does not adjust for doctor, procedure or anything else.
- Outcomes: h14 is primary; h90 and Ale are secondary. The h90 rows are older advice only (n = 659). Ale counts a row under 14 days old only if it has converted, so Ale is computed here on rows at least 14 days old (n = 1,129). Comparisons whose mask repeats another row's split are shown but not tested.

## 1. Patient, visit, doctor and process (design A rows; h14 primary)
Rows: every D episode with a final label: h14 n = 1101 (189 converted), h90 n = 659 (150), Ale n = 1129 (198). ⚑ = BH q < 0.10 within that outcome. Levels not flagged for any outcome are folded into one line.

| Characteristic | Level | n | h14 conv [95% CI] | h14 q | OR within specialty [95% CI] | h90 (n) | Ale (n) |
|---|---|---|---|---|---|---|---|
| Age band | all levels: 30-39 18% (358); 18-29 16% (270); 40-49 14% (185); 60+ 15% (137); 50-59 23% (121); <18 20% (30) | | | none < 0.10 | | | |
| Sex | male | 603 | 18% [15-22] | 0.70 | 1.18 [0.81-1.74] | 24% (387) | 18% (616) |
| Sex | female | 498 | 16% [13-19] |  | 0.84 [0.58-1.24] | 21% (272) | 17% (513) |
| New vs returning | new to Even | 687 | 19% [17-22] | **0.089** ⚑ | 1.17 [0.81-1.69] | 26% (406) ⚑ | 20% (705) ⚑ |
| New vs returning | returning (earlier Even Rx) | 414 | 14% [11-17] |  | 0.85 [0.59-1.23] | 17% (253) | 14% (424) |
| Payer before the advice | all levels: none recorded 17% (1049); insurance / other 17% (41); cash 9% (11) | | | none < 0.10 | | | |
| Pincode zone (3-digit) | no pincode | 462 | 12% [10-16] | **0.007** ⚑ | 0.61 [0.43-0.86] | 16% (343) ⚑ | 12% (466) ⚑ |
| Pincode zone (3-digit) | other levels: Z1 21% (601); other zones (<30 each) 18% (38) | | | none < 0.10 | | | |
| Specialty | General Surgery | 436 | 24% [20-28] | **0.001** ⚑ |  | 31% (294) ⚑ | 24% (441) ⚑ |
| Specialty | Urology | 109 | 11% [6-18] | 0.28 |  | 11% (64) ⚑ | 11% (111) |
| Specialty | other specialties (<20 each) | 76 | 7% [3-14] | **0.076** ⚑ |  | 11% (64) ⚑ | 8% (79) ⚑ |
| Specialty | Dermatology | 50 | 0% [0-7] | **0.006** ⚑ |  | 0% (34) ⚑ | 0% (50) ⚑ |
| Specialty | other levels: Gynaecology 16% (189); Orthopaedics 18% (156); GI Surgery 14% (36); Internal Medicine Specialist 21% (28); ENT 0% (21) | | | none < 0.10 | | | |
| Procedure group | none | 224 | 10% [7-14] | **0.012** ⚑ | 0.54 [0.33-0.90] | 8% (138) ⚑ | 10% (226) ⚑ |
| Procedure group | anorectal | 172 | 27% [21-34] | **0.006** ⚑ | 1.44 [0.93-2.24] | 40% (108) ⚑ | 27% (175) ⚑ |
| Procedure group | gyn_major | 80 | 21% [14-31] | 0.72 | 1.71 [0.84-3.48] | 52% (27) ⚑ | 23% (87) |
| Procedure group | other levels: other 13% (82); minor_skin 16% (79); ent 14% (74); circumcision 27% (59); hernia 18% (57); scopy_diag 11% (47); ortho_other 18% (45); uro_other 15% (41); joint_replacement 19% (37); gyn_minor 29% (34); gallbladder 19% (32); uro_stone 5% (21); maternity 0% (12); vascular 0% (5) | | | none < 0.10 | | | |
| Procedures advised | 1 | 780 | 19% [16-21] | 0.21 | 1.20 [0.82-1.77] | 26% (460) ⚑ | 19% (803) |
| Procedures advised | other levels: 0 10% (224); 2+ 23% (97) | | | none < 0.10 | | | |
| Investigations ordered | no | 792 | 18% [16-21] | 0.27 | 1.29 [0.88-1.88] | 25% (474) | 19% (809) |
| Investigations ordered | yes | 309 | 14% [10-18] |  | 0.78 [0.53-1.13] | 17% (185) | 14% (320) |
| Consult language | all levels: no consult audio 17% (1015); English 16% (45); Kannada 17% (23); Hindi 10% (10); language not detected 0% (5); other / mixed 0% (3) | | | none < 0.10 | | | |
| Doctor gender | male | 852 | 19% [17-22] | **0.006** ⚑ | 1.80 [1.05-3.08] | 26% (509) ⚑ | 20% (877) ⚑ |
| Doctor gender | female | 249 | 10% [7-14] |  | 0.56 [0.32-0.95] | 13% (150) | 10% (252) |
| Day of week of advice | all levels: Sat 17% (221); Mon 21% (193); Tue 16% (183); Wed 16% (178); Thu 15% (169); Fri 16% (134); Sun 17% (23) | | | none < 0.10 | | | |
| Month of advice | all levels: 2026-09 14% (221); 2026-08 21% (152); 2026-07 16% (150); 2026-06 17% (128); 2026-04 19% (90); 2026-02 20% (88); 2026-05 18% (84); 2026-01 15% (78); 2026-03 13% (69); 2025-12 22% (32); 2026-10 11% (9) | | | none < 0.10 | | | |
| Doctor (within specialty) | spread test | 1101 | 17% | **0.020** ⚑ |  | 23% (659) ⚑ | 18% (1129) ⚑ |
Doctor gender q and OR are episode-level. Only General Surgery (1 female, 6 male doctors) and Gynaecology (10 female, 1 male) mix genders. Shuffling gender across doctors within specialty gives p = 0.40 (refute r2), so the gap cannot be told apart from individual-doctor differences. "Procedures advised 0" (= procedure group "none") and "Z1" (near-complement of "no pincode") are shown but not tested.

### 1b. Counsellor calls before day 7 (design B day-7 rows: Rx from 1 Jan 2026, not converted by day 7; h14 n = 926, 42 converted on days 8-14)
Caution: 19 of the 42 converters (45%) vs 109 of 884 non-converters (12%) had a call before day 7 that was flagged outcome-revealing and is dropped here (ft-refute-whoconverts r3_calls). Counsellors often already knew. Read these rows as partly reverse-driven. Levels marked 'untested' repeat another row's split.
| Characteristic | Level | n | h14 conv [95% CI] | h14 q | OR within specialty [95% CI] | h90 (n) | Ale (n) |
|---|---|---|---|---|---|---|---|
| Counsellor calls before day 7 | 3+ | 381 | 6% [4-9] | 0.44 | 1.35 [0.71-2.56] | 15% (218) | 6% (397) |
| Counsellor calls before day 7 | 0 | 355 | 3% [1-5] | 0.11 | 0.51 [0.24-1.09] | 5% (221) ⚑ | 3% (357) |
| Counsellor calls before day 7 | 2 | 96 | 4% [2-10] | 1.00 | 0.89 [0.30-2.61] | 19% (52) | 4% (96) |
| Counsellor calls before day 7 | 1 | 94 | 7% [4-15] | 0.48 | 1.81 [0.79-4.17] | 17% (54) | 7% (96) |
| Any connected call before day 7 | yes | 499 | 5% [4-8] | 0.49 | 1.31 [0.68-2.54] | 17% (287) ⚑ | 5% (514) |
| Any connected call before day 7 | no | 427 | 4% [2-6] |  | 0.76 [0.39-1.47] | 5% (258) | 3% (432) |
| First call | day 0-1 | 453 | 6% [4-8] | 0.49 | 1.39 [0.72-2.67] | 16% (250) ⚑ | 6% (467) |
| First call | no call | 355 | 3% [1-5] | untested |  | 5% (221) | 3% (357) |
| First call | day 2-6 | 118 | 7% [3-13] | 0.53 | 1.49 [0.67-3.29] | 16% (74) | 7% (122) |
| Talk time before day 7 | 0 | 427 | 4% [2-6] | untested |  | 5% (258) | 3% (432) |
| Talk time before day 7 | 2+ min | 372 | 6% [4-9] | 0.35 | 1.44 [0.77-2.72] | 18% (215) ⚑ | 6% (383) |
| Talk time before day 7 | <2 min | 127 | 4% [2-9] | 1.00 | 0.79 [0.30-2.08] | 15% (72) | 4% (131) |

### 1c. Doctors (h14; 76 doctors, labels D1..D76 by volume; shrunk = (k + 10 x specialty rate) / (n + 10))
Doctor spread within specialty: permutation test p = 0.0020, q = 0.020 ⚑. Among the 24 doctors with n >= 10, shrunk rates run 0% to 38%; 52 doctors have under 10 episodes. Doctors with n >= 30:
| Doctor | Specialty | n | Converted | Raw | Shrunk | Specialty rate |
|---|---|---|---|---|---|---|
| D1 | General Surgery | 276 | 73 | 26% | 26% | 24% |
| D2 | Gynaecology | 81 | 16 | 20% | 19% | 16% |
| D3 | Urology | 78 | 6 | 8% | 8% | 11% |
| D4 | General Surgery | 68 | 13 | 19% | 20% | 24% |
| D5 | Orthopaedics | 60 | 11 | 18% | 18% | 18% |
| D6 | General Surgery | 47 | 4 | 9% | 11% | 24% |
| D7 | Orthopaedics | 39 | 9 | 23% | 22% | 18% |
| D8 | GI Surgery | 36 | 5 | 14% | 14% | 14% |
| D9 | Gynaecology | 30 | 5 | 17% | 16% | 16% |
Full list (anonymised): doctors_h14.csv, doctors_h90.csv, doctors_ale.csv.

## 2. Single inputs that matter most inside the frozen FULL forests (h14)
- Design A (at the advice), M2: n = 1101 (189 pos), frozen AUC 0.607; 161 inputs; refit scores match the frozen OOF to 5e-07. 10 held-out folds x 3 shuffles = 30 draws per input.
- Design B (day 7), FULL: n = 926 (42 pos), frozen AUC 0.658; 221 inputs; refit scores match the frozen OOF to 5e-07. 10 held-out folds x 3 shuffles = 30 draws per input.
- Drop = mean AUC loss when that one input is shuffled in the held-out fold (x 1000, so 10 = 0.010 AUC); [2.5-97.5%] of the draws; cover = share of rows with a value. Correlated inputs share credit; an interval crossing 0 means no clear use.

| # | Design A input (layer) | Drop [2.5-97.5] | Cover | Design B day-7 input (layer) | Drop [2.5-97.5] | Cover |
|---|---|---|---|---|---|---|
| 1 | Doctor (in-fold conversion rate) (L0) | 43.9 [-33, 89] | 100% | Runo summaries before T (L3) | 18.1 [-64, 64] | 100% |
| 2 | Doctor gender (L0) | 11.2 [-6, 28] | 100% | Procedure group (L0) | 14.0 [-25, 56] | 100% |
| 3 | Specialty (L0) | 7.5 [-21, 37] | 100% | Recorded calls before T (L2) | 13.2 [-22, 45] | 100% |
| 4 | Diagnosis: injury (L0) | 2.7 [-10, 13] | 100% | Day of first call (L2) | 12.9 [-22, 57] | 100% |
| 5 | No investigations ordered (L0) | 2.2 [-4, 10] | 100% | Age (L0) | 11.9 [-24, 56] | 100% |
| 6 | No diagnosis code on this Rx (L0) | 2.1 [-10, 9] | 100% | Sex (L0) | 7.4 [-9, 30] | 100% |
| 7 | Investigations ordered (L0) | 1.8 [-6, 18] | 100% | No investigations ordered (L0) | 6.0 [-8, 21] | 100% |
| 8 | Diagnosis: musculoskeletal (L0) | 1.6 [-4, 7] | 100% | Calls voice affect (Clef): everyone segments (L7) | 5.4 [-30, 36] | 25% |
| 9 | History: Hb age of result (L1) | 1.3 [-11, 8] | 23% | STT-tagged calls (L3) | 4.7 [-14, 22] | 100% |
| 10 | Procedure group (L0) | 1.2 [-29, 28] | 100% | History: HbA1c age of result (L1) | 4.1 [-22, 18] | 23% |
| 11 | Consult voice emotion (emotion2vec): doctor negative (mean) (C6) | 1.1 [-2, 4] | 4% | Connected calls before T (L2) | 3.9 [-29, 23] | 100% |
| 12 | Diagnosis: skin (L0) | 1.1 [-6, 5] | 100% | History: meds on latest prior Rx (L1) | 3.8 [-26, 20] | 40% |
| 13 | Diagnosis codes on this Rx (L0) | 1.0 [-13, 8] | 100% | No Runo summary (L3) | 3.1 [-12, 22] | 100% |
| 14 | Earlier surgery advice flagged (L0) | 1.0 [-7, 5] | 100% | Investigations ordered (L0) | 3.0 [-7, 20] | 100% |
| 15 | Diagnosis: circulatory (L0) | 1.0 [-1, 4] | 100% | Diagnosis: injury (L0) | 3.0 [-28, 15] | 100% |
| 16 | History: diastolic BP (L1) | 0.8 [-4, 6] | 11% | History: earlier Rx, all time (L1) | 3.0 [-14, 18] | 100% |
| 17 | Opus score of consult text (C8) | 0.7 [-3, 4] | 7% | Runo summary: any next step (L3) | 2.6 [-9, 14] | 100% |
| 18 | Consult voice emotion (Odyssey): doctor arousal (spread) (C5) | 0.7 [-3, 4] | 4% | Opus score of call text (L8) | 2.4 [-35, 18] | 22% |
| 19 | Consult voice emotion (emotion2vec): doctor unknown (mean) (C6) | 0.4 [-1, 3] | 4% | History: earlier Rx, 12 months (L1) | 2.3 [-13, 13] | 100% |
| 20 | Consult voice emotion (Odyssey): everyone arousal (lowest) (C5) | 0.3 [-2, 1] | 5% | Calls voice emotion (emotion2vec): everyone happy (mean) (L6) | 2.2 [-4, 13] | 25% |
| 21 | History: age of BP reading (L1) | 0.3 [-3, 4] | 11% | History: Hb on file (L1) | 2.0 [-2, 6] | 100% |
| 22 | Diagnosis: symptom code (L0) | 0.3 [-1, 2] | 100% | Calls voice emotion (emotion2vec): everyone windows (L6) | 1.9 [-14, 14] | 25% |
| 23 | History: HbA1c value (L1) | 0.3 [-6, 7] | 21% | Calls voice emotion (Odyssey): everyone arousal (lowest) (L5) | 1.7 [-2, 8] | 25% |
| 24 | Consult voice emotion (emotion2vec): patient windows (C6) | 0.3 [-1, 2] | 8% | History: BP on file (L1) | 1.7 [-13, 13] | 100% |
| 25 | Consult voice emotion (emotion2vec): patient fearful (mean) (C6) | 0.2 [-0, 1] | 4% | Calls voice emotion (Odyssey): everyone windows (L5) | 1.7 [-17, 20] | 25% |
| 26 | Consult voice emotion (emotion2vec): doctor disgusted (mean) (C6) | 0.2 [-0, 1] | 4% | History: TSH age of result (L1) | 1.7 [-6, 9] | 21% |
| 27 | Consult voice emotion (emotion2vec): everyone sad (mean) (C6) | 0.2 [-0, 1] | 5% | Calls voice emotion (Odyssey): everyone valence (lowest) (L5) | 1.6 [-2, 7] | 25% |
| 28 | Consult voice affect (Clef): doctor segments (C7) | 0.2 [-2, 3] | 8% | History: Hb number of results (L1) | 1.5 [-8, 8] | 24% |
| 29 | Consult voice emotion (Odyssey): doctor arousal (lowest) (C5) | 0.2 [-1, 1] | 4% | Calls voice affect (Clef): patient segments (L7) | 1.3 [-4, 8] | 17% |
| 30 | Consult voice emotion (Odyssey): doctor windows (C5) | 0.1 [-2, 2] | 8% | Calls voice emotion (Odyssey): patient arousal (spread) (L5) | 1.3 [-9, 10] | 14% |

## 3. Readable comparison: L2 logistic regression (Pulse baseline + top 10 non-baseline inputs from section 2)
- Design A: logistic OOF AUC 0.651 [0.611-0.694] vs frozen forest 0.607; logistic - forest +0.045 [+0.016, +0.075] (same rows and folds).
  Pulse baseline alone: 0.638 (vs this forest +0.031 [-0.005, +0.063]). The top 10 were picked on these same D folds, so the '+ top 10' AUC is optimistic.
  Like for like: the frozen Pulse-only forest M0 scores 0.634, so the logistic regression and the forest are level on the Pulse baseline; M2 is below M0.
- Design B day 7: logistic OOF AUC 0.661 [0.588-0.730] vs frozen forest 0.658; logistic - forest +0.003 [-0.085, +0.086] (same rows and folds).
  Pulse baseline alone: 0.623 (vs this forest -0.035 [-0.134, +0.059]). The top 10 were picked on these same D folds, so the '+ top 10' AUC is optimistic.
- OR > 1 = more likely to convert. Per 1 SD for counts and scores, yes vs no for 0/1 inputs, vs the most common level for categories; L2-penalised, so pulled towards 1. Shown: the 10 added inputs, plus baseline inputs whose interval excludes 1.

| Design | Added input | OR per SD or yes vs no [95% CI] | Direction | Missing vs present OR (if any) |
|---|---|---|---|---|
| A | History: Hb age of result | 1.04 [0.61-1.27] | more likely (unclear) | 1.13 [0.51-2.76] |
| A | Consult voice emotion (emotion2vec): doctor negative (mean) | 1.27 [0.96-2.01] | more likely (unclear) | 1.03 [0.70-1.54] |
| A | History: diastolic BP | 1.00 [0.83-1.20] | less likely (unclear) | 0.79 [0.61-1.13] |
| A | Opus score of consult text | 1.29 [1.05-2.07] | more likely | 1.16 [0.60-2.46] |
| A | Consult voice emotion (Odyssey): doctor arousal (spread) | 1.49 [1.02-2.89] | more likely | 1.03 [0.70-1.54] |
| A | Consult voice emotion (emotion2vec): doctor unknown (mean) | 0.96 [0.54-1.30] | less likely (unclear) | 1.03 [0.70-1.54] |
| A | Consult voice emotion (Odyssey): everyone arousal (lowest) | 0.90 [0.42-1.01] | less likely (unclear) | 1.37 [0.79-2.03] |
| A | History: age of BP reading | 1.00 [0.75-1.17] | less likely (unclear) | 0.79 [0.61-1.13] |
| A | History: HbA1c value | 0.80 [0.47-1.00] | less likely | 1.19 [0.47-2.67] |
| A | Consult voice emotion (emotion2vec): patient windows | 0.57 [0.30-0.79] | less likely | 1.80 [1.09-3.29] |
| B7 | Runo summaries before T | 1.05 [0.76-2.35] | more likely (unclear) |  |
| B7 | Recorded calls before T | 0.70 [0.37-1.24] | less likely (unclear) |  |
| B7 | Day of first call | 1.37 [1.03-1.94] | more likely |  |
| B7 | Calls voice affect (Clef): everyone segments | 1.15 [0.67-2.18] | more likely (unclear) | 1.76 [0.92-3.36] |
| B7 | STT-tagged calls | 1.17 [0.63-2.16] | more likely (unclear) |  |
| B7 | History: HbA1c age of result | 0.93 [0.65-1.15] | less likely (unclear) | 0.79 [0.33-2.04] |
| B7 | Connected calls before T | 1.78 [0.96-2.84] | more likely (unclear) |  |
| B7 | History: meds on latest prior Rx | 1.24 [0.96-1.65] | more likely (unclear) | 0.73 [0.34-1.52] |
| B7 | No Runo summary | 1.46 [0.73-3.79] | more likely (unclear) |  |
| B7 | History: earlier Rx, all time | 0.93 [0.73-1.17] | less likely (unclear) |  |
- Pulse baseline inputs with intervals clear of 1, design A: Earlier surgery advice flagged 6.26; No diagnosis code on this Rx 0.50; Diagnosis: circulatory 0.54; Specialty Urology vs General Surgery 0.51; Specialty Dermatology vs General Surgery 0.27; Specialty ENT vs General Surgery 0.49; Specialty Cardiology Non Interventional vs General Surgery 0.53; Procedure group anorectal vs none 1.93; Procedure group gyn_minor vs none 2.70; Procedure group uro_stone vs none 0.47; Procedure group maternity vs none 0.56.
- Pulse baseline inputs with intervals clear of 1, design B7: Diagnosis: injury 1.42; Diagnosis: health-status factor 0.72; Diagnosis: ear 0.77; Diagnosis: infection 0.88; Diagnosis: circulatory 0.65; Specialty Urology vs General Surgery 0.18; Specialty Dermatology vs General Surgery 0.45; Specialty ENT vs General Surgery 0.83; Specialty Cardiology Interventional vs General Surgery 0.67; Specialty Plastic Surgery vs General Surgery 0.75; Specialty Cardiology Non Interventional vs General Surgery 0.83; Procedure group anorectal vs none 2.67; Procedure group other vs none 0.48; Procedure group gyn_minor vs none 2.73; Procedure group gallbladder vs none 0.58; Procedure group maternity vs none 0.84; Sex f vs m 0.56; Payer before the advice cash vs none 0.63.
- The added inputs were chosen on these same data, so their "clear" ORs are post-selection and not confirmatory. "Day of first call" is -1 when there was no call, so its OR mixes "called at all" with timing. Intervals for sparse levels (for example a specialty with 0 conversions) mostly reflect the penalty, not the data.
Full OR lists: logit_rx_h14.json, logit_lm7_h14.json.

## 4. Medical history blocks (design A rows, h14; returning = an earlier Even Rx before the advice day, n = 414, 56 converted)
| History block | All: present n | present conv | absent conv | q | OR within specialty | Returning: present n | present conv | absent conv | q |
|---|---|---|---|---|---|---|---|---|---|
| Meds on latest prior Rx | 187 | 13% [9-19] | 18% [16-21] | 0.42 | 0.86 [0.54-1.37] | 187 | 13% | 14% | 1.00 |
| Any ICD history | 405 | 14% [11-17] | 19% [16-22] | 0.10 | 0.86 [0.60-1.24] | 391 | 13% | 17% | 0.89 |
| Charlson condition | 64 | 11% [5-21] | 18% [15-20] | 0.53 | 0.72 [0.32-1.61] | 62 | 11% | 14% | 1.00 |
| Diabetes | 43 | 12% [5-24] | 17% [15-20] | 0.79 | 0.69 [0.26-1.80] | 39 | 10% | 14% | 1.00 |
| Hypertension | 35 | 11% [5-26] | 17% [15-20] | 0.86 | 0.68 [0.23-1.99] | 33 | 12% | 14% | 1.00 |
| Kidney disease | 9 | 22% [6-55] | 17% [15-19] | n < 10 |  | 9 | 22% | 13% | n < 10 |
| Heart disease (CAD) | 7 | 14% [3-51] | 17% [15-20] | n < 10 |  | 7 | 14% | 14% | n < 10 |
| Obesity | 67 | 4% [2-12] | 18% [16-20] | **0.020** ⚑ | 0.24 [0.07-0.78] | 65 | 5% | 15% | 0.11 |
| Named comorbidity | 17 | 18% [6-41] | 17% [15-20] | 1.00 | 1.20 [0.34-4.31] | 17 | 18% | 13% | 1.00 |
| Earlier IP admission | 16 | 25% [10-49] | 17% [15-19] | 0.86 | 2.01 [0.61-6.62] | 9 | 33% | 13% | n < 10 |
| BP recorded | 120 | 18% [12-25] | 17% [15-20] | 1.00 | 1.15 [0.69-1.93] | 115 | 18% | 12% | 0.35 |
| HbA1c on file | 236 | 11% [7-15] | 19% [16-22] | **0.020** ⚑ | 0.66 [0.41-1.05] | 224 | 10% | 18% | 0.11 |
| Hb on file | 250 | 11% [8-15] | 19% [17-22] | **0.020** ⚑ | 0.67 [0.43-1.06] | 238 | 11% | 18% | 0.19 |
| Creatinine on file | 206 | 11% [8-16] | 19% [16-21] | **0.076** ⚑ | 0.73 [0.45-1.19] | 199 | 11% | 16% | 0.49 |
| eGFR on file | 176 | 9% [6-14] | 19% [16-21] | **0.020** ⚑ | 0.55 [0.32-0.97] | 171 | 9% | 17% | 0.11 |
| TSH on file | 216 | 10% [7-15] | 19% [16-22] | **0.020** ⚑ | 0.62 [0.38-1.01] | 210 | 10% | 17% | 0.19 |
OR within specialty = Mantel-Haenszel odds ratio, present vs absent, stratified by specialty: < 1 = less conversion when the block is present.

## Limits
- The data are observational, the analysis post hoc, and confounding is heavy: specialty, doctor and procedure are tangled together. Clusters (1,097 for 1,101 rows) are treated as independent.
- Pincode: pin_code is the value on file at pull time (20 Oct), not at the advice. Registration may be completed during the surgery admission, and older and returning records lack it more often (73% missing among returning patients vs 23% among new). The prefix map is in ~/eta-data/forest/whoconverts/zones_map_LOCAL.tsv (0600, the lab box only, outside the out tree).
- Payer: the payer recorded at the visit is excluded because it may be entered after the advice, so only the payer recorded earlier is used, and it is "none" for 95% of rows. Distance: there is no pincode-centroid table, so 3-digit zones are used instead; only Z1 has 30 or more rows.
- Consult language comes from ft-audio features_ale plus ft-cohortb-expand features_all, and covers 86 of the 1,101 design-A rows.
- Permutation importance uses the ft-forest refit protocol (repeats 0-1, 3 shuffles per fold). Its intervals show the spread of the draws; they are not CIs. Correlated inputs share credit. Shuffling doctor_id moves the doctor rate and the doctor volume together.
- The logistic regression uses C = 1, fixed, not tuned. Its top 10 inputs were chosen on these same D folds, so the "+ top 10" AUCs are optimistic. Its ORs are penalised, and those of the added inputs are post-selection.
- Refute: ~/oc/forest-lead/ft/out/ft-refute-whoconverts/VERDICT.md, PASS-WITH-FIXES (0 blockers, 8 fixes, 8 notes). All 8 fixes are applied in this version.
- H: labels.parquet was hashed only; its rows were never loaded. Every table read is D-only, or filtered to D on load (asserted). The frozen loader (forest_build.load_F) reads the whole hash-only f1 TSV (cluster_key, split, ambiguous; no outcomes) and filters it to D. A directory listing of ~/eta-data/forest/ft8 showed the names of the files in its H/ folder; none of them was opened.

## Files (sha256, first 12)
- Inputs: features_D 8ec830bfc4d6; labels 0aefc00f425b; ft8 d674e54010cc; features_all a3fc972290ee; features_ale 3f0c529447e2; calls_D 5d2a1c72a6ec; pin_pull 7b39ab45f35b; ft-forest/model_frozen_rx_h14.json 9ac680310435; ft-forest/model_frozen_lm7_h14.json ed34c0e93b0f; ft-forest/FOREST-TABLES.md 057ee325677d; ft-forest code forest_lib.py f1efb3f87172; ft-forest code forest_build.py 18bc1a321db4. Design B call layers, engines and layer 8 are loaded through forest_build exactly as frozen (its DONE.md lists their sha).
- Code (~/wt/ft-whoconverts/code): wc_desc.py 10247bc2c4a2; wc_logit.py 2247b2ee55ad; wc_names.py 54f4eea68eae; wc_perm.py fb3f22d45bc2; wc_report.py 1fd9523d8c2c; wc_text.md e6f6c68e86c9.
- Outputs (~/oc/forest-lead/ft/out/ft-whoconverts, 0600): desc.json e5970387fc69; doctors_ale.csv d80a3d1e6acc; doctors_h14.csv cc9bfd193731; doctors_h90.csv dfb8600f6bf9; logit_lm7_h14.json b941297ed57b; logit_lm7_h14.log b888ab5c144d; logit_lm7_h14_top0.json aca23ff5d408; logit_lm7_h14_top0.log 2852cda0c1c3; logit_rx_h14.json 12c0b1c0a14e; logit_rx_h14.log 0b00d6d84f60; logit_rx_h14_top0.json d3fa4437f217; logit_rx_h14_top0.log 924d3066b287; perm_lm7_h14.json b1f7d17c7359; perm_lm7_h14.log 7af5582350d3; perm_rx_h14.json e7634e6d4e6f; perm_rx_h14.log 0c68d8ae6e72.
- Run: wc_perm.py rx h14; wc_perm.py lm7 h14; wc_desc.py; wc_logit.py rx|lm7 h14 (and TOPK=0); wc_report.py. Python ~/.venv-forest, -I.
