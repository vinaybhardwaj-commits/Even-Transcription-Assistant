# ft-h1shot DONE v3: refute ft-h1shot-ref PASS-WITH-FIXES, fixes 1-4 applied (2026-10-20 06:40 IST, machine clock). v2 (06:30) = rulings on FT8 v3. Opus 5.5 (global.anthropic.claude-opus-5-5) on Bedrock.
Spec FT-MODEL-SPEC-20OCT s8 (design A, M0 / M1, one-shot H). --run-H NOT run. No H row, label or feature was printed or written.
GO-H.txt not created. H_RUN.done does not exist. sealed/ is empty (0700). v1 (05:40) and v2 (06:30) are superseded.

## Tests
`36 passed in 30.61s` (run: `~/.venv-forest/bin/python -I ~/wt/ft-h1shot/code/run_tests.py`; pytest from the ft8-clinical pytest_shim).
- (a) The FT3 copy, split D, column order fixed: frame-equal to features_D.parquet on all 46 columns, avail == cols.json. The raw copy run as a CLI under PYTHONHASHSEED 0/1/2 gives an equal frame (order aside). A diff check against the original.
- (b) ft8_build v3 (unchanged, imported) on the split-parameterised D cohort with the day pulls and --pull-cut day: frame-equal to features_ft8.parquet **d674e54010cc**.
- (c) Refuses if H_RUN.done exists. Claims it with O_CREAT|O_EXCL before any H work. A second run and a second claim are refused.
- (d) Refuses without GO-H.txt, or with H pulls missing, without creating the flag. The real CLI refuses now (the test skips itself if the real GO or flag exists). GO_FILE is never written.
- (e) The full H path on D (H_SPLIT = D, tmp paths): stdout is one status line and stderr is empty. The only files are sealed/H_features.parquet (0600 / dir 0700), H-RESULT.md (0600) and H_RUN.done. No ids appear in the output or the files, and the real out dir is untouched. A failure prints only the exception type and file:line.
- (f) --dry writes DRY-RESULT.md (0600). It is the same as the shipped file.
- New, pull cut (ruling 2), all refused BEFORE the claim, with counts-only messages:
  - --pull-cut omitted is an argparse error.
  - --pull-cut differs from the D build_stats.
  - The H pull is not day-level: no audit columns; a src_max_ts on the anchor day; cut_ist_midnight is not the anchor midnight; a lab row with age_d 0.
  - An H pull row is not an anchor of the split.
  - A timestamp has no offset.
  - A column that ft8_build.load_a_b rejects.
  - Detection gives 'day' on ft8-pull-a-day + pull-b and 'timestamp' on the old pull A.

## Refute fixes (ft-h1shot-ref REPORT, 06:40)
1. MUST: --run-H now builds both layers, D and H, in memory BEFORE claim_shot, in _build_H. That covers FT3, FT8 with ft8_build.assert_cutoff at the day cut, and the H columns == D columns check (layer 0 and 0+1). Only then does it claim, write the sealed file and score (_run_H_body).
   - Tests: test_fix1_cutoff_quirk_refused_before_claim[blank, sentinel_1970]. Each takes a used block's src_max_ts_prior_rx, sets it blank or to 1970-01-01, runs the real build, and expects a refusal with CutoffViolation, no flag and no id.
   - test_fix1_build_before_claim_order: the build stub asserts there is no flag; the body stub asserts there is.
2. SHOULD: warnings are off, and umask is 077, before any H read. preflight, check_cuts (pull_cut_of + load_a_b on the H pulls) and _build_H run under one handler. Refused passes through as it is. Any other error becomes "REFUSED before the claim (shot NOT used): <type> at <file:line>", with the message suppressed and no flag.
   - Tests: test_e_H_preclaim_failure_refused_no_flag_no_message, and test_e_H_postclaim_failure_prints_no_message_content (after the claim the flag says FAILED and the message is suppressed).
3. DECLARE: render() writes the 97.5% CI (percentiles 1.25 / 98.75 of the same 1,000 draws) and a Holm table, in both DRY-RESULT.md and H-RESULT.md. **Reading rule for F-H (Holm over 2, fixed now, before the run):**
   - order h14 / h90 by P(delta <= 0), with ties going to h14 first;
   - the first is a gain only if its 97.5% CI lies above 0;
   - the second is a gain only if the first is a gain AND its 95% CI lies above 0;
   - otherwise the reading is "no gain shown".
   - The script computes this reading (holm_reading). Tests: test_fix3_holm_reading (5 cases).
4. WATCH: H-RESULT.md records "h_counts_vs_spec_s8": the H n / pos per label against spec s8 (h14 361/82, h90 224/64). It says "match" or "DIFFERS, stated here, not rerun". Counts only.
   - Also added: test_preflight_labels_sha_and_guard_pin (the refuter's two untested refusals).

## Rulings applied
1. Column order: kept (h1shot.ft3_layer reorders to the features_D / cols.json order). Dry is identical under hash seeds 3, 11 and random.
2. Pull cut:
   - `--pull-cut {day,timestamp}` is REQUIRED; there is no default.
   - D pulls are chosen by cut: day = ft8-pull-a-day.tsv + ft8-pull-b.tsv.
   - Preflight check_cuts, before the claim:
     - the argument must equal the D build_stats pull_cut;
     - the D and H pulls must each be classified at that cut from their data:
       - 'day' needs src_max_ts_* plus cut_ist_midnight in pull A;
       - cut_ist_midnight must be the IST midnight of the anchor Rx day for every row;
       - every src_max_ts_* (converted from its offset to IST) must be strictly before it;
       - every pull-B row must have age_d >= 1, and any src_max_ts in B must be before the anchor day;
     - every pull row must be an anchor of the split;
     - ft8_build.load_a_b's own column check runs on both, so a column the builder rejects cannot fail after the claim.
   - A mismatch refuses without burning the shot.
   - The H run therefore needs day everywhere. `--pull-cut timestamp` is now refused (the D build is day).
   - **The single run command will be `~/.venv-forest/bin/python -I ~/wt/ft-h1shot/code/h1shot.py --run-H --pull-cut day`.**
3. All 42 ft8_* columns are in M1, including the 5 ft8_{lab}_n_pre.
4. H pulls: ~/eta-data/forest/ft8/H/ft8-pull-a.tsv and ft8-pull-b.tsv. ft8_build v3 itself now accepts the pull-A audit columns, so h1shot passes the pulls to the unchanged ft8_build.load_a_b. My interim stripping loader is removed, because v3 build() uses src_max_ts to date the blocks. Reading H anchors for the cut check happens inside the script only.
5-7. As written in v1.

## Files (sha256, first 12)
- Code (~/wt/ft-h1shot/code): **h1shot.py 7e4a6a358b43** (v2 was 1d3ebd9c1409); ft3_features_split.py c474a77bf0bf; run_tests.py 31e0e9e1906e; tests/test_h1shot.py e9e76f85371a; tests/conftest.py f181aee5c940.
- Imported unchanged: ft8_build.py **80d12401d12d (v3)**, icd_map.py 7ebdfd518411; split_guard.py 2d39ef2884ee (pin 52959278edd8, checked).
- Inputs:
  - labels.parquet 0aefc00f425b (checked) and features_D.parquet 8ec830bfc4d6 (column order only);
  - ft5a fd8aa1206607, ft3b 09888298b7f4, ft3c c42e200a0ff0, ft3d f0c714fde0ba, 10.tsv 64c80143df16, clusters-2026-10-18 c60ccbea4676, S5 x 11 (shas in DRY-RESULT.md);
  - D ft8-pull-a-day.tsv 7b39ab45f35b, ft8-pull-b.tsv fd26e29ec835; features_ft8.parquet d674e54010cc.
- Output: DRY-RESULT.md a54e92f896ca (same numbers as v2; adds the 97.5% CI and the Holm table: step 1 h90, step 2 h14, both "no gain shown").

## Dry result (FT8 v3, day cut; one D fold of 246 episodes stands in for H; train 987; a rehearsal, not an estimate)
- h14: target 215 / 36. AUC M0 0.614, M1 0.592. Delta -0.022 [-0.069, +0.019], P(delta <= 0) 0.823.
- h90: target 123 / 24. AUC M0 0.659, M1 0.675. Delta +0.016 [-0.028, +0.058], P 0.228.
- M0 is unchanged from v1, as it should be. M1 moved by +0.003 (h14) and +0.004 (h90) with the day-level FT8.

## Open for forest-lead / gating-lead
- H pull B: settled (forest-lead, 06:59 IST). gating-lead delivers exactly the D pull-B columns, with no src_max_ts, so no v4 is needed. The preflight still refuses any other column before the claim.
- Any later change to ft8_build.py, features_ft8.parquet or the D pulls means rerunning the tests and --dry. The shas above are the ones to check before 15:00.
