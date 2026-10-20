# ft-refute-audio: independent refute of FT4 (ft-audio, Cohort B), 19 Oct 2026. Served by Claude Opus 5.5 (global.anthropic.claude-opus-5-5)
I worked from the raw files and wrote my numbers to work/MY-NUMBERS.md before opening the lane's code or model_*.json. D split only; the 10 H consults were dropped unread. Python is ~/.venv-forest -I. Scripts and outputs (0600) are in work/: cohort.py, labels.py, prior.py, model.py, model2.py, res*.json.

## Funnel and inputs
| claim | mine | |
|---|---|---|
| 135 = ft6 83 + RF775 52 | 135 (52 pqm_ clip keys mapped to consult_uid via linked.jsonl; no overlap with ft6) | PASS |
| D 125 | split_guard with the posted list and seed pins: D 125 / H 10. ft4a: 127 Rx / 125 consults, 0 bad rows, set equals D | PASS |
| >=18 d: 58 / 57 / 13 / 5 | 58 consults / 57 clusters / 13 doctors / 5 positives (5 clusters); surgery lags 1-6 d | PASS |
| >=14 d: 77 / 75 / 14 / 7 | 77 / 75 / 14 / 7 | PASS |
| 5 positives, all GS (5/19 vs 0/39), 2 doctors | same | PASS |
| features.parquet sha 9a1802ac873e | sha matches. 125 rows, all split D, row set equals my D. Cluster, age_days and h14 match mine 58/58. Coverage equals COVERAGE.md (lang 58, talk 56, valence 54, val_change 14, Jev 58, payer 15, age/sex/Rx 58) | PASS |
| pre-outcome features | All features come from the consult audio or transcript, or from Pulse at consult time. The doctor prior uses labels.parquet D Rx that are outside the cohort and dated rx+14 <= consult | PASS (see I4, I5) |

RF775 selection rule: I could only partly rebuild it. The rule "last Haiku f01 >= 0.5 AND Jev v2 f01 >= 0.5 AND linked non-duplicate" gives 54. All 52 members are in that set. The 2 extras are CAA consults from the same doctor on the same date, with no exclusion reason recorded. My guess is the rf775score caa_winners rule (one CAA recording goes to one consult), but I have not verified that. FLAG.

## Models (my refit)
My setup: RF with depth 4 and leaf 5, class-balanced. StratifiedGroupKFold(5) grouped by cluster, 20 repeats. 1000 cluster-bootstrap resamples on the repeat-mean OOF score. My own doctor prior: D Rx at least 18 d before the consult, other clusters only, shrunk to the specialty mean with k=10 (r = 0.63 with the lane's prior).

Every row below is n 58 / 5 positives.
| claim (lane) | mine | |
|---|---|---|
| audio8 AUC 0.79 [0.55, 0.96] (includes payer, val_change, pitch score = mean of f03/f07/f18) | 0.79 [0.63, 0.93] with comparable features and f07 inside a composite or left out (500 trees: 0.77 [0.61, 0.92]). 0.89 [0.71, 0.99] when f07, f03 and f18 go in as separate features | PASS (the number depends on how f07 is encoded) |
| Pulse-only 0.88 [0.71, 1.00] | 0.88 [0.72, 0.98]. Without payer: 0.88 [0.75, 0.97]. Specialty alone: 0.77; prior alone: 0.68 | PASS |
| delta -0.09 [-0.21, -0.01]; report line 25 says audio "lowers" AUC | Without f07: -0.09 [-0.22, +0.01], so the CI includes 0. With f07 as its own feature: +0.01 [-0.07, +0.09] | FAIL on the wording. Neither "lowers" nor "adds" holds up |
| permutation importance: specialty is the only CI > 0 in audio8 | Specialty 0.09 [0.02, 0.20] > 0, but f07 0.15 [0.03, 0.26] is also > 0 when f07 enters as its own feature. The composite pitch score hides f07 | PARTIAL |
| item model f07 0.32 [0.10, 0.52] | f07 0.15 [0.03, 0.27] (different model, same direction) | PASS (direction) |
| raw f07 AUC 0.91; 5/18 vs 0/40 | 0.91; 5/18 vs 0/40. Inside GS: 5/8 vs 0/11 | PASS |
| >=14 d (77 / 7): audio8 0.64, Pulse 0.75, delta -0.10 [-0.21, -0.005] | Without f07: 0.71 vs Pulse 0.80, delta -0.09 [-0.18, -0.01]. With f07: 0.90 [0.76, 0.99], delta +0.11 [-0.00, +0.26] | PASS without f07; fragile |

## Issues
- I1. Fill rule broken. The brief says to drop any feature under 60% fill. audio8 still uses payer (15/58, 26%) and val_change (14/58, 24%; only 2 of the 5 positives have it), and Pulse-only uses payer. In my refit, dropping payer did not change Pulse (0.88).
- I2. The delta is not robust. Its sign and whether its CI excludes 0 depend on whether f07 is inside a composite or a feature of its own. Report line 25 ("adding audio lowers AUC") and DONE "delta -0.09 [-0.21, -0.01]" read as a finding. They should say "no evidence audio adds over Pulse; CI spans 0 under other encodings".
- I3. f07 is an outcome proxy (reverse causality). Its question is literally "date/slot for surgery or concrete booking step". All 5 positives had surgery 1-6 d later. f07 records the decision being made in the room, not a pitch lever. The lane does state this caveat, which is good. The fix is to keep f07 out of any "driver" language and out of the audio-vs-Pulse comparison, or report it only as a separate mediator read.
- I4. Specialty is confounded with doctor. 5/5 positives come from 2 GS doctors. The "specialty" importance cannot be told apart from those 2 doctors, and the doctor prior cannot separate them with 13 doctors. Say so.
- I5. The doctor prior is not computed in-fold, but it uses no cohort labels: it comes from out-of-cohort labels.parquet D Rx, time-respecting, so there is no target leakage. Minor deviations from the brief: rx+14 instead of +18 (billing lag), shrinkage to the overall mean with A=5 instead of the specialty mean with k=10, and an H14 rate instead of H90.
- I6. Episode credit. Labels are consult-level from ft4a only. Against the full D s5-clean history, 1 of the 7 positives at >=14 d is credited (FT2 earliest-flagged-Rx rule) to the same patient's flagged Rx 5 d earlier, from another doctor, so the strict count is 6. The >=18 d cohort is unaffected (its 5 positives are clean).
- I7. The CV setup departs from the brief: 10 repeats instead of 20, depth 3 / leaf 3 instead of leaf >= 5. The audio8 per-repeat AUC range is 0.38-0.88 (mine is 0.54-0.84 with 20 repeats).
- I8. The RF775 rule could not be fully rebuilt (2 unexplained exclusions; see above). All 5 positives are RF775 members.

## Small n
The lane states DIRECTIONAL up front, gives n and positives on every number, attaches CIs to every AUC and importance, and says to re-run at >= 25 positives. That is adequate. The brief also asks for "positives < 20" to be said up front and importance to be given as ranks: the lane does the first implicitly and not the second.

With 5 positives from 2 doctors, the supportable claims are:
1. No evidence that audio adds over Pulse.
2. Every conversion in this window is GS, from 2 doctors.
3. f07 (a booking step given in the room) marks the close; it is not a cause.

Any ranking of audio features, any claim that audio lowers AUC, and any valence result are not supportable.

## Verdict: PASS-WITH-FIXES
The funnel, features, labels, Pulse AUC, f07 table and GS concentration all reproduce exactly. Required fixes:
- (a) Reword the delta (I2).
- (b) Drop or flag the <60%-fill features (I1).
- (c) Add the doctor/specialty confound (I4).
- (d) Note the RF775 2-consult gap (I8) and the strict episode count of 6 at >=14 d (I6).
