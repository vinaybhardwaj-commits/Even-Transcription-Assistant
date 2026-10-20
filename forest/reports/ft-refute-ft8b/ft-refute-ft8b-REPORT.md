# FT8 v3 DAY-LEVEL leakage refute (Opus 5.5, cb-ft-refute-ft8b, the lab box, 20 Oct 2026)
Target features_ft8 d674e54010cc / audit 695e5384ba2a; pull-a-day 7b39ab45f35b, pull-b fd26e29ec835, SQL ece4d693c36d, labels 0aefc00f425b (D filter), split_guard 2d39ef2884ee: all shas verified.
VERDICT PASS-WITH-FIXES (the fixes are non-blocking hardening; none changes a current feature value; FT8 v3 is fit for the 11:00 freeze)
Order: I froze my rebuild (work/rebuild.py, work/refuter_stats.FROZEN-before-builder-code.json) BEFORE opening the builder code. All my outputs are in work/ (0600).

## (1) SQL: PASS
- Pull A day: c.m = IST midnight of the anchor date. There are 16 strict `<c.m` predicates, one per output: n_prior_rx_all, _12m, n_doctors_12m, days_since_first_rx, prior_rx_icd, cond_icd, comorb_names, n_ip_events_pre, bp_latest, bp_age_d, n_meds_latest_prior_rx, and src_max_ts_{prior_rx,cond,comorb,ip,bp}.
- Pull A day: no `c.t`, no `<=`; OT/booking/billing appear only in a comment. The builder's static checks catch my `<=` and `<c.t` SQL mutants.
- Pull B: `rd < d`. rd is the result date, a DATE (age_d is an integer), and d is the anchor's IST date.
- Real data: 0 src_max_ts at or after the cut (all carry +05:30). The cut's IST date == rx_date on 1233/1233.

## (2) Independent rebuild: mismatches out of 1233
- 0/1233 on 39 of 43 columns: every count, util, meds, BP and dm/htn/ckd/cad/obesity column, and all labs with their age_d and n_pre.
- Definitional diffs, none a leak (same inputs on both sides):
  - n_icd_codes 20: my regex dropped 7-character codes such as S93.4XXD; the builder is right. charlson_n and charlson_score 41 each: my Quan code list differs.
  - tsh and its 3 companion columns 1 each: one TSH of 180.7, which my cap of 150 drops and the builder's cap of 200 keeps.
- Coverage equals the claim: prior Rx 469, meds 223, ICD 454, BP 148, HbA1c 261, Hb 279, creat 230, eGFR 191, TSH 237.

## (3) v1 fixes kept: PASS
- Sentinel: the 66 rows (24 episodes) are NaN; 0 used audit dates are <= 2000-01-01.
- Undated used block: ft8_build.py:288 grants the day exemption only when `~agg_dates_available`, so with this pull an undated used block FAILS.
- Standalone, from /tmp: `~/.venv-forest/bin/python -I .../code/run_tests.py` -> `24 passed in 1.59s`, 0 skipped. The shim is symlinks into ~/.local, so it runs on the lab box only. Output shas are unchanged after the run.
- xfail: gone (0 in the tests).

## (4) My mutants on the REAL pulls (work/mutants.py, mutants.out): 35/36 caught
- RAISE, for util, icd(cond), ip and comorb: a record on the Rx day at 00:00:01 or at 09:00, at Rx+1, or with a missing src_max_ts. Also a 1970 sentinel (util, ip, comorb) and 20:00Z on Rx-1 (= 01:30 IST on the Rx day).
- Excluded by the shipped builder (has_*=0), and RAISE once the filters are off: BP and labs on the Rx day, at Rx+1, as 1970, or undated.
- H: a split=H row is never loaded. A key not in the lock makes the guard raise. A guard answer of H is dropped and counted.
- MISSED 1: a 1970 cond date passes, because src_max_date_icd = max(prior_rx, cond) and the real prior-Rx date masks it (418 episodes have both). Real data has no sentinel maxima (the earliest src ts is 2024-06-21), but a sentinel inside a max-only aggregate cannot be seen at all. -> Fix 1.

## (5)-(8): PASS
- (5) BP: 148/148 are dated before the Rx day and 0 are same-day. The minimum age is 1 d (23 at exactly 1 d) and the median is 7 d. h14 conversion is 17.5% with a BP vs 17.1% without.
- (6) Index episode: 23/23 ip_events are 3-166 d before rx_date. event_date is >= rx_date on 272/272 episodes; 0 ip dates are >= event_date. No OT, booking, admission or bill column exists.
- (7) AUC (work/auc_univariate.tsv): every feature is 0.38-0.55 at h14 and h90, so none is > 0.65. The only outlier is sbp at h90, 0.281 (inverse), on n=32 with 5 converted: noise (h14 is 0.466 on n=120). More history means less conversion in every block, so there is no post-Rx leak signal. (7) Within the rule, but note it: a prior Rx the day before the anchor converts at h14 12/52 (23%), vs 12.2% for gaps over a day. This looks like consult continuity.
- (8) H: 0 rows read, 0 dropped; 1233/1233 keys are D under RD0-2026-10-18-52959278edd8. (8) PHI: the only output string columns are episode_id and agg_blocks_cut_level. No pin_code and no free text. (8) Perms: outputs 0600, code/ 0700.

## Fixes (non-blocking)
1. Check the sentinel per component (prior_rx and cond, not their max). Add `>= '2000-01-01'` to every aggregate predicate in the SQL, or emit src_min_ts_*. Add a cond-1970 mutant test.
2. build() should itself assert ist_date(cut_ist_midnight) == rx_date (today only a real-data test checks it).
3. Note the day-before-prior-Rx effect (h14 12/52) as a caveat in DONE.md.
