# ft-refute-audio2: independent refute of FT4 v2 (ft-audio, Ale label) + ft-cohortb-expand, 19 Oct 2026. Served by Claude Opus 5.5 (global.anthropic.claude-opus-5-5)
I recomputed from raw: s5-clean, 10.tsv, clusters, split_guard (pins OK) and the p3a rules. My numbers went into work/MY-NUMBERS.md before I opened FT4-REPORT. I read no lane code and no model json.
For features I used the lane feature tables (features_all, ft-audio features.parquet) as inputs, because Jev and Odyssey can't be re-run without new Bedrock calls. I ignored their label, prior and source columns. Scripts and outputs (0600) are in work/: ep.py, cohort.py, feats.py, model.py, desc.py, res_*.json, desc.json.

## Cohort and labels
| claim | mine | |
|---|---|---|
| Ceiling: 306 D episodes since 9 Sep; 174 final h14 / 25 pos; Ale 217 / 54 | 306; 174 / 25; 217 / 54 | PASS |
| 137 recorded anchors | 110 rebuilt independently (clip flac via linked.jsonl), plus 27 CAA tape consults taken from expand. All 137 are my D anchors since 9 Sep | PASS (27 not rebuilt) |
| 137 + 76 non-anchors = 213 consults -> 198 patients, 0 H | 213 -> 198 clusters; every row is D in split_guard | PASS |
| Ale n 139 / 24 pos / 21 doctors | 139 / 24 / 21 with loose credit. **138 / 23 under strict credit**: one consult under 14 d counts as positive, but its surgery is credited to the same patient's unrecorded flagged Rx 2 d earlier | PASS-nit (I-1) |
| Ale >= 14 d 130 / 15; h14 114 / 12 (6 positive doctors) | 130 / 15; 114 / 12 (6) | PASS |
| expand: 99 / 20, 99 patients, 16 doctors; positives by age 13 / 1 / 6 | 99 / 20 / 99 / 16 | PASS |
| 15 / 24 positives from 2 doctors; all 4 GS doctors convert | 15 / 24. GS doctors have 8, 7, 1 and 1 positives (17) | PASS |

## Models: RF 300 trees, depth 4, leaf 5; 5-fold x 20 repeats; 1000 patient bootstraps; my own time-respecting doctor prior; payer and val_change out
| claim (Ale 139 / 24) | mine | |
|---|---|---|
| audio (no f07) 0.71 [0.57, 0.84] | 0.74 [0.62, 0.85]; with f02 and f06 added 0.78 [0.66, 0.88] | PASS (direction) |
| pulse-only 0.73 [0.61, 0.85] | 0.80 [0.69, 0.90] (my pulse set adds sex, doctor gender and prior-Rx count); specialty alone 0.70 | PASS (CIs overlap) |
| delta -0.02 [-0.09, +0.05]: "no evidence audio adds" | -0.055 [-0.09, -0.01] (my audio set); -0.02 [-0.11, +0.06] (with f02/f06); +0.00 grouped by doctor with f02/f06. No specification gives a positive delta | PASS on the wording. Fragile: the sign and whether the CI covers 0 depend on the feature set |
| Ale >= 14 d: delta -0.07 [-0.14, -0.01]; h14 -0.06 [-0.13, +0.02] | -0.05 [-0.11, +0.01]; -0.04 [-0.12, +0.08] | PASS (direction) |
| Specialty is the only importance with CI > 0: 0.10 [0.01, 0.19] | GS 0.05 [-0.09, 0.16]: **no feature has CI > 0** in my run | FAIL (fragile) |
| f07 alone 0.72 [0.59, 0.83], leakage-suspect, out of the headline | 0.72 [0.59, 0.83]. f07 also tracks recency (AUC 0.68 vs -age) | PASS |
| (my extra) grouped by doctor | pulse 0.75; audio 0.69; the doctor prior alone drops 0.71 -> 0.48, so the prior is doctor identity | info |

## Descriptive (Ale; Jev >= 0.5; Fisher)
| claim | mine | |
|---|---|---|
| f06: 83% vs 45%, p 0.001 | 20/24 vs 49/109, p 0.0006 | PASS |
| f06 inside GS: p 0.005 | Fisher 16/17 vs 19/31, p 0.018. The lane's 0.005 is a Mann-Whitney test on the continuous Jev score (I get 0.0046), but DONE.md sets it beside a Fisher p | FAIL (test mislabelled) |
| f02 46% vs 18%, p 0.007; f18 33% vs 13%, p 0.03; f03 29% vs 53%, p 0.04 | p 0.007; 0.029; 0.042 | PASS |
| talk, turns, interruptions, valence, arousal, language: p > 0.2; English 19% vs 16%, p 0.82 | all p > 0.2; 14/73 vs 10/61, p 0.82 | PASS |
| "about 24 tests, unadjusted" | My family: 17 tests (6 Jev, 10 continuous, English). Lane table: about 25. **Only f06 survives correction** (BH q 0.011 over 17 tests, 0.014 over 24; Bonferroni 0.011 / 0.014). f02 q 0.06-0.08, f18 0.12-0.14, f03 0.14 do not survive | PARTIAL: say this |

## Ale-label selection bias (the expand warning)
- Mechanism confirmed: 9/24 positives are under 14 d (surgery 0-5 d later). Recency alone scores AUC 0.68 [0.54, 0.82] (expand: 0.675 on 99); at >= 14 d it is 0.49.
- **It does not create the f02/f06/f18/f03 differences.** The 109 negatives are the same with or without the young positives. Young and older positives have the same item rates (f06 7/9 vs 13/15, f02 5/9 vs 6/15, f18 2/9 vs 6/15, f03 3/9 vs 4/15). Items do not track age (AUC 0.49-0.55), except f07 (0.68). At >= 14 d: f06 87% vs 45%, p 0.004; f18 p 0.016; f02 p 0.08; f03 p 0.10.
- What it does: about doubles the positives (smaller p, same effect sizes) and adds fast in-room deciders, which strengthens f07 (and maybe f06) as an outcome proxy. Models are unaffected: no age or source feature is used, and the >= 14 d picture is the same.
- **Doctor confounding explains more than age.** Adjusted for the top 2 doctors plus age: f06 OR 2.8, p 0.12; f02 2.4, p 0.16; f18 4.0, p 0.036; f03 0.29, p 0.05. Stratified by doctor (Mantel-Haenszel): f06 OR 3.5, p 0.05. "Converters got more practical detail" may really be "these 2 GS doctors give practical detail".

## Prior v1 fixes 1-5
- 1 payer/val_change out: PASS (real fill 30%/25%). 2 delta wording: PASS. 3 confound stated: PASS. 5 strict >= 14 d count of 6: PASS (matches v1's I6).
- 4 RF775 52 vs 54: explained as 55 minus 3 R6 duplicates. NOT VERIFIED; immaterial in v2.

## Issues
- I-1: strict credit is applied inconsistently: 1 row. Strict gives 138 / 23 and moves AUCs by <= 0.01. Fix: either say "own-consult credit for non-anchors" or drop the row.
- I-2: the GS-only p 0.005 is Mann-Whitney on the continuous score, not Fisher; the Fisher p is 0.018. Label the test.
- I-3: "only f06 survives multiple-testing correction" must appear in the headline. f02, f18 and f03 are hypotheses to pre-register on new consults (the lane already proposes this), not findings.
- I-4: the "specialty CI > 0" claim is method-dependent; my CI includes 0. Say "specialty / 2 GS doctors carry most of the signal (specialty alone AUC 0.70)" instead.
- I-5: the doctor-adjusted descriptives weaken f06 and f02 (p 0.12-0.16). Report the adjusted line next to the raw one.
- I-6: horizons are mixed. The Ale positive window is 0-40 d, uncapped, and non-anchor outcomes cap at 30 d (ft4a). The lane notes this. Minor.

## Supportable claims (n 139 / 24, 21 doctors, DIRECTIONAL)
- (1) No evidence audio or pitch features add over Pulse. This is the only supportable model claim: no "audio lowers", no audio ranking. (2) Conversions concentrate in GS and 2 doctors. (3) f07 is an outcome proxy. (4) Descriptive: f06 is higher in converters, survives correction, and is partly doctor-confounded. f02/f18/f03 are unadjusted screening leads.

## Verdict: PASS-WITH-FIXES
The cohort, the labels, the ceiling, the descriptive counts and the "no evidence audio adds" read all reproduce. Fixes needed before FT7: I-2, I-3, I-4 and I-5, plus a note on I-1.
