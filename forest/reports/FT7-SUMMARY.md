# Surgery conversion: first read (for V and Ale). v6 FINAL, 20 Oct 2026
One page. The full report, with every number and its source file, is FT7-REPORT.md. The model and its tests were fixed in writing before the final runs. One group of patients (389) was held back and used exactly once, at the end, to check the result on patients the model had never seen. All fixes from the independent refutes are applied in the report (the whole-report refute closed all of its fixes). An independent reviewer recomputed the final model figures on the development data from the saved scores, and the one test on the held-back patients was watched by an independent refuter.

**1. Most surgeries happen within two weeks.**
- Of 214 surgeries after a doctor flagged surgery (Dec 2025 - Jul 2026), half happened within 6 days and 76% within 14 days.
- Ale's 14-day label is a good fast measure. It misses about 1 in 4. Orthopaedics and Gynaecology look slower than General Surgery, but the intervals overlap, so this is directional only.

**2. Who converts.** (Looking back at our data; these go together with conversion, they are not causes.)
- The largest differences are in what was advised and by whom: General Surgery converts at 24%; anorectal procedures at 27%; prescriptions with no procedure named at only 10%.
- Doctors' conversion rates differ, even within one specialty (11% to 38% in General Surgery, after allowing for small numbers), though most of that is the kind of patients they see.
- Patients with no pincode on file convert at 12% vs 21% in the main local area, but the pincode is the value on file today and may be filled in at admission, so this may partly reflect the outcome. New patients convert a little more often than returning ones.
- No link with age, sex, payer, day of the week or language.

**3. What is said on calls and in the consult room.**
- The biggest difference is insurance and pre-approval paperwork, which comes after a patient has decided, not before.
- Without that talk, little in the words reliably separates converters. Leads worth testing on new patients: counsellor reassurance, doctors explaining recovery and the hospital stay (75% vs 30% of consults), and early mentions of going elsewhere (some of which mean the patient had already gone).
- None of this shows cause. These are things to test on new patients before acting on them.

- How the conversations go: patients who push back or name an alternative rarely convert (7% vs 24%), but mostly late in the call window, so it is close to the outcome itself, not an early warning. A whole-conversation checklist added to the model made prediction no better.

**4. What Pulse already knows predicts conversion weakly at 14 days and only moderately at 90 days. It holds up on new patients at 14 days (lower at 90 days).**
- Cross-validated score about 0.63 (14 days) and 0.69 (90 days); 0.67 and 0.62 on the held-back patients. 0.5 is a coin toss; 1.0 is perfect.
- Almost all of it is which specialty, doctor and procedure. Inside one specialty it does not reliably tell converters apart.

**5. We added everything else. Nothing provably helped, and medical history made it worse.**
- We added each patient's record from before the prescription (earlier visits, diagnoses, labs, blood pressure, medicines), counsellor-call activity, what was said on the calls, voice analysis from every engine, and an AI reading of the call transcripts. Each was added one at a time.
- **Medical history lowered AUC** at 14 days, by -0.024 on our data and by -0.042 on the held-back patients. No single part of the history is to blame; the loss looks like added noise, though our check cannot rule out a weak harmful signal. At the prescription, a simple, readable model does about as well as the forest.
- **By day 7 after the prescription, calls may help a little (+0.03 to +0.08 AUC)**, mostly how many calls there were and what was said, but not enough to be sure. At day 3 nothing helps. Voice and emotion add nothing measurable yet.
- **Among patients with call transcripts, an AI reading them scored 0.79-0.84 at day 3 vs 0.58-0.64 for the model**, but mostly because it picks up insurance, pre-approval and payment talk: the hospital's own conversion process, an outcome proxy rather than the patient's intent. Without that talk it is not clearly better than the model.

**6. It is mostly not the doctor.**
- Within the same specialty, after adjusting for the kind of patient, doctor-to-doctor differences explain only about 0-6% of who converts (at most about 18%) at 14 days; at 90 days about 0-11% (at most about 40%, only 12 doctors). That is far from 80%.
- Four specialties hold most of the non-conversions (717 of 748 among specialties with 30 or more episodes, Dermatology excluded): General Surgery, Gynaecology, Orthopaedics, Urology.
- Rough upside over about 11 months (our data only): every doctor at their specialty's median would give about 18 more surgeries; a 20% lift about 35.

**7. What patients say on counsellor calls** (Haiku tagged every call; Jev, a second AI model, checked every tag):
- People who did **not** convert mention timing ("later") 35% vs 17%, going elsewhere 11% vs 1% (after Jev's cross-check; 8% vs 0% if Haiku and Jev must both agree), and a second opinion 7% vs 0%.
- People who converted talk about insurance and cashless processing (61% vs 31%).
- **Cost comes up about as often in both groups (15% of converters, 19% of the others)**, so cost alone does not mark a lost patient.

**8. Today's English translation sometimes loses "no".** Of 160 consult turns picked for negation and emotion words, 8 (about 1 in 20) had a clear refusal cleanly dropped in today's English (a judge flagged 20; on a closer read 4 were over-calls and 8 sat on garbled or easily misheard text). By ruling, features that read meaning will use a better translator; in this report, consult features built on today's English were left out of the models.

**What would sharpen this:**
- more conversions to learn from: recordings reach about 60 early conversions by mid-December, faster with the EHBR recorder;
- 90-day outcomes maturing over December-January;
- where Dermatology procedures are billed (invisible today), bookings linked to prescriptions (only from 25 Sep), and any source on surgery done elsewhere.
- **Next model (1 Nov):** keep the Pulse baseline, leave medical history out, and re-test the day-7 call signal as data grows.
