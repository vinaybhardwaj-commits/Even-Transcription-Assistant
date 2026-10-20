# ft-doctors DONE: FT5 (19 Oct 2026, v3 = seal fix, 17:50 IST)
Served by Opus 5.5 on Bedrock (global.anthropic.claude-opus-5-5). D split only, read date 2026-10-19. No doctor names in this file; names are in FT5-REPORT.md (admin-only).

**SEAL FIX (from ft-refute-doctors):**
- v2's pitches_by_doctor.tsv held 15 H-split consults (haiku_f01 source). Its filter mapped consults through 10.tsv only.
- Now every consult id goes through split_guard (pinned list sha 52959278edd8; consult -> 10.tsv + 10b.tsv key -> cluster -> lock). Only D is kept.
- Result: 180 candidates -> 145 D (ft6 83, haiku_f01 62), 35 H dropped, 0 unmapped.
- The episode table passes require_dev (0 H). A re-scan of the current outputs finds 0 H ids.
- The old files are moved to _to_delete/ (*.PRE-SEALFIX.*). They were not hard-deleted.
  - pitches/pairs: the in-place rerun overwrote them, so they were rebuilt with the old filter (identical size and counts: 160 ids, 3 pairs).
  - FT5-REPORT and DONE: copied there.

Inputs:
- labels.parquet v2, sha 0aefc00f425b (H14 final at >= 18 d).
- data/ft5a.tsv (sql/ft5a-casemix.sql, sha ec923df3b594).
- data/ft3b.tsv (severity).

## Headlines (DIRECTIONAL)
- **Doctor share of conversion variance within specialty, after case mix incl. severity:** latent ICC best estimate about 0-4%, upper bound about 7-13%.

  | | ML (Gauss-Hermite), profile 95% CI | VB |
  |---|---|---|
  | H14 | 0.0% (0-12.7%); n 833 episodes, 163 conversions, 18 doctors | 4.0% (2.1-7.5%) |
  | H90 | 0.0% (0-6.7%); n 425, 125 conversions, 12 doctors | 3.5% (1.6-7.7%) |

  - Unadjusted: ML H14 3.4%, H90 12.7%.
  - **The "~80% is the doctor" claim is not supported.**
- **Doctor LR test depends on covariates:**
  - H14 fixed-effect p 0.001 (none) / 0.013 (no severity) / 0.014 (full).
  - H90 p < 0.001 / 0.093 / 0.11. The refuter's set gives about 0.03, so the adjusted range is 0.03-0.11.
  - Random-effect LR (ML), adjusted: p = 1.0.
  - CV AUC gain from doctor: +0.016 (-0.016 to +0.063), not significant.
- **Top 4 specialties by non-converted volume** (H14, D, matured): GS 333 of 436, Gyn 159 of 189, Ortho 128 of 156, Uro 97 of 109. Together 717 of 798.
  - Lost conversions over about 11 months, D split: to the median about 18; +20% about 35; best-doctor ceiling about 127 (noise-inflated).
- **Dermatology = outcome coverage gap** (OPD procedures never billed as surgery and with no OT note), not 0% conversion.
  - 50 matured episodes at H14, 34 at H90.
  - Excluded from the doctor comparison; report it in the funnel as "outcome not observed".
- **Listening pairs: 2, both General Surgery (H14 and H90),** with 43 consult ids across the 3 doctors in FT5-REPORT.md. The full list is 145 ids in pitches_by_doctor.tsv.
  - H14 pair: low-doctor O/E 0.34 (CI 0.09-0.87). The O/E CIs only just overlap.
  - The Ortho pair dropped out after the seal fix. There are no Gyn or Uro pairs.

## Files (out/ft-doctors/, 0600 data)
- FT5-REPORT.md: admin-only, names.
- doctor_table.tsv, specialty_volume.tsv, pairs.tsv, pitches_by_doctor.tsv: uids only.
- results.json (ML + VB + ANOVA + LR), run.log.
- Code: ft5.py, ft5_analysis.py, ft5_tables.py.
- _to_delete/.
- Rerun: `~/.venv-forest/bin/python -I ft5.py && ~/.venv-forest/bin/python -I ft5_analysis.py`. The report is assembled from ft5_tables.py output.
