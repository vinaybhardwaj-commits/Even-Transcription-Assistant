# ft-forest DONE (2026-10-20 09:31 IST). Lane ft-forest, Claude Opus 5.5 on Bedrock (global.anthropic.claude-opus-5-5). D split only; H never read.

## Status: FINAL, on the FROZEN spec
- Spec: FT-MODEL-SPEC-20OCT-FROZEN.md sha 704c50dffbef (lane .bc copy md5 0c761d68). FROZEN posted by forest-lead 08:22 IST. The final run started at 08:23:18, the forest finished at 09:10:28, and the pipeline ended at 09:28:50 (final_run.log).
- Tests before the final run: 41/41 (final_tests.log). They cover the synthetic leak, before-T, missing-coding, role-mask, ruling-4 and SELECTED rules. On real data: FTR v2 rows, order, y and clusters equal for 6/6 designs; the FTR base OOF is reproduced exactly with the FTR tree seed; folds equal the ft-bench harness folds; L0 = h1shot cols0 order; L1 = all 42 ft8_* columns; counts as in the spec; no H id.
- H: never read. Every input is D-only or filtered to D on load (asserted).

## Results (detail in FOREST-TABLES.md; DIRECTIONAL unless Holm p < 0.05)
- Tests here: 73 (F-primary 2, F-Ale-Rx 3, F-calls 54, F-consults 14). No Holm gain. 1 Holm loss: FT8 at the Rx, h14 M1-M0 -0.024 [-0.043, -0.003], Holm 0.048. h90 M1-M0 is -0.019 [-0.039, +0.001], Holm 0.072.
- F-bench (24; BENCH-C-FOREST.md, Holm across the 18 B tests from ft-bench bench_results-frozen-0910.json plus the 6 C tests): 1 survives, FULL > Jev at h90 T7 (+0.120, Holm 0.024). No FULL - Opus delta survives. FULL vs L7 for B: BENCH-TABLES-frozen-0910.md, where the column 'text_audio' = FULL and 'base' = L7 (FOREST_MODELS=FULL:text_audio,L7:base).
- SELECTED (optimistic; not a test): T3 = L0 for all three labels. T7: h14 L0+L3, h90 L0+L2+L7, ale L0+L2+L3+L7. C: C0 for both labels.

## Calibration
- B FULL and L7, and C FULL: ft-bench run_frozen.sh -> CALIB-frozen-0910.md (copied here). A M0/M1/M2 and C C7: CALIB-rx-consult.md, made with the same harness (calib.py oof) into this folder.
- Limitation: calib.py oof gives the raw RF and a sigmoid cross-fitted on the OOF scores, which the harness labels an approximation. The spec's nested in-fold sigmoid (calib.nested_platt, needs a refit) was NOT run.

## Rulings applied (forest-lead, 07:24 and 08:20; frozen spec v3.4)
1. Tree seed random_state=0 for every model; FTR fold seeds kept. L0 vs FTR v2 base is +0.000 to +0.004 (FOREST-TABLES, per B design).
2/8:20. Consult layer 3 DROPPED: its Jev items were computed on Saaras English (FT6). C = C0, C1, C4..C8; A M2 = M1 + consult layers 4-8.
3. Role columns = the ft-engines default (lexicon + lexicon_weak; fallback masked per call). The *_lex2 twins are not used. Guard: role columns missing when n_calls_roleok_tT == 0.
4. Layers 4-8 are set missing on episode/T rows with a Jev-added outcome-revealing call before T (S1 Runo summaries and S2 Runo STT): lm3 2/1/2 rows, lm7 2/1/3 (h14/h90/ale).
5. Design C uses the FT4 time-respecting doc_prior_rate. A and B use the in-fold doctor rate (m=10).
- Layer 8 = opus_screen2_p14 (h14/ale) or opus_screen2_p90 (h90), with has_text_screen2 (cleared 07:19). The unscreened score is available only via L8_RAW=1 and was not run.
- Not run (sensitivities in spec s4/s7, not ordered in this lane's brief): raw-Haiku tags (--raw-tags), role-free audio (--role-free), WavLM embeddings, unscreened layer 8. The flags exist in forest_run.py.

## Files written outside this folder
- ft-bench out (by run_frozen.sh, as briefed): CALIB-frozen-0910.md f6e29147c8e2, BENCH-TABLES-frozen-0910.md 8aeb56e6b99d, bench_scores-frozen-0910.parquet 2a3249daee4c, bench_results-frozen-0910.json aa886bddda24.
- The dry run on the draft spec is in dry/ (FOREST-TABLES-DRY.md d40000dd6553; superseded first attempt in dry/superseded-0722).

## Inputs (read-only, sha12)
| key | file | sha12 |
|---|---|---|
| features_D | ~/oc/forest-lead/ft/out/ft-labels-base/features_D.parquet | 8ec830bfc4d6 |
| features_D_cols | ~/oc/forest-lead/ft/out/ft-labels-base/features_D.cols.json | 35d252d4490e |
| labels | ~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet | 0aefc00f425b |
| episodes_D | ~/oc/forest-lead/ft/out/ft-calltext/episodes_D.parquet | a06fa6e0747f |
| calls_D | ~/oc/forest-lead/ft/out/ft-calltext/calls_D.parquet | 5d2a1c72a6ec |
| tags_D | ~/oc/forest-lead/ft/out/ft-calltext/tags_D.jsonl | d86ad5d43700 |
| f1 | ~/eta-data/forest/funnel/hash-only/f1-2026-10-19.tsv | e16e146b41c9 |
| ft8 | ~/oc/forest-lead/ft/out/ft8-clinical/features_ft8.parquet | d674e54010cc |
| tags_D_jev | ~/oc/forest-lead/ft/out/ft-text2/tags_D_jev.jsonl | d507107e9884 |
| rlfeat_tags_jev | ~/oc/forest-lead/ft/out/ft-text2/rlfeat_tags_jev.jsonl | fa7220dcc743 |
| bolna | ~/oc/forest-lead/ft/out/ft-text2/bolna_episode_feats.parquet | 68025a99cc6e |
| rl_calls_basic | ~/eta-data/forest/rl/feat/calls_basic.parquet | 2812b5a2b83e |
| rlfeat_tags_raw | ~/eta-data/forest/rl/feat/tags.jsonl | 0a3f5b87abb3 |
| eng_calls | ~/oc/forest-lead/ft/out/ft-engines/engine_feats_calls.parquet | 41f6928db8f0 |
| eng_consults | ~/oc/forest-lead/ft/out/ft-engines/engine_feats_consults.parquet | 53f44b7113f8 |
| l8 | ~/oc/forest-lead/ft/out/ft-bench/bench_layer8.parquet | 453d83f139b7 |
| l8c | ~/oc/forest-lead/ft/out/ft-bench/bench_layer8_c.parquet | d315521037a9 |
| designC | ~/oc/forest-lead/ft/out/ft-audio/designC_cohort.parquet | 254d16c51a0a |
| features_ale | ~/oc/forest-lead/ft/out/ft-audio/features_ale.parquet | 3f0c529447e2 |
| features_all | ~/oc/forest-lead/ft/out/ft-cohortb-expand/features_all.parquet | a3fc972290ee |

## Code (sha12)
| file | sha12 |
|---|---|
| final.sh | 2dece6f238eb |
| forest_bench_c.py | 25d81ce2f8e6 |
| forest_build.py | 18bc1a321db4 |
| forest_done.py | 0c32aae7db4c |
| forest_lib.py | f1efb3f87172 |
| forest_run.py | e7e5f7ce4566 |
| forest_tables.py | 4b0973b73be7 |
| ftf_desc.py | 55a25eaf9538 |
| run_all.sh | ab8015ddb4d7 |
| tests/test_forest.py | 7863f0463e5c |

## Outputs (~/oc/forest-lead/ft/out/ft-forest, 0600, sha12)
| file | sha12 |
|---|---|
| BENCH-C-FOREST.md | e4f1190daf83 |
| BENCH-TABLES-frozen-0910.md | 8aeb56e6b99d |
| CALIB-frozen-0910.md | f6e29147c8e2 |
| CALIB-rx-consult.md | ab55a5c43bfe |
| DESC-jev.md | f5b6204a8f53 |
| FOREST-TABLES.md | 057ee325677d |
| model_frozen_consult_ale_strict.json | e440ee81f9de |
| model_frozen_consult_h14_ge18.json | a5bfea01ff02 |
| model_frozen_lm3_ale.json | 8d652f844c87 |
| model_frozen_lm3_h14.json | 09b41aac7e01 |
| model_frozen_lm3_h90.json | 3ee9ecda61b0 |
| model_frozen_lm7_ale.json | 7f8625675e44 |
| model_frozen_lm7_h14.json | ed34c0e93b0f |
| model_frozen_lm7_h90.json | 2465365153f5 |
| model_frozen_rx_ale.json | 3c59250e0361 |
| model_frozen_rx_h14.json | 9ac680310435 |
| model_frozen_rx_h90.json | 32463bfb2469 |

## Addendum 09:54 IST: sensitivities + nested in-fold sigmoid (forest-lead 09:32; reported, not tested)
- FOREST-TABLES-SENS.md 55538e86797e. Jobs 09:33-09:54 IST, 50/50 written, 0 failed. FOREST-TABLES.md (057ee325677d) and model_frozen_* unchanged.
- Code: forest_sens.py c43199dc6e02, forest_sens_tables.py e1dd71af92d9. Extra inputs: engine_wavlm_emb_calls.parquet a888f29087a6, engine_wavlm_emb_consults.parquet f440a5d77412.
- Per-run JSON in sens/ (0600):

| file | sha12 |
|---|---|
| sens/sens_consult_ale_strict_l8raw.json | f2ce6fe033bd |
| sens/sens_consult_ale_strict_platt.json | e610d0e080a9 |
| sens/sens_consult_ale_strict_rolefree.json | 0d8db8cdc4f9 |
| sens/sens_consult_ale_strict_wavlm.json | f29d89b2a318 |
| sens/sens_consult_h14_ge18_l8raw.json | aef8bae6c9e4 |
| sens/sens_consult_h14_ge18_platt.json | 5d4be915b13a |
| sens/sens_consult_h14_ge18_rolefree.json | 2c7a93e12535 |
| sens/sens_consult_h14_ge18_wavlm.json | aa5871943565 |
| sens/sens_lm3_ale_l8raw.json | dc1e3121c717 |
| sens/sens_lm3_ale_platt.json | 758e766b6b3c |
| sens/sens_lm3_ale_rawtags.json | 268ded339b0e |
| sens/sens_lm3_ale_rolefree.json | cd4c1e320b6f |
| sens/sens_lm3_ale_wavlm.json | 2942a96857b6 |
| sens/sens_lm3_h14_l8raw.json | f12c588c1e66 |
| sens/sens_lm3_h14_platt.json | 7b6fcb426cf1 |
| sens/sens_lm3_h14_rawtags.json | a9e56fa47110 |
| sens/sens_lm3_h14_rolefree.json | 5fd7d9c00300 |
| sens/sens_lm3_h14_wavlm.json | 8c6f7cd44555 |
| sens/sens_lm3_h90_l8raw.json | 925724b6d5d4 |
| sens/sens_lm3_h90_platt.json | 4029eabdcb03 |
| sens/sens_lm3_h90_rawtags.json | e5e3b59072ed |
| sens/sens_lm3_h90_rolefree.json | ef9ba36b4777 |
| sens/sens_lm3_h90_wavlm.json | 55c23b35af56 |
| sens/sens_lm7_ale_l8raw.json | 1dbc30d1611e |
| sens/sens_lm7_ale_platt.json | 2c70379cf39c |
| sens/sens_lm7_ale_rawtags.json | 2c841df40ba6 |
| sens/sens_lm7_ale_rolefree.json | 38f1f210bd83 |
| sens/sens_lm7_ale_wavlm.json | 94410cc2abc4 |
| sens/sens_lm7_h14_l8raw.json | e54483814434 |
| sens/sens_lm7_h14_platt.json | afdd859a5439 |
| sens/sens_lm7_h14_rawtags.json | 888cc5fefd36 |
| sens/sens_lm7_h14_rolefree.json | 1353ddcdc7a9 |
| sens/sens_lm7_h14_wavlm.json | babc9f2aa932 |
| sens/sens_lm7_h90_l8raw.json | 23e349c67df5 |
| sens/sens_lm7_h90_platt.json | ef799668be62 |
| sens/sens_lm7_h90_rawtags.json | afc5d85f0b3b |
| sens/sens_lm7_h90_rolefree.json | a822b35b615b |
| sens/sens_lm7_h90_wavlm.json | dc69db67e4a8 |
| sens/sens_rx_ale_l8raw.json | 5db1453bfb89 |
| sens/sens_rx_ale_platt.json | 7481be5557f0 |
| sens/sens_rx_ale_rolefree.json | 2cd9fcb730cf |
| sens/sens_rx_ale_wavlm.json | 8107f95c2576 |
| sens/sens_rx_h14_l8raw.json | 611da4fd72fc |
| sens/sens_rx_h14_platt.json | c64c88d61171 |
| sens/sens_rx_h14_rolefree.json | 4e0731e430cf |
| sens/sens_rx_h14_wavlm.json | d2bad6a0c1e7 |
| sens/sens_rx_h90_l8raw.json | 7edaff603ccb |
| sens/sens_rx_h90_platt.json | f573450872f2 |
| sens/sens_rx_h90_rolefree.json | 00f2c1f1796b |
| sens/sens_rx_h90_wavlm.json | 2a7f430071ab |

## Addendum 11:29 IST: ft-refute-forest PASS-WITH-FIXES (report ft-refute-forest-REPORT.md 64f427a0662c); fixes applied
1. **BENCH-C-FOREST.md re-scored (fix 1).** Bug: in the ALL population, design-C benchmark (a) a_intent_raw had its -1 (none stated) codes replaced by the median of the covered scores. That made (a) a constant (AUC 0.500), against my own header, which claimed the bench_score_c.py rule. Now, as in bench_score_c.py, only NaN gets the median and -1 stays the lowest ordinal level.
   - (a) ALL AUC: ale_strict 0.550, h14_ge18 0.461 (as ft-bench and the refuter).
   - FULL-a: ale_strict +0.142 [-0.019, +0.292], raw p 0.094 (was +0.191, p 0.006); h14_ge18 +0.113 (was +0.074).
   - F-bench Holm: survivors unchanged (1/24: h90 lm7 FULL > Jev +0.120, Holm 0.024). ale_strict FULL-a Holm is now 1.000; the B a_intent Holm values move up slightly (family re-ranked).
   - New BENCH-C-FOREST.md 50817a2ae1ce. The old file is kept as BENCH-C-FOREST-v1.md e4f1190daf83, rebuilt with the old rule, byte-identical to the original sha e4f1190daf83.
   - forest_bench_c.py now be47d85dd416. Spec, FOREST-TABLES.md (057ee325677d) and model_frozen_* unchanged.
2. **Calibration wording (fix 2).** The "sigmoid, cross-fitted on OOF" blocks in CALIB-frozen-0910.md and CALIB-rx-consult.md are the ft-bench approximation (labelled "approximate" by the harness). They are NOT the spec s6 nested Platt, and they are optimistic: their slopes are closer to 1 than the nested ones, and they change AUC.
   - The nested in-fold Platt (spec s6) IS in FOREST-TABLES-SENS.md (09:54). A M0/M1 slopes: h14 1.31/1.23, h90 1.22/1.22, ale 1.35/1.45. Brier equals raw to 3 decimals. The refuter's independent nested run gives h14 1.19/1.06 and h90 1.22/1.24, with Brier = raw; the difference is the inner split.
   - B/C FULL nested slopes are 0.83-1.15, except C h14_ge18, which is NOT usable (12 positives; inner maps flip sign).
   - The defensible calibration claim is the RAW RF (slope, intercept, CITL, reliability, Brier vs no-skill). Brier skill is small.
3. **Extra flag columns (note 3).** Two has-type flags, allowed by spec s3, are not in the s4 field lists:
   - roles_ok in B layer 4 (= n_calls_roleok_tT > 0), so B L4 has 15 columns, not 14;
   - has_ft8_row in C layer 1 (consult row linked to an FT8 episode), so C L1 has 43, not 42.
   - The refuter's build without roles_ok gives the same Holm outcomes.
