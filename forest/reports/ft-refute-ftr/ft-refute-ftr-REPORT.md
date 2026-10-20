# ft-refute-ftr REPORT: independent recompute of ft-calltext FTR final (call text + Runo audio, landmark T=3/7), 20 Oct 2026 ~04:20 IST
Served by: Claude Opus 5.5 (global.anthropic.claude-opus-5-5). D only. No Bedrock/Haiku/Sarvam calls. Own code and outputs: ~/wt/ft-refute-ftr/work/ (0600). OWN-NUMBERS.txt was written BEFORE I read lane code.
Base pipeline: the predecessor refuter's own labels, calls and baseline (~/wt/ft-refute-calltext/work), with my audio join (ftr.py). RF 400/leaf 5, 5x5 StratifiedGroupKFold on cluster, with fold seeds 0 and 50, plus a masked rerun. **VERDICT: PASS-WITH-FIXES.** Counts and design reproduce exactly. One audio leak (file membership, fix 1). The h90 T7 "audio CI excludes 0" does not reproduce. Nothing survives multiplicity, so "DIRECTIONAL throughout" is right.

## Counts
- Audio parquet sha acca10d995c4: MATCH. 369 rows, all D. h14/h90 labels: 0 mismatches against labels v2.
- Audio-covered AND at risk (n_calls_tT > 0, surgery > T): MATCH in all 6 cells. h14 197/19, 235/11; h90 96/21, 110/17; Ale 209/23, 244/11. Full n/pos match too (976/92 ... 947/44).
- Cosmetic: I count more pre-landmark converters among in-file P episodes: h14 22/32, h90 14/20, Ale 25/40 (the claim says 19/29, 12/18, 20/34). Event exactly on day T is 9/5, 6/3 and 12/6 of these. The claim's denominator is unstated; please define it.

## Scope checks (newcat-orch)
1. **F1 at-risk: PASS.** My model input rows have 0 episodes with event <= T in all 6 designs (asserted). The lane asserts the same on its model frame D (ftc_model.py:214) after the drop at :211.
2. **Identical folds: PASS.** The lane makes one StratifiedGroupKFold(RS+rep) split per repeat on the same D, y and cluster g, and fits every model (base, text, text_audio, audio, text_only) inside that one loop (:230-233). Mine does the same. Deltas are paired on the same rows.
3. **Bootstrap CIs: PASS-WITH-NOTE.**
   - Method: cluster bootstrap (RD-0 cluster), NB=1000, plain percentile (not BCa), seed RS shared across pairs, on 5-repeat-averaged OOF scores. Draws with a single class are skipped.
   - Recompute: the lane's boot_delta code on my own OOF, 3 bootstrap seeds each. CI lower bounds: h90 T7 audio-base +0.029, -0.016 to -0.013; Ale T7 text_audio-base +0.091, +0.000 to +0.009; h14 T7 text_audio-text +0.027, -0.010 to -0.009.
   - The method reproduces, but the bootstrap seed alone moves the CI bounds by about 0.01. These CIs hold the OOF predictions fixed and ignore refit variance, so they are optimistic. The lane's exact CIs cannot be re-derived because its JSON stores no OOF scores (fix 3).
4. **Audio leakage: FAIL (minor, fixable).**
   - PASS: windows are day_from_rx < T, and day = call_date - rx_date for 933/933 manifest calls. Calls on/after surgery: 0. The 6 calls whose timestamp is not the call day are all in never-operated episodes.
   - PASS: outcome_revealed (verified) calls are excluded from the rl-feat aggregates, and the lane drops n_calls_dropped_outcome_tT and role_fallback_share_tT.
   - FAIL: file membership leaks. An episode that is in the file but has 0 calls before T (h14 T3: 95 eps, 5 pos; h90 T7: 30 eps, 3 pos) gets 0 instead of the -1 "missing" code on n_calls, n_calls_tagged and *_n_windows. The lane also sets aud_has = "any non-NaN", which counts 292 episodes, not 197. So the model can see "has a recorded call at or after T, or had only an outcome-revealing call before T".
   - Masked rerun (all audio set to missing when n_calls_tT = 0): T=3 audio gains go to about 0 (h90 T3 audio-base +0.016 -> +0.002; h14 T3 text_audio-text +0.000 -> -0.009). T=7 is unchanged (h90 +0.032 -> +0.033). The lane's no-role h90 T3 +0.028 [+0.002, +0.059] is likely inflated by this leak.
- H split sealed: PASS. Parquet, labels and my frames are all D, asserted. Text window: no call >= T, none on/after surgery, no revealed calls (asserted).

## Deltas (my seed 0 / seed 50; lane in brackets)
- **Audio over text:** my 95% CI includes 0 in all 6 designs and both seeds (h90 T7 +0.014/+0.007, Ale T7 +0.028/+0.030, h14 T7 +0.023/+0.026). AGREES with the lane. The only exception is masked Ale T7, +0.037 [+0.007, +0.077], which is nominal only.
- **h90 T7 audio-base: NOT REPRODUCED as CI-excluding-0.**
  - Mine: +0.032 [-0.017, +0.074]; +0.031 [-0.013, +0.070]; masked +0.033 [-0.014, +0.074]. Lane: +0.041 [+0.002, +0.082]. The direction agrees and every repeat is positive in both pipelines. Do not headline it as the one significant audio effect.
- **T=7, text(+audio) over base: consistently positive.** The size depends on the baseline (mine 0.565-0.576 vs lane 0.612):
  - h14 text_audio-base: +0.113 [+0.027, +0.202] / +0.093 [-0.004, +0.178] (lane +0.044 [-0.042, +0.126])
  - Ale text_audio-base: +0.094 [+0.010, +0.172] / +0.119 [+0.045, +0.208] (lane +0.080 [-0.001, +0.162])
  - Most of it is text/call volume: text-base is h14 +0.090/+0.067 and Ale +0.065/+0.089.
- **T=3:** null everywhere in both pipelines (|delta| <= 0.02).
- **No-role sensitivity:** close to the primary everywhere. h90 T7 audio_np-base is +0.030 [-0.010, +0.069] / +0.032 [-0.006, +0.071], so the lane's no-role +0.042 [+0.008, +0.081] does not reproduce as excluding 0 either.

## Multiplicity and wording
- Family of 18 deltas (text, text_audio and audio over base, x 6 designs). Nominal 95% CIs excluding 0: 3 / 2 / 3 per run (lane: 1).
- Holm-adjusted minimum p: 0.27 (seed 0), 0.054 (seed 50), 0.20 (masked). Over the 24-delta family: 0.36 / 0.072 / 0.26. Bonferroni-18 CIs exclude 0 in 0 / 1 / 0 runs. The one is seed-50 Ale T7 text_audio-base, at the edge.
- **No delta survives a multiple-comparison correction reliably.** WHICH nominal CI excludes 0 changes with the baseline and the fold seed.
- "DIRECTIONAL throughout" is CORRECT. Suggested headline:
  - "T=3 null. At T=7, call text plus audio beats the Pulse baseline in every repeat for h14, h90 and Ale (+0.04 to +0.12 AUC, baseline-dependent), but no CI survives correction for about 18 comparisons."
  - "Audio adds nothing measurable over text (11-17 audio-covered positives at T=7)."

## Fixes
1. (LEAK) Set audio features to -1 and aud_has = (n_calls_tT > 0) when an episode has no audio call before T. Rerun and replace the T=3 audio rows (the T=7 rows barely move).
2. (WORDING) Drop "only h90 T7 excludes 0" as a finding. It does not reproduce, and it does not survive multiplicity.
3. (REPRO) Save the OOF arrays in model_final*.json so the CIs can be re-derived. Define the pre-landmark-converter denominator.
4. (NOTE) The audio manifest links calls by patient_key, not t1a call_id. In 38-50 at-risk episodes per design it holds more calls before T than the text call table does. That is not a leak, but audio n_calls/minutes carry extra call-volume signal.
   T=7 call signal may also partly reflect calls about surgery that is already being scheduled; it is legitimately known at Rx+T, but say so.

## v2 delta (20 Oct ~05:40 IST, Opus 5.5; FTR-TABLES-final-v2.md sha fa8ec5bee4bb MATCH, model_final2_* with OOF). Code: work/v2chk.py. VERDICT v2: PASS
1. **Leak fix: PASS.** I ran the lane's own rlfeat_to_aud (ftc_model.py:175-179) on the parquet.
   - Rows with n_calls_tT == 0 (114 at T3, 63 at T7) now have 0 non-missing audio features. aud_has = n_calls_tT > 0. The dropped_outcome and fallback columns are not used.
   - The at-risk aud_has counts equal my 6 cells (197/19 ... 244/11).
   - My own masked v1 run already showed the effect: T3 audio falls to about 0, T7 is unchanged.
2. **The 3 v2 deltas, recomputed from the lane's stored OOF (4,000-draw cluster bootstrap, my seed):**
   - h14 T7 text_audio-base +0.055 [-0.029, +0.136]
   - Ale T7 text_audio-base +0.081 [+0.003, +0.158]
   - h90 T7 audio-base +0.038 [+0.000, +0.076]
   - Point estimates: EXACT. All 18 rows also re-pass F1 (0 kept eps with event <= T) and are D only.
   - The CI bounds move by about 0.003 with the bootstrap seed. The lane's "[-0.000]" and "[-0.001]" lower bounds are my "[+0.003]" and "[+0.000]".
   - My own masked baseline gives larger T7 values (+0.116, +0.102, +0.033), as before; the size is baseline-dependent.
3. **Holm over 18: PASS-WITH-NOTE.**
   - From the lane OOF, my minimum adjusted p is 0.78 (Ale T7 text_audio raw p 0.043; h90 T7 audio 0.048). The lane claims 0.97 (raw 0.054).
   - That gap is bootstrap Monte Carlo noise around p ≈ 0.05. Either way nothing is near 0.05 after correction.
   - My v1 0.054 came from MY weaker baseline at fold seed 50 (raw p 0.003), not from the lane model.
4. **Wording: PASS, one tweak.** DIRECTIONAL throughout, and the "CI excludes 0" claim is withdrawn. The no-role +0.040 [+0.005, +0.075] is flagged "not a finding" (Holm 0.58).
   - Tweak: "All CIs span 0" holds at the lane's seed only. Two T7 CIs sit on 0 (Ale text_audio, h90 audio).
   - Say instead: "T7 CIs span or touch 0; none survives multiple-comparison correction".
