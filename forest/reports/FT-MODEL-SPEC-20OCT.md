# FT final model: pre-registered spec. FROZEN (v3.4), forest-lead, 20 Oct 2026 (freeze 12:00 IST; newcat-orch signs)
Plan: the lab box ~/oc/forest-lead/ft/FT-FINAL-20OCT.md, including the DEFINITION OF DONE table (RF doc c32b423d: every layer IN the 18:00 forest; layers added one at a time; calibration; benchmarks a/b/c; one-shot sealed H score).
Versions: v1 04:04 (base + FT8); v2 04:21 (voice engines, V order); v3 04:28 (all doc layers, layer-by-layer design, benchmarks, calibration); v3.1 05:35 (H one-shot at 15:00 on V order; FT8 final by 11:00; ft-engines by 07:40); v3.2 05:39 (layer 8 = Opus transcript score, after the ft-bench leakage audit); v3.3 06:37 (layer 8 primary = fixed screened score; FT8 final); v3.4 FROZEN 08:22 (all field lists final; consult layer 3 dropped per FT6).
Still open at the freeze: the column lists that come from lane DONE/COVERAGE files (section 10). After the freeze nothing changes except a declared bug fix, written in section 10 with time and reason. No new features after 12:00 (plan rule).

## 1. Questions
- Q1 (primary): does pre-prescription medical history (FT8) improve prediction over the Pulse baseline (FT3), at the Rx?
- Q2: which layers of the RF doc add, one at a time, on the counsellor calls (landmark models at day 3 and day 7) and on the recorded OPD consults?
- Q3: does the forest beat the benchmarks (a) stated intent alone, (b) Jev on the raw transcript, (c) a large LLM on the raw transcript?
- Q4: is it calibrated?

## 2. Population and labels (labels v2, labels.parquet sha256 0aefc00f425b)
- Episodes: flagged-Rx episodes from 1 Dec 2025. D split 1,233; H split 389 (sealed).
- H14: surgery within 14 days of the Rx; final at Rx age >= 18 days. D 1,101 / 189.
- H90: surgery within 90 days; final at age >= 94 days. D 659 / 150.
- Ale: surgery = 1 at any age; no surgery and age >= 14 days = 0; younger without surgery = dropped.
- Dermatology episodes stay in the population as a feature level; no conversion claim is made for Dermatology.

## 3. Learner (every model; fixed, no search)
- RandomForestClassifier(n_estimators=400, min_samples_leaf=5, max_features='sqrt', random_state=0). These are the FT3 settings, unchanged.
- Missing values are coded -1, plus one has_<block> flag per block or source. An episode with no usable call before T gets every call feature missing (ft-refute-ftr fix 1).
- In-fold steps (fitted on the training folds only): the doctor prior rate (m = 10, as in FT3), and the PCA of any embedding.

## 4. Layers (the RF doc table), in a fixed order
| # | Layer | Calls (Runo 933 D + Bolna) | OPD consults | Source lane / file |
|---|---|---|---|---|
| 0 | Pulse base (FT3, no same-day payer) | yes | yes | ft-labels-base features_D (cols.json) |
| 1 | Pre-Rx history (FT8) | yes | yes | ft8-clinical features_ft8.parquet (day-level build) |
| 2 | Call activity (count, timing, talk time) | yes | n/a | ft-calltext (as FTR v2) |
| 3 | Haiku facts with exact quotes, Jev cross-checked | Runo summaries (FTC) + Bolna transcripts | Jev/Haiku pitch items f02-f18 (FT4; f07 excluded as an outcome proxy) | ft-calltext tags_D; ft-text2 |
| 4 | Nemotron speaker turns (talk share, turns/min, turn length, interruptions per role) | yes | yes | ft-engines |
| 5 | Odyssey (WavLM-based arousal / valence / dominance per role) | yes | yes | ft-rl-feat / ft-audio, re-roled by ft-engines |
| 6 | emotion2vec (mean neutral / happy / sad / negative probabilities per role) | yes | yes | ft-engines |
| 7 | Clef-omni per speaker segment (numeric and categorical fields only) | yes | yes | ft-engines |
| 8 | LLM read of the raw transcript: Opus 5.5 p14 / p90 (benchmark c, prompt sha 865e5843df5e, scored as given, no training) | yes | yes | ft-bench bench_scores.parquet / bench_scores_c.parquet |
- Layer 3, Jev cross-check: a Haiku tag that Jev contradicts (as reported by ft-text2) is set to 0 and counted. Sensitivity: raw Haiku tags.
- Layer 3, translation: text features that read meaning use only Runo's own English summaries, Bolna transcripts as delivered, or the Gemini leg. Today's Saaras consult English is not an input (fable FT6 ruling). ft-text2 states which of these applies to Bolna.
- Layer 7: any Clef field that states the outcome (agreed, booked, a date) is dropped. That is the same rule as f07.
- Roles: calls = patient and counsellor; consults = patient and doctor. A role-specific feature is set missing when the call's roles come only from the "more words" fallback. Primary = the ft-engines default role columns (lexicon + lexicon_weak calls; ruling 06:31). The *_lex2 twins (lexicon only) are NOT used. Role-free versions are kept. Sensitivity: role-free only.
- Separate WavLM embeddings (beyond Odyssey) enter only if ft-engines delivers them, as a sensitivity (3 in-fold PCA components per role), not as a layer.
- Layer 8 (added 05:39; revised 06:37 after ft-refute-bench2): PRIMARY = the Opus p14/p90 on the FIXED screened text. That text has every call dropped, and every matching consult TURN (not whole consults), that mentions pre-auth, insurance, policy, TPA, mediclaim, admission, OT/pre-op or payment (Latin and native script), and it is renumbered after the screen. The unscreened score is a sensitivity, labelled proxy-inflated. Reason (refuter A5): pre-auth/insurance/payment talk before T is temporally legitimate, but it is the hospital's own conversion pipeline, so by the f07 rule it is an outcome proxy, not patient intent. With it removed (screen2, ft-bench cb9940f, re-refuted PASS-WITH-FIXES by ft-refute-bench2 R2), the T=3 Opus vs forest gap is: ale 0.693 vs 0.658, h14 0.699 vs 0.691 (about level), h90 0.737 vs 0.566 (a point lead whose CI spans 0). No Opus lead has a CI excluding 0. Residual caveat: date words remain in 58% of h90 T3 positives vs 21% of negatives (ft-bench LEAK-AUDIT, item E), so the h90 point lead may still carry scheduling signal. Layer-8 columns: opus_screen2_p14 / opus_screen2_p90 and has_text_screen2 in bench_layer8.parquet (B 407/1952 with text) and bench_layer8_c.parquet (C 189/198). Layer 8 is cleared to enter (R2 check, 07:19). h14 and Ale use p14; h90 uses p90. Missing = -1. D only; never in the H one-shot.
- Calls (layers 2-7) use only calls dated before T, after the outcome-revealing calls are dropped, with the at-risk rule F1 (surgery on or before day T dropped).

## 5. Designs and models
- **A. At the Rx (T = 0), all 1,233 D episodes.** M0 = layer 0; M1 = layers 0-1 (Q1, primary). M2 = M1 + consult layers 4-8 with missing flags (consult layer 3 dropped) (about 10% of rows covered; expected near null; run because V ordered every layer in).
- **B. Landmark, calls (T = 3 and 7; h14 / h90 / Ale).** FTR v2 design and folds. Layers are added in order 0, 1, 2, ..., 8, so models L0..L8.
- **C. Recorded-consult cohort** (FT4 design: one row per patient, strict credit; Ale primary 138 / 23, h14 >= 18 d sensitivity). Layers 0, 1, 4, 5, 6, 7, 8 in that order, so models C0, C1, C4..C8 (layer 3 dropped, see section 10). This design uses 5-fold x 20 repeats and 1,000 patient bootstraps.
- **Two final forests per design, both reported:**
  - **FULL** = every layer in. This is V's definition of done. Its cross-validated AUC is not affected by any selection.
  - **SELECTED** = forward pass in the fixed order: a layer is kept if its paired delta AUC over the current model is > 0 with bootstrap P(delta <= 0) <= 0.20; otherwise it is dropped and the next layer is tried. The keep rule is deliberately loose, because it only chooses what to carry forward; it is NOT a claim of gain. The SELECTED model's cross-validated AUC is optimistic (it was chosen on the same data), and the report says so.
- The H one-shot (15:00, V order) can only use what exists on H: design A, M0 and M1 (section 8).

## 6. Evaluation on D (always reported)
- Folds: 5 x 5 repeated StratifiedGroupKFold on the RD-0 cluster_key for A and B (B uses the FTR v2 folds and seeds); 5 x 20 for C. The same folds are used for every model within a design.
- Discrimination: AUC (primary), PR-AUC with the base rate.
- Deltas: paired, on repeat-averaged out-of-fold scores, 1,000-draw cluster bootstrap, percentile 95% CI, fixed seed; P(delta <= 0) over the bootstrap and the repeats. Out-of-fold arrays are saved.
- **Calibration (ft-bench harness):** Brier with the no-skill Brier; reliability table (10 quantile bins: mean predicted vs observed, with n); calibration slope and intercept (logistic regression of the outcome on logit(OOF p)). Reported for the raw RF and for an in-fold sigmoid-calibrated version (fitted on the training folds only). Calibration does not change AUC.
- **Feature ranking:** grouped permutation importance by layer and by engine in the FULL model (AUC drop; 10 repeats; 2.5-97.5 percentiles). Descriptive, not a test.
- Coverage: per layer, engine and role, the share of rows with data, by label and outcome.

## 7. Benchmarks (ft-bench; same episodes, labels, landmarks and folds as design B, and design C for consults)
- (a) Stated patient intent alone: the last intent tag before T (calls), or the consult's stated intent (consults), as a one-feature model.
- (b) Jev asked directly on the raw transcript for P(surgery at Even), with the same before-T and outcome-revealing exclusions.
- (c) Claude Opus 5.5 (Bedrock) asked the same, with the same exclusions. A fixed prompt is pre-registered in ft-bench DONE.md before scoring.
- Score: AUC with the cluster-bootstrap CI; paired delta FULL minus benchmark on identical episodes. LLM benchmarks (b, c) are scored as given (no training), and also as an extra feature in FULL (sensitivity).
- Benchmarks are D only and never use H.

## 8. One-shot H evaluation: 15:00 IST, V order (relayed by newcat-orch 05:33; no fable signature needed)
- Scored once, on the sealed H split: design A only, M0 (layer 0) and M1 (layers 0-1). No other layer exists on H: H calls, consults and voice engines were never pulled or processed, and the seal stays on them.
- Inputs for H: FT3 base inputs already cover all 389 H Rx (ft5a, ft3b, ft3c, ft3d, S5; checked by id count only). FT8 for H needs gating-lead's day-level pulls A and B run for the 389 H anchor Rx, into a sealed dir (~/eta-data/forest/ft8/H/, 0600). Only the scoring script reads them.
- Procedure (lane ft-h1shot):
  1. The script builds the H features with the unchanged FT3 and FT8 code (split filter switched to H), into a 0600 file that nobody opens by hand.
  2. It trains M0 and M1 once on all labelled D rows: h14 1,101 / 189 and h90 659 / 150.
  3. It scores H once: h14 (361 / 82) and h90 (224 / 64).
  4. It writes metrics only: AUC, PR-AUC with the base rate, Brier with no-skill, calibration slope and intercept, and delta AUC (M1 - M0) with a 1,000-draw cluster-bootstrap CI.
- Dry run first: the same script with one D fold standing in for H. An Opus refuter reviews the script and the dry run before 14:30, then watches the single run at 15:00.
- Not allowed: any change after the score; any second run; printing or inspecting H rows; any call, consult or LLM model on H.
- Tests: the H deltas M1 - M0 for h14 and h90 (2) are a separate family, with Holm. They are confirmatory for F-primary.
- Seal note: this uses up the first look at H that the RD-0 plan kept for Model 1 (1 Nov); V's order supersedes that.

## 9. Tests (pre-declared; Holm within each family; a gain is claimed only if its CI excludes 0 after Holm; everything else DIRECTIONAL)
| Family | Deltas | Count |
|---|---|---|
| F-primary | M1 - M0 for h14, h90 | 2 |
| F-Ale-Rx | M1 - M0 for Ale; M2 - M1 for h14, h90 | 3 |
| F-calls | each layer step L(k) - L(k-1), k = 1..8, x 3 labels x 2 landmarks; plus FULL - L0 x 6 | 48 + 6 = 54 |
| F-consults | each step, 6 steps (layers 1, 4-8), x 2 labels; plus FULL - C0 x 2 | 12 + 2 = 14 |
| F-bench | FULL - benchmark (a, b, c) x 6 call designs + x 2 consult designs (FULL includes layer 8, so FULL - c is partly circular: also reported as L7 - c) | 24 |
| F-H (one-shot, section 8) | M1 - M0 on H for h14, h90 | 2 |
| Total | | 99 |
- The SELECTED model's deltas are reported but are not tests (they are conditional on selection).
- Sensitivities (raw Haiku tags; role-free audio; separate WavLM; LLM score as a feature) are reported, not counted.

## 10. Field lists (fixed at 12:00) and freeze record
- FT8 FINAL (day-level build v3, features_ft8.parquet sha d674e54010cc; refuted PASS by ft-refute-ft8 v3 addendum, 06:32). Missing values coded -1, plus the has_ flags. M1 = all 42 ft8_* columns. Layer-0 column order = the shipped features_D / cols.json order (the FT3 ch_* order otherwise varies with PYTHONHASHSEED; found by ft-h1shot). D and H use the same pull cut, asserted before the H run. D coverage: prior Rx 469, ICD 454, meds 223, IP 23, BP 148, HbA1c 261, Hb 279, creat 230, eGFR 191, TSH 237.
  | Block | Fields | Source (db13) | Cut | D coverage |
  |---|---|---|---|---|
  | Utilisation | ft8_n_prior_rx_all, ft8_n_prior_rx_12m, ft8_n_doctors_12m, ft8_days_since_first_rx, ft8_has_prior_rx | individuals-prescriptions | prior Rx before the Rx day | 38% with a prior Rx (469; the counts are 0 otherwise) |
  | Comorbidity | ft8_n_icd_codes, ft8_charlson_n, ft8_charlson_score (Quan ICD-10), ft8_dm, ft8_htn, ft8_ckd, ft8_cad, ft8_obesity, ft8_has_icd, ft8_n_comorb_names | prior Rx ICDs + individual_medical_conditions; individual_comorbidities | before the Rx day | 37% (454) |
  | Admissions | ft8_n_ip_events_pre | ip_events (created_at) | before the Rx day | 23 episodes |
  | Vitals | ft8_sbp, ft8_dbp, ft8_bp_age_d, ft8_has_bp | individual_vitals_records | recorded before the Rx day | 12% (148) |
  | Labs | ft8_{hba1c,hb,creat,egfr,tsh} with _age_d, _n_pre (count of prior results) and has_ | parameter_digital_values | RESULT date before the Rx day | 15-23% (after sentinel fix) |
  | Medicines | ft8_n_meds_latest_prior_rx, ft8_has_meds | prescriptions__medications (latest prior Rx) | before the Rx day | 18% (223) |
  - Not built: ER visits, prior surgeries at Even, BMI, distance (no source or under 1%).
- Call tags (layer 3) FINAL: tags_D_jev.jsonl d507107e9884 and rlfeat_tags_jev.jsonl fa7220dcc743 (Jev-contradicted Haiku positives set to 0), bolna_episode_feats.parquet 68025a99cc6e; ft-text2 DONE.md 05dc133168b2, refuted PASS-WITH-FIXES (ft-text2-oref). Design C layer 3 is DROPPED (ruling 08:20): the consult Jev pitch items (p2v2 / rf775 / gap-fill) were computed on today's Saaras English, which the fable FT6 ruling excludes as a meaning-feature input. The same applies to the consult layer 3 inside M2. The FT4 pitch descriptives stay in FT7 as description only, with that caveat.
- Runner rulings for ft-forest (07:24):
  - every RF uses random_state=0, with the FTR fold seeds kept;
  - layers 4-8 are set missing for any episode/T whose window contains one of the 6 Jev-added outcome-revealing calls (the engine aggregates were not re-screened for them);
  - design C layer 0 = FT4 pulse_only with its time-respecting doctor prior rate, while A/B use the in-fold rate (m = 10);
  - the *_lex2 role twins are excluded.
- Voice engines (layers 4-7) FINAL: ft-engines DONE.md f07207f35bf3, COVERAGE.md 1ff35c8da660, engine_feats_calls.parquet 41f6928db8f0, engine_feats_consults.parquet 53f44b7113f8; refuted ref1 + ref2 PASS-WITH-FIXES, fix re-check ref2-R2 PASS (f1a3632fa52e). Engines: Nemotron-3 (kit/reb f667ed73), Odyssey (reused, re-roled), WavLM aniemore.v1 (a08f2a01, sensitivity only), emotion2vec_plus_large.v1 (6c303ba9), Clef-omni. Calls: Nemotron 933/933, window engines 911/933, Clef patient 813 / counsellor 873 / role-free 911. Consults: 172/211 with every engine; FT4 Ale cohort 100/139 patients (21/24 positives). Role columns: default (lexicon + lexicon_weak), with fallback masked.
- Benchmarks and calibration harness FINAL: ft-bench HEAD 44520f9; DONE.md dd0f3bf939ac; PREREG.md 8a03af2b4961 (prompt sha 865e5843df5e, written before scoring); LEAK-AUDIT.md 3520d790b231; layer-8 files bench_layer8.parquet 453d83f139b7 and bench_layer8_c.parquet d315521037a9; harness code/calib.py + run_frozen.sh. Refuted: ft-refute-bench2 R1 + R2 PASS-WITH-FIXES (f830205e09ed). Benchmark (a) is scored as the raw ordinal intent (the one-feature RF was invalid, with OOF AUC about 0.40).
- A layer whose lane has no PASS or PASS-WITH-FIXES refute by the run start is run and reported, but marked UNREFUTED in FT7.
- **FROZEN 20 Oct 08:22 IST by forest-lead.** Awaiting newcat-orch's signature.
- Disclosure: before the freeze, forest-lead saw the ft-forest DRY RUN on the draft spec (FOREST-TABLES-DRY.md, sha d40000dd6553). Among other things it shows FT8 lowering the at-Rx AUC (h14 M1 - M0 -0.024). No change was made in response to any dry-run number. The only change after the dry run, dropping consult layer 3, is a compliance ruling (FT6) raised by the runner, and it would have been made regardless of the results. The ft-h1shot design-A definition (h1shot.py 7e4a6a358b43) is part of this freeze.
- SIGNED by newcat-orch, 20 Oct 08:50 IST: the freeze of this spec at sha 704c50dffbef, as is.
- Declared changes after the freeze:
  1. (newcat-orch determination, 08:50 IST, recorded by forest-lead.) The H one-shot run time (section 8) moves from 15:00 to 10:00 IST. Reason: V pulled the schedule forward, and every input is final and refuted. Condition: the run starts only AFTER the ft-forest final D outputs are written and their shas logged here, so no D choice can follow the H result. If the finals are late past 10:00, H runs the moment they land. ft-h1shot-ref watches. Nothing else in the spec changes.
  - ft-forest final D output shas (logged 09:22 IST, before any GO-H; forest done 09:10:28; final_tests.log fdbc6a58b2ef, 41/41): FOREST-TABLES.md 057ee325677d; model_frozen_rx_h14 9ac680310435, rx_h90 32463bfb2469, rx_ale 3c59250e0361; lm3_h14 09b41aac7e01, lm3_h90 3ee9ecda61b0, lm3_ale 8d652f844c87; lm7_h14 ed34c0e93b0f, lm7_h90 2465365153f5, lm7_ale 7f8625675e44; consult_ale_strict e440ee81f9de, consult_h14_ge18 a5bfea01ff02. The calibration and benchmark reports computed from these OOF arrays afterwards are deterministic read-outs, not choices. Harness read-outs (written 09:10-09:28, re-verified 09:32 with the model files unchanged): DONE.md 0b5d036cb50c, CALIB-frozen-0910.md f6e29147c8e2, BENCH-TABLES-frozen-0910.md 8aeb56e6b99d, BENCH-C-FOREST.md e4f1190daf83, CALIB-rx-consult.md ab55a5c43bfe. Pre-declared sensitivities and nested in-fold sigmoid, done 09:54, before any GO-H: FOREST-TABLES-SENS.md 55538e86797e; DONE.md (addendum) 1857e5758c30. FOREST-TABLES.md and model_frozen_* unchanged.
