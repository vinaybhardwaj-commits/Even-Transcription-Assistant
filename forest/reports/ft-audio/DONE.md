# ft-audio DONE v2 (FT4, Ale label primary), 19 Oct 2026. Served by Claude Opus 5.5 on Bedrock (global.anthropic.claude-opus-5-5)
DIRECTIONAL. D split only, every row through split_guard (0 H). Outcomes: labels.parquet v2 (0aefc00f425b) for expand anchors + ft4a (c7021cd608e0, read 19 Oct) for non-anchors; agree 49/49 on overlap.
- Cohort: features_all (137) + ft-audio non-anchors (76) = 213 consults -> 198 patients (1 row per patient, strict episode credit).
- ALE label (primary): n 139 / pos 24 / 21 doctors. Sensitivity: Ale >= 14 d n 130 / 15; h14 (>= 18 d) n 114 / 12; h90 n 0 (nothing 94 d old until ~12 Dec).
- Forest (Ale): audio_f07 AUC 0.71 [0.58, 0.84]; audio_nof07 0.71 [0.57, 0.84]; pulse_only 0.73 [0.61, 0.85]; audio minus pulse -0.02 [-0.09, +0.05] = no evidence audio adds. Only specialty importance CI > 0 (0.10 [0.01, 0.19]). Specialty and doctor are confounded (15/24 positives from 2 doctors).
- f07 standalone AUC 0.72 [0.59, 0.83] (n 133); leakage-suspect, kept out of headline. With/without f07 models equal.
- DESCRIPTIVE (Ale, conv vs non, Jev >= 0.5): f06 practical detail 83% vs 45% (Fisher p 0.001; GS-only p 0.005), f02 urgency 46% vs 18% (p 0.007), f18 cost 33% vs 13% (p 0.03), f03 procedure named 29% vs 53% (p 0.04, reversed). Talk time, turns, interruptions, valence/arousal, language: no difference (p > 0.2). English 19% vs non-English 16% (p 0.82). Unadjusted screening p values.
- Refute fixes 1-5 applied (see FT4-REPORT.md section). v1 >= 14 d positives = 6 under strict credit.
- Final: features_all already carries expand's Ale label (their 99 / 20 = my expand subset); rerun only if expand changes again.
Files: FT4-REPORT.md (v2), FT4-REPORT-v1.md, DONE-v1.md, features_ale.parquet (3f0c529447e2), ale_cohort.json, m2_*.json, DESC_*.md, QUOTES_ale.md (admin-only), code/.
