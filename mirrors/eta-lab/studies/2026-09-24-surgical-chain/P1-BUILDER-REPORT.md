# P1 chain builder, links 1 and 2: first run (linker, 24 Sep 2026, 17:20 IST)

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

All 23 done records come from the platform table; the HIS bill lines contribute 0 in the window. This reproduces mb-rx's warning: the platform table holds roughly a third of in-house CTs and the complete HIS table stops on 13 Jul, so **a missing record is not evidence of "not done" and plain CT stays positives-only** (A7). **Mature plain-CT positives: 0 at 30 days, 7 at 14 days.** Queue visit for these Rx: 67 have one (KEY), 53 do not (RXWIN candidates).

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
