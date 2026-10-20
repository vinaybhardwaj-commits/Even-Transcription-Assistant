# VERDICT: PASS-WITH-FIXES

ft-refute-whoconverts (independent Opus refuter) on ft-whoconverts WHO-CONVERTS.md (sha of the code as listed in its Files section; checked 20 Oct 2026 12:07 IST).
D split only: I read features_D (asserted D), features_ft8 (1,233 rows = D), ft8-pull-a-day (uid set == D, asserted), calls_D, tags_D_jev, features_ale / features_all (asserted D), the frozen OOF jsons and the target outputs. I did not import forest_build (its load_F reads the f1 TSV, which holds H rows). I opened no H file. No identifiers, pincodes or doctor ids are in my outputs.
Counts: 0 blockers, 8 fixes, 8 notes. Every number that I recomputed matches. The fixes concern wording and interpretation (pincode timing, doctor gender, calls, Ale, the logistic claim) and duplicate tests.

## Findings

1. **note: D-only holds.** wc_* reads only D-only or asserted-D files. One gap in the Limits text: through forest_build.load_F, wc_desc, wc_perm and wc_logit read the whole hash-only f1 TSV (~/eta-data/forest/funnel/hash-only/f1-2026-10-19.tsv). That file contains H-split rows (cluster_key, split, ambiguous; no outcomes), which are then filtered to D. labels.parquet is only hashed. Nothing touches ft8/H or the sealed data.
   Fix: in Limits add "the f1 hash-only TSV (cluster_key/split/ambiguous, no outcomes) is read in full and filtered to D by the frozen ft-forest loader."

2. **note: The independent recompute matches (r1_desc.py, r5_compare.py).** For h14: n 1101 / 189, 104 tests, 19 flags; h90: 90 tests, 32 flags; Ale: 106 tests, 31 flags. Matching rows: specialty (GS 103/436, q 0.001; Derm 0/50, q 0.007; ENT 0/21, q 0.155), procedure group (none 22/224, MH 0.54 [0.33-0.90]; anorectal 47/172), doctor gender (m 165/852, f 24/249, MH 1.80 [1.05-3.08]), zone (Z1 125/601, MH 1.62; no pincode 57/462, MH 0.61), new 133/687 (q 0.081, MH 1.17), obesity 3/67 (MH 0.24 [0.07-0.78]) and eGFR 16/176 (MH 0.55 [0.32-0.97]). The sorted h14 q-vectors differ by at most 0.009; the gap comes only from the doctor permutation test. My doctor spread test uses a different statistic (G summed within specialty, 2,000 within-specialty shuffles) and gives p ≈ 0.0005 (q 0.008) against the target's 0.002, so the flag is robust. The day-7 call table (926 / 42) matches cell for cell, MH ORs included.

3. **fix: Duplicate tests inflate the count and the flags.** Three "tests" repeat another test's mask exactly:
   - procedure group "none" = procedures advised "0" (224 / 22)
   - calls "0" = first call "no call" (355 / 9)
   - connected "no" = talk time "0" (427 / 15)

   With them removed, h14 has 101 tests and 17 flags (not 19), h90 87 / 29, Ale 103 / 27. Returning-only obesity moves to q 0.102, which is no longer flagged. Calls "0" moves to 0.109. Z1 and no pincode (601 + 462 of 1101) are also near-complements (see note 16).
   Fix: drop these three levels from testing (show them, but untested), rerun wc_desc and wc_report, and update the header counts and summary 5 ("among returning patients nothing is flagged; obesity q 0.10").

4. **fix: The pincode is not cut at the advice date, and missing pincode is plausibly outcome-touched.** ft8-pull-a-day.sql line 1251 reads the current `individuals.pin_code` with no time cut. "Day-cut pull" applies to the other columns only. Missing pincode tracks record era and returning status:
   - 73% missing among returning patients vs 23% among new ones
   - 95-97% missing for Dec-Jan advice vs 21-33% for Jun-Oct

   Among h90 rows, missing is 42% for ≤14-day converters, 18% for 15-90-day converters and 57% for never-converters. That pattern fits a pincode filled in at the surgery admission. Adjusted for specialty, returning, procedure, doctor gender and month, the OR is 0.53 [0.32-0.87]. Within doctor (MH) it is 0.76 [0.51-1.12].
   Fix: in Limits and summary 3, say "pin_code is the value on file at pull time (20 Oct), not at the advice; registration may be completed during the surgery admission, so missing pincode may partly reflect the outcome; it also tracks record age (older and returning records lack it)". Drop "reflects how complete the registration is" as the explanation, or put this timing caveat next to it. Remove "record complete" from summary 10.

5. **fix: The doctor gender gap is not shown beyond chance at the doctor level.** There are 48 male and 28 female doctors, but only GS (1 female, 6 male doctors) and Gynaecology (10 female, 1 male) mix genders with real volume. A doctor-level permutation of gender within specialty gives p = 0.40 (MH 1.85). Without the largest doctor, MH is 1.65 [0.94-2.91]. The ⚑ q 0.007 and the MH interval treat episodes as independent.
   Fix: summary 2 should read "the episode-level gap persists within specialty, but it rests on one or two doctors per specialty; shuffling gender across doctors gives p = 0.40, so it cannot be told apart from individual-doctor differences". Add a footnote to the gender row that the q is episode-level.

6. **fix: Summary 5 has a wrong range and a knife-edge flag.** "The labs come close (q 0.10-0.17)" is wrong: returning-only creatinine has q = 0.47. Per finding 3, obesity among returning patients is unflagged after deduplication.
   Fix: "HbA1c and eGFR q 0.10, Hb and TSH 0.17, creatinine 0.47". The labs claim itself holds up: 171 of 176 eGFR-present rows are returning patients, and eGFR stays low after adjusting for specialty, returning, log prior-Rx count and age (OR 0.42 [0.20-0.87]; HbA1c 0.54 [0.28-1.04]; obesity 0.19 [0.05-0.69]). MH within specialty × returning gives eGFR 0.56 [0.30-1.04]. You may add this.

7. **fix: Summary 7 / 1b: the counsellors already knew for almost half the converters.** In the h14 day-7 rows, 19 of the 42 converters (45%) had a call before day 7 that was flagged outcome-revealing and dropped, against 109 of 884 non-converters (12%). That is direct evidence for the "counsellors chase patients already keen" reading, so state it. Dropping those calls is the conservative choice. Counting them would strengthen the gap (talk ≥ 2 min MH 2.40 [1.21-4.76]; calls 0 holds at 8/343). Only 12 "no call" rows (1 converter) had only dropped calls.
   Also, "42 converted on days 7-14" is wrong: the at-risk rule drops days_to_surgery ≤ 7, so it should be "days 8-14" (summary 7 and the 1b header).

8. **fix: Summary 9, the logistic vs forest claim, is fair only in part.**
   - (a) Design A compares against M2 (0.607). M2 is worse than the frozen Pulse-only forest M0 (0.634). The like-for-like result is logistic 0.638 vs forest M0 0.634; say so.
   - (b) Design B: −0.035 [−0.134, +0.059] is too wide to call "about as good". Write "not distinguishable; the interval allows the forest to be up to 0.13 better".
   - (c) In section 3, the "+ top 10" logistic beats M2 by +0.045 [+0.016, +0.075]. Selection optimism and M2 < M0 both feed that gap. The "clear" ORs of the top-10 inputs (Opus consult 1.29, doctor arousal spread 1.49, patient windows 0.57, HbA1c value 0.80, day of first call 1.37) are post-selection, so mark them "selected on the same data; not confirmatory".
   - (d) "Day of first call" is coded −1 for no call, so its per-SD OR mixes "called at all" with timing. Do not read 1.37 as "a later first call → more likely".

   I checked the code: the encoding (levels, medians, mean/SD) is fitted in-fold; the doctor rate is in-fold (an inner GroupKFold on the training rows, the training-row rate for the scored rows); the folds are D.folds, 5 repeats, the same as the frozen forest. The top 10 match the perm ranking.

9. **fix: The Ale artefact reaches beyond the October row.** 15 Ale rows are under 14 days old, and all 15 are positive (Ale counts a young row only if it has converted). If I drop them (age_days ≥ 14, n 1129), these Ale ⚑ disappear: Investigations ordered, Procedures 2+, circumcision, ENT, month 2026-10, and returning BP / Hb / IP. New vs returning becomes flagged.
   Fix: run the Ale column on rows with age_days ≥ 14 (or footnote these flags as artefact-sensitive), and say so under "How to read this".

10. **fix: Summary 10 and summary 1 use causal or prescriptive wording.**
    - "Conversion follows what was advised …" → "goes with".
    - "What they were advised … matters most" → "shows the largest differences".
    - "The doctor and process gaps are where follow-up would pay" is a recommendation that rests on causal leverage. Also, no process (call) row is flagged at h14, and the calls look reverse-driven (finding 7). Replace it with "the doctor differences are the strongest unexplained pattern and are worth a case review".
    - "Whether the patient's record is complete" mixes two opposite signs (more history → lower conversion; pincode on file → higher conversion) and leans on a timing-doubtful input (finding 4). Remove it.

11. **note:** Summary 1 says ENT converts at 0%. That is true, but the ENT row is not flagged at h14 (q 0.155). Fine as description; consider "(0 of 21, not flagged)".

12. **note: Permutation fidelity is confirmed independently (r4_models.py).** I rebuilt StratifiedGroupKFold(5, shuffle, 20261019 + rep) from features_D (y, cluster_key) for the frozen ids. The frozen OOF AUC per fold equals wc_perm's refit base AUC to 0.0 on all 10 folds in both designs. There are 30 draws per input. 0 of 161 (A) and 0 of 221 (B) intervals lie above 0. The 5e-7 maximum difference is the rounding of the stored OOF. The shuffle is sound: one column at a time in the held-out fold, with the training-fold doctor rate; shuffling doctor_id moves rate and volume together, as disclosed. The interval is the spread of draws across folds and shuffles. Limits says so ("not CIs"); summary 8's "leans on" is acceptable. Note that the importance is measured in M2, which underperforms M0.

13. **note:** The logistic regression is in-fold and on the same folds (see finding 8). C = 1 is fixed and disclosed.

14. **note: Timing of the other inputs is OK.**
    - payer_prior: last appointment strictly before the Rx day (ft3d-payer-prior.sql). It needs a UHID, so "none" also means no UHID.
    - Labs: result_date < rx_date. The 1970-sentinel fix is in the file (counts 261 / 279 / 230 / 191 / 237 match the ft8 refute's post-fix numbers). The upload-time caveat (a pre-Rx-dated report uploaded later) remains; the direction (lab-havers convert less) argues against leakage.
    - Calls: day_from_rx < 7, with outcome-revealing calls (Haiku verified, unverified and Jev-added, all with outcome_revealed = True) dropped.
    - n_prior_flagged: strictly before the consult. Its OR of 6.26 is the largest in design A; consider mentioning it in summary 9.

15. **note:** zones_map_LOCAL.tsv puts 3-digit pincode prefixes in the shared out folder. It is 0600 and disclosed, but it would be better kept outside the out tree (the lab box-local data dir).

16. **note:** Z1 and no pincode are near-complements (601 + 462 of 1101) and count as two tests of almost the same split. Fold them into one when deduplicating (finding 3).

## Exact fix list for mx-ft-whoconverts
- wc_desc: untest the duplicate levels (finding 3), optionally merge Z1/no-pincode, and run Ale on age_days ≥ 14 (finding 9). Rerun wc_desc and wc_report.
- WHO-CONVERTS summary: rewrite 2, 3, 5, 7, 9 and 10 as given in findings 4-10. Header counts: 101 / 17 (h14).
- Limits: add the pincode timing (4), the f1 read (1) and the post-selection ORs (8c, 8d).

## My code (~/wt/ft-refute-whoconverts/code, 0600; ~/.venv-forest/bin/python -I) and outputs (this folder, 0600)
- r1_desc.py 53f88ed448af (own recompute: all rows, BH, G-statistic doctor test, day-7 calls); r2_confound.py 80671c5371e1 (gender at doctor level, labs, pincode, Ale); r3_calls.py e6af0d7c6ec4 (calls with and without the outcome-revealing calls); r4_models.py 60d63c83c867 (perm/logit fidelity); r5_compare.py 356d89b424f8; r6_dedup.py a9ed94c5b875.
- Outputs: r1_desc.json, r2_confound.json, r3_calls.json, r4_models.json.
