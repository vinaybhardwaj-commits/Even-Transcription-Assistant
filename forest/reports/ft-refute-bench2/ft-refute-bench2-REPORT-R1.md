# ft-refute-bench2 REPORT: lane ft-bench R1 (HEAD 2d8a0c0). Refuter Claude Opus 5.5 (Bedrock), 20 Oct 2026 ~06:35 IST. D only; H never read.
Own numbers: work/OWN-NUMBERS.txt (written before reading lane code). Checks: work/own.py, killers.py, mutate.py (MUTANTS.json), rerun.py.
VERDICT: PASS-WITH-FIXES. No temporal leak in (b)/(c) or layer 8, but the "strict" screen is not strict and the T=3 Opus lead over the forest is largely pre-auth/insurance process talk (fixes 1-3 before layer 8 enters as main).
Tests: lane test_bench.py 7/7 PASS (my rerun). Mutants: 12/16 killed (3 equivalent on this data, 1 real test gap). Bedrock: 30/40 requests used.
## Items
- A1 PASS. My own rebuild of the eligible calls equals inputs.jsonl on all 2010 rows (0 calls differ either way).
  - Rule: day<T, call_date<event, tagged, no OR flag in ANY tag record, nonempty STT.
  - Used calls 536 (lag1 498, screen 369, consult 0): 0 flagged, 0 untagged, 0 day>=T, 0 lag1 day>=T-1. Consult day<T 166/166 (matches consult_ist-rx_date).
  - Sandbox rebuilds of inputs/lag1/screen/consult and layer8 are byte-identical to the lane's.
- A2 PASS (notes).
  - day_from_rx = call_date-rx_date 1407/1407. Calls of another episode via patient_key 0; multi-part STT 0; negative-day calls 0; no call/event ties.
  - 27926/27938 call lines are substrings of the row's own calls' STT. The other 12 match their own calls at prefix/suffix; 0 found in any other call.
  - Notes: (i) 4 used calls have ts_is_call_day=0 with call_ts one day later; if call_ts is the truth, 2 fall on day 3 (=T at T3). (ii) 2 call_ids have an earlier OR-flagged tag record; bench_inputs.py:88 keeps 'last' (neither call is used today).
- A3 PASS. Episodes/y/clusters equal model_final2 for all 6 designs (976/92 ... 947/44); days_to_surgery<=T rows 0; forest OOF unchanged.
- A4 PASS. My AUCs and bootstrap reproduce BENCH-TABLES exactly.
  - Covered T3: ale Δ -0.141 [-0.239,-0.040], h14 -0.144 [-0.261,-0.040], h90 -0.274 [-0.408,-0.147]. T7: -0.023 / -0.005 / -0.199. ALL: forest ahead.
  - Not reported by the lane: h90 T7 on screened text, Δ -0.166 [-0.368,+0.042] (the CI spans 0).
- A5 PASS-WITH-FIXES. Pre-auth/payment/admission talk before T is known at Rx+T, so it is temporally legitimate.
  - But it is the hospital's own conversion pipeline: the decision has been made. By the spec's own f07 / layer-7 rule it is an outcome proxy, not patient intent.
  - The screen regex has no insurance/policy/TPA/mediclaim terms (leak_audit.py:15-21). On screened text these remain in 52% of positives vs 26% of negatives (ale T3).
  - Without those rows: Opus ale3 0.642 (154/11) vs forest 0.601; h14_3 0.659 (142/8) vs 0.629. The T3 lead shrinks to ~0.03. h90 is robust (0.797 vs 0.58).
  - Spec line 41 ("31% vs 3%") understates: that is 29+29 sampled ale-T3 rows only; at T7 it is 62-67% vs 11%.
  - LEAK-AUDIT "survives at T=3" is too strong, and its verdict conflates 0.68-0.69 (rows with no word) with 0.75 (screened text).
- A6 PASS. PREREG born 04:34:06, before the first score files (04:34:13 Jev, 04:34:19 Opus) and the first AUC (04:51:51). The prereg JSON hashes to PSHA 865e5843df5e.
  - Addenda 4-5 are not labelled post-hoc.
- A7 PASS. slope/intercept/CITL equal statsmodels to 1e-4; Brier/no-skill/AUC/reliability exact; folds partitioned and group-disjoint; selftest OK.
  - Gap: nothing tests folds == FTR folds (M13 survives both suites).
## Layer 8
- bench_layer8: 1952 rows = the FTR v2 at-risk union (T3 1005 + T7 947), 0 duplicates/missing/extra. has_text 551 and screen 456 (0 mismatches); all 6 p columns equal the scores.
- bench_layer8_c: 198 = designC_cohort; has_text 193/189, 0 mismatches. No p comes from text >= T or from an OR-flagged or untagged call.
- The screen drops whole calls, and consult turns by line; screened text has 0 regex hits.
  - LEAK: headers keep pre-screen numbering (bench_inputs.py:121), so 68/366 rows show a numbering gap. Gap alone AUC 0.62-0.63 at T7.
- Stability: 298 identical-text pairs gave |Δp14| median 0.00, r=0.983. My 30 Bedrock re-asks: median 0.00, p90 0.05, r=0.986, AUC 0.916→0.920.
## Mutants 12/16 (copies under work/mutX)
- Killed: M1 day<=T, M2 unverified ignored, M4 lag1 no-op, M6 partial-line screen, M8 tags keep=first, M9 has_text from Jev, M10 undeduplicated union, M11 CITL sign, M12 reliability obs, M14 no-skill=prev, M15 consult not screened, M16 payment category dropped.
- Survived: M3 post_event >, M5 untagged default, M7 consult<=T (all equivalent on this data); M13 fold seed+1 (real gap).
## Fixes
1. (required) Renumber calls after the screen; rerun scores_screen_opus.
2. (required) Add insurance/policy/TPA/mediclaim (Latin and native script) to the preauth screen; rerun and report ale/h14 T3 vs forest.
3. (required) Reword spec line 41 and the LEAK-AUDIT verdict:
   - "the T=3 Opus lead is mostly pre-auth/insurance/payment process talk, an outcome proxy by the f07 rule; without it ale/h14 T3 ≈ forest; h90 holds".
   - Prefer the fixed screened score as layer 8 main; else label L8/FULL−c proxy-inflated.
   - Fix the 0.68 vs 0.75 conflation; report the h90 T7 screened CI.
4. DONE headline: add the proxy caveat next to "Opus beats forest at T3 covered".
5. Test calib.folds == FTR folds (stored fold ids, or assert refit AUC in a test).
6. Extend test_bench to the lag1/consult/screen/c inputs and bench_layer8* (keys, has_text, p == scores, 0 screen hits).
7. Drop a call if ANY tag record flags OR: bench_inputs.py:88 and bench_score.py intent_codes.
8. Sensitivity without the 4 used ts_is_call_day=0 calls, or document that call_date is authoritative.
9. Label Addenda 4-5 post-hoc.
10. Minor: inputs_meta_screen.parquet is 0664; intent_codes sorts mixed ts string formats (within-day order wrong).
