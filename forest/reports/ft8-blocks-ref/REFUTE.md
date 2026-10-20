# ft8-blocks-ref: refutation of ft8-blocks (FT8-BLOCKS.md). 20 Oct 2026, started 11:34 IST, Opus

**Verdict: PASS-WITH-FIXES.** The mechanics are exact. Block lists, learner, folds, seeds, doctor rate, NaN coding, bootstrap, parity, deltas, CIs and table transcription all check out, and there was no H access. The fixes are all wording fixes in the summary (items 3 to 5) and the method line. No number in the tables is wrong.

Target: `~/oc/forest-lead/ft/out/ft8-blocks/` (read only, nothing edited). My scratch scripts and outputs are in `~/wt/ft8-blocks-ref/scratch/`.

## Checks

1. **Blocks vs spec s10: PASS.** The 6 lists in `ft8_blocks.py` BLOCKS match FT-MODEL-SPEC-20OCT s10 field for field: utilisation 5, comorbidity 10, admissions 1, vitals 4, labs 20, medicines 2, for 42 in total. The code asserts `sorted(c8) == sorted(union of blocks)` with `len == 42`. Two sorted lists can only be equal if every ft8 column appears exactly once.
2. **Reuse of ft-forest: PASS.** The script imports `forest_build`, `forest_lib` and `forest_run` from `~/wt/ft-forest/code`. Their sha256 values (18bc1a321db4, f1efb3f87172, e7e5f7ce4566) match ft-forest DONE.md, and their mtimes (08:23 and earlier) are before the run. `forest_bench_c.py` changed at 11:21, but it is not imported. The script calls `Runner.oof` / `FL.fit_predict`, which use RF_KW = (400, leaf 5, sqrt, rs 0), the in-fold doctor rate, Enc `fillna(-1)` and 5x5 StratifiedGroupKFold with seed RS + rep. Deltas use `FL.boot_delta` (1,000 cluster draws, BOOT_SEED 20261019, the same draws for every pair; draws = 1000 in every entry). **Parity:** M0 and M1 OOF match `model_frozen_rx_{h14,h90,ale}.json` exactly, max|diff| 0.0 in all 6 cases (re-run by me). The M1-M0 rows match FOREST-TABLES (-0.024 [-0.043, -0.003], -0.019 [-0.039, +0.001], -0.015 [-0.034, +0.003]).
3. **Deltas, CIs and transcription: PASS.** I re-ran `ft8_blocks_tables.py` on the shipped JSON. Every `|` table row it prints is identical to FT8-BLOCKS.md (sorted diff is empty). I recomputed 3 deltas per label (M1 vs M0, M0+labs, M1 vs shuffled) from the OOF with `boot_delta`, and all agree with the JSON to 4 dp. I recomputed coverage from features_ft8.parquet using the JSON episode order: 0 mismatches. The h14 L1 count is 444, matching FOREST-TABLES, and the +7 for any_history from admissions checks out. The v1/ claim holds: all 16 shared comparisons per label are identical and the OOF max|diff| is 0. SHA256SUMS verifies.
4. **Dilution control (d): valid mechanics, disclosed, but the reading is over-claimed.**
   - The permutation is a joint row permutation of all 42 columns over all D rows of that label, with fixed seed `default_rng(BOOT_SEED)`. That keeps each column's marginal distribution and the within-row missingness pattern, and breaks any link to y and to L0. It is a valid control.
   - The doc discloses that (d) was added post hoc after (a) to (c) had been seen. The summary also says "single shuffle seed".
   - **Over-claim:** Summary 4 says shuffled FT8 "cost about as much as the real FT8 does". That is false for h14 on the shipped seed: -0.009 vs -0.024.
   - **Seed sensitivity (my re-run, seeds 1 to 4 plus the shipped seed, M0 and M1 OOF reused):**

     | label | shuffled vs M0, 5 seeds | mean | real M1-M0 | M1 vs shuffled, 5 seeds | mean |
     |---|---|---|---|---|---|
     | h14 | -0.009, -0.040, +0.013, -0.019, -0.015 | -0.014 | -0.024 | -0.015, +0.016, -0.037, -0.005, -0.009 | -0.010 |
     | h90 | -0.019, -0.026, -0.016, -0.011, -0.017 | -0.018 | -0.019 | -0.001, +0.007, -0.003, -0.009, -0.002 | -0.002 |
     | ale | -0.016, -0.017, -0.030, -0.012, +0.013 | -0.012 | -0.015 | +0.001, +0.002, +0.014, -0.004, -0.029 | -0.003 |

   - **What the seeds show:**
     - On average, the multi-seed result supports the qualitative dilution reading. The shuffled columns cost roughly what real FT8 costs, consistently for h90 and on average for h14 and ale.
     - The seed-to-seed spread is about ±0.02 to 0.03, as large as the effect itself. For h14 and ale, one seed gives +0.013. For h14, one seed gives real-minus-shuffled -0.037 [-0.068, -0.006], with a CI that excludes 0.
     - So any single-seed number (d), including the h14 -0.015, is seed noise. Summary 5's "the loss is dilution, not a harmful signal" is stated as a conclusion, and it must not be.
5. **"New to Even alone does not explain it": mostly fair, but over-simplified.**
   - The one-flag models are -0.001 to +0.004, and the 32% vs 43% history coverage is correct. On these numbers, a single new-to-Even indicator does not lower AUC.
   - For ale, though, both one-flag models give +0.004 [+0.000, +0.008] with P(Δ<=0) = 0.03. That is a small nominal gain, not "neutral".
   - "The base layer seems to carry that already" was never tested: no run checks L0 for prior-visit information. The ale gain argues somewhat against it.
6. **Comparison count and claims: PASS.** 18 per label and 54 in total (1 + 6 + 6 + 3 + 2) are confirmed from the JSON. The doc states that there is no multiplicity correction, no test, D only, and that F-primary stays the pre-registered result. The summary heading says "nothing here is a finding". The only drift into finding language is in Summary 5 (see fix 2).
7. **H access and writes: PASS.** Neither code file references `eta-data`, `ft8/H` or `sealed`. `forest_build.build('rx')` reads only D-side files and asserts `split == {'D'}`. `features_ft8.parquet` is merged onto D rows only. Writes go only to `--out` (blocks_*.json), and `dont_write_bytecode` is set. No ft-forest file used by the run changed after it. I did not touch H (no reads or stats).

## Fixes required (PASS-WITH-FIXES)

1. **Summary 4.** Replace "cost about as much as the real FT8 does" with something like "about as much for h90 and Ale; for h14 the shipped seed cost less than half (-0.009 vs -0.024)".
   - Add that a 5-seed check (this report) gives a mean shuffled-vs-M0 of -0.014 / -0.018 / -0.012 with a spread of about ±0.02 to 0.03. One seed per label even has a positive sign.
   - So single-seed (d) values, including the h14 real-minus-shuffled -0.015, are not interpretable on their own.
2. **Summary 5.** Change "the loss is dilution, not a harmful signal" to "the loss is consistent with dilution; (d) cannot separate dilution from a weak harmful signal at this n". Fix the description too:
   - About 60% of rows have no FT8 history (1 - 444/1101).
   - Non-flag ft8 columns are -1 (NaN) for a median of about 77% of rows (28 of 33 columns are over 50%). The has_ flags are 0/1, not -1.
   - Under sqrt, M1 tries about 8 of 71 columns per split (about 3.3 of them base columns on average) vs 5 of 29 base columns in M0. State this mechanism as a hypothesis.
3. **Summary 3.** Write "neutral for h14 and h90; a small nominal gain for Ale (+0.004 [+0.000, +0.008], P = 0.03, uncorrected)". Drop "the base layer seems to carry that already" or mark it as untested speculation.
4. **Method line.** State that the (d) permutation is joint across all 42 columns, covers all D rows of the label and uses `default_rng(20261019)`, one seed.
5. **Header timestamp.** "written 11:40 IST" is later than the file's mtime (11:33) and later than when this review started (11:34). Correct it to the actual time.

Optional: the (c)/(d) table header in the doc was edited by hand and differs from the tables script output. That is fine, but the script should be updated to match.

## Reproduction
- `scratch/chk.py`: v1 identity and independent boot_delta recompute.
- `scratch/cov.py`: coverage and NaN shares.
- `scratch/shuf_seeds.py <lab> 1,2,3,4`: extra shuffle seeds. Logs and JSON are `scratch/shuf_*.{log,json}`. The run used `PYTHONHASHSEED=0 NJ=4 ~/.venv-forest/bin/python -I` on D only.
- `tables_out.md`: the tables script re-run.
