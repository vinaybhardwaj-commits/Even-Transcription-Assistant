# Surgery conversion: first read for Ale (FAST TRACK FT7). v6 FINAL, forest-lead, 20 Oct 2026 (the lab box clock)
Status: v6 FINAL (20 Oct, 15:52 IST), delivered for the 16:00 V review; includes the yes-to-surgery drop (3d, newcat-orch 15:53). The V review (11:20 and 12:40) added sections 3b "What is said", 3c "Who converts" and 3d "How the conversations go" before the model results, plus a breakdown of which medical-history parts hurt (4d). They come from lanes ft-lexical, ft-whoconverts, ft8-blocks, ft-dialog-runo, ft-dialog-consult, ft-docstyle and ft-convo, each refuted (PASS-WITH-FIXES or CONFIRMED WITH CAVEATS) with fixes applied. The model results and the held-back test are unchanged from v5. v6 whole-report refute (round 2): PASS-WITH-FIXES, all 20 fixes applied. Jev claim check of the summary: PASS (0 unsupported). Sections 3b-3d and 4d are post hoc and descriptive.
Every number carries a source tag [Sx]. The tag list at the end gives the file path on the lab box and its sha256 (first 12 characters). Each number names n, positives and split.
The held-out set H (lock RD0-2026-10-18-52959278edd8) was used exactly once, at 10:00:55, for the frozen at-prescription models (section 8). Nothing was trained or tuned on it, and nothing changed after it.
Number of comparisons: each section states how many tests its claims come from. Small n is DIRECTIONAL. A gain is claimed only if its 95% CI excludes 0.

## 1. The short version
1. **Most surgeries happen fast.** Of 214 matured surgeries, half happened within 6 days and 76% within 14 days of the consult [S1, S19]. A 14-day label is a fair fast read; it misses about 1 in 4. We keep 90 days as the reference.
2. **Who converts: the largest differences are in what was advised and by whom** (post hoc, descriptive) [S38, S40]. General Surgery converts at 24%, anorectal procedures at 27%, prescriptions with no procedure named at 10%. Doctors' rates differ within the same specialty (11% to 38% in General Surgery, after shrinking towards the specialty average), though most of that is case mix (item 7). Patients with no pincode on file convert at 12% vs 21%, but the pincode is today's value and may be filled in at admission. No link with age, sex, payer, day or language.
3. **What is said: outside paperwork, little in the words reliably separates converters** (post hoc, descriptive; 141,932 comparisons) [S39, S42]. The biggest word difference is insurance and pre-authorisation talk, which follows a yes. With it removed, almost no single word survives correction. Non-converters mention alternatives and delay more often, but once call windows are matched only "going elsewhere" in summaries stays flagged (2% vs 13%), and some of those statements are the non-conversion itself. The leads worth testing are counsellor reassurance and doctors explaining the stay. Converters' doctors explain recovery and the stay more often (75% vs 30% of consults).
3b. **How the conversations go: patients who push back rarely convert, but late in the window; doctors explaining the stay goes with surgery; a whole-conversation checklist does not improve prediction** (post hoc, descriptive; small numbers) [S49, S44, S45, S46].
3c. **Many who say yes do not get to surgery in time:** of 134 labelled recorded consults, 60 reached a yes (45%), but only 24 of those 60 had surgery within 14 days (40%). The paperwork and scheduling inside that step cannot be seen from consults alone (post hoc, descriptive) [S46].
4. **Pulse data alone predicts conversion weakly. It holds at 14 days on patients the model never saw (0.67), less so at 90 days (0.62 vs 0.69 on dev, 64 conversions).** Cross-validated AUC about 0.63 at 14 days and 0.69 at 90 days; on the sealed test patients 0.67 and 0.62 [S26, S28]. Almost all of it is which specialty, doctor and procedure. It ranks patients a little but does not give usable probabilities.
5. **Adding everything else did not provably help. Medical history made it worse.** A forest with every layer the RF doc lists (medical history before the prescription, call activity, what was said on calls, who spoke, voice emotion from three engines, Clef, and an AI reading of the transcripts) was pre-registered, frozen and tested one layer at a time [S26, S27]:
   - Medical history (FT8) lowered AUC: -0.024 at 14 days on dev (significant after correction; -0.019 at 90 days, not significant), and -0.042 on both labels on the sealed patients, scored once (both intervals below zero) [S28]. [S26]
   - No single part of the history is to blame. The loss is consistent with dilution: 42 shuffled columns with no link to the outcome cost on average about as much (post hoc; 5 shuffle seeds with a spread of about ±0.02-0.03, so dilution cannot be told apart from a weak harmful signal) [S37, S41]. A plain logistic regression on the Pulse inputs does about as well as the Pulse-only forest at the prescription (0.638 vs 0.634) [S38, S40].
   - At day 3 after the prescription, no layer helps.
   - At day 7, calls help a little (+0.03 to +0.08, mostly call activity and what was said); nothing survives Holm correction within the 54 call-layer tests.
   - Recorded consults (138 patients): nothing adds over Pulse.
6. **An AI reading the call transcripts looked better than the forest, but mostly because it reads the hospital's own process.** Opus scored 0.79-0.84 on patients with transcripts at day 3. With insurance, pre-auth and payment talk removed, it is level with the forest, apart from a 90-day point lead whose interval spans zero [S29].
7. **It is mostly not the doctor.** Within a specialty, after case mix, doctor-to-doctor differences explain about 0-6% of who converts (upper bound about 18%) at 14 days; at 90 days about 0-11% (upper bound about 40%, only 12 doctors) [S6], nowhere near 80%. Raw rates differ more (item 2), but most of that is the patients each doctor sees.
8. **What patients say on calls:** non-converters talk about timing (35% vs 17%), other hospitals (11% vs 1%) and second opinions; converters talk about insurance (61% vs 31%). Cost comes up about equally (Jev-checked) [S24].
9. **Today's English translation loses some refusals:** on 160 negation-heavy consult turns, about 1 in 20 clean dropped-"no" errors [S20]. By ruling, meaning-reading features will use a better translator; in this report, consult features built on today's English were left out of the models.
10. **What would change this:** more conversions to learn from (recordings: about 60 early conversions by mid-December; the EHBR recorder speeds this), 90-day outcomes maturing over Dec-Jan, and a better English track. The first next step is to drop medical history from the 1 Nov model and keep the Pulse baseline. [S8, S2, S27]

## 2. When do conversions happen? (FT1; refuted PASS-WITH-FIXES, fixes applied [S19])
- Data: 978 doctor-flagged surgery recommendations (Rx) dated 18 Dec 2025 - 17 Jul 2026, all at least 94 days old on 19 Oct, forming 883 matured patient-episodes [S1, S19]. Development and held-out patients are pooled here: this is a counts-only timing check, and no model is fitted on it.
  - 214 episodes became a surgery at Even within 90 days (the longest gap seen is 82 days), each surgery counted once per patient cluster and surgery date. That is 214 of 978 Rx (21.9%) or 214 of 883 episodes (24.2%).
  - Exclusions per the agreed rules: deliveries, staged second procedures, same-day minor procedures.
- Half of the surgeries happen within 6 days of the consult [S19].

| Specialty (of the Rx doctor) | Rx | Episodes | Surgeries | Median days | Done by day 7 | by day 14 (95% CI) | by day 30 | by day 60 |
|---|---|---|---|---|---|---|---|---|
| All | 978 | 883 | 214 | 6 | 58% | 76% (70-81) | 89% | 97% |
| General Surgery | 405 | 391 | 128 | 5 | 63% | 80% (72-86) | 91% | 98% |
| Orthopaedics | 148 | 127 | 29 | 8 | 48% | 72% (54-85) | 83% | 93% |
| Gynaecology | 139 | 113 | 25 | 8 | 48% | 68% (48-83) | 92% | 100% |
| Urology | 98 | 89 | 16 | 6 | 63% | 75% (51-90) | 94% | 100% |
| Other specialties | 188 | 163 | 16 | 7.5 | 50% | 69% (44-86) | 75% | 94% |
Source: independent recompute [S19], which reproduces every lane cell [S1] exactly except the Urology median (the lane script took the upper middle value: 7; the true median is 6). Shares are of the surgeries in each row.
- Development split only: 150 surgeries, 75% (67-81) by day 14.
- **Meaning for the label.** A 14-day label (Ale) catches about 3 in 4 conversions. Orthopaedics and Gynaecology look slower, but their intervals overlap General Surgery's (Fisher test, GS vs Ortho+Gyn, p 0.18), so the difference is directional only. We use H14 for the fast first read and keep H90 as the reference label.
  - Our H14 counts a patient as a non-converter only once the Rx is at least 18 days old (14 days plus a 4-day billing lag), matching the 90-day rule (94 days) [S3, S2 issue 1].
- Caveat: surgery done at another hospital is invisible and counts as no surgery.

## 3. The funnel so far (funnel F1; dev split D; Opus recompute matched exactly) [S16]
- Of 1,233 patient-episodes [S16]:
  - 74% got a counselling lead (881/1,193 eligible from Jan);
  - 71% received at least one counsellor call (845/1,193);
  - 23% of the mature ones had the surgery (150/659; 452 still too recent).
- Bookings are only traceable to the prescription from 25 Sep. The early lower bound is 18% booked (25/136). [S16]
- 8 episodes are excluded from rates because the phone contact is shared by two patients. [S16]

## 3b. What is said, and what goes with conversion (V review, 20 Oct; DEVELOPMENT split only; post hoc and descriptive: associations, not causes; refuted PASS-WITH-FIXES, corrections applied here) [S39, S42]
- **What was analysed.** The words of the Runo counsellor calls (transcripts and counsellors' summaries) and of the recorded OPD consults, split by speaker (counsellor, patient; doctor, patient). Converters were compared with non-converters on Ale's label (14 and 90 days secondary). Single words and 2-3 word phrases were scored, plus 16 themes listed in writing before any outcome was looked at (coded by Haiku with verified quotes; a 15% sample was cross-checked by Jev, agreement kappa 0.29-0.93).
  - Calls used are only those before the surgery, with outcome-revealing calls dropped. Everything is repeated with insurance, pre-authorisation, payment, booking and date talk removed.
  - 141,932 comparisons were made in total. A result is flagged only at a false-discovery rate of 10% within its family.
- **The biggest word difference is paperwork, and it follows a yes, not before it.** In converters' calls, counsellors talk far more about insurance, approval, claim, card, Aadhaar, PAN and cashless. Insurance comes up in 75% of converters' call episodes vs 44% of non-converters'. This is the pre-authorisation process after a decision.
- **With that talk removed, almost no single word survives correction** (2 of 27,902 terms on Ale's label: "Monday", which is scheduling the mask missed, and fewer "follow up" chase calls in the summaries).
- **What non-converters say: a lead, weaker than it first looks** [S39, S42]. With all text, non-converters more often mention a second opinion (0% vs 13% of call episodes), another hospital or their home town (2% vs 16% of summaries) and "later" (19% vs 35% of summaries). Two things inflate these gaps:
  - converters' call windows stop at their surgery, while non-converters keep getting late "chase" calls;
  - some statements say the patient has already chosen or gone to another hospital, which is the non-conversion itself (the outcome screen removed only "booked / done at Even" calls).
  - With windows matched (each non-converter cut at a converter-like day), only "going elsewhere" in summaries stays flagged (2% vs 13%). At the day-3 landmark nothing is flagged. The direction agrees with the call-tag findings in section 4b, but they are not independent (same summaries).
- **In the consult room, converters' doctors more often explain recovery and the hospital stay**: 75% of converters' consults vs 30% of non-converters' with admin talk removed (24 converters). As with FT4's "practical detail" item, this may be talk that follows a decision already made in the room.
- **Counsellor reassurance** ("don't worry", "it is simple") is more common in converters' calls: 46% vs 26%, and 46% vs 24% with windows matched. It loses its flag when quotes containing admin words are dropped, and at the day-3 landmark (52% vs 25%, only 23 converters). The two AI coders agree only moderately on this theme (kappa 0.43). It is a lead to test, not a finding [S39].
- Converters' summaries name the doctor less often (58% vs 78%; 58% vs 72% with windows matched, no longer flagged): this is mostly the same late-chase-call effect [S39].
- **What did not differ:** the doctor's own words (none flagged on Ale's label with admin talk removed); cost being quoted; risks or the procedure being explained; empathy; follow-up dates offered; patient fear; family decisions; the call's main language; code-mixing (one script measure is flagged, but the effect is negligible).
- **Counsellor activity:** counsellors call converters more in the first 3 days (median 2 vs 1 calls; at least one connected call 61% vs 48%) [S39], with no difference in talk share or question rate. Interest probably drives the calls, not the reverse. Individual counsellors could not be compared: the data these lanes used has no Runo agent id. The linkage repair has since found one in the recording keys (232 agents), not yet used [S43].
- **Bottom line.** Outside paperwork, little in the words reliably separates converters once window length and leakage are handled. The leads worth a test on new patients are counsellor reassurance, doctors explaining the stay and recovery, and early mentions of going elsewhere. None is shown to cause conversion [S39].

## 3c. Who converts (V review, 20 Oct; DEVELOPMENT split only; post hoc and descriptive: associations, not causes; refuted PASS-WITH-FIXES, corrections applied here) [S38, S40]
- **How to read this.** Conversion rates (14-day label unless stated) with 95% intervals. 100 characteristics were compared for the 14-day label (86 and 102 for the 90-day and Ale labels, after removing duplicated tests), and 15 / 28 / 20 are flagged at a false-discovery rate of 10% [S38, S40]. About 1 in 10 flags may be chance. "Within specialty" means the gap still holds when patients are compared inside the same specialty.
- **What was advised, and by whom, shows the largest differences.** Overall 189 of 1,101 patients (17%) had surgery within 14 days.
  - By specialty: General Surgery 24% and Dermatology 0% are flagged; Urology 11% and ENT 0 of 21 are not. Dermatology's 0% is a data gap, not a result: its outcomes are not visible (section 6), and its 50 rows are inside the 1,101.
  - By procedure: anorectal procedures convert at 27% (OR 1.44 within specialty, interval 0.93-2.24, so not clear inside a specialty). When no procedure was named on the prescription, conversion is 10% (OR 0.54 within specialty).
- **Doctors.** Raw conversion rates differ between doctors in the same specialty beyond chance (permutation test p 0.002). Among General Surgery doctors with 10 or more patients, rates run from 11% to 38% after shrinking towards the specialty average.
  - Patients of male doctors convert at 19% and of female doctors at 10%. The gap holds within specialty when patients are counted one by one (OR 1.80), but it rests on one or two doctors per specialty. Shuffling gender across doctors gives p 0.40, so it cannot be told apart from individual-doctor differences [S40].
  - How this fits section 6: there, after adjusting for the kind of patient and procedure, the doctor explains only about 0-6% of who converts. Both are true. Doctors' raw rates differ, but most of that difference is the case mix they see.
  - The per-doctor table is admin-only and not in this report.
- **The patient's record.**
  - Patients with no pincode on file convert at 12%, against 21% in the main local area. Caution: the pincode is the value on file today, not at the advice. Registration may be completed during the surgery admission, so a missing pincode may partly reflect the outcome itself; it also tracks older and returning records [S38, S40]. Distance could not be computed.
  - New patients convert more often than returning ones (19% vs 14%), but within specialty the gap is not clear (OR 1.17, interval crosses 1).
  - Patients with earlier lab results on file (HbA1c, Hb, creatinine, eGFR, TSH) convert at 9-11%, against 19% without. Within specialty the gap is smaller, and clear only for eGFR. A recorded obesity diagnosis goes with low conversion (3 of 67; OR 0.24). The eGFR and obesity gaps hold after adjusting for specialty, returning status, number of earlier visits and age (OR 0.42 and 0.19) [S40]. Among returning patients alone, nothing in the history is flagged (obesity, HbA1c and eGFR q about 0.11) [S38].
- **No link was found with** age, patient sex, payer recorded before the advice (95% have none), day of week, month, consult language (only 86 consults have audio) or investigations ordered.
- **Counsellor calls** (patients not converted by day 7): those not called by day 7 converted at 3% between days 8 and 14, against 6% for those called 3 or more times. It is not flagged at 14 days or on Ale's label, only at 90 days. It most likely runs the other way: 19 of the 42 converters (45%) had a call before day 7 that already revealed the outcome (and was dropped), against 12% of non-converters [S40]. The counsellors often already knew.
- **Which single inputs the frozen forests lean on.** At the prescription: the doctor, doctor gender and specialty. At day 7: call activity (Runo summaries, recorded calls, day of first call), procedure group, age and sex. No single input is clearly needed: every shuffle interval crosses zero. Each voice and audio input adds about 0.001 AUC or less.
- **A simpler model does about as well.** A plain logistic regression on the Pulse inputs scores 0.638 at the prescription, against 0.634 for the Pulse-only forest (like for like). At day 7 it scores 0.623 vs 0.658 (-0.035, -0.134 to +0.059), which cannot be told apart: the interval allows the forest to be up to 0.13 better [S38, S40]. The forest is not clearly better than a simple, readable model. Its directions: General Surgery, anorectal and minor gynaecology procedures go up; Urology, Dermatology, ENT, circulatory diagnoses and a missing diagnosis code go down.
- **Bottom line.** Conversion goes with what was advised and by which doctor. The doctor differences are the strongest unexplained pattern and are worth a case review. Nothing here shows that changing any one of these would change conversion.

## 3d. How the conversations go (V review, 20 Oct; DEVELOPMENT split only; post hoc and descriptive; first pass; all four lanes refuted PASS-WITH-FIXES or CONFIRMED WITH CAVEATS, fixes applied [S47, S48, S50]) [S44, S45, S46]
- **How to read this section.** Four lanes looked at the back-and-forth of calls and consults, not just the words. Every lane tagged turns with a fixed act list written before any outcome was joined (Haiku; Jev re-tagged a 15% sample of turns, or of consults for ft-docstyle). Only the act lists were fixed in advance. The test lists, including ft-docstyle's whole 77-test family, were chosen after the data were in hand, so every flag is exploratory. Every test is counted, and a result counts only at a false-discovery rate of 10%. The numbers are small: 48 converters on the calls, 20-24 in the consults, 9 doctors with enough consults. A real effect of moderate size would usually be missed. Negative results are stated first. [S44, S45, S46]

### Patient and counsellor back-and-forth on the calls (ft-dialog-runo) [S44]
- **Almost no conversational pattern survives correction.** 4,318 tests in 5 families on 343 episodes with calls (48 converters). With the main yes definition nothing reaches the 10% false-discovery rate (best mined pattern q 0.12). With the commit-only definition one fair result passes: converters get more counsellor document requests after the yes (q 0.037; q 0.11 in the pooled sensitivity family). It does not hold after adjusting for baseline risk (p 0.14), and it is post-yes paperwork, most likely following the decision [S44, S50]. V's hypothesis is not confirmed at this sample size, and not refuted either.
- **The other apparently significant result is an artefact.** Patients who said yes and then had no surgery seemed to say "yes" about 3 times as often. That disappears on a fair comparison (it came from how the yes point was defined). There is no "hollow yes" effect.
- **Leads** (after adjusting for Pulse baseline risk; none is significant after correction; two are weak: the deferral-callback gap is 9% vs 14% on each episode's first call only, and the unanswered-worry gap does not hold under the commit-only yes definition):
  - before any yes, patients who never said yes more often had a deferral answered with a callback promise ("call me later" / "sure, I'll call"): 22% vs 11% of episodes;
  - calls that are only courtesy (greeting, acknowledgement, nothing more) are more common among patients who never said yes: 31% vs 13%;
  - after the yes, converters have more document requests and more "patient question, counsellor reassurance" exchanges (24% vs 3%). This is the paperwork, which most likely follows the decision;
  - before the yes, among patients who later said yes, a patient worry left unanswered is less common in converters (19% vs 39%);
  - converters' calls have longer turns (fewer speaker switches per minute: median 12.2 vs 14.0).
- **No difference:** who opens or closes the call, the patient's share of turns, response gaps and overlaps, unresolved questions, and repeated loops on the same topic across calls.
- **Reliability:** Haiku and Jev agree on 75% of turn acts (kappa 0.70; this is model agreement, not accuracy). Jev tags cost and scheduling far more often than Haiku, so the yes point may be placed late.

### Doctor and patient back-and-forth in the consult room (ft-dialog-consult) [S45, S48]
- **One pattern stands up: the doctor explains the hospital stay and recovery.** Among patients who said yes, 18 of 20 who had surgery within 14 days had recovery or stay talk in the consult, against 12 of 36 who said yes but did not have surgery. It survives correction even when all 1,554 tests are pooled (q 0.069) [S48]. It also holds:
  - on the alternative 14-day labels (10 of 12 vs 11 of 35);
  - when "yes" is entered the same way for both groups (11 of 12 vs 11 of 30, from calls only);
  - when same-day surgeries are dropped (12 of 14 vs 12 of 36);
  - before the yes point (12 of 20 vs 6 of 36; p 0.002, not flagged after correction, q 0.14) [S45].
  - The within-doctor (only 5 doctors have both outcomes) and risk-adjusted checks point the same way but are not significant after correction [S48].
  - It repeats the "what is said" result in 3b by a different method on the same consults, so it is not an independent confirmation.
- **It goes with having the surgery, not with saying yes.** Patients who said yes but did not have surgery look like those who never said yes on this measure. It may still be talk that follows a decision the patient has already made; the transcript cannot tell.
- **Hypothesis, not flagged:** a real answer to a patient's worry (14 of 20 vs 11 of 36). When cost comes up, the patient side raising it first goes with no surgery (3 of 15 converters vs 9 of 14 non-converters), but that is mostly after the yes, so it most likely reflects the paperwork stage after a decision, not a cause [S50].
- **No difference:** whether or when surgery was first named (always by the doctor, about 4 minutes in); a yes said in the room; deferral; doctors brushing off worries (almost never seen); the share of questions answered (about 70% in every group); family members speaking; risks or options explained; invitations to decide; the order of topics.
- **Not trustworthy here:** talk share and pace. Converters' consults look more doctor-led and faster, but both differences vanish in consults with reliable speaker labels, so they are most likely labelling artefacts.
- **Reliability:** the two models agree poorly on the acts that set the yes point (patient commitment kappa 0.15), so the before/after-yes cut is rough.

### Doctor styles (ft-docstyle; doctors anonymised) [S46]
- **Doctors talk very differently.** Median consult length runs from 5 to 21 minutes. The share of consults where the doctor explains recovery or the stay runs from 0% to 58%, and invitations to decide from 0% to 62%.
- **Three rough style types** ("explains and involves", "brief, light on information", "long talk, passed on") exist, but weakly (no natural clusters), and they follow specialty closely. They are not better or worse styles.
- **Conversion differs by doctor, but doctor cannot be separated from case mix.** Only 9 doctors have 5 or more labelled consults (24 surgeries in total, 17 of them General Surgery). The "explains and involves" type has 20 surgeries in 76 consults; the other two types have 0 in 30 consults. That is essentially surgical outpatient clinics against the rest. The type difference is not robust: at the doctor level (9 doctors) p is 0.22 [S47], and it cannot be estimated after adjusting for baseline risk (zero events).
- **Many patients who agree do not go on to surgery.** Of 134 labelled consults, 60 reached a yes (45%), and only 24 of those 60 had surgery within 14 days of the prescription (40%). More than half of the patients who agreed had not had surgery 14 days later. That step is where paperwork and scheduling sit; we cannot see inside it from consults alone [S46].
- **The one consult-level style measure that survives correction** is the same as above: recovery or stay explained before any yes (58% of consults that reached surgery vs 19% of those that did not).
- **No difference** after correction: options offered, risk explained, teach-back, reassurance, timing of the first surgery mention, questions per 10 minutes, questions answered, interruptions, speaking rate, pauses, patient voice tone, and doctor-patient language mismatch (too rare to say).
- **What would settle it:** 15 or more labelled consults for each of about 20 doctors.

### Whole-conversation checklist (ft-convo) [S49, S50]
- **Method.** A 12-item checklist for the whole conversation was written and frozen before any scoring. Claude Opus scored every call and consult, needing an exact quote (code-checked) for each positive. Each conversation was cut before the first sign that the patient had already agreed. Ale's label is primary. 280 tests in the main family, 67 in the day-3 family, and 8 pre-registered forest tests.
- **The one call-side signal is the patient pushing back, and it is not an early warning.**
  - When the patient or family raised any objection before deciding, 7% converted (10 of 146 episodes), against 24% without one (36 of 151). This holds after adjusting for baseline risk, and at 14 and 90 days. Patients who named an alternative (medicines first, a traditional remedy, another hospital, home town) converted 0 of 40.
  - The signal is weak early: with only calls before day 3, the direction holds (6% vs 15%, p 0.07) but nothing passes correction (67 tests, smallest q 0.89). Most of the gap comes from later chase calls, which converters do not get because they decide fast.
  - So the objection is largely the patient saying "not now / not here", close to the outcome itself, not a lever. Before day 3, an objection left unanswered goes with 7% vs 13% conversion (p 0.23); the 6% vs 20% gap uses all pre-decision calls, mostly later ones.
- **In the consult room, only "the doctor explains recovery and stay" goes with conversion:** 41% (13 of 32) converted when the doctor explained it, against 9% (8 of 86). Within doctors the odds ratio stays above 1 (2.4), but that test has only 6 strata, so doctor mix cannot be ruled in or out. The cut leaked in 6 of 14 sampled consults, so part of this may be talk after a decision made in the room. Same direction as the other consult analyses above (same consults).
- **Negative results.** None of these is linked to conversion in calls or consults after correction: recommendation strength, the reason explained in plain terms, risks, cost (who raised it and when), questions answered, family present, a concrete next step booked, empathy or reassurance, pressure or urgency, language match. Staff behaviours show no link once baseline risk is controlled (for calls, baseline only: there was no counsellor id to control for).
- **Adding the checklist to the forest does not improve prediction.** 7 of the 8 pre-registered deltas are negative and none survives Holm correction; at day 3 on Ale's label it is significantly worse (0.634 to 0.616, -0.018, -0.032 to -0.003). Only 20% of episodes have any pre-decision call before day 3.
- **The cut is imperfect both ways:** 12 of 60 checked cut points still showed agreement before the cut, and in 17 of 33 cut units the cut came before any real agreement (usually a first insurance question).

- **Section bottom line.** Across calls and consults, two things go with conversion. On the calls, patients who push back or name an alternative rarely convert, but that is mostly late in the window and close to the outcome itself, not an early warning. In the consult room, doctors explaining the stay and recovery goes with surgery, though doctor mix and talk after a decision cannot be ruled out. Adding a whole-conversation checklist to the forest made prediction no better (7 of 8 deltas negative). Everything else is a lead or a negative result. With 20-48 converters and 9 usable doctors, none of this is close to proof. The consult results in 3b, ft-dialog-consult and ft-docstyle all come from the same 191 recorded consults: one pattern seen three ways, not three findings. [S44, S45, S46]

## 4. How well does Pulse data alone predict conversion? (FT3; dev split; refuted PASS-WITH-FIXES, fixes applied; refuter's own figures in brackets [S5])
- **Weakly at 14 days, moderately at 90 days.** A random forest (400 trees, leaf 5, fixed, no search) on what Pulse already holds was tested on later months it never saw [S3, S4]. [S5]
  - Inputs: specialty, doctor (in-fold past conversion rate), doctor gender, procedure type, ICD codes, age, sex, earlier visits, investigations ordered, month. Same-day payer is **left out**: it already reveals patients on the surgery path (with it, the 14-day test AUC was 0.650; a leak, not skill).

  | Label | Test window | Recommendations / conversions | AUC (95% interval) | PR-AUC | Calibration |
  |---|---|---|---|---|---|
  | Surgery within 14 days | Jun-Sep 2026 | 651 / 110 | **0.60** (0.54-0.65) [0.60] | 0.21 (base rate 0.17) | uncalibrated RF; Brier 0.14 = no-skill 0.14 |
  | Surgery within 90 days | 1 Jun - 17 Jul 2026 | 218 / 53 | **about 0.7** (lane 0.72, 0.65-0.80) [0.69, 0.61-0.76] | 0.39 (base rate 0.24) | uncalibrated RF; Brier 0.17 vs no-skill 0.185 |

  - The 90-day test AUC moves between 0.69 and 0.74 across runs and seeds, so it is quoted as "about 0.7" [S5 note 5].
  - Cross-validation over all dev months agrees: 0.63 (0.60-0.67) [0.65] at 14 days (1,101 / 189); 0.69 (0.64-0.73) [0.68] at 90 days (659 / 150) [S3].
  - Seal-safe sensitivity, 14-day test on Jun-Jul only: 0.63 (0.55-0.72), 278 / 46 [S5].
  - Disclosure: three runs were scored on the same Jun-Sep test (with payer 0.650, no payer 0.600, final 0.597). The only change between them was the payer-leak ruling, not a choice made on test AUC [S5].
- **What drives it** (cross-validated permutation importance, 14 / 90 days): the doctor (+0.035 / +0.073), then the procedure type (+0.023 / +0.047), then specialty (+0.016 / +0.006); doctor gender +0.011 and ICD codes +0.008 at 14 days (doctor gender is a stand-in for the doctor) [S3, S5 issue 4]. The doctor's past conversion rate alone scores 0.58 at 14 days [S3]. Age, patient sex and investigations add about nothing.
- **Within one specialty, Pulse data does not separate converters reliably** (14 days, cross-validated) [S3, S5]:

  | Specialty | n / conversions | AUC (95% CI) | Refuter |
  |---|---|---|---|
  | General Surgery | 436 / 103 | 0.54 (0.48-0.60) | 0.56 (0.50-0.63) |
  | Gynaecology | 189 / 30 | 0.57 (0.49-0.65) | 0.65 (0.55-0.75) |
  | Orthopaedics | 156 / 28 | 0.52 (0.38-0.65) | 0.59 (0.48-0.70) |
  | Urology | 109 / 12 | 0.55 (0.36-0.75) | 0.49 (0.31-0.67) |

  - Every lane interval includes 0.5. The refuter's Gynaecology interval does not, so "close to chance" is too strong for Gynaecology; "not reliable" holds for all four. 4 within-specialty tests.
- **Meaning.** The structured data tells us where conversions happen, not which patient in front of a given doctor will convert. That gap is what FT8 (medical history, section 4d), the counselling calls (4b, 4c) and the consult recordings (5) are meant to fill.
- Seal note: the 14-day test includes Aug-Sep 2026 (held back for the 90-day final test). They were used only for 14-day results here, never to tune anything (verified by the refute). Drivers and doctor rates learned from Aug-Sep 14-day outcomes must not be used to choose features for the 90-day final model [S5 fix 2]. [S5]

## 4b. What the counselling calls say (call text; ft-calltext v2; dev split; refuted, v2 PASS [S11])
- Runo counsellor call summaries for the first 14 days after the recommendation were tagged by Haiku: 2,295 calls, 552 patient-episodes, quotes checked word-for-word [S10].
  - Calls that already reveal the outcome (a surgery date fixed, or "done") were set aside.
  - 11 batches (110 calls, 11 episodes) failed and were dropped.
- **Description (what patients say on the calls; converted vs not converted within 14 days; 463 episodes with at least one usable call, 72 converted) [S24]:**
  - Every Haiku tag was cross-checked by Jev (ft-text2, refuted PASS-WITH-FIXES [S25]). The main column drops the Haiku tags that Jev contradicts. "Both agree" is stricter: it keeps only tags that Jev also confirms. The raw Haiku shares reproduce the earlier table exactly. The shares in the table below are from [S24].

  | Raised on a call | Converted (Jev-checked) | Not converted (Jev-checked) | Both agree: conv. / not | Raw Haiku: conv. / not |
  |---|---|---|---|---|
  | Insurance / cashless | 61% (50-72) | 31% (26-35) | 60% / 30% | 61% / 31% |
  | Timing ("later", "after X") | 17% (10-27) | 35% (31-40) | 8% / 25% | 21% / 39% |
  | Going elsewhere | 1% (0-7) | 11% (8-15) | 0% / 8% | 1% / 15% |
  | Second opinion | 0% (0-5) | 7% (5-10) | 0% / 6% | 0% / 8% |
  | Fear | 0% (0-5) | 4% (3-7) | 0% / 3% | 0% / 5% |
  | Family must decide | 8% (4-17) | 14% (11-18) | 8% / 12% | 8% / 15% |
  | Cost | 15% (9-25) | 19% (16-23) | 8% / 16% | 21% / 24% |
  | Any objection | 71% (59-80) | 73% (69-78) | 68% / 66% | 72% / 77% |
  (95% Wilson intervals; descriptive, no test.) [S24]

  - **The cross-check confirms the direction of every finding but shrinks some gaps.** Haiku over-tagged "going elsewhere" and "cost" (Jev contradicts about 1 in 4 to 1 in 5 of its positives; ft-text2 rated both tags DROP, and the call-level filter used here raises their precision to 83-92%). "Going elsewhere" falls from 15% to 11% of non-converters (8% if both must agree), against 0-1% of converters. [S24, S25]
  - **Cost does not mark a lost patient.** It is raised by 15% of converters vs 19% of non-converters (Jev-checked), and the intervals overlap. [S24]
  - Read this as **what the two groups talk about, not as causes.** Patients who have decided discuss insurance and paperwork (partly pre-authorisation). Those who will not convert talk about timing, other hospitals and second opinions.
  - "Going elsewhere" (11% of non-converters after the cross-check, about 44 episodes) is the clearest **visible leakage** to other hospitals. The rest is invisible to us.
    - On the raw tags the gap held even in the worst case for the 110 dropped calls (going elsewhere up to 8% vs 16%; timing 27% vs 40%) [S11].
  - These call summaries are Runo's English text. Section 7 shows that today's consult English sometimes drops negations, so if the call summaries carry the same weakness, refusal and hesitation would be under-counted here (not measured for calls).
- Cost: 593 Haiku requests, about 1.0M tokens in, 1.1M out [S10].

## 4c. Do the calls predict conversion? Call text and call AUDIO (FTR final v2; dev split; refuted PASS-WITH-FIXES, fixes applied [S13])
- **Design.** Prediction at day T = 3 or 7 after the recommendation, using only calls made before day T. Patients who already had surgery by day T are dropped (at-risk rule F1, asserted in code: 0 kept episodes with surgery on or before T) [S12, S14]. Calls that reveal the outcome are dropped. Same Pulse baseline as section 4 (no payer), patients from 1 Jan 2026, 5x5 grouped cross-validation, identical folds for every model, paired cluster-bootstrap intervals.
- **Audio.** 933 Runo calls were transcribed (Sarvam), covering 369 dev patient-episodes [S14]. Audio features: talk-time shares, Odyssey voice emotion, transcript tags. Patients with audio who are still at risk (n, conversions): 14-day label 197/19 at day 3, 235/11 at day 7; 90-day 96/21, 110/17; Ale's label 209/23, 244/11 [S12, reproduced exactly S13]. Those small numbers are what any audio effect rests on.
- **Change in AUC over the Pulse model (lane v2, leak-masked, 95% CI)** [S12]:

  | Label | Day | n / conversions | call text | text + audio | audio over text |
  |---|---|---|---|---|---|
  | 14 days | 3 | 976 / 92 | -0.006 (-0.045, +0.032) | -0.012 (-0.054, +0.032) | -0.006 (-0.024, +0.011) |
  | 14 days | 7 | 926 / 42 | +0.040 (-0.038, +0.114) | +0.055 (-0.029, +0.135) | +0.015 (-0.017, +0.055) |
  | 90 days | 3 | 572 / 90 | -0.003 (-0.040, +0.035) | -0.010 (-0.057, +0.040) | -0.007 (-0.029, +0.020) |
  | 90 days | 7 | 545 / 63 | +0.023 (-0.040, +0.089) | +0.036 (-0.031, +0.105) | +0.013 (-0.021, +0.048) |
  | Ale | 3 | 1,005 / 102 | -0.003 (-0.043, +0.037) | -0.012 (-0.054, +0.032) | -0.009 (-0.029, +0.010) |
  | Ale | 7 | 947 / 44 | +0.055 (-0.025, +0.136) | +0.081 (-0.000, +0.165) | +0.026 (-0.008, +0.062) |

- **Reading (refuter's wording, adopted) [S12, S13]:**
  - Day 3: null everywhere (every change 0.015 or less), in both the lane's and the refuter's pipelines.
  - Day 7: call text plus audio beats the Pulse model in most repeats for all three labels, by +0.04 to +0.08 AUC in the lane and +0.09 to +0.12 in the refuter's pipeline (its baseline is weaker). Most of it is call volume and timing, not what was said: the text tags add 0.005 or less [S10]. [S13]
  - **No interval survives correction for the number of comparisons.** 18 deltas were tested (call text, text + audio and audio alone, each against the Pulse model, for 3 labels at 2 landmarks); the Holm-adjusted minimum p is 0.97 (1.00 over 24 deltas) [S12]; the refuter gets 0.78 from the same scores and 0.054 in its own pipeline at one fold seed [S13]. Which single interval comes close to excluding 0 changes with the baseline and the fold seed [S13]. DIRECTIONAL.
  - **Audio adds nothing measurable over the call text** (-0.009 to +0.026; all 6 intervals include 0, in both pipelines). Only 11-23 audio-covered conversions are still at risk in each cell.
  - Withdrawn: the earlier "audio over Pulse at 90 days, day 7, excludes 0". After the leak fix it is +0.038 (-0.001, +0.078); the refuter gets +0.032 (-0.017, +0.074).
  - The day-7 signal may partly reflect calls about a surgery already being scheduled. That is legitimately known at day 7, but it marks the process, not only the patient's intent.
- **Refute fixes applied** (lane v2) [S12]: audio features for patients with no audio call before day T are now coded missing (this removed a small file-membership leak; the day-3 audio gains fell to 0 or below, day 7 moved by 0.011 or less); out-of-fold scores are saved so the intervals can be re-derived; the intervals hold the fitted predictions fixed and the bootstrap seed alone moves the bounds by about 0.01, so they are slightly optimistic.
- Calls are linked to patients by phone. 4,479 calls on phones shared with another person were set aside, never guessed [S31].

## 4d. Medical history before the prescription (FT8): built, refuted PASS, in the forest (V, 20 Oct). Result: no gain [S27]
- **What exists in the records** (Metabase db13, records dated strictly before the prescription day; all 1,233 dev episodes) [S21, S22]:
  - 469 episodes (38%) have an earlier Even prescription. The rest have no Even history at all, so "missing" means "no earlier record here".
  - Earlier diagnoses (ICD codes): 454 episodes. Latest blood pressure: 148. Labs: HbA1c 261, Hb 279, creatinine 230, eGFR 191, TSH 237. Medicines on the latest earlier prescription: 223. Earlier admissions: 23.
  - Not available: ER visits, earlier surgeries at Even, BMI (under 1%), distance to hospital (no pincode table).
  - Vitals, named comorbidities and admissions are recorded only from 2026, so coverage rises over the study window.
  - Converters have less recorded history than non-converters in every block except blood pressure (11% vs 11%) (14-day label: an earlier prescription 30% vs 39%, HbA1c 13% vs 23%) [S22].
- **Which parts of the history did this? None on its own; the loss is consistent with dilution** (post hoc, descriptive, dev only; 54 comparisons, no correction, nothing claimed as a finding; refuted PASS-WITH-FIXES, wording fixes applied here) [S37, S41]:
  - Adding one block at a time to Pulse: labs cost the most (-0.011 to -0.019), then vitals (-0.004 to -0.009) and earlier-visit counts (-0.008 to -0.009 at 14 and 90 days). Diagnoses cost a little; admissions and medicines are neutral.
  - Taking one block out of the full history changes AUC by 0.005 or less. Removing labs wins back only +0.004 to +0.005 of the loss. The loss is spread across the blocks.
  - "New to Even" alone does not lower AUC: a single yes/no "has any history" flag is neutral at 14 and 90 days, with a small nominal gain on Ale's label (+0.004, +0.000 to +0.008, uncorrected). Converters have a history less often (32% vs 43% at 14 days).
  - **Dilution check:** the 42 history columns shuffled together (no link to the outcome) cost on average about as much as the real history over 5 shuffle seeds (-0.014 / -0.018 / -0.012 vs -0.024 / -0.019 / -0.015 at 14 / 90 days / Ale), but the seed-to-seed spread (about ±0.02-0.03) is as large as the effect [S41]. The loss is consistent with dilution: most history columns are empty for about 77% of patients, and in this forest setting each split then sees fewer of the 29 Pulse columns. At this n the check cannot separate dilution from a weak harmful signal; it is a hypothesis.
- **Leakage controls** [S22, S23]:
  - Every record is cut at midnight before the prescription day. A first build that cut at the prescription time was replaced: it let same-day records in.
  - Labs are cut by result date. 66 lab values with a placeholder date (1970) were blanked, because their real date cannot be shown to be before the prescription.
  - Nothing about the index surgery's booking, OT, admission or billing is used.
  - The cutoff test fails on any record on or after the prescription day. The independent refuter's 28 mutant records were all caught, and its own rebuild matches all 28 checked features on all 1,233 rows (one cosmetic ICD count differs). No sealed-set row was read.
- **Result: medical history does NOT improve prediction. It makes the model slightly worse** (dev split, cross-validated, frozen model; section 8) [S26]:

  | Label | n / conversions | Pulse only | Pulse + history (FT8) | Change (95% CI) | After correction (Holm, within the family) |
  |---|---|---|---|---|---|
  | Surgery within 14 days | 1,101 / 189 | 0.634 | 0.610 | -0.024 (-0.043 to -0.003) | a significant LOSS (Holm p 0.048) |
  | Surgery within 90 days | 659 / 150 | 0.690 | 0.670 | -0.019 (-0.039 to +0.001) | not significant |
  | Ale's label | 1,144 / 213 | 0.661 | 0.646 | -0.015 (-0.034 to +0.003) | not significant (Holm over 3, p 0.23) |

  - Why it can hurt: 42 extra columns that carry almost no signal (the history block's own importance interval spans zero at every label) add noise to a forest trained on about 150-190 conversions.
  - The one pattern in the history is that converters have **less** of it: patients new to Even convert slightly more often than those with an Even record. Whether the Pulse fields already carry this was not tested [S37, S41].
  - [The one-shot sealed test (H) of exactly this comparison: section 8.]

## 4e. Every layer, one at a time: calls, voice and an AI reading of the transcripts (frozen model; DIRECTIONAL) [S26]
- **What was added, in a fixed order** (spec section 4): 0 Pulse; 1 medical history (FT8); 2 call activity (count, timing, talk time); 3 what was said on the calls (Haiku tags, cross-checked by Jev; plus Bolna automated calls); 4 who spoke when (Nemotron); 5-6 voice emotion (Odyssey, emotion2vec); 7 Clef-omni on each speaker's audio; 8 an AI (Opus) reading the raw call transcripts, with insurance, pre-auth, payment and admission talk removed.
  - Two yes/no flags were added beyond the spec's field list, both of the kind the spec allows: roles_ok (layer 4: the call's speakers could be told apart) and has_ft8_row (consult design, layer 1). Removing roles_ok gives the same test results [S36].
  - Voice engines ran on 933 Runo calls (911 with speech) and 211 recorded consults. Patient/counsellor features use only calls whose speakers could be told apart (Nemotron plus words; the old "who talks more" guess is masked). [S33]
- **Predicting at day 3 after the prescription: nothing helps.** In every label the best model is Pulse alone; the forward pass keeps no layer. With every layer in, AUC is 0.02-0.04 lower than Pulse alone (intervals span zero).
- **Predicting at day 7: the calls help a little, but not provably.**

  | Label (n / conversions) | Pulse only | Every layer | Change (95% CI) | Layers the forward pass keeps |
  |---|---|---|---|---|
  | 14 days (926 / 42) | 0.614 | 0.658 | +0.044 (-0.040 to +0.132) | Pulse + what was said |
  | 90 days (545 / 63) | 0.640 | 0.667 | +0.027 (-0.043 to +0.099) | Pulse + call activity + Clef |
  | Ale's label (947 / 44) | 0.592 | 0.669 | +0.078 (-0.005 to +0.168) | Pulse + call activity + what was said + Clef |

  - The gain comes from how many calls there were and when (layer 2) and from what was said (layer 3). The voice engines add little: the largest step is Odyssey at 90 days, +0.021 (+0.001 to +0.041), which does not survive correction for 54 tests; emotion2vec and Clef add 0.016 or less.
  - The "forward pass" model is chosen on the same data, so its figure is optimistic and is not a test.
- **Recorded consults (138 patients, 23 converted): nothing adds over Pulse.** Pulse only 0.718; every layer 0.691 (-0.026, -0.150 to +0.088). The Jev pitch items were left out because they were computed on today's English (section 7).
- **Number of tests: 73** in the cross-validated families (2 primary, 3 secondary at the Rx, 54 call steps, 14 consult steps). After Holm correction: **0 gains, 1 loss** (FT8 at 14 days, section 4d).

## 4f. Does the forest beat simpler or smarter readers? Benchmarks and calibration (frozen model; DIRECTIONAL) [S29, S30]
- **Three benchmarks, scored on the same patients and folds** (prompts fixed before scoring):
  - (a) the patient's stated intent alone (last "wants surgery / undecided / declines" tag before the day);
  - (b) Jev asked directly, on the raw native-language transcripts, "will this patient have the surgery at Even?";
  - (c) Claude Opus 5.5 asked the same.
- **Over all at-risk patients** (most have no transcript): the full forest is level with or ahead of every benchmark. Of 24 pre-declared comparisons (family F-bench), 1 survives Holm correction within that family: the forest beats Jev at 90 days, day 7 (+0.120, Holm p 0.024). Stated intent alone is weak (AUC 0.52-0.61).
- **Among the patients who do have call transcripts** (96-288 per design, 12-29 conversions) [S29], reading the raw text is strong at day 3:
  - Opus on the unscreened transcripts scores 0.79-0.84, against 0.58-0.64 for the forest on the same patients.
  - But most of that comes from insurance, pre-auth, payment and admission talk: the hospital's own conversion process, an outcome proxy, not the patient's intent. Pre-auth words appear in 31% of converters' transcripts vs 11% of non-converters' (Ale's label, day 3).
  - With that talk removed, Opus drops to 0.69-0.74. Against the earlier (FTR v2) forest on the same patients, that is about level at 14 days and on Ale's label (0.70 vs 0.69; 0.69 vs 0.66), with a point lead at 90 days (0.74 vs 0.57) whose interval spans zero. At day 7 the screened Opus also leads on points (0.83 vs 0.76, 0.83 vs 0.78, 0.77 vs 0.59), and every interval spans zero [S29]. Date words still remain in 58% of 90-day converters' transcripts vs 21% of non-converters', so even that lead may carry scheduling signal.
  - The screened Opus score is layer 8 of the forest; it adds nothing on top of the other layers (section 4e).
- **Recorded consults (138 / 23):** Opus 0.69, Jev 0.69 and the forest 0.69 are level. The screened Opus score is higher (0.75), but the leak audit calls that rise unexplained and not a gain (single run, CI spans zero).
- **Calibration:** the forest ranks patients but does not produce trustworthy probabilities.
  - Brier skill is 0.00-0.08 (no better than predicting the base rate at the landmarks).
  - At the prescription, the calibration slope is about 0.7-1.1 (Pulse only 0.9-1.1). At days 3 and 7 the raw forest is too flat (slope 0.63-0.92). Calibrating inside each training fold (nested Platt) moves the slope to about 1.0-1.45. At the prescription it over-corrects (slope 1.2-1.45 on the dev runs; 1.06-1.24 in the independent forest refute). It does not change Brier and costs up to 0.02 AUC. The raw forest is the calibration we stand behind [S30, S36].
  - On the 14-day consult model (12 conversions) in-fold calibration breaks down, so the raw forest is used there.
- **Sensitivity checks (pre-declared, not tests):** raw instead of Jev-checked tags, and separate WavLM voice embeddings, change nothing (0.004 or less). Using only role-free voice features moves day-7 Ale's label to +0.089 (+0.004 to +0.181). Using the unscreened Opus score lifts results, as expected from its process-talk content (day 7, Ale's label: +0.095).

## 5. First read on recorded consults (FT4 v2, ft-audio; DIRECTIONAL; refuted PASS-WITH-FIXES twice [S9])
- **The cohort is bigger now, but still small.** Recorded consults where surgery was discussed, from 9 Sep, dev split only [S8]:
  - 213 consults, 198 patients, 21 doctors, one row per patient.
  - **Ale's label** (surgery = 1; at least 14 days and no surgery = 0; younger = dropped): 138 patients, 23 converted, counting each surgery for the patient's earliest Rx (strict credit) [S9 I-1]. The model figures below were run on 139 / 24 (one row credited loosely); strict credit moves the AUCs by 0.01 or less [S9].
  - On our stricter 14-day label (at least 18 days old): 114 / 12.
  - None are 90 days old yet (the first will be about 12 Dec).
- **What the model says: no evidence that the recordings add anything** [S8, S9].
  - Pulse-only on the same patients: AUC 0.73 (0.61-0.85); with recording features: 0.71 (0.57-0.84). Difference -0.02 (-0.09 to +0.05).
  - The independent refute found the difference between -0.055 and +0.00 across feature sets, never positive.
  - Recording features tested: language, doctor vs patient talk time, turns, emotion (Odyssey), the Jev pitch items, plus specialty, doctor's prior rate, age.
  - Specialty and two General Surgery doctors carry most of the signal (specialty alone AUC 0.70; 15 of 24 converters come from 2 doctors). No single feature's importance interval reliably excludes 0 [S9 I-4].
- **What the pitch sounds like in converters vs non-converters (description, not cause; 17-24 items screened) [S8, S9]:**
  - **Practical detail explained** (how the operation is done, anaesthesia, stay, recovery): 83% of converters vs 45% of non-converters (20/24 vs 49/109, Fisher p 0.0006). It is the only pitch difference that survives correction for testing many items (BH q 0.011-0.014).
    - Adjusted for the two highest-converting doctors and age, it weakens: odds ratio 2.8, p 0.12 (Mantel-Haenszel by doctor: OR 3.5, p 0.05). So it may be how those doctors talk, not something that works on its own [S9 I-5].
    - Inside General Surgery alone: Fisher p 0.018 (the lane's 0.005 was a Mann-Whitney test on the continuous score) [S9 I-2].
  - Urgency stated (46% vs 18%, p 0.007) and cost discussed (33% vs 13%, p 0.03) point the same way but do **not** survive correction (q 0.06-0.14). They are hypotheses to test on new consults, not findings [S9 I-3].
  - "Doctor gives a date or booking step" predicts conversion (AUC 0.72), but it mostly records a decision already made, so it is kept out of the headline.
  - Talk time, emotion and language show no difference (all p > 0.2).
- **What it would take (forest-lead's projection, not a lane output):** the 23 conversions came from consults dated 9 Sep (the start of recording [S8]) up to 5 Oct (the last date at least 14 days old at the 19 Oct read). That is 26 days, about 3.7 weeks, so about 6 conversions a week in the dev split (23 / 3.7). At that rate about 60 conversions are reached by early-to-mid December, allowing for the 14-day wait. That is the first point where a recording effect of useful size could show. It assumes recording coverage stays where it is; more recorders (EHBR Windows) shorten this. [S8]

## 6. Is it the doctor? (FT5, ft-doctors; labels v2; refute PASS-WITH-FIXES, all 5 fixes applied; numbers below are the refuter's [S6, S7])
- **Short answer: the doctor matters much less than hoped.** Within the same specialty, after adjusting for case mix, the share of variation in 14-day conversion explained by the doctor is about **0-6%** (point estimates across methods and case-mix sets). The upper 95% bound is about 17-18% [S6].
  - Data: dev split only; 833 recommendations, 163 conversions, 18 doctors, 4 specialties.
  - At 90 days: about 0-11% (point estimates), upper bound about 40%, on 425 recommendations, 125 conversions, 12 doctors in 3 specialties. The bound is wide because there are only 12 doctors.
  - These figures depend on the method and on which case-mix terms are included. With the fullest case mix (ICD chapter, procedure-named flags) the doctor share goes to 0 at both horizons; that set may over-adjust, because what a doctor flags or codes is partly the doctor's own behaviour. Read the light and full adjustments as brackets.
  - **The "80% is the doctor" idea is not supported.** Every estimate is far below 80%, and even the 90-day upper bound is about half of it. DIRECTIONAL.
- **Is any doctor effect detectable?** At 14 days, no case-mix-adjusted model rejects "no doctor effect" (p 0.2 or more). At 90 days it depends on the case mix: p 0.03 (light) or 1.0 (full) [S6]. A typical doctor-to-doctor odds ratio is 1.0-1.3 at 14 days and 1.0-1.7 at 90 days [S6].
  - Adding the doctor to a prediction model does not measurably improve it (AUC +0.016, -0.016 to +0.063) [S7].
- **Where the non-conversions are.** Four specialties hold 717 of the 748 non-converted episodes in specialties with 30+ episodes (14 days; dev split, matured) [S6, S18]. Dermatology's 50 are left out of the 748 because they are not real non-conversions (below).

  | Specialty | Not converted | Episodes |
  |---|---|---|
  | General Surgery | 333 | 436 |
  | Gynaecology | 159 | 189 |
  | Orthopaedics | 128 | 156 |
  | Urology | 97 | 109 |

- **The money question (Mayank), rough and dev split only (about 10-11 months)** [S18]:
  - bringing every doctor (10+ episodes) up to their specialty's median: about 18 more conversions;
  - a 20% relative lift: about 35;
  - matching the best doctor in each specialty: up to about 127. That ceiling is inflated by noise: after full case-mix adjustment the refuter's model shrinks every doctor close to average [S6].
- **Pairs for listening:** 2 same-specialty pairs with at least 5 recorded dev-split pitches each, both in General Surgery (one at 14 days, one at 90 days) [S6]. **None of the doctor differences survives correction for comparing 18 doctors** (the low doctor's p 0.013-0.022 becomes 0.23-0.40), so these pairs are for listening and learning, not evidence of a better or worse doctor. Consult ids (145, dev split only) are in the admin-only annex.
  - An Orthopaedics pair was dropped, and 15 pitch consults were removed, after the refute found they came from the sealed test set.
- **Data gap, not a result: Dermatology.** 58 flagged Dermatology recommendations in the dev split (50 matured at 14 days, 34 at 90 days) have no OT note, surgical or IP-package bill, or admission at all [S6]. Its named procedures are office procedures (PRP, cautery, laser, excisions). A billing pull of all flagged Rx from the 5 Dermatology doctors (aggregate only) found **no dermatology-procedure bill line in KX under any service type** [S6]. So these procedures are not in KX billing at all; the outcome cannot be seen. In addition, 34 of 58 carry the surgery flag with no procedure named (flag noise).
  - Dermatology is excluded from conversion rates and from "lost conversions". **Open question for the business: where are Dermatology procedures billed?**

## 7. Does translation flatten meaning? (FT6, palimpsest-architect; results refuted PASS-WITH-FIXES, fixes applied [S20])
- **What the pipeline uses today** [S15]: Sarvam Saaras speech-translate (audio straight to English) for consult clips from 8 Oct; Sarvam Mayura text-translate where that returns nothing (7% of the turns here); Mayura for the September CAA consults. No Google or Gemini.
- **The test:** 20 recorded surgery-pitch consults from the dev split (Hindi 8, Kannada 10, Telugu 2; 0 from the sealed set, checked [S20]), 4,407 turns translated three ways. A blind Haiku judge scored 8 turns per consult (160 turns) for preserved feeling and intent (0-2), and had to quote both languages for any reversal [S15].
  - The 8 turns were picked from the native text for negation and emotion words, without seeing the translations. So they are heavily enriched for refusals: 82% of judged turns carry a negation or refusal word, against 13% of all turns [S20]. The rates below are for such turns, not for every turn.

  | Version | Mean score (0-2) | Meaning reversed (judge) |
  |---|---|---|
  | Today's served English (93% Saaras speech-translate, 7% Mayura gapfill) [S15] | 0.95 | 20 of 160 (12.5%; 95% CI 7.5-17.5%) |
  | Sarvam Mayura on the native text [S15] | 1.28 | 9 of 160 (5.6%) |
  | Gemini (general LLM translator) on the native text | 1.73 | 0 of 160 |
  Every count reproduces exactly; all 29 kept reversal quotes are verbatim in the native text and in the named version [S20].

- **A closer read of today's 20 reversals** (independent refuter) [S20]: 8 are clean dropped-negation errors on clear native text (8 of 160 = 5%, CI 1.9-8.1%); 4 are judge over-calls; 8 sit on garbled or easily misheard transcript text, where today's English (made from the audio) may be the right one.
  - Examples that hold up on a closer read: a spoken refusal came out as an instruction to go ahead, and a repeated "no" came out as agreement (the quotes stay in the FT6 files).
- **Does it support the ruling?** In direction, yes, even after removing every doubtful reversal: Gemini scores higher in 19 of 20 consults (mean gap +0.78, CI 0.61-0.94; +0.65 without the 20 reversal turns) [S20]. Not yet settled: one AI judge rating an AI translator, a reference transcript that favours the text translators, and only 2 Telugu consults (no claim for Telugu).
- **Ruling (fable, 20 Oct 02:10):** fast-track features that read meaning (intent, refusal, emotion and similar) use the Gemini text-translate leg only. Today's Saaras English is not a feature input; it is kept stored as an audit and fallback track. Voice emotion (Odyssey) works on the audio and is not affected. [S35]
- **Before the ruling is final** [S20 fixes 4-5]: a human check of all 29 kept reversals (not only the 5 spot-check turns for V), more Telugu consults, and storing the raw judge reply on future runs (this run's 1 dropped reversal cannot be audited). Google Translate was not run (no credential on the lab box).

## 8. The frozen model and its one test on the sealed patients
- **Recomputed.** An independent whole-report refuter recomputed every frozen-model AUC and delta in sections 1, 4d, 4e and the dev figures of section 8 from the saved out-of-fold scores (the sealed-set figures come from the one-shot script, watched but not recomputed), with its own code. All match to 3 decimals [S32].
- **Pre-registered.** Every model, layer, setting, metric and test above was fixed in writing before the final runs: FT-MODEL-SPEC-20OCT-FROZEN.md, frozen 08:22, signed by newcat-orch 08:50 [S27].
  - Disclosed in the spec: forest-lead saw a dry run of the draft before freezing. No number changed the spec. The one last change, dropping the Jev consult items, was a translation-compliance rule.
  - One declared change after the freeze: the sealed test was moved from 15:00 to 10:00 (V pulled the schedule forward), after the final dev results were written and their shas logged, so nothing could be tuned after seeing it.
- **The sealed test (H): 389 patients never used for anything above.** The forest is trained once on all dev patients and scored once on H. Only the at-prescription models can be scored there (Pulse, and Pulse + medical history); calls, consults and voice exist for dev patients only. [S4, S28]
- **Result on the sealed patients (scored once, 20 Oct 10:00:55; watched by an independent refuter: clean, one run, counts as expected) [S28]:**

  | Label | Sealed patients / conversions | Pulse only | Pulse + medical history | Change (95% CI) |
  |---|---|---|---|---|
  | Surgery within 14 days | 361 / 82 | 0.669 | 0.627 | -0.042 (-0.077 to -0.010) |
  | Surgery within 90 days | 224 / 64 | 0.621 | 0.580 | -0.042 (-0.076 to -0.007) |

  - Pre-declared reading (Holm over the 2 labels): **no gain shown** on either label. Both intervals lie wholly below zero, so on patients the model never saw, **adding medical history made prediction worse**, consistent with dev (significant there at 14 days only) (section 4d).
  - On unseen patients the Pulse-only model holds at 14 days and is lower at 90 days: 0.669 at 14 days (dev 0.634) and 0.621 at 90 days (dev 0.690; the 90-day sealed set is small, 64 conversions). Brier is at or near the no-skill value at both labels (0.170 vs 0.176; 0.205 vs 0.204), so it ranks patients a little but does not give usable probabilities. [S26]
- **Calibration** on the sealed patients: Pulse-only slope 1.10 at 14 days and 0.58 at 90 days (with history 0.82 and 0.38) [S28]; on dev, see 4f.

## 8b. Discussion: what failed, what is weak, and what limits every result
**Negative results, stated first** [S26, S28]:
- **Medical history before the prescription (FT8) made prediction worse.** Dev, 14 days: 0.634 to 0.610, M1 - M0 = -0.024 (-0.043 to -0.003), the only Holm-significant result of 73 tests. Sealed patients: -0.042 at both 14 and 90 days, both intervals below zero. V asked for FT8 to be included; it was, and it hurt.
- **No layer produced a gain that survives correction.** Out of 73 dev tests: 0 gains. The benchmarks give 1 of 24, and that one favours the forest over Jev.
- **At day 3 after the prescription nothing helps**, and adding every layer is 0.02-0.04 below Pulse alone.
- **Voice and emotion engines (Odyssey, emotion2vec, WavLM, Clef) add nothing measurable.** The largest nominal step is +0.021, and it does not survive correction.
- **The recorded-consult cohort shows nothing over Pulse** (0.718 vs 0.691 with every layer).
- **Calibration:** the forest's probabilities are only slightly better than the base rate at the prescription (Brier skill 0.03-0.08) and no better at days 3 and 7 (0.00-0.03, intervals include zero). On the sealed patients the 90-day Brier is at the no-skill value (0.205 vs 0.204). It can rank patients a little; it cannot say "this patient has a 30% chance".
- **The AI transcript reader's lead was mostly an artefact** of insurance, pre-auth and payment talk (section 4f).

**What is weak but worth following:** the day-7 call signal (+0.03 to +0.08, exactly +0.027 to +0.078, mostly call activity and what was said). It is positive in every label, but every interval spans zero and it rests on 42-63 conversions. [S26]

**Limitations that apply to everything:**
- **Small numbers.** 189 conversions at 14 days and 150 at 90 days on dev; at day 7 only 42-63 are still at risk; 23 in the recorded-consult cohort; 82 and 64 on the sealed set. At day 7 the intervals are about ±0.08 AUC wide, so smaller effects cannot be seen; at the prescription they are about ±0.02. [S26, S4, S28]
- **Surgery elsewhere is invisible.** A patient operated at another hospital counts as "not converted".
- **Call linkage was incomplete.** The call models used 414 of the 1,233 dev episodes (the fetch set: calls in days 0-14, before the decision). Calls on phones shared by family members were set aside, never guessed. A repair (lane ft-runolink, rule: a shared phone is matched only when exactly one cohort patient's prescription window contains the call) links 941 of 1,233 episodes (563 before). Like for like with the 414, episodes with an answered pre-decision call in days 0-14 rise to 666. Its precision for shared phones (tier B) is not yet measured, and it is not used in any number in this report [S43].
- **Coverage is partial and rising over time.** Vitals and admissions start in 2026; recordings start 9 Sep; call audio exists for 369 of 1,233 dev episodes; Bolna has 37 calls. [S22, S8, S33, S25]
- **Labels.** The 14-day label misses about 1 in 4 conversions. Dermatology outcomes are not observable at all. [S2, S19, S6]
- **Translation and roles.** Call summaries are Runo's own English. The consult Jev items were dropped because they were computed on today's Saaras English. Half of the call speaker roles are still a "who talks more" guess (72% if the weak lexicon tier is counted as a guess) (masked in the model). [S33]
- **Model choice.** One fixed random forest setting throughout (no tuning, by design). A post-hoc check found that a plain logistic regression on the Pulse inputs does about as well as the Pulse-only forest at the prescription (0.638 vs 0.634) [S38, S40]. The forest is not clearly the better learner here. The SELECTED forward-pass model is optimistic by construction.
- **The sealed set is now used.** It was scored once, after everything was frozen, for the at-prescription models only. It cannot serve as an untouched test again.
- **Multiple comparisons.** 99 pre-declared deltas (73 cross-validated, 24 benchmark, 2 on the sealed set), plus earlier exploratory work (FT3-FT6, FTC, FTR). Every nominal "interval excludes zero" outside the Holm results should be read as chance until replicated. [S27, S26, S29, S28]

**Bottom line.** With today's data, the structured record says where conversions happen (specialty, doctor, procedure), weakly. Nothing else we can measure yet adds reliably. The directions worth more data are what happens on counsellor calls in the first week, and the doctor explaining the stay and recovery (post hoc, sections 3b-3d).

## 9. What we need next
- **More recorded surgery pitches.** At about 6 early conversions a week, the recorded cohort reaches about 60 by early-to-mid December. The EHBR Windows recorder and a fuller transcript backfill shorten this the most. [S8]
- **A better English track** for non-English consults and calls (section 7): an LLM text-translate on the native transcript, benched with a human check first. Until then, call and consult features that count refusals under-count them.
- **Time.** 90-day outcomes for the September-October consults mature in December-January. The 90-day final test (Aug-Sep 2026) stays sealed until then. [S2, S27] [S5]
- **Booking data.** Pulse bookings link to the prescription only from 25 Sep 2026, so the booking stage of the funnel can be measured properly only from late December. [S16]
- **Dermatology billing.** No flagged Dermatology prescription has a dermatology-procedure bill in KX. Where are these procedures billed?
- **Surgery elsewhere.** It is invisible except when a patient says so on a call (11% of non-converters after the Jev cross-check; 15% on raw tags). Any external data source would help. [S24, S10]
- **Next modelling step (Model 1, due 1 Nov):** keep the Pulse model as the baseline and leave the pre-prescription medical history out (it lowered AUC on dev and on the sealed patients). The day-7 call signal (call activity plus what was said) is the lead worth re-testing as more conversions accrue. Add any layer only when it beats the baseline on held-out data, with honest n. [S27, S28]
  - Note: the sealed set H has now been used once (for the at-prescription models). The 1 Nov final test needs a fresh holdout (for example later months), not H. [S28] [S27]
  - FT3 reproducibility: the order of some Pulse columns depended on Python's hash seed, which can change results slightly between runs. The frozen runs pin the column order, and the sealed-test script gives identical results under different hash seeds. [S34]

## Sources (the lab box; sha256 first 12 characters; read 20 Oct 10:05 IST, updated after the whole-report refute)
| Tag | File | sha256 | What |
|---|---|---|---|
| S1 | ~/oc/forest-lead/ft/ft1_timing.py (stdout counts, run 19 Oct) | 3b36eb5d076b | FT1 timing table |
| S2 | ~/wt/ft-refute-labels/.bc/ft-refute-labels-REPORT.md | 8c091939a96f | FT2 labels refute (978/883/214, 163/51) |
| S3 | ~/oc/forest-lead/ft/out/ft-labels-base/DONE.md; ft3_results.json | 7743dedd8f79; e7d5d01e34b1 | FT3 baseline |
| S4 | ~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet (labels v2) | 0aefc00f425b | labels |
| S5 | ~/wt/ft-refute-base/.bc/ft-refute-base-REPORT.md | bfb367be087d | FT3 refute |
| S6 | ~/wt/ft-refute-doctors/.bc/ft-refute-doctors-REPORT.md; ~/oc/forest-lead/ft/out/ft-refute-doctors/VERDICT.md | 5248d480d450; 7d5253de4d7d | FT5 refute |
| S7 | ~/oc/forest-lead/ft/out/ft-doctors/FT5-REPORT.md | c52e084a3db8 | FT5 lane |
| S8 | ~/oc/forest-lead/ft/out/ft-audio/FT4-REPORT.md; DONE.md | 641c64a6b547; 62497bff9f4e | FT4 lane |
| S9 | ~/wt/ft-refute-audio2/.bc/ft-refute-audio2-REPORT.md | a64f9ee88917 | FT4 refute 2 |
| S10 | ~/oc/forest-lead/ft/out/ft-calltext/DONE.md; FTC-REPORT.md; V2-TABLES.md | 734fbdd0eaad; ec6366dc9c6d; c651bc07ece9 | call text |
| S11 | ~/wt/ft-refute-calltext/.bc/ft-refute-calltext-REPORT.md | 28d444a49f47 | call text refute |
| S12 | ~/oc/forest-lead/ft/out/ft-calltext/FTR-TABLES-final-v2.md; FTR-REPORT.md | fa8ec5bee4bb; 5c71961c5de4 | FTR final v2 (refute fixes) |
| S13 | ~/wt/ft-refute-ftr/.bc/ft-refute-ftr-final-REPORT.md (v1 refute + v2 re-check) | 1666413a466a | FTR refute |
| S14 | ~/oc/forest-lead/ft/out/ft-rl-feat/call_audio_feats.parquet; ~/wt/ft-refute-rlfeat/.bc/ft-refute-rlfeat-REPORT.md | acca10d995c4; ebb9104e241d | audio features + refute |
| S15 | ~/oc/palimpsest/ft6/DONE.md; run1/summary.json | 30a7f41059c0; 1e691b31b78d | FT6 |
| S16 | ~/oc/forest-lead/funnel/hash-only/F1-COUNTS.md | 25e256bb33bf | funnel F1 |
| S17 | ~/oc/forest-lead/ft/out/ft-calltext/DESC.md | b5f39a8b531c | call descriptives |
| S18 | ~/oc/forest-lead/ft/out/ft-doctors/specialty_volume.tsv | eced48296993 | volumes, money |
| S19 | ~/wt/ft-refute-ft1/.bc/ft-refute-ft1-REPORT.md | ad1f9bc8ce50 | FT1 refute + corrected table |
| S20 | ~/wt/ft-refute-ft6/.bc/ft-refute-ft6-REPORT.md | 331c8e00eee4 | FT6 results refute |
| S21 | ~/oc/forest-lead/ft/out/ft8-clinical/INVENTORY.md | 23311020a88f | FT8 inventory (gating-lead) |
| S22 | ~/oc/forest-lead/ft/out/ft8-clinical/DONE.md; COVERAGE.md; features_ft8.parquet | 8edb4543ec76; dff9021318d7; d674e54010cc | FT8 v3 day-level build |
| S23 | ~/wt/ft-refute-ft8/.bc/ft-refute-ft8-REPORT.md (v1 + v3 addendum) | a75ab551515c | FT8 leakage refute, PASS |
| S24 | ~/oc/forest-lead/ft/out/ft-forest/DESC-jev.md | f5b6204a8f53 | call objections, raw / Jev-checked / both agree |
| S26 | ~/oc/forest-lead/ft/out/ft-forest/FOREST-TABLES.md (+ model_frozen_*.json, shas in S27 section 10) | 057ee325677d | frozen forest, all designs |
| S29 | ~/oc/forest-lead/ft/out/ft-bench/BENCH-TABLES-frozen-0910.md; LEAK-AUDIT.md; ~/oc/forest-lead/ft/out/ft-forest/BENCH-C-FOREST.md | 8aeb56e6b99d; 3520d790b231; 50817a2ae1ce (re-scored after the forest refute; v1 e4f1190daf83) | benchmarks vs the frozen forest; leak audit (refuted R1 + R2) |
| S30 | ~/oc/forest-lead/ft/out/ft-forest/FOREST-TABLES-SENS.md (calibration + sensitivities); CALIB-rx-consult.md | 55538e86797e; ab55a5c43bfe | calibration, sensitivities |
| S28 | ~/oc/forest-lead/ft/out/ft-h1shot/H-RESULT.md (+ H_RUN.done; watcher ~/wt/ft-h1shot-ref/.bc/ft-h1shot-ref-REPORT.md) | fb94f9eaf95f; H_RUN.done d2bce163f503; watcher 2a420a9a76c4 | sealed one-shot H result |
| S27 | ~/oc/forest-lead/ft/out/FT-MODEL-SPEC-20OCT-FROZEN.md (live copy with signature + declared change: FT-MODEL-SPEC-20OCT.md) | 704c50dffbef; live 5f28053ec17d | pre-registered spec |
| S25 | ~/oc/forest-lead/ft/out/ft-text2/DONE.md (+ ~/wt/ft-text2-oref/.bc/ft-text2-oref-REPORT.md) | 05dc133168b2; oref 3c0b697009f1 | Jev cross-check + Bolna, refuted |

| S31 | ~/oc/forest-lead/ft/out/ft-rl-run/DONE.md | ad061e77554e | RL-2 phone linkage |
| S33 | ~/oc/forest-lead/ft/out/ft-engines/DONE.md; COVERAGE.md | f07207f35bf3; 1ff35c8da660 | voice engines (coverage, speaker roles) |
| S34 | ~/oc/forest-lead/ft/out/ft-h1shot/DONE.md | c7168aa8b580 | H script build, tests, column-order finding |
| S50 | ~/oc/forest-lead/ft/out/ft-refute-convo/VERDICTS.md | 904cafc13fb6 | cross-lane refute of the 4 conversation lanes (all PASS-WITH-FIXES) |
| S49 | ~/oc/forest-lead/ft/out/ft-convo/CONVO.md | 434983d8a7f0 | whole-conversation checklist (pre-registered rubric) |
| S48 | ~/oc/forest-lead/ft/out/ft-dialog-consult/ft-refute-dconsult-REPORT.md | c6a2c7bc0d83 | refute of ft-dialog-consult (CONFIRMED WITH CAVEATS) |
| S47 | ~/oc/forest-lead/ft/out/ft-dialog-runo/ft-refute-descr-REPORT.md (same file in ft-docstyle/) | 7a55d79ad447 | refute of ft-dialog-runo and ft-docstyle (PASS-WITH-FIXES) |
| S46 | ~/oc/forest-lead/ft/out/ft-docstyle/DOCSTYLE.md (revised after refute) | fa810fb37467 | doctor styles (post hoc) |
| S45 | ~/oc/forest-lead/ft/out/ft-dialog-consult/DIALOG-CONSULT.md (revised after refute) | a6d1d161fdce | consult back-and-forth (post hoc) |
| S44 | ~/oc/forest-lead/ft/out/ft-dialog-runo/DIALOG-RUNO.md (revised after refute) | 1e11f71eaf60 | call back-and-forth (post hoc) |
| S43 | ~/oc/forest-lead/ft/out/ft-runolink/RUNOLINK.md | 91930d9e8256 | Runo linkage repair (not used in this report's numbers) |
| S42 | ~/wt/ft-lexical-oref/.bc/ft-lexical-oref-REPORT.md | dbdb06f340e1 | lexical refute (matched windows, one-sided screen) |
| S41 | ~/wt/ft8-blocks-ref/REFUTE.md | 3683e2114bf1 | history-blocks refute (5 shuffle seeds) |
| S40 | ~/oc/forest-lead/ft/out/ft-refute-whoconverts/VERDICT.md | 380209ce5ed7 | who-converts refute |
| S39 | ~/oc/forest-lead/ft/out/ft-lexical/LEXICAL.md (v2, after refute; + LEXICAL-TERMS.md, DONE.md) | afc19669aae7; 7735e4ac2313; 936e5334b5b9 | what is said (post hoc) |
| S38 | ~/oc/forest-lead/ft/out/ft-whoconverts/WHO-CONVERTS.md (v2, after refute) | eb6133986557 | who converts (post hoc) |
| S37 | ~/oc/forest-lead/ft/out/ft8-blocks/FT8-BLOCKS.md (wording fixed after refute) | aeb982f3e6b5 | which history blocks hurt (post hoc) |
| S36 | ~/wt/ft-refute-forest/.bc/ft-refute-forest-REPORT.md | 64f427a0662c | frozen-forest refute (PASS-WITH-FIXES) |
| S35 | ~/oc/forest-lead/ft/FASTTRACK-ALE-21OCT.md (copy of the plan of record on the Mini, specs/) | 8466a18f0db6 | rulings with times (FT6 ruling 02:10) |
| S32 | ~/wt/ft7-wholeref/.bc/ft7-wholeref-REPORT.md (whole-report refute) and ~/wt/ft7-jevcheck/.bc/ft7-jevcheck-REPORT.md (Jev claim check) | ec3a1181bed9 (whole-report refute, final, all 31 fixes closed); dc40fff825d5 (Jev check v4, PASS) | final checks |

_The admin-only annex (doctor tables, the 145 listening-pair consult ids) is kept in a separate file and is not part of this report._
