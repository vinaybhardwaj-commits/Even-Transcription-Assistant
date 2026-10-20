# FT8 build DONE (cb-ft8-build, Sonnet 5.5, 20 Oct 2026, the lab box, D split only)

Tests: `20 passed, 1 xfailed in 1.23s` (run: `~/.venv-forest/bin/python -I code/run_tests.py`; pytest comes from a shim of ~/.local site-packages, as .venv-forest has none). The xfail is `test_pull_a_is_day_level`, a documented known gap (below), strict-xfail so it turns red when fixed.

## Files (sha256, first 12)
Outputs (0600): features_ft8.parquet b5aba7a5fb8c (v2; v1 was 95df8ba1bfd9) (1,233 rows, episode_id + ft8_* ; no pin_code), features_ft8_audit.parquet 8c5e1c6374e8, COVERAGE.md 1f66a6a2a449, build_stats.json, code/ (ft8_build.py, icd_map.py, coverage_report.py, run_tests.py, tests/).
Inputs (read-only): labels.parquet 0aefc00f425b (D rows only) ; ft8-pull-a.tsv e806a0cdc485 ; ft8-pull-b.tsv fd26e29ec835 ; ft8-pull-a.sql 7677478506a0 ; ft8-pull-b.sql 97fd300a24be ; split_guard.py 2d39ef2884ee (lock RD0-2026-10-18-52959278edd8).

## Rows dropped / counts
H rows read 0 (parquet filter split=='D'); guard-H dropped 0; join failures 0 (1,233/1,233 prescription_uid matched).
BP: 618 episodes had a BP; 588 dropped (bp_age_d = 0, same-day vitals); 1 implausible/unparsable -> NaN; 29 kept.
Labs: 0 rows with age_d < 1 in pull B; 66 rows (24 episodes) have a 1970-01-01 sentinel result date and are set to NaN (65 would have been used; refute FIX 1). Unit unknown -> NaN: hb 2, egfr 2 (unit missing), tsh 9 (mmol/L, nmol/L). Implausible -> NaN: creat 1 (>20 mg/dL; the other was a sentinel row). Counts in build_stats.json.
Quarantined: 51 episodes whose first prior Rx was < 24 h before the anchor (days_since_first_rx = 0); treated as "no prior Rx record" for Rx-derived blocks (see gap 1).

## Leakage rule as implemented (file:line)
- Day-level strict rule: code/ft8_build.py:21 MIN_AGE_D = 1 ; BP age filter :178 ; labs select_labs :117 ; cutoff check assert_cutoff :223 (run in main before writing) ; D-only load :52 (filters split=='D') + guard check in load_cohort :49.
- Pull B (labs), result date, strict: ft8-pull-b.sql:1248 (rd = coalesce(x.result_date, pv.result_date)), :1251 `rd < d` (d = IST date of the anchor, :1236). Order dates are never read. Min age in the data = 1 d.
- Pull A: all blocks cut at the anchor TIMESTAMP, strict "<", ft8-pull-a.sql:1240-1250 (`q."timestamp"<c.t`; cond_icd :1245 clinical_status ts < c.t; comorb :1246 and ip_events :1247 created_at < c.t; vitals :1248-1249 measurements__timestamp < c.t; meds :1250 latest prior Rx). Not day-level.
- Static SQL test: tests/test_ft8.py test_sql_predicates_strict (fails on "<="). Mutant tests: test_cutoff_mutant_fails_on_rx_day_and_next_day, test_cutoff_mutant_disabled_filter_is_caught.

## Known gaps (forest-lead decision)
1. Pull A is timestamp-level, not day-level (rule 1 says Rx-day records are excluded). Effects: vitals 588/618 are same-day and dropped (BP coverage 29/1,233, 2.4%); Rx-derived aggregates (n_prior_rx_*, doctors, prior_rx_icd, meds) may include same-day prior Rx that cannot be seen in aggregates. Only the "< 24 h" case is quarantined (51). Fix: gating-lead re-pull A with `< anchor IST date` (midnight) and vitals `measurements__timestamp < c.d`; then run `ft8_build.py --pull-cut day`. The base feature n_prior_rx in features_D equals pull A's n_prior_rx_all exactly (same timestamp-level cut), so FT3 has the same property. Audit src_max_date_{util,icd,ip,meds} are NaT: aggregates carry no per-record date.
2. ip_events and comorbidities are cut on created_at (ingest time), tables start 20 Mar / 28 May 2026.
3. Charlson here is the Quan ICD-10 category set (unweighted count ft8_charlson_n, original-weight score ft8_charlson_score), from prior_rx_icd U cond_icd; chapter ranges like "A30-A49" carry no diagnosis and are ignored; R73.x is not diabetes.

## Not built (inventory/addendum)
ER visits (no source), prior surgeries at Even (0 pre-Rx), BMI (<1%), distance (no pincode-centroid table on the lab box, no hospital pincode documented in a repo file; searched; skipped; pin_code is in no output). OPD visits are the prior-Rx count (ft8_n_prior_rx_12m); chronic vs acute meds not split (ft8_n_meds_latest_prior_rx). H split never touched; no model/AUC run.

## v2 changes (refute ft-refute-ft8 PASS-WITH-FIXES, fixes 1, 3, 4, 5; fix 2 still waits for the day-level re-pull)
- FIX 1 sentinel dates: ft8_build.py:22 SENTINEL_DATE (2000-01-01), :119 undatable(), :126 select_labs (null or <= 2000-01-01 implied result date -> dropped, counted), :194 same guard for BP. Only the 5 lab blocks changed vs v1. Coverage after the NaN (of 1,233): HbA1c 261, Hb 279, creat 230, eGFR 191, TSH 237 (BP 29 and ICD 512 unchanged); see COVERAGE.md (also by Rx month and by converted / not). Tests: test_sentinel_lab_and_bp_become_nan, test_sentinel_guard_fails_if_sentinel_survives (guard off -> assert_cutoff fails), test_no_sentinel_survives_real_data.
- FIX 3 assert_cutoff (:250): now reads used_<block> flags; a used block with NO source date FAILS, as does a date at/after the cutoff or <= 2000-01-01. The 4 pull-A aggregates (util, icd, ip, meds) carry no per-record date in the pull, so they can only pass when agg_blocks_cut_level == 'day'. On the current timestamp-level pull the strict check FAILS on exactly those blocks (util 456, icd 512, ip 23, meds 456 episodes); main() records this as cutoff_check in build_stats.json and prints WARN, and the file is still written. This is the known gap 1, not new. With `--pull-cut day` a failure aborts. Underlying per-record dates of an aggregate cannot be checked from the pull; the day-level SQL (static test) plus the day re-pull is what closes it. New mutants alter the SOURCE records (pull B age_d and pull A bp_age_d at 0 and -1, builder filters off), not the audit columns: test_cutoff_mutant_source_records_at_and_after_rx_day, test_cutoff_aggregate_without_date_fails_unless_day, test_cutoff_real_data_aggregates_known_gap.
- FIX 4: code/pytest_shim/ shipped (symlinks to ~/.local site-packages); run_tests.py looks in code/pytest_shim, ../pytest_shim, then ~/.local. Verified by running ~/.venv-forest/bin/python -I code/run_tests.py from /.
- FIX 5 ICD normalisation: the 1-row difference (14 vs 13) is one non-ICD token (an id-like string) in an ICD field; the builder drops it (icd_map.norm requires a letter, digit, alnum pattern), the refuter's rebuild counted it. Builder value 13 is intended; no change.
- Not done: FIX 2 (day-level re-pull of pull A; waits for the newcat-orch ruling). The timestamp build is the current features_ft8.parquet; the quarantine of 51 stays.
