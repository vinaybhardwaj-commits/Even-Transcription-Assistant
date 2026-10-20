# ft-refute-bench REPORT: lane ft-bench at 21a7f2a (round R1, focus: leakage in b/c). Refuter: Claude Opus 5.5 (Bedrock), 20 Oct 2026.
Verdict: **PASS-WITH-FIXES**. tests 19/19 (lane test_bench 7/7 from clean, own work/test_refute.py 12/12); mutants 13/16 killed (2 equivalent).
Own numbers: work/OWN-NUMBERS.txt (written before reading lane code beyond tests; post-code section labelled). D split only, H never read, no text/ids out.

## Items
- A1 inputs PASS. I rebuilt every (episode, T) call set from manifest.tsv, tags.jsonl, stt/ and labels.parquet with my own code: 0 missing, 0 extra (2010 rows, 904 calls).
  - 0 calls on day >= T, by manifest and by call_date − rx. 0 calls on or after the event date, and no date ties.
  - 0 calls flagged outcome_revealed or unverified, counting ANY tag run (247 call_ids have duplicate tag runs). 0 untagged calls.
  - Every consult is day 0 and matches labels.consult_uid. lag1 has 0 calls on day >= T−1. The consult variant has 0 calls.
  - Drop counts match the audit: 108 outcome-revealed, 16 untagged.
- A2 hidden leaks PASS (notes).
  - day_from_rx equals call_date − rx on all 1407 manifest rows. 0 calls are linked to another episode; patient_key maps 1:1 to an episode and no cluster has a sibling episode.
  - No duplicate path or call key (multi-part audio). Text headers never carry a day >= T.
  - Note: 8 used calls have ts_is_call_day=0, and for 2 of them (T=3, both negatives) the recording ts falls on day T. Upstream ft-rl-run DONE.md rules call_date authoritative, so this is not a leak.
- A3 PASS. For all 6 designs: same episodes, y and clusters as model_final2. forest_text_audio equals the OOF mean (max diff 0.0). Split is D only.
- A4 PASS. My own code (own_auc.py) reproduces every headline exactly, including the CIs.
  - Covered rows, Opus vs forest: ale3 0.794/0.652, Δ −0.141 [−0.239,−0.040]; h14-3 0.814/0.671, Δ −0.144 [−0.261,−0.040]; h90-3 Δ −0.274.
  - ALL rows (median fill): 0.606, 0.602, 0.617.
  - The lag1, consult-only and screen tables in LEAK-AUDIT §2/§4 also match to 3 decimals.
- A5 PASS-WITH-FIX (wording). My judgement: pre-auth/payment/scheduling talk before T is available at Rx+T, so it is not outcome leakage. It is, however, a process mediator: the decision is largely made. It must be reported as such, and it is weak evidence that the LLM "reads intent better".
  - FIX-1 (top): the claim says "T=7: level", and LEAK-AUDIT says "At T=7 the forest is level with the LLMs". Both are false for h90.
    - h90 T7 covered Δ is −0.199 [−0.376,−0.029] (BENCH-TABLES l.338), and lag1 gives −0.184 [−0.367,−0.018] (LEAK-AUDIT §2 itself).
    - Correct wording: level for ale/h14; Opus ahead for h90, where the forest's covered AUC is low (0.62).
  - FIX-2: the bold "The signal survives at T=3" should carry the qualifier: survives the lag1 and proxy screens; not significant under the strict screen for ale/h14.
  - FIX-2 also: "lowers Opus by about 0.04 to 0.06" should read 0.03–0.06 (h90 0.838 → 0.811).
- A6 PASS. The PREREG JSON block hashes to 865e5843df5e, which equals bench_llm.PSHA. The prompts are unchanged from 8136a8e (04:34:12) to HEAD.
  - PREREG.md mtime is 04:34:06; the first score file was last written 04:35:12 (jev).
  - Addendum 1 (04:39) came after the LLM scores but before any AUC. Its "median fill" is the pre-registered constant (tie), so it changes nothing.
  - Addendum 3 is honestly marked post-hoc.
  - Minor: Addendum 4 is stamped 05:10 but cites a 05:15 order.
- A7 PASS (test gap).
  - Matches independent references: slope/intercept vs sklearn unpenalised LR (<1e-4), CITL vs a brentq root (<1e-6), Brier/AUC vs sklearn, Wilson bounds.
  - Bootstrap keeps clusters whole and resamples with replacement. Folds are group-disjoint and differ by repeat. Crossfit uses only the other folds. Nested null gives AUC < 0.62.
  - calib selftest OK.
  - Note: FTR clusters are all singletons (n clusters = n), so the "cluster bootstrap" is effectively iid. It is the same as FTR, so it is not a lane bug.

## Extra findings
- FIX-3 (screen variant, low impact): screened calls leave gaps in the "Phone call i" numbering in 68 rows, which tells the model that a call was removed.
  - Gap rows are enriched for positives at T=7 (13–14% vs 4%).
  - Opus probe (35 of the 40 allowed requests): re-asking 19 gap rows with contiguous numbering changes p14 by a mean |Δ| of 0.013 (Spearman 0.985). Base re-run stability on 14 rows: |Δ| 0.006, Spearman 0.997.
  - So the gap has no measurable effect. Still, renumber after screening (bench_inputs.py, the enumerate is taken before the screen `continue`).
- FIX-4 (tests): lane tests alone kill 6/16 mutants.
  - Not covered: lag1/consult variants, day < T inside the builder (only its internal assert catches it), Brier no-skill, Wilson z, crossfit in-fold map, fold seed.
  - M8 (nested Platt map fitted on test-fold scores) survives every test. Add a test that detects it.
- Defaults / flag-off: a stub-text rebuild with R1 code and with lane HEAD 2d8a0c0 is byte-identical for base, lag1 and consult. VARIANT=screen output is a subset of base (619 ⊂ 904 calls). Output naming for the default and lag1 runs is unchanged.

## Mutants (work/mutants.py, run in a 0700 tmp copy with transcript text stubbed; all reverted, tmp removed, the committed .pyc restored)
- Killed (13): M1 slope on p, M2 CITL sign, M3 no-skill Brier, M4 Wilson z, M5 bootstrap without replacement, M6 crossfit in-fold, M7 fold seed, M9 day <= T, M10 numpy `is True`, M11 unverified unscreened, M13 tags keep=first, M14 lag1 cut, M15 consult keeps calls.
- Survived (3): M8 nested map on the test fold (a real test gap); M12 post_event `>` and M16 post_event filter off (equivalent on this data: every at-risk call before T already precedes the event).
- **Top issue:** "T=7 forest level with the LLMs" (BUILDER-CLAIM 3, LEAK-AUDIT verdict) is false for h90. Opus is ahead with a CI excluding 0, on the original covered rows and with lag1.
