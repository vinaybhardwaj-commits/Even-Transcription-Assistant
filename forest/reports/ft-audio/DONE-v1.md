# ft-audio DONE (FT4), 19 Oct 2026, served by Claude Opus 5.5 on Bedrock (global.anthropic.claude-opus-5-5)
DIRECTIONAL. D split only. H14 at age >= 18 d (forest-lead ruling). Outcomes: ft4a pull read 19 Oct 2026 (sha c7021cd608e0); agrees with labels.parquet v2 (0aefc00f425b) 27/27 on overlap; doctor prior uses v2 (results unchanged).
- Cohort B: 135 recorded surgery-discussion consults (ft6 83 + RF775 52) -> D 125 -> eligible 58 consults / 57 patients / 13 doctors / 5 H14 positives (5 patients). At >= 14 d: 77 / 75 / 14 / 7.
- audio8 RF (8 features) AUC 0.79 [0.55, 0.96]; Pulse-only (specialty, doctor prior, age, payer) 0.88 [0.71, 1.00]; delta -0.09 [-0.21, -0.01]. n 58 / 5 pos.
- Permutation importance: specialty 0.21 [0.03, 0.46] is the only CI above 0 in audio8. In the item model Jev f07 (concrete booking step/date) 0.32 [0.10, 0.52]; raw f07 AUC 0.91; 5/18 f07-yes converted vs 0/40 (reverse-causality caveat).
- All 5 positives are General Surgery (5/19 vs 0/39), from 2 doctors.
- Coverage (eligible 58): language 58, talk-time/turns 56, Odyssey valence 54, valence change 14, Jev items 58, payer 15, age/sex/Rx id 58.
- Engines run by ft-audio: Odyssey on the lab box GPU (2,394 windows, 0 err), Jev v2 gap-fill (25 consults, 0 fail). Not run: emotion2vec, Clef.
Files: FT4-REPORT.md, features.parquet (sha 9a1802ac873e), COVERAGE.md, model_age18.json, model_age14.json, code/.

## Seal check, 19 Oct 2026 (forest-lead / newcat-deputy request)
- Every consult/clip id in every out/ft-audio file (regex scan, incl. ft6, RF775 and haiku_f01-sourced ids) -> consult_uid -> 10b patient_key -> cluster -> split_guard (pin 52959278edd8). Code: code/seal_check.py.
- Found: the 10 RF775 H consults were still in 2 intermediate files: base.parquet (10 consults, with their convert-lead Jev/Haiku scores) and rf775_members.jsonl (10). Both were moved to _to_delete/ and regenerated D-only (filtered at write time through split_guard; unknown keys fail closed).
- features.parquet, features_age14.parquet, audio_feats, emo_*, jev_gapfill, model inputs/outputs: 0 H before and after. No H audio, emotion or Jev was ever computed. (The track inventory listed file names only for all 135 consults; no H track content was read.)
- After the fix: 0 H ids in any out/ft-audio file outside _to_delete/. features.parquet sha 9a1802ac873e unchanged, so every model number is unchanged.
- Note: cb-ft-cohortb-expand also flags f07 as leakage (the decision is often fixed in the room) and drops its AUC to 0.695 on an expanded set (n 80, 12 positives). Treat the f07 result in FT4-REPORT as leakage-suspect, not as a driver.
