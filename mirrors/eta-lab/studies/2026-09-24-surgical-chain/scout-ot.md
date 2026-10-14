# scout-ot: OT bookings, OT schedule, OT notes, procedure master (mb-ot, 24 Sep ~15:00 IST)

Read-only, Metabase db 13 via `studies/2026-09-24-surgery-30/mb.py` (SELECT-only guard, box key never printed). Aggregates only, one query in flight, date-filtered 1 Aug - 24 Sep. Weeks are IST Monday-start. No identifiers in this file; nothing sampled to the box (no samples were needed).

## Bottom line
1. **`surgery_cases` is the OT booking + OT schedule table** (one row per case, lifecycle in columns). 417 cases created in window; 171 have a scheduled OT slot.
2. **`kx_clinical_template_ot_notes` is the only "surgery actually done" evidence** in my scope: 387 final notes in window, 100% filled on the key fields.
3. **`ot__status = COMPLETED` does NOT mean the surgery was done.** It is set on every case that has an OT slot, including 4 slots dated 24-30 Sep (future). Do not use it as a truth label.
4. `surgery_cases.prescription_uid` is **empty on all 417 window cases** (0%). The case→Rx link cannot come from this table; use the patient + doctor + date route, or `prescription_surgery_recommendation` (mb-rx's scope).
5. Actual surgery timestamps (`admission__surgery_started_at`, `admission__surgery_ended_at`) and `admission__discharged_at` are **empty on all window cases**. OT date = `ot__start_at` (the slot), and the done-time is the note's `created_at`.
6. Case ↔ note overlap is partial: 176/387 notes reach ANY case for the same patient; 99 reach a case with an OT slot; 97 of those within 3 days of the slot. Conversely 95/174 slotted cases have a note within 3 days. So the two tables cover **different surgery populations**; the chain needs both as independent sources, not one joined to the other.

## Table 1: `surgery_cases` (booking + OT schedule)
- Key: `uid`. Patient: `individual_uid` (= `individuals.uid`; `individuals.kx_uhid` gives the hospital UHID). Doctors: `treating_doctor_uid`, `admitting_doctor_uid` (= `doctors.uid`), also `surgery_poc_uid`, `ip_coordinator_uid`.
- Booking time: `created_at` (also `updated_at`; history in `surgery_cases-case_history` (`case_uid`, `category`, `created_at`)).
- Procedure: `procedure_name` (free text; 297 distinct in 417 cases), `surgery_type_uid` (→ `surgeries.uid`, filled only 108/417 = 26%), `diagnosis_name` (15/417), `case_type` (SURGERY / MEDICAL_MANAGEMENT / null).
- Plan: `planned_surgery_date`, `planned_admission_date`, `planned_discharge_date`.
- OT schedule: `ot__slot_day`, `ot__start_at`, `ot__end_at`, `ot__ot_room_uid` (→ `ot_rooms.uid`, 171/171 resolve), `ot__scheduled_at`, `ot__scheduled_by`, `ot__anaesthetist`, `ot__anaesthesia_type`, `ot__duration_min`, `ot__status`.
- Lifecycle `status`: ADMITTED 265, PRESCRIBED 56, FINANCIAL_DONE 51, LEAD 26, CANCELLED 18, FINANCIAL_PENDING 1 (window, created_at basis).
- `source`: MANUAL 337 / PRESCRIBED 80. Only 80/417 (19%) are created from a prescription; the other 81% are manual counsellor entries, so "advised in this visit" is not implied by the row.

Weekly, by booking `created_at` (n = cases; other columns = rows filled):

| week | n | Rx uid | treating doc | procedure_name | surgery_type | planned date | OT slot | admitted_at |
|---|---|---|---|---|---|---|---|---|
| 27 Jul* | 7 | 0 | 7 | 7 | 3 | 7 | 4 | 6 |
| 3 Aug | 36 | 0 | 36 | 36 | 10 | 34 | 27 | 31 |
| 10 Aug | 42 | 0 | 42 | 42 | 15 | 39 | 29 | 34 |
| 17 Aug | 49 | 0 | 49 | 49 | 18 | 49 | 33 | 45 |
| 24 Aug | 38 | 0 | 38 | 38 | 5 | 37 | 3 | 30 |
| 31 Aug | 35 | 0 | 35 | 35 | 12 | 34 | 13 | 32 |
| 7 Sep | 41 | 0 | 41 | 41 | 11 | 41 | 22 | 31 |
| 14 Sep | 77 | 0 | 77 | 69 | 18 | 45 | 23 | 37 |
| 21 Sep | 92 | 0 | 92 | 85 | 16 | 37 | 17 | 19 |

*1 Aug only. Oddities: the 24 Aug cohort has only 3/38 with an OT slot (others booked but slot not recorded, or day-care without the OT module); 14-21 Sep case counts nearly double and `procedure_name` starts to be blank (8 + 7 rows), while `planned_surgery_date` fill falls (45/77, 37/92): recent cases are earlier in the funnel, so their planned/OT fields are not yet filled.

Weekly, by actual OT slot (`ot__start_at`):

| week | slots | rooms used | cancelled cases |
|---|---|---|---|
| 27 Jul* | 6 | 2 | 0 |
| 3 Aug | 22 | 3 | 0 |
| 10 Aug | 32 | 3 | 0 |
| 17 Aug | 30 | 3 | 0 |
| 24 Aug | 11 | 4 | 1 |
| 31 Aug | 11 | 3 | 0 |
| 7 Sep | 19 | 3 | 1 |
| 14 Sep | 19 | 4 | 0 |
| 21 Sep | 24 (4 future) | 4 | 1 |

Lags (171 cases with `ot__scheduled_at`):
- case `created_at` → `ot__scheduled_at`: median 22.6 h, p90 96.6 h;
- case `created_at` → `ot__start_at`: median 1.5 d, p90 4.8 d;
- `created_at` → `planned_surgery_date`: median 0.6 d, p90 4.3 d;
- slot duration (`ot__end_at - ot__start_at`) median 90 min;
- `ot__start_at::date = ot__slot_day` on 171/171.
- Cases with an OT slot are 41% of all cases: the OT schedule is the minority of bookings.

## Table 2: `kx_clinical_template_ot_notes` (OT notes / operative record)
- Key: `uid`. Patient: `uhid` (=`individuals.kx_uhid`, 383/387 = 99% resolve to an individual), `patient_id`, `encounter_id` (356 distinct in 387 notes, i.e. some encounters have >1 note).
- Timestamps: `created_at` (note creation; treat as the surgery-done pin, there is no separate procedure timestamp), `modified_at` (median lag from created 0 h), `g_creation_time`/`g_modify_time` (epoch), `fetched_at` (max 24 Sep 07:49, so the last ~day is not yet synced: newest note is 23 Sep 17:41).
- Content: `surgery_name` (free text; 333 distinct), `surgeon` (name text; 116 distinct strings), `note` (median 1.1k chars), `component_json` (median 2.8k chars), `template_json` (~25% filled, ignore).
- Doctors: `current_treating_doctor_id`, `admitting_doctor_id`, `ordering_doctor_id` (KX ids, 38-47 chars). These do NOT match `doctors.karexpert_metadata__uid` (0/387). They match by text-containment in `doctors.karexpert_metadata__practitioner_id_by_hospital` for 45 of 71 distinct ids (63%). Doctor id is a partial join; the `surgeon` name string is the fallback.
- One template only: "Doctor: OT Notes", status `final` on all 387.

Weekly (all key fields, uhid / encounter_id / surgeon / note, are 100% except where shown):

| week | notes | surgery_name filled | surgeon filled |
|---|---|---|---|
| 3 Aug | 42 | 42 | 41 |
| 10 Aug | 55 | 55 | 55 |
| 17 Aug | 63 | 63 | 63 |
| 24 Aug | 62 | 60 | 62 |
| 31 Aug | 41 | 41 | 41 |
| 7 Sep | 57 | 57 | 57 |
| 14 Sep | 51 | 50 | 51 |
| 21 Sep* | 16 | 16 | 15 |

*partial (through 23 Sep only; sync lag).
Total 387 notes, 348 distinct UHIDs. Note volume (~55/wk) is about 2x the case OT-slot volume (~20/wk), consistent with the notes covering surgeries that never went through `surgery_cases` OT scheduling (day-care / minor procedures / non-booked). This is an inference from the overlap numbers, not verified.

## Table 3: `ot_rooms` (OT room master)
9 rows, 9 active (`uid`, `hospital_uid`, `name`, `sort_order`, `active`). Joins from `surgery_cases.ot__ot_room_uid`. Only 3-4 rooms are used in any week.

## Table 4: procedure masters
- `medical_procedures`: 2,317 rows, 480 enabled, `service_code` 100% filled, 19 departments (`department`, `sub_department`, `base_cost`, `is_cosmetic`, `usage_counter`). A service/billing catalogue. No FK from `surgery_cases` (which has free-text `procedure_name` and `surgery_type_uid`), so this is useful for a name→code lookup, not a join. Best candidate for the billing-code cross-check mb-ipd is doing.
- `surgeries`: 3,552 rows (3,490 non-draft) (`uid`, `name`, document-type arrays). Resolves `surgery_cases.surgery_type_uid` for all 108 filled cases. Coverage of the join is limited by the 26% fill, not by the master.
- `surgery_packages`: **0 rows**; `surgery_cases.financial__package_uid` is 0/417 filled. Packages are not a usable source.

## Join map (for linker)
```
consult/visit -> (patient uhid + doctor + date) -> surgery_cases.individual_uid    [Rx uid not filled, see below]
individuals.uid = surgery_cases.individual_uid ; individuals.kx_uhid = ot_notes.uhid   (99% of notes resolve)
surgery_cases.ot__start_at  <-> ot_notes.created_at   (same patient, |dt| <= 3 d: 97 notes / 95 slotted cases)
surgery_cases.treating_doctor_uid = doctors.uid (417/417 resolve)
ot_notes.*_doctor_id -> doctors via karexpert_metadata__practitioner_id_by_hospital (text contains; 63% of ids)
```
- Rx→case link: `surgery_cases.prescription_uid` = 0% filled. `prescription_document_url` not measured (URL, not a key). mb-rx should report whether `prescription_surgery_recommendation` carries a case or visit key.
- Visit→case link (per SURGERY-DETECT.md): `queue_tokens.metadata->>'INDIVIDUAL_UID'` = `surgery_cases.individual_uid`; not re-measured by me (linker's OPD scope).

## Risks / traps for P1
- Do not treat `ot__status=COMPLETED` or `status=ADMITTED` as "surgery done": 106 ADMITTED cases have ot__status PENDING, and COMPLETED includes future slots. Use the OT note (final) or the IPD/discharge tables (mb-ipd) as done-evidence.
- OT note ≠ booking: 74% of notes (288/387) have no case with an OT slot for that patient (55% [211/387] have no case at all). Chains starting from a note will have no `surgery_cases` booking (so no "booked_at"); chains starting from a case with an OT slot will miss ~45% of them for lack of a note within 3 days (possibly note not yet fetched for the latest week, or note not written).
- Free-text procedure names on both sides (297 case names, 333 note names): matching needs normalization/Jev, not string equality. `surgery_type_uid` is only 26% filled.
- OT notes can have several rows per encounter (387 notes / 356 encounters): dedupe by `encounter_id` before counting surgeries.
- Latest ~24 h of notes not synced (`fetched_at` 24 Sep 07:49). Any 24 Sep OT-day will look note-less.
- Recent weeks of `surgery_cases` are incomplete by funnel stage (planned/OT fields unfilled), not by sync.

## Not covered (other scouts / open)
- IPD admission, discharge summary, billing procedure codes: mb-ipd (`kx_ip_admissions`, `kx_discharge_summary_records`, `cdmss_discharge_extracts`, ...).
- Rx / advised procedure / investigation orders (CT angio): mb-rx. Nothing in my scope carries CT angiography orders; `surgery_cases.case_type` is only SURGERY / MEDICAL_MANAGEMENT.
- Note-vs-case procedure agreement (do the names describe the same operation?): not measured; needs P1 text matching.
- Booking edits after creation: `surgery_cases-case_history` exists (`category`, `summary`, `created_at`) but I did not profile it.

## Follow-ups on linker's open items (SCHEMA.md section 10), added after bus #381
Same rules (read-only, aggregates, no identifiers). Scheduler/creator ids are shown as session-local rank labels (S1 = most active), not real ids.

**Cross-check with SCHEMA.md:** counts agree (417 cases, 387 notes, 174 slots by `ot__start_at`, prescription_uid 0/417). Note-to-case overlap differs only by window: linker [-1 d, +2 d] of `ot__start_at` = 94 notes; mine |dt| <= 3 d = 97 notes (99 with any dt). Same conclusion: the OT note, not the case, is the bigger surgical population (about 4x).

**1. The 24 and 31 Aug `ot__start_at` dip is under-recording of slots, not fewer surgeries.**
- Non-cancelled cases by `planned_surgery_date` week: OT slot filled 76-83% (weeks of 27 Jul to 17 Aug), then **26% (24 Aug) and 31% (31 Aug)**, then 46% (7 Sep), 49% (14 Sep), 60% (21 Sep).
- Surgeries still happened in the dip weeks: admissions with `admitted_at` were 33 and 33 of 39 and 35 planned, and OT notes were 62 and 41. Cases admitted but with no slot: 24 and 23 in the dip weeks (vs 1-8 before).
- `ot__scheduled_by`: one person (S1) entered essentially all slots through the week of 17 Aug (28, 22, 32, 30); S1 drops to 10 slots in the week of 24 Aug; the week of 31 Aug is a different person (S3, 11 slots); from 7 Sep S2 does most (11, 16, 21) with S3/S4/S5 occasionally. The dip coincides with a change of who enters OT slots. Cause (leave/handover/process) is my inference and is not verified.
- Consequence: `ot__start_at` is a reliable done-date only for weeks up to 17 Aug and for the newest weeks; for 24 Aug to 14 Sep use the OT note date (`created_at`) and `admission__admitted_at`. About 55-75% of admitted cases in the dip weeks have no OT slot at all, so a "case has OT slot" filter would drop them.

**2. Surgeon name to doctor uid (OT notes, 387 in window).**
- Name route (lowercase, drop `Dr`/`Mr`/`Prof` prefix incl. no-space forms like `DR.NAME`, strip punctuation; exact match, else surgeon tokens subset of doctor tokens, length >= 4) against `doctors.karexpert_metadata__name` / `name_with_prefix`: on the 385 notes with a surgeon string, 217 resolve to exactly one doctor uid (114 exact + 103 token-subset), 44 ambiguous (several doctors share the tokens; single-token strings like a bare first name), 124 unmatched (not a doctor row, or spelled differently).
- KX-id route (`current_treating_doctor_id` or `admitting_doctor_id` text-contained in `practitioner_id_by_hospital`): 201 of 387 unique.
- Either route gives a unique uid for **313 of 387 (81%)**; both routes unique for 98. I did NOT check that the two agree on the same uid when both resolve. P1 should treat name-only matches as medium confidence and prefer the id route when both exist.
- Use for chains: OT note surgeon uid can be compared with the OPD consult doctor (`DOCTOR_UID`); 19% of notes have no usable doctor link.

**3. `surgery_cases` changed how it is created around 14 Sep.**
- `source=PRESCRIBED` is **0 cases through the week of 7 Sep**, then 28 (week of 14 Sep) and 52 (week of 21 Sep); `source=MANUAL` stays 41-49/week. So the jump from ~40 to 77-93 cases/week is entirely the new PRESCRIBED cases.
- Those 80 PRESCRIBED cases all come from ONE `created_by` id (13 chars, not in `employees`, not in `doctors`, never the treating doctor), i.e. an automated/service creator; the weekly counts equal the 80 cases with a platform `even-prod-prescription` URL in `prescription_document_url` (0 before 14 Sep; 335 manual uploads are the rest), so they are very likely the same rows (row-level overlap not checked).
- `case_type` is filled from the week of 7 Sep (null 4 that week, 0 after): before that 100% null; `MEDICAL_MANAGEMENT` appears only from 14 Sep (8, then 7 cases). `lead_source` is 100% filled all weeks.
- Consequence: from 14 Sep a case can exist because the Rx recommended surgery (an auto-created LEAD; it may never be booked, planned_surgery_date/OT slot unfilled: planned date fill fell to 45/77 and 37/92), not because someone booked an operation. For truth labels, filter PRESCRIBED cases to those with a later OT note or admission; they are also the only cases with a machine-usable Rx link (uid in URL). Before 14 Sep every case was a manual counsellor entry, so a case then meant a booking decision after the consult.

## Follow-up 2 (after bus #440, ~16:20 IST): case_history profile, PRESCRIBED row overlap. Part (a) NOT done.
Read-only, aggregates only, window 1 Aug - 24 Sep.

**(b2) PRESCRIBED cases = platform-Rx-URL cases, exactly (row level).** Cases created in window by (`source`, URL is `even-prod-prescription`): MANUAL / not platform 336 (17 creators), MANUAL / URL null 2, **PRESCRIBED / platform 81 (1 creator, all created on or after 14 Sep)**. No MANUAL case has a platform URL and no PRESCRIBED case lacks one. (81, not the 80 I reported earlier: a new one arrived; live data.) 88 of the manual cases were also created on or after 14 Sep, so manual booking continued alongside the auto-created leads.

**(b1) `surgery_cases-case_history`** (`case_uid`, `category`, `summary`, `actor`, `created_at`, `mentioned_employee_uids`): an append-only event log; 419 of 419 window cases have history (median 7 rows/case, max 15); `summary` and `actor` filled on 100% of rows.
- Rows by category (window, by event `created_at`): ADMISSION 504 (305 cases), LEAD 447 (419), FINANCIAL_COUNSELLING 409 (330), PAC 404 (283), SPOC_CHANGES 351 (320), CLINICAL_HANDOVER 333 (322), REMARK 229 (191), OT 186 (174), LSQ 40 (25), BILLING 6 (6).
- Weekly rows: 54 (27 Jul, partial), 297, 369, 401, 333, 281, 312, 405, 457 (week of 21 Sep); cases with events per week 39, 49, 58, 54, 47, 49, 87, 113 (from 3 Aug), so the recent rise follows the 14 Sep case surge.
- Event wording (first 3 words, categories ADMISSION and OT only): ADMISSION = "patient marked admitted" 268, "admission scheduled for" 219, "admission cancelled" 17; OT = "OT details marked" 186 (one per slotted case, matching 174 slots). Other categories not profiled.
- **No surgery-done, surgery-started, discharge or procedure-performed event exists in the history.** It records that an OT slot was entered and that the patient was marked admitted, never that the operation happened. So it does not replace the OT note as done-evidence. It does give an event time for "admitted" and "OT scheduled" per case (the LEAD event is a creation timestamp per case, 419 for 419).
- `summary` is free text and may contain patient details; I only counted its leading words and did not copy any text out.

**(a) Doctor-entered flag (Rx with `requires_surgery_or_procedure`) vs cases / OT notes / admissions within 30 days: NOT DONE, blocked on input.** The task needs the 517 Rx uids in `~/eta-data/surgical-chain/dpipe_flag_rx_uids.json`. My first read of that file was denied by the Claude Code auto-mode permission classifier (reason given: PII data handling), so I did not read it and did not try to rebuild the list another way (for example by re-querying the flag from Metabase, which would reach the same outcome by another route). Needs a decision from V/Fable/linker: either allow reading that file for this session, or have linker/mb-rx compute the (a) join and only share counts.
