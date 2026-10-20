# ft-bench DONE (IN PROGRESS; 04:38 IST 20 Oct 2026). Served by Claude Opus 5.5 on Bedrock.
No benchmark AUC/Brier has been computed at the time of writing this section. The pre-registered prompts and rules follow (identical to PREREG.md, written 04:34 IST).

D split only; H is never read. Episodes, labels (h14, h90, Ale), landmarks (T=3, 7), clusters and folds are exactly the ft-calltext FTR v2 ones (model_final2_*.json OOF arrays).

## Inputs (code/bench_inputs.py)
- Consult: the episode's recorded anchor consult (ft-cohortb-expand inventory, duplicates dropped), native Sarvam STT text (raw transcript; NOT the Saaras English, fable FT6 ruling), roles from role.llm-roles/caa-labels when present else 'Speaker N'. Kept only if the consult day < T (asserted).
- Calls: Runo calls with Sarvam STT (ft-rl-stt, 933 D calls): day_from_rx < T; call date < event date; Haiku-tagged (untagged calls dropped, they cannot be screened); outcome_revealed verified OR unverified dropped. Speakers = diarisation ids, not the guessed roles.
- Episodes with no usable text get no request; they score as a constant (tie) in the full-set AUC.

## Benchmarks
- (a) Stated intent alone: the LAST stated intent before T over the Runo-summary tags (ft-calltext tags_D) and the Runo-STT tags (rl-feat tags.jsonl), ordered by call time, same before-T / outcome-revealed / untagged exclusions. Coded declines=0, undecided=1, wants_surgery=2, none stated=-1. Consult fallback when no call intent: Jev f10 (will go ahead) >= 0.5 -> wants; else f11 or f12 >= 0.5 -> undecided. Scored as a one-feature RF (FT3 learner settings, 400 trees, leaf 5) on the FTR folds (5x5, seeds RS+rep), repeat-averaged OOF. Raw ordinal AUC is also shown.
- (b) Jev (jev-latest, typesafe systemone, 'noul' P(yes)) on the raw transcript, two questions: p14, p90. h14 and Ale are scored with p14; h90 with p90.
- (c) Claude Opus 5.5 (Bedrock global.anthropic.claude-opus-5-5, default effort, no temperature control on this model) with the same text; returns p14, p90, booked. Same label mapping. One request per (episode, T), not repeated.
- Scoring: as given (no training). AUC with the same 1,000-draw cluster bootstrap (RD-0 cluster_key, seed 20261019) as FTR; paired delta (forest minus benchmark) on identical episodes. Two populations per design: ALL at-risk episodes (benchmark = constant where no text/intent) and the COVERED subset (episodes with text, resp. a stated intent). Forest = FTR v2 text_audio and base until the frozen FULL model OOF exists, then FULL.
- Sensitivity (reported, not tested): (c) excluding requests where Opus says booked=true (residual outcome leak screen).
- Brier and calibration of (b)/(c) raw probabilities via the ft-bench calibration harness, COVERED subset.

## Prompts (sha256[:12] = 865e5843df5e)
```json
{
 "context": "Even Hospitals, Bangalore, India. On day 0 a doctor at Even advised this patient to have a surgery or procedure. Below is everything recorded about this patient up to day {T} after the advice: the consultation recording (if there is one) and phone calls from the hospital's patient-counselling team. The transcripts are automatic speech recognition in the original language(s) and may contain errors; speaker labels come from automatic diarisation. As of day {T}, the surgery or procedure has not been done.",
 "jev": {
  "p14": "Will this patient have the advised surgery or procedure at Even Hospitals within 14 days of the doctor's advice (that is, between day {T} and day 14)?",
  "p90": "Will this patient have the advised surgery or procedure at Even Hospitals within 90 days of the doctor's advice?"
 },
 "opus_system": "You are assessing patients of Even Hospitals (Bangalore, India) after a doctor advised surgery. You will read raw speech-recognition transcripts and estimate calibrated probabilities. Return ONLY JSON.",
 "opus_user": "Even Hospitals, Bangalore, India. On day 0 a doctor at Even advised this patient to have a surgery or procedure. Below is everything recorded about this patient up to day {T} after the advice: the consultation recording (if there is one) and phone calls from the hospital's patient-counselling team. The transcripts are automatic speech recognition in the original language(s) and may contain errors; speaker labels come from automatic diarisation. As of day {T}, the surgery or procedure has not been done.\n\n{TEXT}\n\n=== Question ===\n1. p14: probability that this patient has the advised surgery or procedure AT EVEN HOSPITALS within 14 days of the doctor's advice (between day {T} and day 14).\n2. p90: probability that this patient has it AT EVEN HOSPITALS within 90 days of the advice.\n3. booked: true if the text shows the surgery is already booked with a date or OT slot, or the patient is being admitted for it; else false.\nReturn ONLY JSON: {{\"p14\": <0-1>, \"p90\": <0-1>, \"booked\": <true|false>}}"
}
```

## Addendum to the pre-registration (04:39 IST, still before any benchmark AUC/Brier is computed)
- ALL-population AUC for (b)/(c): episodes without a score (no usable text, or a Jev failure) get the MEDIAN of that design's covered scores (rank-neutral constant). The COVERED-subset comparison is the clean one and is reported next to it.
- Jev failures: 2 of 551 requests return http 400 (the two longest inputs, 49k and 63k chars). They are not truncated or retried; they count as missing.
- Consult fallback for (a) uses Jev v2 f10/f11/f12 from the existing answers (p2v2 jev.jsonl, ft-audio/cohortb gap-fills, rf775_members.jsonl). These were computed on the Saaras English (FT6 caveat: fable ruled Saaras English is not a feature input; it is used here only inside the stated-intent benchmark, flagged).
- Existing p2v2 Jev 'bench_b' (P(surgery at this hospital within 90 d), consult only, Saaras English, run 15 Oct) is reported as an extra consult benchmark (b-p2v2), not a pre-registered one.

## Addendum 2 (04:51 IST, before any design-C score): design C (recorded-consult cohort, prediction at the consult)
- Input = consult-only native STT (code/bench_inputs_c.py; 201 consults from ft-audio features_ale + cohortb-expand features_all, 196 with text). (b)/(c) use the SAME prompts with T=0 ("up to day 0 ... as of day 0 not done"). Ale and h14 scored with p14.
- (a) consult stated intent = Jev f10 >= 0.5 -> wants (2); else f11 or f12 >= 0.5 -> undecided (1); else none (-1). Plus the raw f10 P(yes) as a continuous variant.
- Rows, labels, patient groups: forest-lead's design-C table when delivered; until then ft-audio features_ale (Ale) and features_ale eligible_h14 (h14 >= 18 d), one row per patient as in ft-audio, groups = cluster_key (else consult_uid), 1,000 patient bootstraps.

## Addendum 3 (04:55 IST): declared AFTER the first design-B tables were seen (so these are post-hoc, labelled as such)
- (a) one-feature RF is INVALID as a benchmark: on shuffled labels it gives OOF AUC 0.32-0.46 (mean 0.40, 4 shuffles, h14 T=3). With a 4-level feature, in-fold level rates anti-correlate with the held-out fold (the known small-cell target-encoding bias). The raw ordinal code (no training) becomes the (a) benchmark for the Holm family; the RF rows are kept, marked invalid.
- Leakage audit of (c), code/bench_audit.py: Opus flags evidence categories (no text out) on a fixed selection: all covered positives, the top 30% of Opus p14 per T, and a seeded 60 per T of the rest. Sensitivity: (c) AUC on the covered subset after removing episodes flagged date_or_slot_fixed, admission_or_preop or preauth_or_insurance_filed (outcome-proxy rule, as f07). Also reported: calls-only vs consult-containing split.

## Addendum 4 (05:10 IST): LEAK-AUDIT reruns ordered by newcat-orch (05:15) and forest-lead
- Same prompts (sha 865e5843df5e), same engines. VARIANT=lag1: calls on day >= T-1 removed (consult kept). VARIANT=consult: consult text only. Outputs scores_{lag1,consult}_{jev,opus}.jsonl. The prompt still says "up to day T"; the text simply stops earlier. Opus token cap raised from 5M to 10M for these reruns.
- 05:26 IST: the Opus category audit is extended to EVERY covered design-B row (AUDIT_ALL=1), so the proxy-removed sensitivity is on the full covered set, not the enriched selection.

## Addendum 5 (05:41 IST): layer-8 strict-screened score (forest-lead spec v3.2)
- VARIANT=screen: STRICT lexical screen. Any call whose transcript matches the leak_audit regex for preauth/admission/ot_preop/payment is dropped whole (T3: 118 calls, T7: 167); matching consult turns are dropped. Opus 5.5 only, same prompts (sha 865e5843df5e), designs B and C. Files: scores_screen_opus.jsonl, scores_c_screen_opus.jsonl; per-episode table bench_layer8.parquet (episode_id, T) and bench_layer8_c.parquet (consult_uid).
- 05:42: own Opus token guard raised from 10M to 16M (ledger count) for the screened runs.

## RESULTS (06:04 IST the lab box clock; REVISED 07:15 after the refutes). Refutes: ft-refute-bench (wBA) PASS-WITH-FIXES and ft-refute-bench2 (wBB) PASS-WITH-FIXES. Fixes 1-4 and 7-10 are applied (Addendum 6). Fixes 5-6 (tests) are owned by lane ft-bench-tests. Re-check pending (forest-lead / ft-refute-bench2).
### Benchmarks, design B (BENCH-TABLES.md; same FTR v2 episodes, labels, clusters, folds; 1,000 cluster bootstraps)
- ALL at-risk episodes (no-text rows tied): the forest (FTR v2 text_audio) is ahead or level.
  - (a) raw stated intent: 0.52-0.61
  - (b) Jev: 0.55-0.60
  - (c) Opus: 0.59-0.62
  - forest: 0.62-0.67
  - Holm over the 18 deltas (forest minus benchmark; rerun after fixes 7/10, with 1 intent code changed): two survive at Holm p < 0.05. They are forest > (a) at h90 T3 (+0.098) and forest > Jev at h90 T7 (+0.126). No Opus delta survives. Table at the end of BENCH-TABLES.md.
- COVERED episodes (22-30% with transcribed calls or a consult), T=3, ORIGINAL text: Opus beats the forest. PROXY CAVEAT: this lead is mostly pre-auth/insurance/payment process talk, an outcome proxy by the f07 rule (see LEAK-AUDIT.md).
  - Opus 0.794 / 0.814 / 0.838 vs forest 0.652 / 0.671 / 0.564 (ale / h14 / h90). On this original text the Δ CIs exclude 0. Jev sits between them (0.75-0.79).
  - On screen-v2 text (process talk removed; layer-8 PRIMARY): 0.693 / 0.699 / 0.737 vs 0.658 / 0.691 / 0.566. Every CI spans 0, so ale/h14 are about level with the forest. h90 keeps a point lead (Δ -0.17), but its CI spans 0.
  - Residual (refute R2 note E): broad date words (weekday/tomorrow/date) survive screen 2. For h90 they appear in 58% of positives vs 21% of negatives at T3, and 64-67% vs 41-42% at T7. This is a possible residual scheduling signal, not a blocker. Book/slot/schedule words are balanced or reversed for ale/h14.
- COVERED, T=7: ale/h14 level (0.80 vs 0.78-0.80). h90: Opus ahead on the original text (forest - Opus -0.199 [-0.376, -0.029]); this is not significant on screen-v2 text (-0.185 [-0.419, +0.056]). The forest's covered h90 AUC is low (0.56-0.62).
- LEAK-AUDIT.md v2: no temporal leak. Both refuters rebuilt the inputs with 0 diff.
  - The original-text lead survives removing calls on day >= T-1 and dropping the ts_is_call_day=0 rows.
  - It sits in the CALLS; consult-only is near chance.
  - Screen v1 (pre-auth/admission/OT/payment calls removed) gives 0.755 / 0.760 / 0.801. Screen v2 (+ insurance/TPA/policy/mediclaim) gives 0.693 / 0.699 / 0.737.
- (a) one-feature RF: INVALID (null OOF AUC ~0.40). The raw ordinal score is used.
### Design C (BENCH-TABLES-C.md; forest-lead designC_cohort, ale_strict 138/23)
- Opus 0.692 [0.583, 0.797], Jev (native STT) 0.689, existing p2v2 Jev bench_b 0.670, raw f10 0.675.
- h14_ge18 (114/12): Opus 0.697, Jev 0.638.
- Forest comparison: pass FOREST_C once the FULL design-C OOF exists.
### Calibration + permutation harness (code/calib.py; selftest + 7/7 invariant tests in code/test_bench.py)
- Input: the FTR-format 'oof' JSON (or a parquet). Folds are regenerated exactly from y, cluster and seed RS+rep.
- Output:
  - Brier, no-skill Brier and Brier skill
  - reliability table (10 quantile bins with n and Wilson CIs)
  - calibration slope, intercept and CITL
  - ECE (bootstrap ECE is biased upward)
  - cluster-bootstrap CIs
  - raw RF and two sigmoid versions: nested in-fold sigmoid (spec version; needs fit_predict) and cross-fitted on OOF (fast approximation)
- Permutation ranking: grouped by layer or engine, refit per fold, AUC drop over 10 permutations x folds, 2.5-97.5 percentiles.
- Demo on the FTR v2 stand-in:
  - CALIB-FTR-v2.md: raw RF slopes 0.56-0.92, CITL about 0, Brier skill about 0.01-0.04.
  - PERM-FTR-h14-lm7.md: the refit reproduces AUC 0.668 exactly; every group CI spans 0.
- Frozen model: code/run_frozen.sh '<glob>' with FOREST_MODELS=FULL:text_audio,L0:base. The run writes CALIB-frozen-HHMM.md and BENCH-TABLES-frozen-HHMM.md. It was smoke-tested on the FTR stand-in (point estimates identical; *-SMOKE-ftr-standin.* files).
- For permutation on the frozen model: calib.perm_rank(fit_predict, cols, DX, y, g, groups); calib.py perm-ftr shows the adapter.
### Layer 8 for the forest (spec v3.3: PRIMARY = opus_screen2)
- bench_layer8.parquet: (episode_id, T), 1952 rows. opus / opus_screen (v1, renumbered) / opus_screen2 (v2; spec v3.3 PRIMARY) / jev p14 and p90; has_text (551), has_text_screen (456), has_text_screen2 (407). The unscreened opus_* is a proxy-inflated sensitivity.
- bench_layer8_c.parquet: consult_uid, 198 rows; has_text 193, screen2 189.
### Spend
- Opus 5.5: 18.55M input / 0.63M output tokens, summed from per-request usage (the ledger under-counts concurrent runs). That includes the fix-round reruns: screen v1 renumbered, screen v2 on B and C.
- Jev: $0. 4 Jev http 400s on the longest inputs.
### Files (the lab box ~/oc/forest-lead/ft/out/ft-bench/, 0600)
- PREREG.md, DONE.md, BENCH-TABLES.md, BENCH-TABLES-C.md, LEAK-AUDIT.md, LEAK-AUDIT-TABLES.md, CALIB-FTR-v2.md, PERM-FTR-h14-lm7.md
- bench_scores*.parquet, bench_results*.json, bench_layer8*.parquet, leak_audit_rows.parquet
- Code: ~/wt/ft-bench/code/ (git). Transcript inputs and raw LLM outputs: ~/eta-data/forest/bench/ (0700).

## Addendum 6 (06:55 IST; POST-HOC, refute fixes from ft-refute-bench and ft-refute-bench2)
- Fix 1/3: calls are numbered after the screen ("Phone call i" counts only the calls shown). The default, lag1 and consult inputs are unchanged (0 numbering gaps before; text lengths are identical to the scored inputs). Screen v1 is rescored; the old file is kept as scores_screen_opus.v0-gapnumbering.jsonl.
- Fix 2: VARIANT=screen2 = screen + an 'insurance' category (insurance/policy/TPA/mediclaim/health card/Ayushman, Latin and Devanagari/Kannada/Tamil/Telugu/Malayalam/Bengali). Pre-auth/cashless/claim were already in 'preauth'. Opus is rescored on designs B and C. Layer-8 PRIMARY (spec v3.3) = opus_screen2_p14/p90.
- Fix 7: a call counts as outcome-revealing if ANY of its tag records flags it, not only the last one. This changes 0 used calls; the default inputs are byte-for-byte the same length. The same rule now applies in intent_codes.
- Fix 8: call_date is authoritative (upstream ft-rl-run DONE.md ruling). A sensitivity drops the rows that use any of the ts_is_call_day=0 calls.
- Addenda 4 and 5 are POST-HOC: they were written after the first design-B tables were seen. Addendum 4 is stamped 05:10 and cites newcat-orch's order, which was timed 05:15 on the Mini clock; the the lab box clock reads earlier.
- 07:17: fixes 5+6 tests landed from lane ft-bench-tests (code/test_bench_ext.py): 56 passed, 0 failed; test_bench 7/7. The xfail for folding insurance into screen v1 was removed, because screen2 stays separate by design.
