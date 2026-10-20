# ft-h1shot-ref REPORT: independent Opus refute of ft-h1shot (2026-10-20 ~06:40 IST). Opus 5.5 (global.anthropic.claude-opus-5-5).
Claim DONE.md 0c12cfa08158, h1shot.py 1d3ebd9c1409, ft3_features_split.py c474a77bf0bf: shas checked. No H file, pull, label or feature read. GO-H.txt and H_RUN.done absent before and after.
VERDICT PASS (fix check 06:42 IST, h1shot.py 7e4a6a358b43; the first refute at 06:40 was PASS-WITH-FIXES on 1d3ebd9c1409)
## Checks (evidence under ~/wt/ft-h1shot-ref/work/: tests.log, repro.py/.log, guards.py/.log, gap.py/.log)
1. Tests: `26 passed in 26.71s` (rc 0; run with -I -B so no bytecode was written into the lane's code dir).
2. Dry reproduced with my own code (shipped features_D + features_ft8; own doctor rate, encoding and bootstrap; same fold 0 of SGKF(5, shuffle, seed 0)): stand-in 246 / train 987.
   h14 886/153 -> 215/36, AUC M0 0.614, M1 0.592, delta -0.022 [-0.069, +0.019], P 0.823. h90 536/126 -> 123/24, AUC 0.659 / 0.675, delta +0.016 [-0.028, +0.058], P 0.228.
   PR-AUC and Brier match too. An exact match to DRY-RESULT.md.
3. Guards (copies under work/mut, tmp paths, H_SPLIT=D). Each of these is refused before the claim, with no flag, no body call and no id in the message:
   done exists; GO absent; pull A or B missing; labels sha mismatch; guard pin mismatch (local and module); --pull-cut timestamp; build_stats cut mismatch; H pull A in timestamp format; extra column in A (foo) or B (bill_amt).
   The labels-sha and pin cases have no test in the lane suite; my cases cover them.
   Mutants: without O_EXCL a second claim is ALLOWED (orig refuses); without the exists check plus without O_EXCL, a raced run proceeds; without the GO check the run starts; with check_cuts after the claim, a bad column burns the flag. So each guard is the thing that refuses.
4. Seal: after the claim, everything is under the BaseException handler (type + file:line only); FT3 prints are redirected; ft8_build prints only in main(); split_guard prints only in __main__; warnings are off; RF uses threads, so no joblib memmaps.
   Files written: sealed/H_features.parquet (umask 077 + chmod 0600), H-RESULT.md (0600, metrics, counts and input shas), H_RUN.done (timestamps, pid, exception type, line numbers). Test (e) confirms this on D. One gap before the claim: fix 2.
5. Train/score: training = labelled D only; on D, notna equals age >= 18 / >= 94 (0 mismatches; 1101/189 and 659/150). The doctor rate (m 10, inner GroupKFold OOF) and the Enc levels are fitted on train rows only; target rows get the train rate.
   Payer is dropped (29 layer-0 columns). The D build keeps only rows whose cluster split_guard maps to D. The bootstrap is over target clusters, seed 20261020, 1000 draws.
   FT3 ch_* set comes from the whole ft3b file, so H gets the same columns as D.
6. FT3 diff vs ft-labels-base ft3_features.py c827d0aed308: only SPLIT/OUT_DIR (the filter, a print label, guarded writes). ft8_build.py 80d12401d12d, icd_map.py and split_guard.py are imported unchanged (shas match DONE.md).
7. H output = design A only, M0/M1, h14/h90. It has AUC, PR-AUC with the base rate, Brier with no-skill, calibration slope and intercept, and delta with the 1000-draw cluster CI. That matches spec s8. No layer 2-8, Ale or call/consult path exists in the code.
## Fixes
1. MUST before 15:00: the shot can burn on H-pull data that passes the preflight. check_cuts tests only non-null src_max_ts. ft8_build.assert_cutoff, which runs AFTER the claim (h1shot.py:86 via :363), also fails on a used block with no src date or on a sentinel date (<= 2000-01-01).
   Proved on the D stand-in: one row with src_max_ts_prior_rx blank, or set to 1970-01-01, passes the preflight. It then claims H_RUN.done and fails with CutoffViolation at ft8_build.py:301 (gap.log).
   Fix: build both layers (D and H, in memory) and the t1 == cols1 check BEFORE claim_shot. Then claim, write the sealed file and score. Add a test for each quirk (refused, no flag). Then rerun the tests and --dry, and send me the new sha for a diff check.
2. SHOULD: H-reading code before the claim (check_cuts / pull_cut_of / load_a_b on the H pulls, and the fix-1 build) runs outside the sanitised handler, and warnings are switched off only after the claim. An unexpected exception there would print its full message.
   Wrap this in the same type-plus-file:line handler, re-raising Refused as is, and call warnings.simplefilter('ignore') before it.
3. DECLARE (no code needed): spec s8/s9 say Holm within F-H (2 tests), but H-RESULT gives only 95% CIs and P(delta <= 0). Write the reading rule into DONE.md before 15:00.
   Proposed rule: order by P; claim the first gain only if P(delta <= 0) <= 0.0125 (the 97.5% CI excludes 0), the second only if <= 0.025. Better: add the 97.5% CI to render().
4. WATCH at 15:00: the H n/pos should be h14 361/82 and h90 224/64 (spec s8). FT3's no-UHID drop could lower them; any difference must be stated in the report, never fixed by a rerun.
## Fix check (06:42 IST): h1shot.py 7e4a6a358b43, tests e9e76f85371a, DONE v3 c7168aa8b580, DRY a54e92f896ca. Verdict PASS
- Diff against 1d3ebd9c1409 (my copy) contains only fixes 1-4; ft3_features_split.py is unchanged (c474a77bf0bf). Tests: `36 passed in 30.30s` (rc 0).
- Fix 1: _build_H (D and H in memory, assert_cutoff, t0 == cols0 and t1 == cols1) now runs BEFORE claim_shot. My gap cases (blank, and 1970 src_max_ts_prior_rx) are now "REFUSED before the claim (shot NOT used): CutoffViolation at ... ft8_build.py:301", with no flag (gap2.log).
- Fix 2: umask 077 and warnings off before the preflight. Any non-Refused error before the claim becomes a Refused with type + file:line only; Refused messages pass through (counts / column names only).
- Guards rerun (guards2.log): all 13 cases refuse with no flag and no leak; the baseline claims. The mutants still flip (no O_EXCL lets a second claim through; no GO check lets the run start; a claim before the pre-claim block burns the flag).
- Fix 3: the Holm rule is correct (step 1 needs the 97.5% CI above 0; step 2 needs the 95% CI above 0 and step 1 to be a gain). It is pre-declared in DONE v3 and rendered in the results. My bootstrap reproduces the 97.5% CI: h14 [-0.075, +0.027], h90 [-0.034, +0.062]. All other dry numbers are unchanged.
- Fix 4: EXPECTED_H h14 361/82, h90 224/64 are compared with the labelled H n/pos, and a difference is stated, not rerun. GO-H.txt and H_RUN.done are still absent. No H access by me.
## H pull check (07:06 IST, SQL text + header lines only; no H row read): PREFLIGHT-READY
- With ids masked, ft8-H-pull-a.sql and ft8-H-pull-b.sql differ from ft8-pull-a-day.sql / ft8-pull-b.sql only in the anchor VALUES list (389 vs 1233 ids) and in pull A's two header comments. Pull B has no 1970 or other logic change. Cosmetic: the H pull-A comment still says "(1,233)".
- The H headers equal the D headers byte for byte, which also equal ft8_build PULL_A_COLS / PULL_B_COLS in order (no src_max_ts in B). Perms: H dir 0700; both files 0600. Not checked by me: the file shas and H-anchor membership (the --run-H preflight checks membership via row_not_H_anchor).
## H run watch (10:00-10:01 IST): CLEAN. GO 10:00:22, declared change 1 in s10 (ft-forest shas spot-checked: 3 match). One process (pid 63008, the exact GO command); claimed 10:00:45, finished ok 10:00:55. h1shot.py 7e4a6a358b43 at launch.
- H-RESULT.md fb94f9eaf95f (0600) holds metrics, counts and shas only (id scan: 0 ids). H n/pos match s8 (361/82, 224/64); 2 files written plus the flag; sealed 0700/0600, not opened. Result: M1 - M0 h14 -0.042, h90 -0.042, Holm reading "no gain shown".
