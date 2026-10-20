# FT8 leakage refute (Opus 5.5, cb-ft-refute-ft8, the lab box, 20 Oct 2026). Verdict: PASS-WITH-FIXES
Target: features_ft8.parquet 95df8ba1bfd9, audit 4284a6643bdd. Inputs: pull-a e806a0cdc485, pull-b fd26e29ec835, labels 0aefc00f425b (D filter only).
Method: I rebuilt the features from the raw pulls (work/rebuild.py) and froze my numbers (work/refuter_cov.FROZEN-before-lane-code.json) BEFORE I read code/. Refuter outputs are in work/ (0600).

## (4) Recompute: reproduces
- Coverage matches every claim: prior Rx 456 (507 - 51 quarantined), ICD 512, HbA1c 273, Hb 292, creat 244, eGFR 206, TSH 248, BP 29.
- Values: compared 28 features on all 1,233 rows. All are equal except ft8_n_icd_codes on 1 row (14 vs 13; code-string normalisation, cosmetic). The 30 random rows (seed 20261020) are all equal. DM 55, HTN 39, CKD 10, CAD 11, obesity 72 match.

## (1) Leakage, per block
- Labs (pull B): cut by RESULT date at the IST day level (`rd < d`, pull-b.sql). Order dates are never read. rx_date equals the consult IST date on 1,233/1,233 rows. 0 records are dated at/after rx_date (min age 1 d).
- **FIX-1 (top issue).** 66 lab rows in 24 episodes have result_date = 1970-01-01, a null-date sentinel (age about 20,000 d). 65 of them are used as features (hba1c 12, hb 13, creat 14, egfr 15, tsh 11). Their true date is unknown, so they cannot be proven pre-Rx. They pass `<` only because 1970 is earlier than any Rx.
  - Directional: h14 6/24 and h90 6/17 converted here, vs h14 37/293 (12.6%) among all episodes with labs.
  - Fix: set to NaN and add a sentinel guard to assert_cutoff. Coverage after the fix: HbA1c 261, Hb 279, creat 230, eGFR 191, TSH 237.
- BP: the builder keeps only bp_age_d >= 1 (24 h or more before the Rx timestamp). This is stricter than a day cut, so it does not leak.
- Utilisation, ICD, IP, comorbidity and meds (pull A): every cut is a strict `< c.t` (the Rx timestamp). These are aggregates with no per-record date, so audit src_max_date_{util,icd,ip,meds} is all NaT. As a result, assert_cutoff passes VACUOUSLY on these 4 blocks (FIX-3). There is no future-dated record: every predicate is strict-before.
- Index surgery: no OT, booking, admission or bill column or table is in either SQL or in either pull. ip_events is cut on created_at < Rx (23 episodes; h14 4/16), so no post-Rx admission can enter.
- Availability caveat (not fixable from the pull): labs and conditions are cut on result date and clinical_status ts, not on created_at. A pre-Rx-dated report that was uploaded after the Rx would pass. Converters have LESS history in every block (e.g. HbA1c 14.8% vs 24.1%), so there is no sign of a post-Rx upload effect.

## (2) Timestamp vs day cut: recommend the DAY cut (FIX-2). Not an outcome leak on the evidence.
- Can same-day pre-Rx records carry the decision? In principle yes: an earlier same-day Rx or a consult note by the same doctor, or conditions entered during the index consult. The data shows no conversion signal in the groups exposed to this:
  - Quarantined (first prior Rx < 24 h; 51 episodes, 47 with 1 doctor): h14 5/43 (11.6%), h90 5/25. Overall: 17.2% / 22.8%.
  - Same-day BP (age 0; 588): h14 19.1%.
  - cond_icd with no prior Rx (49): h14 16.3%. 34/49 contain the index Rx's own dx code, so this is index-visit diagnosis recorded as "history". It duplicates the base ICDs, which are already at Rx time.
- Size: pull A cannot be re-cut from aggregates, and only flagged Rx exist on the lab box. Day-level proxy (cond/IP/comorb kept only where a prior Rx is 1 day or more old): ICD 512 -> 429 (lower bound), IP 23 -> 14, comorb 24 -> 20. Unseeable part: same-day prior Rx inside the 456 non-quarantined histories (it affects counts, doctors, ICDs, and meds of the "latest" Rx). BP could RISE under a day re-pull: the latest BP before midnight would surface older vitals for the 588.
- Recommendation: gating-lead re-pulls A with `< c.d` (IST midnight) for every predicate, including the vitals and the cond, comorb and ip timestamps, then runs `ft8_build.py --pull-cut day`. That makes the strict-xfail flip. It matches pull B and brief rule 1.
- If the re-pull misses the 12:00 freeze, the timestamp version is acceptable with the quarantine, plus a footnote. FT3 n_prior_rx is identical to pull A n_prior_rx_all on 1,233/1,233 rows and shares the property.

## (3) H sealed: PASS
- split_guard PINNED_LIST_SHA256 = 52959278edd8...1d65 (exact).
- All 1,233 target cluster_keys are D under set_of, and require_dev raises nothing.
- Episode set == labels D, unique, 1,233.
- Builder: n_h_read 0, guard-H dropped 0. Refuter disclosure: one exploratory read of labels.parquet loaded all rows to print split counts (D 1,233 / H 389). No H row content was used or printed. Every later read used the D filter.

## (5) Tests
- Builder: `16 passed, 1 xfailed in 4.69s`. The xfail is test_pull_a_is_day_level (strict, so it turns red once pull A is day-level). This is correct.
- FIX-4: the documented command `code/run_tests.py` fails. Its `pytest_shim` dir does not exist (ModuleNotFoundError). I ran the tests via ~/.local site-packages.
- Gaps in the builder's cutoff test:
  - The mutants only alter the audit columns, and the audit is derived from age_d (rx_date - age), so the test is near-tautological. It cannot fail on pull-A blocks or catch the 1970 sentinel.
- Refuter tests (work/test_refute_ft8.py): `3 failed, 9 passed`.
  - The independent checker FAILS on mutant records at rx_date, rx_date+1, rx_date+30, a same-day 09:00 timestamp, a 1970 sentinel, and an undated used block. It passes at rx_date-1 23:59.
  - On the target: dated records at/after the cutoff = 0 (pass).
  - FAIL undatable labs (hba1c 12; total 65): FIX-1. FAIL used blocks without a source date (util, icd, ip, meds): FIX-2/3. D-only + keys pass. Target == refuter rebuild passes.

## Fixes (apply before the 12:00 freeze)
1. NaN the 1970-01-01 lab values and guard the sentinel in assert_cutoff and in a test. MANDATORY.
2. Day-level re-pull of A and `--pull-cut day`, or a footnote if it misses the freeze.
3. assert_cutoff must fail when a used block has no date unless agg_blocks_cut_level == 'day' (or pull A emits a per-block max record date).
4. Ship the pytest shim, or fix run_tests.py.
5. Cosmetic: ICD code normalisation (1 row).

## v3 delta (day level; Opus 5.5, 20 Oct): PASS
Target features_ft8.parquet d674e54010cc, audit 695e5384ba2a, from ft8-pull-a-day.tsv 7b39ab45f35b (SQL ece4d693c36d) + pull-b fd26e29ec835. Own rebuild first: work/rebuild_day.py, work/refuter_cov_day.json.
- (1) Day cut. Every predicate in the day SQL is `< c.m` (IST midnight of the Rx day). The cut date == rx_date on 1,233/1,233.
  - Source max timestamps on or after the cut, or on an IST date >= rx_date: 0 for prior Rx (469), cond (438), comorb (20), IP (23), BP (150). None before 2000. Every used block has a timestamp (0 missing).
  - Audit src_max_date_* for all 11 blocks: 0 >= rx_date, 0 pre-2000.
  - My day rebuild == v3 on all 1,233 rows x 28 features. The one exception is ft8_n_icd_codes on 1 row (same junk token as v1; cosmetic).
- (2) Fixes. FIX-1 holds: 66 sentinel rows (24 episodes) are NaN, and no sentinel lab is used. FIX-3 holds: the builder's assert_cutoff passes on clean v3 and RAISES on all 28 of my mutants (7 blocks x {Rx day, Rx day+1, 1970, missing}) applied to the real audit. FIX-4 holds: the documented run_tests.py works (24 passed). The old strict-xfail is replaced by a passing day-level SQL test.
- Tests now: builder `24 passed in 1.58s`; refuter `41 passed in 1.65s`. The 3 v1 failures (sentinel, undated audit, undated aggregates) all pass on v3.
- (3) Coverage matches the claim exactly:
  - prior Rx 469 (456 + 51 ex-quarantine, minus those with only same-day priors), meds>0 223, ICD 454 (prior-Rx ICD 431 U cond 438; specific codes), IP 23, comorb 20, BP 148.
  - Labs post-sentinel: HbA1c 261, Hb 279, creat 230, eGFR 191, TSH 237.
- BP 29 -> 148: the timestamp pull returned only the LATEST BP before the Rx timestamp. For 588 episodes that was same-day triage, which was dropped, and it hid any older reading. The day pull returns the latest BP before midnight:
  - 148 = the 29 already used + 119 same-day episodes that also have an earlier-day BP (150 rows, 2 implausible). 0 of the 29 are lost. 469 of the 588 have no earlier BP. Median age 7 d.
  - No label skew: h14 has_bp 11.1% conv vs 10.9% non-conv.
- Note: the pull's bp_age_d is floor((midnight - ts) in days), which is calendar age - 1 on all 150 rows (23 show 0). The builder correctly uses calendar age (min 1). Do not use the raw pull column.
- (4) H: 0 rows. All 1,233 cluster_keys are D (pin 52959278edd8...1d65), require_dev passes, and the set == labels D.
- Residual caveat (unchanged, not a blocker): labs and conditions are cut on result date / clinical-status time, not upload time. There is no sign of a post-Rx upload effect.
