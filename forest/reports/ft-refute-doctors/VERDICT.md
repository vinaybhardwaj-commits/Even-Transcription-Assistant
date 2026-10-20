# ft-refute-doctors VERDICT on FT5 (ft-doctors v2 DONE.md, 17:05 IST)
Refuter: Opus 5.5 on Bedrock (global.anthropic.claude-opus-5-5), 19 Oct 2026. D split only, read date 2026-10-19. No doctor names here; doctor uids are cut to 6 characters.
Inputs: labels.parquet v2 (sha 0aefc00f425b, checked), data/ft5a.tsv, data/ft3b.tsv, S5 **clean** copies (eta-data/forest/funnel/s5-clean, 1,938 rows), ft6-candidates.txt, the p2v2 and rf775 haiku_f01 files, p1/linked.jsonl, and the split pins (lock-2026-10-18.tsv, clusters, 10.tsv + 10b.tsv).
I wrote all of my own code (glmm.py, pairs.py, load.py) and reused none of the lane's .py.

## VERDICT: **PASS-WITH-FIXES**
These conclusions hold:
- "The ~80% doctor claim is not supported."
- The top-4 volumes.
- Dermatology is a data artefact.

These must change before the numbers go to V:
- (1) Remove the 15 H-split pitch consults (this breaks the seal).
- (2) Drop the Ortho listening pair.
- (3) Replace the "95% CrI" on the doctor share with a frequentist interval that includes 0, and say that the point estimate depends on the prior and the covariates.
- (4) Downgrade the GS H14 contrast so it is no longer called "credible".
- (5) State the Dermatology cause precisely: the procedures are not in KX billing at all.

## (a) Within-specialty doctor share of variance (latent ICC, doctor random intercept, specialty fixed)
My method: marginal ML GLMM. I coded it myself with 25-node Gauss-Hermite quadrature and analytic gradients. Intervals are a profile-likelihood 95% CI and a 200-replicate parametric bootstrap. The p-value is a boundary LR test of sigma = 0 (0.5·χ²₁). I also fitted the same design with statsmodels VB to check the lane's numbers. Eligibility is the same as the lane's: doctor n >= 10, specialty with >= 2 doctors and >= 1 conversion. My eligible n matches theirs exactly: H14 n 833 / 163 positives / 18 doctors / 4 specialties; H90 n 425 / 125 / 12 / 3 (Uro drops out).

Case-mix levels:
- **lite**: age, age², sex, payer, prior Rx, ICD count and missing flag, investigations and missing flag, obstetric flag, quarter. This is close to the lane's set, without their procedure classes.
- **full**: lite plus first-ICD chapter (the SWARM says "ICD counts/chapters"), a no-procedure-named flag, and the number of named procedures.

| | Theirs (VB, prior vcp_p=1) | Mine ML, unadj | Mine ML, lite | Mine ML, full | Mine VB p=1 / p=0.5 on my design (lite) |
|---|---|---|---|---|---|
| H14 | unadj 5.6%; **adj 4.0% (CrI 2.1-7.5)** | 3.4% (profile 0-16.9; boot 0-7.5), p 0.10 | 2.7% (0-18.4; boot 0-6.0), p 0.22 | **0.0%** (0-16.9), p 1.0 | 5.8% [3.1-10.6] / 9.5% |
| H90 | unadj 13.7%; **adj 3.5% (1.6-7.7)** | 13.4% (1.4-47.7; boot 0-24.4), p 0.006 | 8.0% (0-40.4; boot 0-20.4), p 0.03 | **0.0%** (0-8.4), p 1.0 | 11.7% [5.6-22.7] / 14.8% |

- When I run VB with their prior on my design, I reproduce their unadjusted H14 figure to the third decimal: 0.0560 vs 0.0560. The pipeline matches; the inference method is what's wrong.
- **Fix 3: the lane's intervals are artefacts of the method.**
  - `fit_vb` with vcp_p=1 puts a N(0,1) prior on log-SD. With only 12-18 doctors, the VB posterior on log-SD is both pulled by the prior and too narrow. That is why every "CrI" excludes 0.
  - Changing the prior to vcp_p=0.5 moves the ICC by about 1.6-2x (H14 lite 5.8% → 9.5%).
  - By ML, no adjusted configuration rejects sigma = 0 at H14. At H90 the result depends on the covariates: lite gives p 0.03 and full gives p 1.0.
- With the full case mix (ICD chapter plus procedure-named flags), the doctor variance goes to **0** at both horizons.
  - Caveat: what a doctor chooses to flag or code is partly the doctor's own behaviour, so "full" may over-adjust. Read lite and full as brackets.
- Including all doctors (nmin 1) gives a similar picture:
  - H14: n 890 / 173 positives / 34 doctors; unadj 5.3%, lite 3.8%, full 3.5%; all p >= 0.06.
  - H90: n 539 / 139 / 29; unadj 15.8%, lite 11.3% (p 0.015), full 0.0%.
- The simulation-based ICC on the probability scale (Goldstein method B) is roughly half the latent ICC: H14 unadj 1.8%, lite 1.5%; H90 unadj 8.7%, lite 5.4%.
- **What should be said instead:** the case-mix-adjusted doctor share is **about 0-6% at H14 and about 0-11% at H90 (point estimates), with an upper 95% bound of about 17-18% at H14 and about 40% at H90 (lite)**. It is DIRECTIONAL. "~80% is the doctor" is firmly rejected. A specific figure like "4.0% (2.1-7.5)" is not supported.
- A minor point: the lane takes procedure names from the **raw** .bc/out exports (ft5.py from_labels), which lose 43 rows, instead of the s5-clean copies. This only affects their pclass covariate.

## (b) Top-4 specialties by non-converted volume (H14, D, matured >= 18 d, from labels.specialty)
| | Theirs | Mine |
|---|---|---|
| General Surgery | 333 of 436 | 333 of 436 (103 converted) |
| Gynaecology | 159 of 189 | 159 of 189 (30) |
| Orthopaedics | 128 of 156 | 128 of 156 (28) |
| Urology | 97 of 109 | 97 of 109 (12) |
| Specialties with n >= 30 | 717 of 798 | 717 of 798 (GS, Gyn, Ortho, Uro, Derm 50, GI 31) |

**PASS, exact.** The 798 includes Dermatology's 50, which per (c) are not real non-conversions. Footnote that, or use 748.

## (c) Dermatology 0 conversions: a **label/source artefact**, plus flag noise
- D split: 58 flagged Dermatology episodes. 50 are matured at H14 and 34 at H90. 0 conversions. 5 doctors (24/21/8/3/2 episodes).
- In S5 (clean), **0 of 58** have any OT note, any Surgery/IP-Package bill, or any IP admission.
- The S5 query (sql/f1-s5-*.sql) keeps only `kx_clinical_template_ot_notes`, `kx_billing_records` with `service_type IN ('Surgery','IP Package')`, and `kx_ip_admissions`.
- The named Dermatology procedures are office procedures done in the OPD:
  - PRP injection for scalp: 10
  - cauterisation: 4
  - laser for DPN/skin tags: 2 (+1 with intralesional steroid)
  - sebaceous cyst / mole / ingrowing-nail excision, toe-nail avulsion, RFA, chemical peel: 1-2 each
- **The confirmation pull is back:** data/ftref-derm-billtypes.tsv (gating-lead, sha f6002365dbf3). It counts all flagged Rx from the 5 Dermatology doctors, Dec-Sep, **D+H combined, aggregate only**, with any bill line in Rx day .. +90 d:
  - Pharmacy 12; IP Consultation, Pathology, Administration, Procedure, Room Rent, Surgery 1 each.
  - **0** carry a derm-like item (PRP, cautery, laser, peel, excision, wart, mole, nail).
  - The single Surgery bill is not in the D split, where S5 has 0.
- So these procedures do **not appear anywhere in kx_billing_records**, under any service type. The most likely explanation is that the Dermatology clinic bills outside KX, or does the procedures without a KX bill. Either way the outcome cannot be observed from the HIS.
- Separately, **34 of 58 (59%)** have `requires_surgery_or_procedure` = true but **no procedure named**. That is flag noise. Across the D split, flagged Rx with no named procedure convert at 24/228 at H14.
- Conclusion: the 0 is a **data-source artefact** (outcome not observable), compounded by flag noise. It says nothing about the doctors. **Fix 5:**
  - Exclude Dermatology from conversion denominators and from "lost conversions".
  - Label it "outcome not observable in KX (no derm procedure bills, OT notes or admissions)".
  - Ask forest-lead/ops where Dermatology procedures are billed.

## (d) Listening pairs
My pitch set uses the same sources: ft6 plus Haiku p_yes >= 0.5 from p2v2 and rf775, mapped through linked.jsonl. That gives 180 consults.
- **I mapped each consult to a split through both 10.tsv and 10b.tsv; 35 are H.**
- The lane checked only 10.tsv, which covers flagged-Rx consults only. Consults with no flagged Rx were therefore treated as D.
- **Fix 1 (seal): 15 of the lane's 160 pitch consult ids belong to H-split patients.** They are spread across 10 doctors: IM 3; Ortho csYMPj 2, Tbvyk1 1, FP1ces 1; Uro 1awHj0 2, JLqKUj 1; unknown 2; Gyn, ENT, CNI 1 each. They must be dropped from pitches_by_doctor.tsv before anyone listens. The correct D list has **145 ids**.

| Pair | Theirs | Mine (D-only pitches; own case-mix O/E, Byar 95%) |
|---|---|---|
| GS H14 | high 8ih9F6 O/E 1.06 vs low 0q9pSZ **0.34 (0.09-0.87)**, 15/11 pitches | lite: 8ih9F6 1.09 (0.85-1.37) vs 0q9pSZ **0.38 (0.10-0.98)**. Full: high becomes mGXTED 1.22 (0.65-2.08), low 0q9pSZ 0.36 (0.10-0.91). Pitches 15/17/11. |
| Ortho H14 | csYMPj 1.45 (6 pitches) vs Tbvyk1 0.96 (16) | **No pair.** csYMPj has only 4 D pitches; its 6 included 2 H consults. **Fix 2: drop.** |
| GS H90 | 8ih9F6 1.00 vs mGXTED 0.85 | full: 1.00 vs 0.83 (0.33-1.72); lite: 1.08 vs 0.48 (0.19-0.99). All CIs overlap. |
| Gyn / Uro | none | none. Gyn has one doctor with >= 5 pitches (FxzVVv, 10). Uro 1awHj0 has 3 D pitches (5 including H). |

- **Fix 4: the GS H14 low doctor is not a credible contrast.**
  - The doctor has 4 conversions out of 47 against 10.4-11.2 expected. One-sided Poisson p is 0.013-0.022.
  - Selecting the lowest of 18 doctors makes that p 0.23-0.40 after a ×18 correction. The Bonferroni Byar upper bound is 1.28-1.39, so 1 is inside it.
  - My full-adjusted GLMM shrinks every doctor to about O/E 1.
  - The pair is still a reasonable thing to listen to as a qualitative contrast, but should not be presented as evidence of a doctor effect.
- In total, 10 doctors have >= 5 D pitches; the lane reported 12, which included H pitches.

## Number-by-number
| Item | Theirs | Mine | Status |
|---|---|---|---|
| H14 eligible n / positives / doctors | 833 / 163 / 18 | 833 / 163 / 18 | match |
| H90 eligible n / positives / doctors | 425 / 125 / 12 | 425 / 125 / 12 | match |
| H14 adj ICC | 4.0% (2.1-7.5) | 0-2.7% ML (profile upper about 17-18%); p >= 0.2 | interval wrong |
| H90 adj ICC | 3.5% (1.6-7.7) | 0-8.0% ML (upper 8-40%); p 0.03 (lite) / 1.0 (full) | interval wrong |
| H14 / H90 unadj ICC | 5.6% / 13.7% | 3.4% / 13.4% (ML); 5.6% / 13.7% (VB) | method-dependent |
| MOR adj | about 1.4 | 1.0-1.33 (H14), 1.0-1.67 (H90) | overstated |
| Top-4 non-converted | 333/159/128/97 | 333/159/128/97 | exact |
| Derm | 50 H14 / 34 H90, 0 conversions | 50 / 34 / 0; S5 has no OT, bill or admission for any of them; 34/58 have no procedure named ; KX billing shows 0 derm procedure bills | source artefact |
| Pitch ids (D) | 160 | 145 (15 of theirs are H) | seal fix |
| Pairs | 3 | 2 (GS H14, GS H90) | Ortho pair dropped |

## Files (this directory, 0600 data)
- glmm.py, glmm_results.json, glmm.log
- pairs.py, pairs_refute.tsv, doctor_oe_refute.tsv, pitches_refute.tsv (with a split column)
- load.py
- ../../../sql/ftref-derm-billtypes.sql
Rerun: `OMP_NUM_THREADS=2 ~/.venv-forest/bin/python glmm.py 200; ~/.venv-forest/bin/python pairs.py` (about 40 min on a loaded the lab box).
