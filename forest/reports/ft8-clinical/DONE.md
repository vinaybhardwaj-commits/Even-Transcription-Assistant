# FT8 build DONE v3 (cb-ft8-build, Sonnet 5.5, 20 Oct 2026, the lab box, D split only): DAY-LEVEL primary

Tests: `24 passed in 1.80s` (run from anywhere: `~/.venv-forest/bin/python -I code/run_tests.py`; pytest via code/pytest_shim). The strict-xfail is gone: test_pull_a_day_sql_is_day_level passes.
Command: `~/.venv-forest/bin/python -I code/ft8_build.py --pull-cut day` (build_stats.json: cutoff_check = pass).

## Files (sha256, first 12)
Outputs (0600), PRIMARY: features_ft8.parquet d674e54010cc (1,233 rows x 43 cols), features_ft8_audit.parquet 695e5384ba2a, COVERAGE.md dff9021318d7, build_stats.json, code/.
For the record only (NOT a model input), the v2 timestamp build: features_ft8_ts.parquet b5aba7a5fb8c, features_ft8_ts_audit.parquet 8c5e1c6374e8, DONE-ts.md, COVERAGE-ts.md, build_stats_ts.json. (v1 was 95df8ba1bfd9.)
Inputs (read-only): labels.parquet 0aefc00f425b (D rows only); ft8-pull-a-day.tsv 7b39ab45f35b; ft8-pull-b.tsv fd26e29ec835; ft8-pull-a-day.sql ece4d693c36d; ft8-pull-b.sql 97fd300a24be; ft8-pull-a.tsv e806a0cdc485 and its SQL 7677478506a0 (ts build only); split_guard.py 2d39ef2884ee (lock RD0-2026-10-18-52959278edd8).

## Rows dropped / counts
H rows read 0; guard-H dropped 0; join failures 0 (1,233/1,233).
Quarantine of the 51 "first prior Rx < 24 h" episodes: GONE (n_quarantine_lt24h = 0): the day pull has no same-day Rx.
Source timestamps at or after the cut midnight: 0 (all 5 src_max_ts_* columns; also asserted against the pull's cut_ist_midnight, and cut date == rx_date on 1,233/1,233).
BP: 150 episodes have a BP before the Rx day; 2 implausible/unparsable -> NaN; 148 used (was 29 under the timestamp cut). BP age = calendar days (anchor date - IST date of the record) >= 1.
Labs (pull B, unchanged): 66 sentinel rows (1970-01-01, 24 episodes) -> NaN; unit unknown -> NaN: hb 2, egfr 2, tsh 9; implausible -> NaN: creat 1.

## Coverage (non-missing of 1,233; full tables, h14/h90 by converted, and by Rx month in COVERAGE.md)
prior Rx 469 (was 456), meds>0 223, ICD (prior_rx_icd U cond_icd, specific codes) 454 (gating-lead's 431 is prior-Rx ICD only; 438 have cond ICD), IP events 23, named comorbidities 20, BP 148, HbA1c 261, Hb 279, creat 230, eGFR 191, TSH 237.

## Leakage rule as implemented (file:line)
- ft8_build.py:23 MIN_AGE_D = 1 (day level: a used record is >= 1 day before rx_date); :24 SENTINEL_DATE; :60 D-only parquet filter + guard in load_cohort; :125 ist_date(); :131 undatable(); :138 select_labs (labs: result-date age >= 1 and datable); :203 dated pull -> BP age from src_max_ts_bp; :212 BP guard; :278 assert_cutoff (run before writing; aborts a day build on failure); :316 day_level_violations.
- Pull A day SQL (ft8-pull-a-day.sql:1237 c.m = IST midnight of the anchor date; every predicate `< c.m`, lines 1240-1256: prior Rx, cond clinical_status ts, comorb and ip_events created_at, vitals measurements timestamp, latest-Rx meds), with per-block max source timestamps src_max_ts_* at :1252-1256 that the builder copies into audit.src_max_date_{util,meds,icd,ip,comorb,bp}.
- Pull B labs: ft8-pull-b.sql:1248 result date, :1251 `rd < d` (IST date of the anchor).
- assert_cutoff: every USED block needs a real source date, strictly before rx_date and after 2000-01-01; an undated aggregate is tolerated only for a day-level pull that has NO src dates (not this pull). Tests: test_cutoff_real_data_aggregates_day_pull, test_dated_aggregate_mutants (source timestamp on the Rx day / the day after / 1970 / missing, per block), test_cutoff_mutant_source_records_at_and_after_rx_day, sentinel tests, test_day_pull_source_ts_before_cut_midnight, static SQL tests (strict `<`, c.m not c.t, fail on `<=`), test_cutoff_real_data_ts_pull_known_gap (the ts pull fails the strict check, as designed).

## Remaining caveats
1. Availability: labs and conditions are cut on result date / clinical_status ts, not on upload time (the refute's caveat; no sign of a post-Rx-upload effect: converters have less history in every block). ip_events and comorbidities are cut on created_at (ingest time); tables start 20 Mar / 28 May 2026.
2. cond_icd can hold the index visit's own diagnosis if entered the day BEFORE; now excluded for the Rx day itself by the day cut.
3. Charlson = Quan ICD-10 categories (ft8_charlson_n unweighted, ft8_charlson_score original weights); chapter ranges like "A30-A49" ignored; R73.x is not diabetes; the 1-row ICD count difference vs the refuter is a non-ICD junk token the builder drops.
4. Coverage drifts up over the window (BP and comorbidities start in 2026): see by-month table.

## Not built
ER visits (no source), prior surgeries at Even (0 pre-Rx), BMI (<1%), distance (no pincode-centroid table on the lab box and no documented hospital pincode; pin_code is in no output). OPD visits = prior-Rx count; chronic vs acute meds not split (ft8_n_meds_latest_prior_rx). H split never touched; no model/AUC run.
