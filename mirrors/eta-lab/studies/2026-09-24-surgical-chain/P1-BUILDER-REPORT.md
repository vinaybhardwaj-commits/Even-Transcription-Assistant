# P1 chain builder, links 1 and 2: first run (linker, 24 Sep 2026)

Code: `p1/build_chains.py` (stages A, B, D, C). Read-only Metabase, window 1 Aug to 24 Sep IST. Rows and ids are on the box in `~/eta-data/surgical-chain/p1/` (0700); this file has counts only. Rules: `P1-PREREG.md` (frozen, 564d934) and `P1-PREREG-v2.md` (amendments). No transcripts, no link-3 scoring.

## 1. Link 1: visit to Rx (stage A)
7,188 completed consult steps pulled; **6,713 kept**, 475 dropped (missing patient, doctor or time, or under 1 minute).

| Route | Tier | Visits |
|---|---|---|
| KEY | A (one Rx, patient and doctor agree) | 6,536 |
| KEY | B (2 or more Rx; latest non-draft chosen) | 132 |
| KEY | X (patient or doctor disagree with the step) | **23** |
| HEUR | B | 3 |
| HEUR | C (ambiguous) | 2 |
| none | no Rx at all | 17 |

99.7% of visits carry the key (see `P1-PREREG-v2.md` A1: the P0 measurement of "complete from 14 Aug" no longer holds). The 23 tier-X visits are a defect count, not investigated.

## 2. Advised flags and done evidence (stage B)
- Structured flag `S`: **518** Rx (the "517" of earlier messages was one short); 418 have at least one named procedure, 100 have none. Model-read `P`: 535 with `yes` (PSR rows in window 6,545; explicit `no` 3,251). Advised Rx in total 633: **BOTH 420, S_ONLY 98, P_ONLY 115**. Surgical-clinic doctors (10 or more advised Rx): 17 of 58 doctors with any.
- Outcome tables in window: OT notes 387, admissions 1,438, procedure-billing lines 816 (`IP Package` plus non-overhead `Surgery`), non-cancelled cases 402.

30-day outcome per advised Rx (mature = Rx on or before 22 Aug):

| Flag class | n | DONE_STRONG (note or procedure billing) | ADM_ONLY | BOOKED_MANUAL_ONLY | NONE |
|---|---|---|---|---|---|
| BOTH | 130 | 41 | 3 | 2 | 84 |
| S_ONLY | 44 | 11 | 1 | 0 | 32 |
| P_ONLY | 58 | 26 | 3 | 0 | 29 |
| All mature | 232 | **78** | 7 | 2 | 145 |

14-day outcome (mature = on or before 7 Sep): BOTH 247 (DONE 67, NONE 171), S_ONLY 67 (10, 54), P_ONLY 98 (42, 52); 119 done-positives in all.

## 3. Ruling 163: `offered_in_house` and the recount (stage D)
Corpus: OT-note names and procedure-billing names, 24 Mar to 24 Sep (899 OT-note rows; billing 28 to 520 rows a month). **198 distinct advised names: 162 in-house-evidenced, 15 referred out, 21 unjudged.**

**Referred-out list** (advised name, Rx count; zero occurrence of any distinctive term in six months of OT notes and procedure billing). **Read with the corpus limit: OT and inpatient billing only, so OPD-only procedures show zero whether or not they are done here.**

| Rx | Advised name | Likely OPD-only or non-surgical? |
|---|---|---|
| 3 | chemical peel | probably OPD |
| 2 | keloid excision with skin graft (two spellings) | possibly a name mismatch |
| 2 | epididymal cyst excision (two spellings) | "cyst" occurs in-house; the distinctive stem does not |
| 1 | ingrowing nail excision | probably OPD |
| 1 | intravenous immunoglobulin infusion | day care / infusion |
| 1 | hemodialysis | service, not an operation |
| 1 | nebulisation | OPD service |
| 1 | nebulization | OPD service |
| 1 | oxygen saturation monitoring | monitoring, not a procedure |
| 1 | metacarpophalangeal joint ORIF | surgical |
| 1 | stapedectomy | surgical |
| 1 | thymectomy | surgical |
| 1 | uvuloplasty, radiofrequency | surgical |

CT angiography is referred out by V's ruling 163: 30 prescriptions in the window, **1** in the structured-flag set, 29 in neither.

**Recount of the structured-flag set (518):** 373 in-house named, 100 unnamed, 35 unjudged, **10 referred-out-only (dropped)**.

**Recount of the candidate-negative pool** (structured-flag Rx, mature, no note, no procedure billing, no admission, no manual case; `PRESCRIBED` cases ignored):

| Follow-up | Mature cutoff | Before drop | After dropping referred-out and CT angio | of which unnamed | of which unjudged |
|---|---|---|---|---|---|
| 30 days | 22 Aug | 116 | **115** | 27 | 5 |
| 14 days | 7 Sep | 225 | **221** | 49 | 12 |

**Note for Fable:** ruling 151 called "517 prescriptions with no case, note or admission within 30 days" the negative pool. **517 (now 518) is the whole structured-flag set.** Only the mature part can be judged, and about 2 in 3 of those have no follow-on record: **116 at 30 days (115 after drops), 225 at 14 days.** The rest are too recent to call.

## 4. Frame: matched negatives (stage C, seed 24, from box files only)

| | 30-day | 14-day |
|---|---|---|
| Done-positives (mature, no CT angio) | 78 | 119 |
| ... of which with a queue visit tier A or B | **35** | 75 |
| N1 pool (advised, not done) | 115 | 221 |
| ... with a queue visit tier A or B | 68 | 157 |
| N2 pool (visits by surgical-clinic doctors, explicit PSR `no`, no `S`) | 295 | 717 |
| Positives with no same-doctor same-week N1 | 12 of 35 | 28 of 75 |
| Positives with no same-doctor same-week N2 | 8 of 35 | 14 of 75 |

**Yield finding:** 43 of the 78 done-positives have no queue visit. They are hospital GP (29) and gynaecology (14) prescriptions; the consult id resolves to a consultation service request in 42 of 42, but only 3 of those requests appear on a queue step, so these consults did not go through the queue. `P1-PREREG-v2.md` A4 adds a route `RXWIN` (the Rx's own start-to-last-save window) for them; the frame above does not yet include it.

## 5. Not done
Link 3 (recording) and everything that scores; the plain-CT done source (waiting for `mb-rx`'s radiology tables, ruling 164); investigation of the 23 tier-X visits; `RXWIN` visits in the frame.

## 6. Input freeze and drift (eta-refuter-2 #588)
The queue-side visit key was repaired at source between about 16:07 and 17:25 (eta-refuter-2 re-ran its P0 query and confirmed; the service-request rows it now resolves to have old `created_at`, so that table was not newly loaded). To stop a mid-run change from silently altering the route mix:
- **Inputs are frozen per pull.** Every stage writes its output to `~/eta-data/surgical-chain/p1/` and stamps it in `MANIFEST.json` (written-at time and size). Stages B, C and D read only those files, never Metabase results of a different time. Present stamps: visits and Rx **17:12**, flags, PSR and outcome evidence **17:16-17:17**, negatives frame **17:18** (IST, 24 Sep). Existing entries were back-filled from file mtimes and say so.
- **Drift check** (`build_chains.py drift`): re-resolves a seeded sample of 300 stored visits against live Metabase. At 17:27, 300 of 300 visits stored as KEY were still KEY with the same candidate counts. It samples KEY visits only (the 22 non-KEY visits are too few to sample); it detects a repair or backfill that changes a stored KEY visit, not one that would newly promote a HEUR visit.
- A re-pull means a new stamp and a re-run of every downstream stage; nothing is patched in place.
- I did no writes: the builder goes through the SELECT-only guard in `mb.py` (a single SELECT or WITH, blocked words for any write), and every query in this work was a SELECT.

## 7. Procedure agreement, stage 1 (stage F; rules `P1-PREREG-v4.md` then `-v5.md`; no label accepted)
Names pulled 17:38 (stamped). Mature 30-day candidates (advised Rx + OT note or procedure billing, same patient), 78: **match 50** (BOTH 28, P_ONLY 16, S_ONLY 6), technique_changed 1, mismatch 4, **unknown 23**. Mature 14-day, 119: match 69, technique_changed 1, mismatch 4, unknown 45. Of the 23 unknown: 13 have no advised name in any structured field (12 have a model-read row, all with an empty procedure-type text), 10 have names on both sides (generic advice against a specific operation, a subset, a technique change, one spelling gap). Item-level split of the 50 matches: 47 full, 3 partial (an "extended" match inside one item is not detectable by rule). Precision (refuter grades): v4 sample 16 of 20 (below the bar; rule replaced by v5); v5 fresh sample 15 of 20 for the same operation fully, 18 of 20 counting partial or extended. **The policy (same operation / advised operation done, possibly with more / same indication) is with Fable and V; labels wait for it.** Counts by option: 47 / 50 / 51 of 78. No `MANUAL` case name is used as a match source (it would have matched 23 of 78 by construction).

## 8. Plain CT done source (stage E; ruling 164, `P1-PREREG-v3.md` A7)
Plain-CT orders on prescriptions (CT by name, excluding angiography, calcium score, CTPA, PET, MRI): **120 prescriptions, 107 patients** in the window (mb-rx counted 102 by investigation uid; my name match is broader; the 18 extra are not investigated). Done evidence, same patient within [-1, +30] days: a COMPLETED platform CT service request, or a HIS plain-CT bill line.

| Follow-up | Mature cutoff | Mature Rx | of which done | Immature Rx | of which done |
|---|---|---|---|---|---|
| 30 days | 22 Aug | 41 | **0** | 79 | 23 |
| 14 days | 7 Sep | 78 | **7** | 42 | 16 |

All 23 done records come from the platform table; the HIS bill lines contribute 0 in the window. This reproduces mb-rx's warning: the platform table holds roughly a third of in-house CTs and the complete HIS table stops on 13 Jul, so **a missing record is not evidence of "not done" and plain CT stays positives-only** (A7). **Mature plain-CT positives: 0 at 30 days, 7 at 14 days.**

**Name rule corrected after mb-rx #636 (no done rate was consulted):** the first run included "CT Venogram" and "CT SCAN AORTOGRAM" (vascular contrast studies, the referred-out angio family) and missed "CECT Thorax"; the exclusion list now has venogram, aortogram, arteriogram and portogram, and the inclusion pattern has CECT and NCCT. Re-run at 17:59 (new stamp): **119 prescriptions, 106 patients** (was 120 and 107). mb-rx counts 107 and 95 after the same corrections: **a gap of 12 prescriptions and 11 patients that I have not explained.** The done counts did not change (30 days: 0 of 41 mature, 23 of 78 immature; 14 days: 7 of 78 mature). Positives-only stands. Queue visit for these Rx: 67 have one (KEY), 53 do not (RXWIN candidates).

## 9. RXWIN in the frame (stage R; `P1-PREREG-v2.md` A4)
For advised prescriptions with no queue visit and explicit-no prescriptions from surgical-clinic doctors with no queue visit, the visit window is the prescription's own `[timestamp, updated_at]`: 1,096 windows, **median 8.9 minutes, p90 100 minutes** (none needed the 8-minute default). **The p90 is a warning:** some prescriptions stay open long, so an `RXWIN` window can run past the real consult and overlap the doctor's next visit. A cap is needed before any link-3 scoring and must be pre-registered first (candidate cap: 30 minutes, near the p95 of queue consult duration, 38 minutes); it is not applied here.

Frame counts, KEY and RXWIN kept apart (seed 24, box files):

| | 30-day | 14-day |
|---|---|---|
| Candidates (advised + note or procedure billing) | 78 (KEY 35, RXWIN 43) | 119 (KEY 75, RXWIN 44) |
| N1 pool, "no evidence of done in our records" | 115 (KEY 68, RXWIN 47) | 221 (KEY 157, RXWIN 64) |
| N2 pool, explicit no, surgical-clinic doctors | 595 visits (KEY 295, RXWIN 300) | 1,060 (KEY 717, RXWIN 343) |
| Candidates with no same-doctor same-week N1 | 35 of 78 | 51 of 119 |
| Candidates with no same-doctor same-week N2 | 18 of 78 | 24 of 119 |

Every candidate and every N1 prescription now has a visit. The matched draw needs the adjacent-week borrowing rule of `P1-PREREG.md` section 6 for the 35 and 51 unmatched; the shortfalls are reported, not filled silently.

## 10. proc_match precision record (eta-refuter-2 grades, names only; every sample fresh at the time)
| Rule | Sample | Same operation fully (A) | Counting partial / extended (A+) | Bar | Outcome |
|---|---|---|---|---|---|
| v4 | 20 pairs, seed 24 | 16 | 18 | 18 of 20 | tripped (strict 16) |
| v5 | 20 units, seed 25 | 15 | 18 | 18 of 20 | passes A+ only |
| v6 | 20 units, seed 26 | 14 to 17 | 18 to 20 | 18 of 20 | passes A+ only |

For v6 the refuter's range depends on how three pairs are read (a technique not verifiable from a billing-package name; a route unstated). **Reading: the name rule is fit for A+ and not for A.** It cannot see technique or route in package names, so an A policy needs a text step (a judge over the operative note), not a better name rule. Under A+ the rule is ready; the policy is with Fable and V (A: the same operation; A+: the advised operation performed, possibly with more or part of a multi-item list; B: the same indication, any technique). No label is accepted before the ruling. RXWIN cap and next-visit cut (v6 B1) accepted by the refuter as pre-registered.

## 11. Labels under A+ (ruling 179, final), the link-3 worklist, and the audio limit (stage L; `P1-PREREG-v6.1.md`, `-v7.md`; stamped 18:05-18:30)
**Labels, 30-day follow-up, A+ units** (one per patient and advised name, earliest prescription kept). Under the v6.1 mature rule (all classes on or before 22 Aug): **50 positives** (46 full, 4 partial; 18 with a queue visit, 32 with a prescription window), `B only` 1 (B sensitivity: 51), mismatch 4, unknown 21. Under the v7 rule (positives and N2 any date; N1 mature only): **92 positives** (83 full, 9 partial; 58 queue, 34 prescription window; 50 mature and 42 immature), B sensitivity 93, mismatch 5, unknown 52. The 14-day relaxed set has 85 positives (68 mature, 17 immature). Never pool the maturity classes in one rate (v7 C2).

**Matched negatives (seed 24; same doctor and ISO week, else adjacent week, flagged):** v6.1: 29 N1 and 42 N2 drawn for 50 positives (21 without an N1, 8 without an N2, 10 borrowed weeks). v7 relaxed: 33 N1 and 78 N2 for 92 positives (59 without an N1 because N1 is mature-only, 14 without an N2, 14 borrowed).

**The audio limit (Neon `bench_chunk`, 5-minute chunks, all rooms merged: an upper bound on any one room's coverage).** Chunks per IST day: 18, 1, 171, 18, 108 on 4, 18, 19, 20, 22 Aug; 237, 212, 136 on 23 to 25 Aug; 317 to 1,227 a day from 9 to 24 Sep; almost none otherwise. Visits whose own window has at least half the consult covered:

| Worklist | Positives | N1 | N2 |
|---|---|---|---|
| v6.1 mature: 121 visits | **1 of 50** | 2 of 29 | 0 of 42 |
| v7 relaxed: 203 visits | **20 of 92** (all A+ full: 19 queue, 1 prescription window; 0 of 9 partial) | **2 of 33** | 15 of 78 (14 queue, 1 prescription window) |

**Reading.** The chain is not the bottleneck; recorded audio is. The v6.1 rule leaves one positive with audio. The v7 rule leaves **20 positives, 15 no-procedure negatives and 2 advised-not-done negatives**: enough to exercise link 3 and the pipeline, **not enough for a rate claim, and the advised-not-done class (N1) is close to unmeasurable now** because its mature prescriptions (before 22 Aug) predate the tape and its September prescriptions are not mature until October. Prescription-window visits rarely have audio (2 of the 37). A blinded input file for link 3 (37 visits, pseudonymous item ids, doctor, window and day only; no class, no patient, no prescription id) and its key are on the box. Ruling 181 (MRI referred out) is recorded in v7.1; it changes no count.

## 12. v7.2 conditions (refuter #686), recorded in `P1-PREREG-v7.2.md`
(1) Link-3 comparison = positives versus N2 from the same weeks; N1 descriptive only (era confound: September audio and pipeline against an August N1). (2) Procedure mix beside every result: mature positives are led by hysterectomy, myomectomy, haemorrhoidopexy and endometriosis surgery; immature positives by circumcision, myomectomy, endometriosis, hysterectomy, hysteroscopy and LSCS: more day-care procedures, otherwise similar. (3) Pipeline state (engine and flags version; before or after the 24 Sep 04:39 gate change) recorded per audio item, and an item without it is excluded and counted. (4) Open for Fable: the judge that scores the content link (patient text cannot go to the `even-jev` endpoint).

## 13. Link-3 judge: synthetic scale check (v7.3 E2; 16 invented pairs, no patient text; run after the v7.3 commit)
`P1-LINK3-SCALECHECK.json` holds every score. **All three pre-registered criteria pass: clear matches 4 of 4 at p(yes) >= 0.70 (all 0.98); clear mismatches 4 of 4 at <= 0.30 (0.02 to 0.03); near-decoys 4 of 4 with own >= 0.50 and own minus decoy >= 0.15 (own 0.98 to 0.99; decoys 0.02, 0.03, 0.03 and 0.19).** The score is a 0-1 probability, so the pre-registered floor (0.50) and margin (0.15) stand unchanged.

**What this does and does not show.** It shows the route works end to end and that the scale is the one v1 assumed. It does **not** show how the judge behaves on real transcripts: the scores are close to binary (0.98 and 0.02), and even the "near" decoys were easy (a decoy at 0.19 was the highest). Real consults are short (median 5.2 minutes), code-switched, speech-recognised and de-identified, and the doctor's same-day prescriptions are often much more alike than a cold and a wheeze. The expected failure is not a low score for the right room but **ties near the top**, so the real risk sits in the margin rule, not in the scale. That is why item D1 (positives against same-week N2), the SINGLE class and the per-item redaction counts matter, and why no accept rate is quoted before real pairs are scored. Real pairs remain blocked on Fable's confirmation that prescription text is an allowed Jev input under ruling 42 (v7.3 E4).

## 14. Link-3 judge: the hard synthetic set (v7.3a F1-F2; 12 invented visits, 24 calls; criteria committed before the run)
`P1-LINK3-HARDCHECK.json` holds every score. **H1 (same complaint, different medicines): 4 of 4 separate, margins +0.87 to +0.93. H2 (different complaint, same medicines): 4 of 4 separate, margins +0.83 to +0.95. Both pre-registered criteria pass.** **H3 (routine, near-identical, different wording): all 4 pairs tie, margins +0.00 to +0.01 (own 0.98 to 0.99, decoy 0.97 to 0.99): a tie rate of 4 of 4.**

**Reading.** The judge is decisive when either the complaint or the medicines differ, and it cannot separate visits whose complaint and medicines are the same. That is the right behaviour for the question as frozen, and it puts the whole selection problem in one place: **a visit whose same-day neighbour by the same doctor has the same complaint and the same common medicines (routine reviews of diabetes, hypertension, thyroid, uncomplicated colds) will fail the 0.15 margin by construction, whatever the recording; visits with an unusual presentation will pass.** So the accepted set will be tilted toward unusual presentations, as the refuter warned (v7 D1/D2, A6). The rate at which real same-day pairs are near-identical is not known yet; it can be estimated before any transcript is scored from the prescription side alone (same doctor, same day, same structured complaint and medicine codes), and that estimate is the next descriptive number to produce. Surgical clinics probably sit between H1 and H3 (shared complaint, medicines usually differ in dose or add-ons), which the real pairs will show. Real pairs are still blocked on Fable's confirmation that prescription text is an allowed Jev input (v7.3 E4); the window stays plus or minus 10 minutes.

## 15. How often is a visit's same-day neighbour near-identical? (stage T; prescription side only, no transcript)
Upper bound on margin ties, from the doctor's other hospital-type prescriptions on the same IST day with an **identical diagnosis-code set** (medicines can still differ, so this over-counts near-identical; visits with no diagnosis code are not judged).

| Group | Prescriptions | With a diagnosis code | Identical-diagnosis same-day neighbour |
|---|---|---|---|
| All queue visits with a prescription | 6,671 | 3,677 (55%) | 839 = **23%** of the coded |
| Surgical-clinic doctors | 3,063 | 1,974 (64%) | 392 = 20% |
| All other doctors | 3,608 | 1,703 (47%) | 447 = 26% |
| The 37 blind link-3 items (together, class-blind) | 37 | 28 (76%) | 7 = 25% |

Other same-doctor same-day hospital prescriptions per visit: median 7, p90 20; **none at all for 219 of 6,671 (3.3%)**, the SINGLE class (matches the 3.7% found earlier). **Reading:** with the hard-set behaviour (section 14: a complete tie when complaint and medicines match), the margin rule can be expected to fail for **at most about a fifth to a quarter of coded visits** because of same-diagnosis neighbours, plus the 3% with no neighbour; the true rate is lower than this bound (medicines and wording differ), and the 45% of visits with no diagnosis code cannot be judged from this side. So the selection effect toward unusual presentations is real but moderate, not the majority. The number to watch on real pairs is the accepted share by diagnosis group, per v7 D2 and the A6 table.

## 16. The link question for real pairs (v7.6): synthetic acceptance passes (invented text only; criteria committed first)
`P1-LINK3-V2CHECK.json` holds every score. **M1 (three-visit window containing the visit): 4 of 4 at 0.98. M2 (window without it): 4 of 4 at 0.04 to 0.06. M3 (no-medicine prescriptions): 4 of 4 correct (matches 0.96 and 0.97; non-matches 0.04 and 0.05).** The v7.3a hard set under the new wording: **H1 4 of 4 and H2 4 of 4 still separate** (own 0.97 to 0.98; decoys 0.05 to 0.37), **H3 still ties (own and decoy within 0.01 on all 4)**. So the new question keeps the tie behaviour, gains the two properties real windows need (any visit in a multi-visit window; no medicines listed), and the 0.50 floor and 0.15 margin stand. The same limit as before applies: these are clean invented pairs, not real consults.

## 17. The ruling-191 mechanics pilot (4 items with production text in every shortlisted room; NOT a result; the class key was never read)
**Run 1 (v7.6, everything on the consult plus or minus 10 minute window):** 45 files (10 room windows, 4 own prescriptions, 31 same-day decoy prescriptions) de-identified on the GPU (262 names, 28 addresses, 10 phone numbers, 8 dates of birth, 6 ids, 2 ages redacted in all), all passed the residual-identifier gate, 41 Jev calls in 46 seconds. Verdicts: 1 accepted, 1 ambiguous tie on the prescription side (a decoy scored 0.95 against an own-prescription score of 0.90), 2 below the floor. **Run 2 (v7.7, the prescription-side margin on the consult plus or minus 2 minutes, room choice unchanged):** 2 accepted, 2 below the floor. **The tied item became accepted: its best decoy fell from 0.95 to 0.62 and the margin is +0.28.** In that item exactly one same-day decoy visit starts inside the padded window, 6 minutes after the consult ended; the other tied-free items have none. This supports the leakage explanation (evidence from timestamps and scores; I did not read the text). The two below-floor items are not linked in their shortlisted rooms (one has a single shortlisted room; the other's three rooms score 0.04 to 0.06): the shortlist is a gate and a consult can be absent from all of it.

**These four items informed the v7.7 rule and are excluded from every accuracy or rate claim of link 3** (v7.7 K2.4); the primary analysis runs on the other 33. Mechanics findings fixed on the way: an ASCII locale crashed the de-identification writer (now UTF-8 mode, and scoring refuses unless every output parses and keeps its turn count) and a timestamp parser that did not accept a trailing Z. Code: `p1/link3_pilot.py`.

## 18. Interim yield pass on the first 10 complete HIST items (mechanics only; class key sealed; no class join; not a result; commit 7e2d62d)
Windows finished by hist-bulk at the time: 30 of 99 (all from the no-production-text group); items whose every shortlisted room had finished: 10 of 37. Provenance of every window verified against the published immutable git copy (sha256 equality; `temperature_fallback` recorded as "on, ruling 196; field absent in this run's record" because the run started before the ruling). 127 files de-identified on the GPU (343 names, 140 omitted non-Latin fields, 30 ids, 15 phone numbers, 10 dates of birth, 6 addresses); all passed the gate.

**Verdict counts over the 10 items, by item id only:** ACCEPTED 1; AMBIGUOUS_TIE (prescription side) 1; REJECT_BELOW_FLOOR ("not linked in the shortlisted rooms") 4; LANGUAGE_LIMITED 4 (v7.9); INCOMPLETE 0 (v7.10 turned 4 silence-only cases, which the first pass wrongly withheld, into scored items). **Observations:** (1) HIST windows are much sparser than production text for comparable windows (15 to 75 turns against 300 to 700), so the primary HIST comparison and the production secondary check will differ in more than transcription noise; (2) **CORRECTED (in commit 3286587, v7.12): my first version of this observation was wrong.** The numbers I printed for the four language-limited items (0.67 and 0.63, 0.57, 0.82 against 0.39, and 0.57) were the **non-English shares of each room's turns**, not scores: language-limited items are withheld before any scoring, so **no scores exist for them** and I had no basis to say that one "would have been accepted". Whether withholding costs links is unknown until those items' English-only scores are computed (v7.12 stores them as a flagged stratum). (3) Four items had a silent shortlisted room (finished output, no speech). (4) Same-doctor neighbour visits inside the padded window: 0 to 4 per item.

**Mechanics fixed along the way (all committed):** the window indexer missed the real output path (`runs/<run_id>/<room>/<date>/l3-*.json`), so an early "0 of 99 finished" was wrong; provenance is now verified by sha equality to any published stack copy (the git listing needed `--full-tree`); a finished window with no speech scores 0 (v7.10).

## 19. Ruling 200: interim over 18 items, the flagged stratum, and the coverage pass on the 8 below-floor items (diagnostic; class sealed)
**Verdicts, 18 items (by item id only):** ACCEPTED 1; AMBIGUOUS_TIE (prescription side) 1; REJECT_BELOW_FLOOR 8; LANGUAGE_LIMITED 8. **Flagged stratum (v7.12; the English-only chain of the 8 language-limited items, descriptive, never pooled):** would-be verdicts 7 REJECT_BELOW_FLOOR (best 0.04 to 0.17) and 1 INCOMPLETE; none would have been accepted, so withholding cost no accepted link in this sample. (My earlier statement that one would have been accepted was wrong: those were non-English shares. Retracted, section 18.)

**Coverage pass (v7.13; window widened to the consult plus or minus 60 minutes and to every room with text; production and HIST kept apart; 10-minute sub-windows, step 5; the floor and the question unchanged; a diagnostic, not a result).** Text that exists in the widened span: production text for the four August items only (1 or 2 rooms each), HIST outputs in 1 to 5 rooms per item (mostly the link-3 windows). 25 documents de-identified and gated; 172 sub-window calls.

| Item | Best score | Offset from Rx time (min) | Source of the best | Rooms with text (production / HIST) | Best in the pre-registered window |
|---|---|---|---|---|---|
| c002 | 0.26 | -72 | HIST | 0 / 4 | 0.06 |
| c003 | 0.10 | +55 | HIST | 1 / 2 | 0.06 |
| c007 | 0.18 | +50 | HIST | 0 / 3 | 0.06 |
| c009 | 0.26 | -10 | HIST | 0 / 5 | 0.13 |
| c017 | 0.09 | +50 | HIST | 0 / 2 | 0.05 |
| c018 | 0.16 | -15 | production | 1 / 1 | 0.03 |
| c019 | 0.11 | -35 | HIST | 2 / 2 | 0.08 |
| c022 | 0.33 | -35 | production | 1 / 1 | 0.04 |

**Reading.** No item reaches 0.50 anywhere in the text that exists; the best offsets are scattered from -72 to +55 minutes with no cluster, and a maximum over 8 to 52 sub-windows raises the best score even from noise, so these values are not evidence of a hidden match. **This does not test the coverage hypothesis where it matters:** rooms without any text in the widened span. That needs new transcription of every room with tape in the span (window list requested from hist-miner, #826); the pass is re-run when it lands. Part B (translate the language-limited items) is not run: the redactor omits Indic-script fields (102 of the 134 non-English turns in the over-half rooms), so de-identify-then-translate reaches only the 32 Latin-script turns; Fable to decide (#826).

## 20. Disclosures on the record (refuter #910 verified the numbers; these are process points against my own wording)
1. **"Committed before each run" was not true for the 18-item interim.** The stored `run_results.json` for the 18 items was written at 19:42:34; the commit that fixed the scorer's flagged-stratum branch (f9b19f2, the deletion of an early `if lang_limited: ... continue`) is dated 19:47:01, about 4.5 minutes later. The results come from code that was committed afterwards. eta-refuter-2 checked that the stored records match the committed code, re-derived every verdict from the stored scores (floor 0.50, margin 0.15) with 0 mismatches, and found the flagged stratum's would-be verdicts as I reported them (7 below the floor, 1 incomplete). The numbers stand; the sentence I used in my messages did not.
2. **The coverage-pass reading rule (v7.14 S2) is post-hoc for the first coverage table.** The first table (8 below-floor items, no sub-window at or above 0.50, offsets scattered from -72 to +55 minutes; commit 6512b2a) was posted before S2 was written. S2 is pre-registered only for the pass on the **new** transcription; for the existing table it is a reading applied after the fact.
3. **S1 (v7.14: an errored or chunk-dropped window counts as missing) is a rule change**, made after seeing hist-miner's harness bug. It removes none of the 47 window files behind the 18 interim items, so no stored verdict changes (refuter check).
4. **Translation (ruling 211) has not run.** The ruling names Gemini 3.8 Flash on Vertex; the box has no Vertex credentials, and OpenRouter's Gemini is not what the ruling named. No translation and no Jev call on translated text happens until Fable or V rules on the route. The refuter's invented-name check (68 of 68 removed on two sets, unchanged `deid.py`) and mine (37 of 37) are pre-checks on invented text only and do not replace the 20-real-turn check that gates any Jev spend.
