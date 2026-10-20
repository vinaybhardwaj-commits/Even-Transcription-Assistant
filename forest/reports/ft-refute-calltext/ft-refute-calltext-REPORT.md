# ft-refute-calltext REPORT: independent recompute of ft-calltext (Opus 5.5, Bedrock), 19 Oct 2026
Served by: Claude Opus 5.5 (global.anthropic.claude-opus-5-5). D split only; H labels touched only inside recompute.py's count line (no H features or text). No Haiku/Bedrock tagging calls.
Own code and outputs: ~/wt/ft-refute-calltext/work/ (labels, join, feats, verify, desc, model, run*.py; res*.json; 0600). Lane code and model_results were read only AFTER my numbers were saved (work/res_*.json).

## Rebuild
- Labels: ran ft-refute-labels recompute.py, then h14 NaN at age < 18 d. D h14 1,101/189, h90 659/150; vs labels.parquet (sha 0aefc00f425b): 0 h14 and 0 h90 mismatches.
- Calls: rebuilt from raw funnel/in/t1a-call-ids.tsv (23,024 rows, 20,047 calls) and t1b01-11 (read_export, 0 bad, 6,098 calls, latest summary_ts). Cluster join via 10.tsv + clusters.
  Window (days 0-14, before the surgery day): 5,788 rows / 787 eps / 3,305 connected / 2,295 with summary / 552 eps. Identical to the claim. (293 t1a Rx are not in 10.tsv, so they are not linked; same in both pipelines.)
- Baseline (my own): specialty, OOF smoothed doctor prior + volume (inner OOF on train), my keyword procedure class (18 classes), age, sex, doctor gender, ICD chapter counts, investigations + missing flag, prior-visit payer, prior Rx, month. RF 400 / leaf 5; 5x5 StratifiedGroupKFold on cluster, same folds for base and base+call; 1,000-draw cluster bootstrap.

## Tags (tags_D.jsonl sha d86ad5d43700, 2,185 calls)
- 3,786 retained quotes: 3,780 exact at their offsets in the whitespace-normalised source, 4 exact but at a different offset, 2 case-insensitive only (not exact substrings). 0 fail. All quote shas match.
- The 6 failures CANNOT be recounted from the file: dropped tags were not written. The only evidence is the lane's tag_report_run.json ("unverified": 6). 1 claimed-unverified outcome_revealed flag is retained, as DESC says.
- Untagged: 110 calls / 11 eps; GS 7, Ortho 3, Other 1; h14 5 pos / 5 neg / 1 pending; 3 eps have no tags at all. All confirmed.
  76 of the 110 calls fall before day 3 and 97 before day 7, so they sit inside the landmark windows.

## Landmark table (cohort P; n/pos match the claim in EVERY row; delta = base+call - base, paired)
| design | n/pos | claim base, delta [CI] | mine base, delta [CI], P(delta<=0) |
|---|---|---|---|
| h14 lm3 | 976/92 | 0.651, -0.002 [-0.039,+0.035] | 0.616, +0.010 [-0.042,+0.049], 0.37 |
| h14 lm7 | 926/42 | 0.645, +0.028 [-0.046,+0.096] | 0.565, **+0.090 [-0.002,+0.166], 0.03** |
| h90 lm3 | 572/90 | 0.671, -0.004 [-0.042,+0.035] | 0.660, -0.009 [-0.066,+0.028] |
| h90 lm7 | 545/63 | 0.641, +0.016 [-0.044,+0.080] | 0.616, +0.030 [-0.044,+0.089] |
| h14 S lm3 | 550/56 | 0.603, -0.000 | 0.584, +0.008 [-0.070,+0.078] |
| h90 S lm3 | 302/57 | 0.586, -0.016 | 0.644, -0.045 [-0.102,+0.002] |
| h14 asis (leaky) | 1,061/177 | +0.046 [+0.023,+0.073] | +0.053 [+0.022,+0.081] |
| h90 asis (leaky) | 621/139 | +0.027 | +0.024 [-0.008,+0.056] |
Base AUC is the mean of per-repeat AUCs; CIs are from repeat-averaged OOF scores. Cohort P drops 9 D eps in 7 hash-ambiguous clusters (claim: 8); n is unchanged after the label filter.
Sensitivity on h14 lm7: a different fold seed gives +0.067 [-0.018,+0.145]; adding same-day payer gives base 0.599, +0.082 [-0.010,+0.154]; dropping the 11 parse-fail eps gives +0.047 [-0.031,+0.127] (n 919/40). h14 lm3 without them: +0.001.

## forest-lead checks
1. Calls dated >= T or on/after surgery: PASS. Asserted in my pipeline, and the lane code cuts at day_from_rx < T (lm) or < min(15, surgery day) (asis).
   Residual: Haiku tagged chunks of up to 10 calls spanning days 0-14, so an early call's tag could be shaped by later calls in its context. Each quote must come from the call's own text, and the tags add <= 0.004, so impact is minor.
2. outcome_revealed calls (verified or claimed) excluded from model and DESC: PASS (lane `~c.leak`; my DESC recompute with the same exclusion matches cell for cell).
3. Paired deltas: PASS. Same episodes and the same StratifiedGroupKFold seeds for base and base+call; base per-repeat AUCs are identical across asis and matched.
4. Parse-fail bias: it pushes the converters' objection shares DOWN. 10 of the 11 eps are in h14 P and 5 are converters (vs 17% base), so the "converters almost never object" contrast is the most exposed.
   Worst case (every failed ep gets the tag): going_elsewhere 1% -> 8% vs 15% -> 16%; second_opinion 0 -> 7 vs 8 -> 9; timing 21 -> 27 vs 39 -> 40; insurance 61 -> 67 vs 31 -> 32.
   In the model, dropping them halves my h14 lm7 delta (see the sensitivity line above).
5. DESC shares: PASS, exact. h14 463 eps / 72 conv: cost 15/72 vs 93/391, insurance 44 vs 121, fear 0 vs 18, second_opinion 0 vs 30, going_elsewhere 1 vs 59, timing 15 vs 153, family 6 vs 57, declines 1 vs 35, wants 19 vs 61.
   Revealing eps: 71/177 vs 137/884. h90: 209 / 57, all cells match. GS/Gyn/Ortho/Uro going_elsewhere, timing and family cells match.

## Issues
1. (FIX, wording) "Call features add nothing measurable" holds at T=3 only. At h14 T=7 every run is positive: lane +0.028; mine +0.047 to +0.090 with P(delta<=0) 0.03-0.14.
   The size depends on baseline strength (lane base 0.645 vs mine 0.565-0.60) and on 7 parse-fail eps. Say: "T=3 null; T=7 positive but DIRECTIONAL (42 pos), CI touches 0, baseline-dependent".
2. (FIX, disclose) The lane baseline includes FT3's same-day `payer` (BCOLS from features_D.cols.json), which ft3_model.py turns OFF by default as leaky. It is known by Rx+T, so it is acceptable in a landmark model, but it is not the FT3 baseline. State it.
   In my runs it lifts base by +0.013 to +0.034 and barely moves delta.
3. (FIX, caveat) Add the parse-fail worst case to the objection headline ("going_elsewhere 1% vs 15%" could be up to 8% vs 16%). The direction holds; the gap could roughly halve.
4. (NOTE) The 6 quote failures can only be verified from the lane log, and 2 kept quotes match only case-insensitively. Cohort P drops 9 eps, not 8 (no effect on n).
   "with summary" counts tagged calls (337), not summaries (344). Haiku tags are still unbenched (kappa pending).

## v2 delta (19 Oct 2026, Opus 5.5; LANE-CLAIM-v2 vs v1)
Served by: Claude Opus 5.5 (global.anthropic.claude-opus-5-5). D only, no Bedrock/Haiku calls. New code: work/run3.py (Ale), output work/res3_ale.json; worst-case objections re-run with work/desc.py.

### What changed v1 -> v2
- The primary baseline is now payer-OFF, so every headline delta changed. The v1 numbers are kept as a "with-payer sensitivity".
- New Ale label (1 = surgery <= 14 d; 0 = Rx >= 14 d old with none; younger = drop) at T=3 and T=7.
- P(delta<=0) is now reported from both the bootstrap and the repeats. Cohort S now has an h90 row. The leaky as-is rows are re-run payer-free.
- Worst-case objection line added. FTR (audio) plan and code added (run_ftr.sh, audio_feats); no audio results yet.

### Fixes
1. Wording ("T=3 null; T=7 DIRECTIONAL, baseline-dependent"): **APPLIED.** v2 says "T=3: null. T=7: positive in every repeat for h14 and Ale, but DIRECTIONAL (42-44 positives, CI spans 0) and baseline-dependent."
2. Payer disclosure: **APPLIED + CHANGED-NUMBER.** The lane went further than asked: payer is OFF in the primary (ftc_model.py strips BCOLS 'payer' unless PAYER=1). My first-round primary was already payer-off, so my numbers below are like-for-like.
   | design | n/pos (both) | lane v2 base, delta [CI] | mine (payer-off) base, delta [CI], P(d<=0) |
   |---|---|---|---|
   | h14 lm3 | 976/92 | 0.644, -0.006 [-0.045,+0.032] | 0.616, +0.010 [-0.042,+0.049], 0.37 |
   | h14 lm7 | 926/42 | 0.612, +0.040 [-0.038,+0.114] | 0.565, +0.090 [-0.002,+0.166], 0.03 |
   | h90 lm3 | 572/90 | 0.673, -0.003 [-0.040,+0.035] | 0.660, -0.009 [-0.066,+0.028] |
   | h90 lm7 | 545/63 | 0.637, +0.023 [-0.040,+0.089] | 0.616, +0.030 [-0.044,+0.089] |
   | **Ale lm3 (new)** | 1005/102 | 0.634, -0.003 [-0.043,+0.037] | 0.614, +0.004 [-0.043,+0.044], 0.52 |
   | **Ale lm7 (new)** | 947/44 | 0.587, +0.055 [-0.025,+0.136] | 0.571, +0.065 [-0.018,+0.146], 0.07 |
   | h14 S lm3 | 550/56 | -0.004 | +0.008 |
   | h90 S lm3 | 302/57 | -0.022 | -0.045 |
   | h14 asis (leak) | 1061/177 | +0.067 | +0.053 [+0.022,+0.081] |
   | h90 asis (leak) | 621/139 | +0.021 | +0.024 |
   Ale n/pos match exactly. The pattern agrees everywhere: null at T=3; positive and CI-touching-0 at T=7. The lane's T=7 gains are smaller than mine (stronger lane baseline), so the "baseline-dependent" wording is right.
3. Parse-fail caveat on the objections: **APPLIED, one number differs.** going_elsewhere 8% vs 16% matches my recompute. Timing: the lane says 25% vs 40%; mine gives 27% vs 40% (all 10 failed h14-P eps flagged, 5 conv / 5 not). The lane's figure slightly understates the worst case (cost would be 27% vs 25%, which flips its direction; not quoted). Minor.
4. (NOTE from round 1) Cohort P still says "D 8"; I count 9 dropped eps in 7 clusters. No effect on n. Not fixed; cosmetic.

### Leak re-check (v2 code)
- Calls dated >= T or on/after surgery: PASS. The text window is unchanged (`day_from_rx < cut & ~leak`, landmark cut = T, episodes with surgery <= T dropped). My Ale run asserts no call >= T, none on/after surgery, no revealed calls.
- outcome_revealed: PASS. Verified and unverified revealed calls are both dropped, unchanged.
- H split: PASS. ftc_model.py asserts split == {'D'}. Ale is built on the same D frame. My epsD2 is D only (1,233 rows).
- New, forward-looking (audio path, no results yet), NOTE:
  (a) The per-call audio window for the non-landmark designs is `day_from_rx < 15`, with no surgery-day cut, unlike the text path. Only the as-is leak demo is affected; keep audio out of as-is or add the cut.
  (b) The rl-feat format builds only `_t7`/`_t14`, so run_ftr's T=3 rows will assert-fail. The plan's "T=3 and T=7" would then deliver T=7 only.
  (c) Audio quality rests on rl-feat's own `leak` flag and post-event drop; re-check that when the file lands.

### v2 verdict: PASS
All 3 fixes are applied. My recompute confirms every changed number in direction and CI-includes-0 status (Ale included). Top residual: T=7 effect size is baseline-dependent (h14 +0.040 lane vs +0.090 mine; Ale +0.055 vs +0.065), so quote it as DIRECTIONAL only. Minor: worst-case timing is 27% vs 40%, not 25% vs 40%.
