# ft-calltext DONE (19 Oct 2026 17:50 IST; v2 refute fixes 19:45 IST)
- **Lane model:** Claude Opus 5.5 on Bedrock (global.anthropic.claude-opus-5-5).
- **Tagger:** Claude Haiku 5.5 on Bedrock, global.anthropic.claude-haiku-5-5, steward ZDR creds.
- **Data scope:** D split only. Labels v2, sha 0aefc00f425b.
- **Report:** FTC-REPORT.md.

## Model type (forest-lead leakage ruling)
- This is a **post-Rx landmark model (prediction at Rx+T, T = 3 and 7)**:
  - features use only calls dated < T;
  - episodes with surgery ≤ T are dropped;
  - outcome_revealed calls are dropped;
  - label = surgery in (T, H] vs none by day H.
- It is separate from FT3/FT4. Call features never enter any model that predicts at Rx or consult time.
- The brief's own window (calls before the surgery day) is reported only as a leakage demonstration.

## Headline numbers, v2 (19 Oct ~19:45 IST; refute fixes applied)
- Baseline = FT3 primary, same-day payer OFF. Cohort P = hash-only F1 ambiguity dropped (D 8). Rx >= 1 Jan 2026. Same episodes and folds for base and base+text.

| label | landmark | n | positives | base AUC | base+text ΔAUC [95% CI] | P(Δ≤0) boot / repeats |
|---|---|---|---|---|---|---|
| h14 | T=3 | 976 | 92 | 0.644 | −0.006 [−0.045, +0.032] | 0.63 / 0.60 |
| h14 | T=7 | 926 | 42 | 0.612 | +0.040 [−0.038, +0.114] | 0.18 / 0.00 |
| h90 | T=3 | 572 | 90 | 0.673 | −0.003 [−0.040, +0.035] | 0.57 / 0.40 |
| h90 | T=7 | 545 | 63 | 0.637 | +0.023 [−0.040, +0.089] | 0.23 / 0.20 |
| Ale | T=3 | 1005 | 102 | 0.634 | −0.003 [−0.043, +0.037] | 0.57 / 0.40 |
| Ale | T=7 | 947 | 44 | 0.587 | +0.055 [−0.025, +0.136] | 0.09 / 0.00 |

- **Verdict.**
  - T=3: null.
  - T=7: positive in every repeat for h14 and Ale, but DIRECTIONAL (42–44 positives, CI spans 0) and baseline-dependent.
  - The gain comes from call volume and timing, not text tags (objections +0.004 to +0.005).
- **With-payer sensitivity (= v1):** h14 T=3 −0.002, h14 T=7 +0.028, h90 T=3 −0.004, h90 T=7 +0.016.
- **Cohort S (shared-phone set also dropped):** h14 T=3 −0.004 (n 550, 56 positives); h90 T=3 −0.022 (n 302, 57 positives).
- **Leaky as-is window (payer-free):** h14 +0.067, h90 +0.021. These are leak demonstrations, NOT gains.
- **Objections (h14, 463 episodes / 72 converted).** Point estimates: going_elsewhere 1% vs 15%, timing 21% vs 39%, insurance 61% vs 31% (partly pre-auth), cost 21% vs 24%.
  - Parse-fail worst case: going_elsewhere up to 8% vs 16%, timing 25% vs 40%. DESC.md.
- **Tables:** V2-TABLES.md, model_v2_*.json.

## FTR (RUNO-AUDIO step 4): FINAL v2 20 Oct ~05:20 IST (ft-refute-ftr fixes 1-4 applied)
- **Leak fix.** Audio is masked to missing when n_calls_tT == 0, and aud_has = (n_calls_tT > 0).
- **T=3:** null.
- **T=7:** text+audio over base is +0.055 (h14, n 926 / 42 positives), +0.036 (h90, 545 / 63) and +0.081 (Ale, 947 / 44). All CIs span 0. Holm-adjusted min p is 0.97 over 18 deltas and 1.00 over 24.
- **Audio over text:** −0.009 to +0.026, all CIs span 0.
- The v1 claim "h90 T7 audio CI excludes 0" is withdrawn (now +0.038 [−0.001, +0.078]). DIRECTIONAL throughout.
- **Files:** FTR-TABLES-final-v2.md (sha fa8ec5bee4bb, also copied to FTR-TABLES-final.md), model_final2*.json (with OOF arrays), FTR-REPORT.md. The leaky v1 is kept in FTR-TABLES-final-v1-superseded.md.

## Earlier plan (RUNO-AUDIO step 4)
- When out/ft-rl-feat/call_audio_feats.parquet lands (target Tue 16:00), run code/run_ftr.sh. It compares base vs base+text vs base+text+audio for h14, h90 and Ale at T=3 and T=7. Output: FTR-REPORT.md by Tue 22:00.
- The join is tested on a synthetic stub (~/wt/ft-calltext/stub/, random values, ids only).
- Requested schema sent to cb-ft-rl-feat: per-call rows with day_from_rx and a leak flag.

## Ledger
- **Requests:** 593 (590 run + 3 trial).
- **Tokens:** 998k in / 1.09M out (run); 1,002,282 in / 1,095,396 out with the trial. Pre-flight projected 853k against the 5M cap.
- **Coverage:** 2,295 window calls with a summary; 2,185 tagged.
  - 11 chunks failed parse (110 calls / 11 episodes, heavy-call GS/Ortho, h14 5 positive / 5 negative / 1 pending). Dropped, not retried.
  - 6 quotes failed verification; those tags were dropped.
- **Disclosure:** this tagging ran before I read forest-lead's "do not run a second tagging" reply. forest-lead then approved using it for FT. No further Haiku calls.

## Pending
- Per-tag kappa against funnel T1 on the overlapping calls, once T1 lands (it is blocked on the split_guard pin).
- No hand-labelled accuracy sample in this lane.

## Files (the lab box ~/oc/forest-lead/ft/out/ft-calltext/, 0600)
- Report and tables: FTC-REPORT.md, DESC.md, model_results_*.json.
- Data: calls_D.parquet (5d2a1c72a6ec), episodes_D.parquet (a06fa6e0747f), tags_D.jsonl (d86ad5d43700).
- Code: code/ftc_{join,tag,model,desc,table}.py, run_ftr.sh, make_stub.py (v1 model kept as ftc_model_v1.py).
