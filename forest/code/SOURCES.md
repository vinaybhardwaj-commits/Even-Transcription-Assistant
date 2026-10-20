# Code sources
Each staged script, its FT7 lane, the source tags it produced, its original path and code ref.
Code ref = git short HEAD where the lane dir is a git repo, else sha:<sha256[:12] of the script>. To be replaced by the ETA repo commit at check-in.

| staged file | lane | tags | original path | code ref | sha256[:12] (original) | note |
|---|---|---|---|---|---|---|
| code/forest-lead/ft1_timing.py | FT1 timing (forest-lead) | S1 | ~/oc/forest-lead/ft/ft1_timing.py | sha:3b36eb5d076b | 3b36eb5d076b |  |
| code/ft-doctors/ft5.py | FT5 doctors (ft-doctors) | S7 | ~/oc/forest-lead/ft/out/ft-doctors/ft5.py | sha:6120436949fb | 6120436949fb |  |
| code/ft-doctors/ft5_analysis.py | FT5 doctors (ft-doctors) | S18; S7 | ~/oc/forest-lead/ft/out/ft-doctors/ft5_analysis.py | sha:bcb4562efd1a | bcb4562efd1a |  |
| code/ft-doctors/ft5_tables.py | FT5 doctors (ft-doctors) | S7 | ~/oc/forest-lead/ft/out/ft-doctors/ft5_tables.py | sha:6bb7cde3f9e2 | 6bb7cde3f9e2 |  |
| code/ft-engines/assemble.py | ft-engines | - | ~/oc/forest-lead/ft/out/ft-engines/code/assemble.py | 15b31b3 | 97f6ffa021be |  |
| code/ft-engines/cov.py | ft-engines | - | ~/oc/forest-lead/ft/out/ft-engines/code/cov.py | 15b31b3 | 3d3e2f62e4f8 |  |
| code/ft-labels-base/ft2_labels.py | FT2 labels (ft-labels-base) | S4 | ~/oc/forest-lead/ft/out/ft-labels-base/code/ft2_labels.py | sha:218fb1eca06b | 218fb1eca06b |  |
| code/ft-labels-base/ft3_features.py | FT3 Pulse base (ft-labels-base) | S3 | ~/oc/forest-lead/ft/out/ft-labels-base/code/ft3_features.py | sha:c827d0aed308 | c827d0aed308 |  |
| code/ft-labels-base/ft3_model.py | FT3 Pulse base (ft-labels-base) | S3 | ~/oc/forest-lead/ft/out/ft-labels-base/code/ft3_model.py | sha:35b2dcad9e9e | 35b2dcad9e9e |  |
| code/ft-lexical/common.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/common.py | sha:ffaa2f56661a | ffaa2f56661a | REDACTED copy: 52 native-script runs replaced by <native-redacted>; not runnable as-is; original sha ffaa2f56661a |
| code/ft-lexical/jev_check.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/jev_check.py | sha:0835efb5ed73 | 0835efb5ed73 |  |
| code/ft-lexical/lex.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/lex.py | sha:f2b93a6357b6 | f2b93a6357b6 |  |
| code/ft-lexical/names.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/names.py | sha:c8ff97c4dc35 | c8ff97c4dc35 |  |
| code/ft-lexical/other.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/other.py | sha:0b678856d345 | 0b678856d345 | REDACTED copy: 2 native-script runs replaced by <native-redacted>; not runnable as-is; original sha 0b678856d345 |
| code/ft-lexical/prep.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/prep.py | sha:faab87ff51dd | faab87ff51dd |  |
| code/ft-lexical/quotes.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/quotes.py | sha:4f782359c05b | 4f782359c05b |  |
| code/ft-lexical/report.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/report.py | sha:2fcc5eeee673 | 2fcc5eeee673 |  |
| code/ft-lexical/sens_lex.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/sens_lex.py | sha:d9f9479f1d67 | d9f9479f1d67 |  |
| code/ft-lexical/tag.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/tag.py | sha:6afe4c89cd91 | 6afe4c89cd91 |  |
| code/ft-lexical/themes.py | ft-lexical | S39 | ~/oc/forest-lead/ft/out/ft-lexical/code/themes.py | sha:adecb59f674a | adecb59f674a |  |
| code/ft-refute-doctors/glmm.py | FT5 refute (VERDICT.md) | S6 | ~/oc/forest-lead/ft/out/ft-refute-doctors/glmm.py | sha:8813d45e2dfd | 8813d45e2dfd |  |
| code/ft-refute-doctors/pairs.py | FT5 refute (VERDICT.md) | S6 | ~/oc/forest-lead/ft/out/ft-refute-doctors/pairs.py | sha:5f212db38028 | 5f212db38028 |  |
| code/ft-text2/analyze.py | ft-text2 | S25 | ~/oc/forest-lead/ft/out/ft-text2/code/analyze.py | c68778b | e6a74ef87efa |  |
| code/ft-text2/bolna_episode.py | ft-text2 | S25 | ~/oc/forest-lead/ft/out/ft-text2/code/bolna_episode.py | c68778b | 5b94d907d8ad |  |
| code/ft-text2/bolna_join.py | ft-text2 | S25 | ~/oc/forest-lead/ft/out/ft-text2/code/bolna_join.py | c68778b | 6c79e3678e04 |  |
| code/ft8-blocks/ft8_blocks.py | ft8-blocks | S37 | ~/oc/forest-lead/ft/out/ft8-blocks/code/ft8_blocks.py | sha:bfdff3f31b3e | bfdff3f31b3e |  |
| code/ft8-blocks/ft8_blocks_tables.py | ft8-blocks | S37 | ~/oc/forest-lead/ft/out/ft8-blocks/code/ft8_blocks_tables.py | sha:df94b1c7f0dc | df94b1c7f0dc |  |
| code/ft8-clinical/coverage_report.py | FT8 build (cb-ft8-build) | S22 | ~/oc/forest-lead/ft/out/ft8-clinical/code/coverage_report.py | sha:07dad0821a2e | 07dad0821a2e |  |
| code/forest-lead/rl_stt.py | ft-rl-stt-a; ft-rl-stt-b; ft-rl-stt-c | - | ~/oc/forest-lead/ft/rl_stt.py | sha:83dbef36df52; sha:83dbef36df52 (final run inferred 4ef05cbe) | 83dbef36df52 |  |
| code/forest-lead/ft8-inventory.sql | FT8 inventory (gating-lead) | S21 | ~/oc/forest-lead/sql/ft8-inventory.sql | sha:b9251c8e35f6 | b9251c8e35f6 |  |
| code/forest-funnel-join/funnel_f1.py | F1 funnel (forest-funnel-join; run by forest-lead) | S16 | ~/wt/forest-funnel-join/studies/2026-10-19-funnel/funnel_f1.py | 524a77a3 | 5d1bffc0571b |  |
| code/ft-audio/ale.py | ft-audio | S8 | ~/wt/ft-audio/code/ale.py | sha:6bdbd99902ba | 6bdbd99902ba |  |
| code/ft-audio/desc.py | ft-audio | S8 | ~/wt/ft-audio/code/desc.py | sha:567607d7cf87 | 567607d7cf87 |  |
| code/ft-audio/model.py | ft-audio | S8 | ~/wt/ft-audio/code/model.py | sha:6e54bd023979 | 6e54bd023979 |  |
| code/ft-audio/model2.py | ft-audio | S8 | ~/wt/ft-audio/code/model2.py | sha:2192f6dff1d2 | 2192f6dff1d2 |  |
| code/ft-bench/bench_score.py | ft-bench | S29 | ~/wt/ft-bench/code/bench_score.py | 44520f9 | b7eb7f86f538 |  |
| code/ft-bench/calib.py | ft-bench; ft-forest | S29; S30 | ~/wt/ft-bench/code/calib.py | 44520f9 | b57aa45d5b68 |  |
| code/ft-bench/leak_audit.py | ft-bench | S29 | ~/wt/ft-bench/code/leak_audit.py | 44520f9 | dc6943ea94aa | REDACTED copy: 85 native-script runs replaced by <native-redacted>; not runnable as-is; original sha dc6943ea94aa |
| code/ft-bench/make_layer8.py | ft-bench | S29 | ~/wt/ft-bench/code/make_layer8.py | 44520f9 | 23c0b2152140 |  |
| code/ft-bench/run_frozen.sh | ft-bench | S29 | ~/wt/ft-bench/code/run_frozen.sh | 44520f9 | b73d7cd48e21 |  |
| code/ft-calltext/ftc_desc.py | ft-calltext | S17 | ~/wt/ft-calltext/code/ftc_desc.py | sha:19568eede161 | 19568eede161 |  |
| code/ft-calltext/ftc_join.py | ft-calltext | S10 | ~/wt/ft-calltext/code/ftc_join.py | sha:373f30494519 | 373f30494519 |  |
| code/ft-calltext/ftc_model.py | ft-calltext | S10; S12 | ~/wt/ft-calltext/code/ftc_model.py | sha:ea1cd4187fd1 | ea1cd4187fd1 |  |
| code/ft-calltext/ftc_model_v2final.py | ft-calltext | S10 | ~/wt/ft-calltext/code/ftc_model_v2final.py | sha:26eec7b9a863 | 26eec7b9a863 |  |
| code/ft-calltext/ftc_table.py | ft-calltext | S10; S12 | ~/wt/ft-calltext/code/ftc_table.py | sha:da62529162f8 | da62529162f8 |  |
| code/ft-calltext/ftc_tag.py | ft-calltext | S10 | ~/wt/ft-calltext/code/ftc_tag.py | sha:54d97b97d0f6 | 54d97b97d0f6 |  |
| code/ft-calltext/run_ftr.sh | ft-calltext | S12 | ~/wt/ft-calltext/code/run_ftr.sh | sha:d93661ed9925 | d93661ed9925 |  |
| code/ft-cohortb-expand/assemble.py | ft-cohortb-expand | S8 | ~/wt/ft-cohortb-expand/code/assemble.py | sha:27aa104632c9 | 27aa104632c9 |  |
| code/ft-engines-ref2/check.py | ft-engines-ref2 | - | ~/wt/ft-engines-ref2/work/check.py | sha:88e1e81f149b | 88e1e81f149b |  |
| code/ft-engines-ref2/check2.py | ft-engines-ref2-R2 | - | ~/wt/ft-engines-ref2/work/check2.py | sha:f2b2fcb557eb | f2b2fcb557eb |  |
| code/ft-engines/assemble.py | ft-engines | S33 | ~/wt/ft-engines/code/assemble.py | 15b31b3 | 97f6ffa021be |  |
| code/ft-engines/clef_run.py | ft-engines | S33 | ~/wt/ft-engines/code/clef_run.py | 15b31b3 | 295b92625e85 |  |
| code/ft-engines/cov.py | ft-engines | S33 | ~/wt/ft-engines/code/cov.py | 15b31b3 | 3d3e2f62e4f8 |  |
| code/ft-engines/gpu_manners.py | ft-engines | S33 | ~/wt/ft-engines/code/gpu_manners.py | 15b31b3 | 52197c593022 |  |
| code/ft-engines/nemo_diar.py | ft-engines | S33 | ~/wt/ft-engines/code/nemo_diar.py | 15b31b3 | b06d5382a490 |  |
| code/ft-engines/roles_A.py | ft-engines | S33 | ~/wt/ft-engines/code/roles_A.py | 15b31b3 | 8e1c613cdfe3 |  |
| code/ft-engines/score_windows.py | ft-engines | S33 | ~/wt/ft-engines/code/score_windows.py | 15b31b3 | fcf134ebfc1e |  |
| code/ft-engines/winB.py | ft-engines | S33 | ~/wt/ft-engines/code/winB.py | 15b31b3 | 4ca7ee94b0c3 |  |
| code/ft-engines/run_chain.sh | ft-engines | S33 | ~/wt/ft-engines/run_chain.sh | 15b31b3 | 05567f2d4c29 |  |
| code/ft-engines/run_gpu.sh | ft-engines | S33 | ~/wt/ft-engines/run_gpu.sh | 15b31b3 | 60f9c60b7317 |  |
| code/ft-forest/forest_bench_c.py | ft-forest | S29 | ~/wt/ft-forest/code/forest_bench_c.py | sha:25d81ce2f8e6 | be47d85dd416 |  |
| code/ft-forest/forest_run.py | ft-forest | S26 | ~/wt/ft-forest/code/forest_run.py | sha:e7e5f7ce4566 | e7e5f7ce4566 |  |
| code/ft-forest/forest_sens.py | ft-forest | S30 | ~/wt/ft-forest/code/forest_sens.py | sha:c43199dc6e02 | c43199dc6e02 |  |
| code/ft-forest/forest_sens_tables.py | ft-forest | S30 | ~/wt/ft-forest/code/forest_sens_tables.py | sha:e1dd71af92d9 | e1dd71af92d9 |  |
| code/ft-forest/forest_tables.py | ft-forest | S26 | ~/wt/ft-forest/code/forest_tables.py | sha:4b0973b73be7 | 4b0973b73be7 |  |
| code/ft-forest/ftf_desc.py | ft-forest | S24 | ~/wt/ft-forest/code/ftf_desc.py | sha:55a25eaf9538 | 55a25eaf9538 |  |
| code/ft-h1shot/h1shot.py | ft-h1shot | S28; S34 | ~/wt/ft-h1shot/code/h1shot.py | sha:7e4a6a358b43 | 7e4a6a358b43 |  |
| code/ft-lexical-oref/recheck_k.py | ft-lexical-oref | S42 | ~/wt/ft-lexical-oref/.bc/recheck_k.py | sha:ef43b16741ca | ef43b16741ca |  |
| code/ft-lexical-oref/recheck_lex.py | ft-lexical-oref | S42 | ~/wt/ft-lexical-oref/.bc/recheck_lex.py | sha:aace361aac24 | aace361aac24 |  |
| code/ft-lexical-oref/recheck_window.py | ft-lexical-oref | S42 | ~/wt/ft-lexical-oref/.bc/recheck_window.py | sha:c63a9a8f4074 | c63a9a8f4074 |  |
| code/ft-refute-audio2/cohort.py | ft-refute-audio2 | S9 | ~/wt/ft-refute-audio2/work/cohort.py | sha:cb655bf2e7b3 | cb655bf2e7b3 |  |
| code/ft-refute-audio2/desc.py | ft-refute-audio2 | S9 | ~/wt/ft-refute-audio2/work/desc.py | sha:8372eee5ac05 | 8372eee5ac05 |  |
| code/ft-refute-audio2/ep.py | ft-refute-audio2 | S9 | ~/wt/ft-refute-audio2/work/ep.py | sha:d48f41ae1408 | d48f41ae1408 |  |
| code/ft-refute-audio2/model.py | ft-refute-audio2 | S9 | ~/wt/ft-refute-audio2/work/model.py | sha:b8519845f174 | b8519845f174 |  |
| code/ft-refute-base/feats.py | FT3 refute (ft-refute-base) | S5 | ~/wt/ft-refute-base/work/feats.py | sha:3bb90b6a2577 | 3bb90b6a2577 |  |
| code/ft-refute-base/model.py | FT3 refute (ft-refute-base) | S5 | ~/wt/ft-refute-base/work/model.py | sha:d9f5b65451cd | d9f5b65451cd |  |
| code/ft-refute-base/spec_gsonly.py | FT3 refute (ft-refute-base) | S5 | ~/wt/ft-refute-base/work/spec_gsonly.py | sha:6441ab8a0264 | 6441ab8a0264 |  |
| code/ft-refute-calltext/desc.py | ft-refute-calltext | S11 | ~/wt/ft-refute-calltext/work/desc.py | sha:b223ce9f0cbb | b223ce9f0cbb |  |
| code/ft-refute-calltext/model.py | ft-refute-calltext | S11 | ~/wt/ft-refute-calltext/work/model.py | sha:50df52835c07 | 50df52835c07 |  |
| code/ft-refute-calltext/run2.py | ft-refute-calltext | S11 | ~/wt/ft-refute-calltext/work/run2.py | sha:f15cd9df4499 | f15cd9df4499 |  |
| code/ft-refute-calltext/run3.py | ft-refute-calltext | S11 | ~/wt/ft-refute-calltext/work/run3.py | sha:14a02769d3b0 | 14a02769d3b0 |  |
| code/ft-refute-calltext/verify.py | ft-refute-calltext | S11 | ~/wt/ft-refute-calltext/work/verify.py | sha:c6f925375c98 | c6f925375c98 |  |
| code/ft-refute-doctors/derm.py | FT5 refute (wt REPORT) | S6 | ~/wt/ft-refute-doctors/work/derm.py | sha:8c1913bd228d | 8c1913bd228d |  |
| code/ft-refute-doctors/glmm.py | FT5 refute (wt REPORT) | S6 | ~/wt/ft-refute-doctors/work/glmm.py | sha:10fc7a461b47 | 10fc7a461b47 |  |
| code/ft-refute-doctors/scen.py | FT5 refute (wt REPORT) | S6 | ~/wt/ft-refute-doctors/work/scen.py | sha:d09c151c27b1 | d09c151c27b1 |  |
| code/ft-refute-forest/analyze.py | ft-refute-forest | S36 | ~/wt/ft-refute-forest/work/analyze.py | sha:ee94014814f0 | ee94014814f0 |  |
| code/ft-refute-forest/guard.py | ft-refute-forest | S36 | ~/wt/ft-refute-forest/work/guard.py | sha:b7d7d7697f98 | b7d7d7697f98 |  |
| code/ft-refute-forest/rf_refute.py | ft-refute-forest | S36 | ~/wt/ft-refute-forest/work/rf_refute.py | sha:68ca34a6c888 | 68ca34a6c888 |  |
| code/ft-refute-ft1/ft1_own.py | FT1 refute (ft-refute-ft1) | S19 | ~/wt/ft-refute-ft1/work/ft1_own.py | sha:d913694db700 | d913694db700 |  |
| code/ft-refute-ft6/recompute.py | ft-refute-ft6 | S20 | ~/wt/ft-refute-ft6/work/recompute.py | sha:84f105465c9e | 84f105465c9e |  |
| code/ft-refute-ft6/sel.py | ft-refute-ft6 | S20 | ~/wt/ft-refute-ft6/work/sel.py | sha:6ea38e218ea4 | 6ea38e218ea4 | REDACTED copy: 10 native-script runs replaced by <native-redacted>; not runnable as-is; original sha 6ea38e218ea4 |
| code/ft-refute-ft6/split_check.py | ft-refute-ft6 | S20 | ~/wt/ft-refute-ft6/work/split_check.py | sha:8be7e0f68c2d | 8be7e0f68c2d |  |
| code/ft-refute-ft8/rebuild.py | FT8 refute (ft-refute-ft8) | S23 | ~/wt/ft-refute-ft8/work/rebuild.py | sha:cf24bf6a4c7d | cf24bf6a4c7d |  |
| code/ft-refute-ft8/rebuild_day.py | FT8 refute (ft-refute-ft8) | S23 | ~/wt/ft-refute-ft8/work/rebuild_day.py | sha:8e314b96d911 | 8e314b96d911 |  |
| code/ft-refute-ft8/test_refute_ft8.py | FT8 refute (ft-refute-ft8) | S23 | ~/wt/ft-refute-ft8/work/test_refute_ft8.py | sha:cb0bbb1b6f4d | cb0bbb1b6f4d |  |
| code/ft-refute-ftr/boot3.py | ft-refute-ftr | S13 | ~/wt/ft-refute-ftr/work/boot3.py | sha:ffc20b7c7d54 | ffc20b7c7d54 |  |
| code/ft-refute-ftr/counts.py | ft-refute-ftr | S13 | ~/wt/ft-refute-ftr/work/counts.py | sha:53c7a4d19f98 | 53c7a4d19f98 |  |
| code/ft-refute-ftr/ftr.py | ft-refute-ftr | S13 | ~/wt/ft-refute-ftr/work/ftr.py | sha:dc4448454ff8 | dc4448454ff8 |  |
| code/ft-refute-ftr/stats.py | ft-refute-ftr | S13 | ~/wt/ft-refute-ftr/work/stats.py | sha:df1aa5bf898f | df1aa5bf898f |  |
| code/ft-refute-ftr/v2chk.py | ft-refute-ftr | S13 | ~/wt/ft-refute-ftr/work/v2chk.py | sha:71925a98d162 | 71925a98d162 |  |
| code/ft-refute-labels/compare.py | FT2 labels refute (ft-refute-labels) | S2 | ~/wt/ft-refute-labels/work/compare.py | sha:472a644ac7fe | 472a644ac7fe |  |
| code/ft-refute-labels/recompute.py | FT2 labels refute (ft-refute-labels) | S2 | ~/wt/ft-refute-labels/work/recompute.py | sha:e8bee51d5b53 | e8bee51d5b53 |  |
| code/ft-refute-rlfeat/lm.py | ft-refute-rlfeat | S14 | ~/wt/ft-refute-rlfeat/work/lm.py | sha:07c46bfa9348 | 07c46bfa9348 |  |
| code/ft-refute-rlfeat/recompute.py | ft-refute-rlfeat | S14 | ~/wt/ft-refute-rlfeat/work/recompute.py | sha:a29f4f96b6f7 | a29f4f96b6f7 |  |
| code/ft-refute-rlfeat/recompute2.py | ft-refute-rlfeat | S14 | ~/wt/ft-refute-rlfeat/work/recompute2.py | sha:694591c9f16c | 694591c9f16c |  |
| code/ft-refute-whoconverts/r1_desc.py | ft-refute-whoconverts | S40 | ~/wt/ft-refute-whoconverts/code/r1_desc.py | sha:53f88ed448af | 53f88ed448af |  |
| code/ft-refute-whoconverts/r2_confound.py | ft-refute-whoconverts | S40 | ~/wt/ft-refute-whoconverts/code/r2_confound.py | sha:80671c5371e1 | 80671c5371e1 |  |
| code/ft-refute-whoconverts/r3_calls.py | ft-refute-whoconverts | S40 | ~/wt/ft-refute-whoconverts/code/r3_calls.py | sha:e6af0d7c6ec4 | e6af0d7c6ec4 |  |
| code/ft-refute-whoconverts/r4_models.py | ft-refute-whoconverts | S40 | ~/wt/ft-refute-whoconverts/code/r4_models.py | sha:60d63c83c867 | 60d63c83c867 |  |
| code/ft-refute-whoconverts/r5_compare.py | ft-refute-whoconverts | S40 | ~/wt/ft-refute-whoconverts/code/r5_compare.py | sha:356d89b424f8 | 356d89b424f8 |  |
| code/ft-refute-whoconverts/r6_dedup.py | ft-refute-whoconverts | S40 | ~/wt/ft-refute-whoconverts/code/r6_dedup.py | sha:a9ed94c5b875 | a9ed94c5b875 |  |
| code/ft-rl-feat/rlf_assemble.py | ft-rl-feat | S14 | ~/wt/ft-rl-feat/code/rlf_assemble.py | sha:3858f7392d2f | 3858f7392d2f |  |
| code/ft-rl-feat/rlf_emo.py | ft-rl-feat | S14 | ~/wt/ft-rl-feat/code/rlf_emo.py | sha:9003469b4e32 | 9003469b4e32 |  |
| code/ft-rl-feat/rlf_prep.py | ft-rl-feat | S14 | ~/wt/ft-rl-feat/code/rlf_prep.py | sha:37588889a3c2 | 37588889a3c2 |  |
| code/ft-rl-feat/rlf_tag.py | ft-rl-feat | S14 | ~/wt/ft-rl-feat/code/rlf_tag.py | sha:8401d0db9be4 | 8401d0db9be4 |  |
| code/ft-rl-run/ftrl_cohort.py | ft-rl-run; ft-rl-run (RL-2 phone linkage) | -; S31 | ~/wt/ft-rl-run/ftrl_cohort.py | sha:d602c64415a5 | d602c64415a5 |  |
| code/ft-rl-run/ftrl_manifest.py | ft-rl-run; ft-rl-run (RL-2 phone linkage) | -; S31 | ~/wt/ft-rl-run/ftrl_manifest.py | sha:decd52906da9 | decd52906da9 |  |
| code/ft-rl-run/ftrl_select.py | ft-rl-run; ft-rl-run (RL-2 phone linkage) | -; S31 | ~/wt/ft-rl-run/ftrl_select.py | sha:a1d301709ec3 | a1d301709ec3 |  |
| code/ft-text2-oref/own_nums.py | ft-text2-oref | S25 | ~/wt/ft-text2-oref/work/own_nums.py | 6aa91f7 (work/ untracked; sha:53437333df7c) | 53437333df7c |  |
| code/ft-text2-oref/own_win.py | ft-text2-oref | S25 | ~/wt/ft-text2-oref/work/own_win.py | 6aa91f7 (work/ untracked; sha:5240eb972891) | 5240eb972891 |  |
| code/ft-whoconverts/wc_desc.py | ft-whoconverts | S38 | ~/wt/ft-whoconverts/code/wc_desc.py | sha:10247bc2c4a2 | 10247bc2c4a2 |  |
| code/ft-whoconverts/wc_logit.py | ft-whoconverts | S38 | ~/wt/ft-whoconverts/code/wc_logit.py | sha:2247b2ee55ad | 2247b2ee55ad |  |
| code/ft-whoconverts/wc_names.py | ft-whoconverts | S38 | ~/wt/ft-whoconverts/code/wc_names.py | sha:54f4eea68eae | 54f4eea68eae |  |
| code/ft-whoconverts/wc_perm.py | ft-whoconverts | S38 | ~/wt/ft-whoconverts/code/wc_perm.py | sha:fb3f22d45bc2 | fb3f22d45bc2 |  |
| code/ft-whoconverts/wc_report.py | ft-whoconverts | S38 | ~/wt/ft-whoconverts/code/wc_report.py | sha:1fd9523d8c2c | 1fd9523d8c2c |  |
| code/ft7-jevcheck/claims.py | ft7-jevcheck | S32 | ~/wt/ft7-jevcheck/work/claims.py | sha:db8606a4dcbc | db8606a4dcbc |  |
| code/ft7-jevcheck/jevcheck.py | ft7-jevcheck | S32 | ~/wt/ft7-jevcheck/work/jevcheck.py | sha:c8c10f0c3f8d | c8c10f0c3f8d |  |
| code/ft7-wholeref/allsteps.py | ft7-wholeref | S32 | ~/wt/ft7-wholeref/work/allsteps.py | sha:78ffb9ced30e | 78ffb9ced30e |  |
| code/ft7-wholeref/recompute.py | ft7-wholeref | S32 | ~/wt/ft7-wholeref/work/recompute.py | sha:4764ffb6103f | 4764ffb6103f |  |
| code/ft8-blocks-ref/chk.py | ft8-blocks-ref | S41 | ~/wt/ft8-blocks-ref/scratch/chk.py | sha:019483acf41e | 019483acf41e |  |
| code/ft8-blocks-ref/cov.py | ft8-blocks-ref | S41 | ~/wt/ft8-blocks-ref/scratch/cov.py | sha:85dcbb7c8076 | 85dcbb7c8076 |  |
| code/ft8-blocks-ref/shuf_seeds.py | ft8-blocks-ref | S41 | ~/wt/ft8-blocks-ref/scratch/shuf_seeds.py | sha:46ac0a84f701 | 46ac0a84f701 |  |
| code/ft8-build/ft8_build.py | FT8 build (cb-ft8-build) | S22 | ~/wt/ft8-build/code/ft8_build.py | sha:80d12401d12d | 80d12401d12d |  |
| code/pal-ft6/ft6_translate_compare.py | palimpsest-ft6 | S15 | ~/wt/pal-ft6/kit/reb/ft6_translate_compare.py | c4891121 (run1 commit per DONE.md; worktree HEAD now 4a2ad5e8) | 6221736a5f12 | REDACTED copy: 133 native-script runs replaced by <native-redacted>; not runnable as-is; original sha 6221736a5f12 |
| code/forest-lead/check.py | ft-engines-ref1 | - | /tmp/ref1/t/check.py | d296961 (checker outside repo; sha:42156a104e7d) | 42156a104e7d |  |

Producing scripts not staged (failed the scrub; see SCRUB-REPORT.md): 0.
