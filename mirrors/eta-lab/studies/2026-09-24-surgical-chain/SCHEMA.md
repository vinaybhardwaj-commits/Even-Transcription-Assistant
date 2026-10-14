# SURGICAL-CHAIN-LINKER P0: schema scout, merged (linker, 24 Sep 2026, read-only Metabase)

Status: **v2, 16:15 IST. Merges the lead's probes with `scout-rx.md` (mb-rx), `scout-ot.md` (mb-ot) and `scout-ipd.md` (mb-ipd).** Per-table detail (every field, every fill rate) lives in the scout files; this file carries how the tables join, the timestamps that pin a visit, weekly coverage, orphans, and the design constraints for P1. Where a number is a scout's, it says so. Where two of us disagree, section 10 reconciles.

Rules kept: SELECT-only through the `mb.py` guard (key never printed), every query date-filtered, one query in flight. Row-level pulls only in `~/eta-data/surgical-chain/` (0700; files 0600; ids and timestamps, no names, no text). This file holds table names, field names and counts only. Window 1 Aug 00:00 to 24 Sep 24:00 IST; weeks start Monday IST; the 27 Jul bucket is 1-2 Aug only and the 21 Sep bucket is 21-24 Sep only.

## 1. The answer in one paragraph

Everything joins on **`individuals.uid`** (patient), **`doctor uid`** (same id space on queue, Rx and cases) and, for inpatients, **`encounter_id`**. **A deterministic visit key exists from about 14 Aug: queue step `SERVICE_REQUEST_UID` → `chart_service_request.uid` → `service_metadata__consult_uid` = Rx `consult_uid` = `accounts-members-calendar_events.uid`.** It covers 5,962 of 7,142 consults (83%). Before 12 Aug it does not resolve, and patient + doctor + IST date is the only route. Rx `timestamp` is the consult **start**, not the write time. **Discharge tables carry no procedure text**; the procedure lives in billing lines, OT notes, and the doctor's structured "surgery or procedure advised" entry. **The OT note, not the booking, is the surgical spine** (211 of 387 OT notes have no `surgery_cases` row at all). **Only 42% of surgeries (counted per de-duplicated encounter) have a platform Rx for the same patient in the prior 30 days.** **From 14 Sep a `surgery_cases` row can be an auto-created lead from the Rx, not a booking decision** (section 6).

## 2. The chain, table by table

| Stage | Table (db 13 unless noted) | Rows in window | Patient key | Visit / encounter key | Doctor key | Pinning timestamp |
|---|---|---|---|---|---|---|
| OPD visit | `queue_token_steps` (station `CONSULTATION`) + `queue_tokens` (`token_uid=uid`) | 7,369 (7,142 COMPLETE) | `metadata->>'INDIVIDUAL_UID'` | step `uid`; `metadata->>'SERVICE_REQUEST_UID'` (filled on every consult step) | `routing->>'DOCTOR_UID'` | `called_at`, `completed_at` (text; cast `nullif(x,'')::timestamptz`); `waiting_since`, `effective_at` filled 7,144/7,144; `queue_tokens.created_at` 10,115 tokens |
| Visit ↔ Rx bridge | `chart_service_request` | n/a | `individual_uid` (equals the step's on 253/253 sampled) | `uid` = step `SERVICE_REQUEST_UID` (sampled below); `service_metadata__consult_uid`; `prescription_uid` filled only 5/253 (do not use) | `service_metadata__doctor_uid` (equals the step's on 253/253) | `created_at` |
| Rx (hub) | `"individuals-prescriptions"` | 26,979 (mb-rx: 26,988) | `_parent_doc_id` (mb-rx `_parent_id`) = `individuals.uid`, 100% resolve | `uid`; **`consult_uid`** (~98% filled) = `calendar_events.uid` (mb-rx, 300/300 sampled) and = `chart_service_request.service_metadata__consult_uid`; `kx_encounter_id`, `ip_uid`, `emr_id`, `doc_id`, `consult_type` **0% filled** | `doctor_uid` 100% | `"timestamp"` = consult start; `updated_at` (text, 92% filled in Sept) = last save; `uploaded_at` |
| Rx text | same hub + children joined `child._parent_id = Rx.uid` | | | | | `general_practitioner_prescription__presenting_complaints` 97%, `__plan_of_management` ~88-91%, `medications` ~52-55%, `diagnosis_icd_codes` ~74-79%, `structured_general_advice` ~14-19%; `free_text` collapsed from ~10% to 0.2% in September. Types: GENERAL_PRACTITIONER 16,257 and HOSPITAL_GP 6,157 are the consult-like ones. **Draft** share ~11% (`is_draft`) |
| Advised procedure (doctor-entered) | `dpipe_prescription_pipeline__plan_of_management` (`_parent_id` = `dpipe_prescription_pipeline._id`; `dpipe.presc_uid` = Rx `uid`) | 517 Rx with `requires_surgery_or_procedure = true` | via Rx | `presc_uid` | via Rx | `surgery_or_procedure_recommendation` (array: name, notes, `scheduled_date`); 258 named entries since 1 Sep, 65 with notes, 23 with a scheduled date |
| Advised procedure (model-read) | `prescription_surgery_recommendation` (PSR) | 6,502 (533 `yes`) | `patient_uhid` → `individuals.kx_uhid` | `prescription_uid` = Rx `uid` (6,500 of 6,502); `visit_id` unusable (228 non-blank) | `doctor_name` text | `prescription_date` **date-only text**, 3 malformed values plus 151 NULLs table-wide: filter `left(x,10)` with a regex |
| Rx (hospital system) | `kx_prescription_records`, `kx_eprescriptions` | **0** (ends 26 Apr 2026; 1 row Aug 2025) | | | | Dead; do not use |
| Appointments | `kx_appointment_records` | 292, all `Pending` | `uhid` | `visit_id` mostly blank | `doctor_name` | Not a visit queue |
| Calendar events (visit record for the Rx) | `accounts-members-calendar_events` | ~3.1-4.8k / week (mb-rx) | `membership_id` | `uid` = Rx `consult_uid`; `prescription_uid` back-link filled 60-69% | `doctor_uid` 100% | slot `start_time`/`end_time`; actual `consult_timing_metadata__*` (65-77% filled, **derived from the Rx save times, not an independent clock**); `consult_facility_info__facility__type = 'EVEN_HOSPITAL'` marks in-person hospital OPD |
| OT booking + schedule | `surgery_cases` | 417 by `created_at` (399 non-cancelled) | `individual_uid` | `uid` | `treating_doctor_uid` = `doctors.uid` (417/417), `admitting_doctor_uid` | `created_at`; `planned_surgery_date` 323; slot `ot__start_at`/`ot__end_at`/`ot__scheduled_at` 171 (mb-ot: 174 by slot week); `admission__admitted_at` 265. **`prescription_uid` 0/417, `admission__surgery_started_at`/`_ended_at`/`admission__discharged_at` 0/417.** `source`: MANUAL 337, PRESCRIBED 80 |
| OT note | `kx_clinical_template_ot_notes` | 387 final (356 encounters, 348 uhids) | `uhid` (383 of 387 resolve) | `encounter_id` (386/387 in admissions) | `surgeon` text; `*_doctor_id` are HIS ids | `created_at` (median 5.2 h after the case slot start; last synced 24 Sep 07:49, newest note 23 Sep 17:41). Fields `surgery_name` (333 distinct), `note`, `component_json` |
| Admission | `kx_ip_admissions` | 1,433 (882 `ip_admission`, 551 `er_admission`) | `uhid` | `encounter_id` = `identifier` | `admitting_doctor_id`, `current_treating_doctor_id` (HIS uuid-style, 100% filled) + names | `admission_date_time` |
| Discharge (event) | `kx_discharge_summary_records` | 866 (864 Final) | `uhid` (18 unresolvable) | `ipd_no` = `encounter_id` (865/866) | team/speciality only | `discharge_date_time`; **no diagnosis, no procedure, no body** |
| Discharge (fact) | `kx_discharged_completed_patients` | 1,183 | `uhid` | `encounter_id` | admitting/treating doctor id | `discharge_date`; `discharge_summary_final_date_time` ~75% filled; `actual_los_in_days` |
| Procedure lines | `kx_billing_records` (mb-ipd) | see weekly | `uhid` | `visit_id_admission_id` = `encounter_id` (859/859 matched) | `perform_by(_code)`, `treating_doctor_code` (different code formats) | `order_date_time` (median 2 h after admission for Surgery lines, package lines ~0 h), `bill_date_time` (~61 h after order). **Not the operation time.** service_type `Surgery`, `IP Package`, `Procedure` (bedside nursing, ignore), `Cardiology` (ECG/echo/TMT, not interventions) |
| Discharge (structured extract) | `cdmss_discharge_extracts` | 4 rows, all 22 Sep 20:30 | `member_uid` (0 of 4 resolve) | `encounter_id` (0 of 4) | | Unusable now |
| Historic procedure/diagnosis | `rh_ehbr_ipd_detail` (**db 16**) | **0 in window** (Dec 2025 - 18 Jun 2026 only) | `uhid` | `admission_no` | `admitting_consultant` | Backfill only |
| Masters | `medical_procedures` (2,317 billing catalogue), `surgeries` (3,552, resolves only the 108 cases with `surgery_type_uid`), `ot_rooms` (9), `surgery_packages` (**0 rows**) | | | | | |

Not stored as a field anywhere I or the scouts looked: room per visit (`assigned_bay` empty 7,144/7,144; `queue_display_counters` is a sequence counter; `queue_token_links` links tokens, not rooms), doctor-to-room, a complete map from HIS doctor id to Even uid.

## 3. The deterministic visit key: measurements (lead probe)

> **Update 24 Sep 17:20: superseded for coverage.** The table below is what I measured at 15:15-16:07 and what eta-refuter-2 reproduced. **At 17:12 the same probe on 3 Aug returned 135 of 135, and the P1 builder resolved the key for 6,691 of 6,713 visits (99.7%) across the whole window.** The service-request rows for 1-3 Aug were loaded on 2-4 Aug, so this is not a late load of that table. My P0 probe did not record whether the queue-side `SERVICE_REQUEST_UID` was empty or merely unresolved on those days; queue metadata carries repair-backfill markers, so a queue-side repair is the likeliest cause, **unverified**. Read "complete from 14 Aug" and "83% of consults" below as true at the time and no longer the current state. See `P1-PREREG-v2.md` A1.

Chain: queue consult step → `SERVICE_REQUEST_UID` → `chart_service_request.uid` → `service_metadata__consult_uid` → Rx `consult_uid` (and the calendar event `uid`).

| Day (IST) | Consult steps | `SERVICE_REQUEST_UID` resolves in `chart_service_request` |
|---|---|---|
| 3 Aug (Mon) | 135 | **0** |
| 10 Aug (Mon) | 114 | **0** |
| 11 Aug | 122 | 30 |
| 12 Aug | 91 | 77 |
| 13 Aug | 103 | 94 |
| 14 Aug | 111 | 111 |
| 15 / 16 Aug | 3 / 27 | 3 / 27 |
| 17 Aug | 131 | 130 |
| 24 Aug, 31 Aug, 3 Sep, 7 Sep | 200, 214, 154, 216 | all |
| 10 Sep | 179 | 179 |
| 22 Sep | 253 | 253 |

- **Complete from 14 Aug**; 5,962 of the 7,142 completed consults are on or after that date (83%). Before 11 Aug the request id does not exist in `chart_service_request`; I did not find where it points. Cause of the ramp on 11-13 Aug not investigated.
- On 22 Sep: every resolved request has the same individual and the same doctor as the step (253/253), `consult_uid` is filled on all 253, and **each equals an Rx `consult_uid`**. Of the 248 steps that also have exactly one same-patient-same-doctor-same-day Rx, the two methods agree on all 248. So the heuristic in section 4 is right where there is exactly one Rx, and the key is what resolves the rest.
- On 10 Sep: 174 of 179 consult ids map to exactly 1 Rx, 2 map to 2 Rx, 3 map to none.
- `chart_service_request.prescription_uid` is filled on only 5 of 253: use `consult_uid`, not that field.
- One day per line, not a full-window sweep. **eta-refuter-2 reproduced the key independently on my days (10 Aug 0/114, 12 Aug 77/91, 22 Sep 253/253) and measured it at 100% on four days I had not sampled: 20 Aug 146/146, 27 Aug 150/150, 2 Sep 151/151, 18 Sep 155/155** (`consult_uid` filled on all). "Complete from 14 Aug" is therefore measured, not inferred. The refuter's consult count is 7,148 against my 7,142 (the window includes today, so it grows).

## 4. Queue step to Rx without the key (before 14 Aug), lag, and what pins the visit

Join used (7,362 pairs pulled in 3-day pages): `_parent_doc_id = INDIVIDUAL_UID`, `doctor_uid = DOCTOR_UID`, Rx IST date = step `called_at` IST date.

Orphans, both ways:
- Steps with no Rx that day: 33 of 7,142 (0.5%). Steps with more than one candidate Rx: 236 (3.3%). Rx that match more than one step: 55. eta-refuter-2's own run: 0.4% with no Rx, 4.1% with two or more; lag p50 -7.2 min and 93.4% negative, the same as mine.
- Rx with no queue consult: about 19.7k of 26,979. The hub is network-wide (mb-rx: GP types include teleconsults, and most calendar events have a null facility type); I did not split it by hospital. Rx authors: 112 doctors, 76 also on queue consult steps.
- Visits that are the **only** consult of that doctor that day: 263 of 7,144 (3.7%). Consults per doctor-day: median 4, p90 12 (1,364 doctor-days). Very short consults exist (`completed_at - called_at` p05 0.28 min, p50 8.0, p95 38.2): filter under about 1 min in P1.

Lag, steps with exactly one candidate Rx (minutes; negative = before the consult closed):

| Measure | n | p50 | p90 | p99 | share < 0 | share > 60 min | share > 24 h |
|---|---|---|---|---|---|---|---|
| Rx `timestamp` - `completed_at` | 6,873 | -7.32 | -0.15 | 70.2 | **93.4%** | 1.4% | 0.0% |
| Rx `timestamp` - `called_at` | 6,873 | 0.02 | 0.03 | 91.8 | 0.5% | 2.2% | 0.0% |
| Rx `updated_at` - `completed_at` | 6,709 | -0.05 | 34.5 | 424.5 | 79.3% | 6.8% | 0.42% |
| Rx `updated_at` - `called_at` | 6,709 | 9.65 | 54.7 | 439.1 | 0.1% | 9.0% | 0.45% |

Cross-check from mb-rx (Sept, non-draft): `updated_at - timestamp` p50 11.8 min (p90 33.3) for GENERAL_PRACTITIONER, 6.8 min (p90 23.5) for HOSPITAL_GP; against the calendar event's actual start, Rx `timestamp` is +0.02 min. Consistent with mine.

Reading it:
- **Rx `timestamp` is when the consult opens** (within 2 min of `called_at` for 92.3%). Rx is not created after the consult. Any window built on "Rx after consult end" is wrong by a median 7 minutes the other way.
- **`updated_at` is the write time**, within [-5, +15] min of `completed_at` for 85.1%; 3.7% written more than 2 h after close, 1.2% more than 6 h (a late-edit tail), 2.4% missing.
- **Pin the visit on the queue step, `called_at` to `completed_at`.** It is the only record with both ends, it exists for every consult, and its doctor id is in the Rx id space. **Caveat (mb-rx):** the queue times and the Rx times agree to seconds, and the calendar's "actual" times are derived from the Rx save times, so these are the doctor's software events, not door times. The patient may enter later or leave earlier; a doctor who opens the Rx late or finishes it after the patient leaves shifts the window. A wider search window than the pin (I would start with called_at - 10 min to completed_at + 10 min, the same as hist-miner's chunk window) is needed when matching to audio.

## 5. Weekly row counts, 1 Aug - 24 Sep (IST weeks)

| Table (timestamp used) | 27 Jul (2d) | 3 Aug | 10 Aug | 17 Aug | 24 Aug | 31 Aug | 7 Sep | 14 Sep | 21 Sep (4d) | Total |
|---|---|---|---|---|---|---|---|---|---|---|
| queue CONSULTATION COMPLETE (`called_at`) | 125 | 646 | 571 | 755 | 1012 | 1049 | 1152 | 1040 | 792 | 7,142 |
| queue CONSULTATION any status | 126 | 678 | 590 | 784 | 1047 | 1089 | 1185 | 1065 | 805 | 7,369 |
| `individuals-prescriptions` (`timestamp`) | 701 | 3565 | 3161 | 3483 | 3434 | 3377 | 3737 | 3220 | 2301 | 26,979 |
| Rx with structured `requires_surgery_or_procedure` (mb-rx) | 17 | 67 | 61 | 32 | 57 | 68 | 81 | 78 | 54 | 515 |
| PSR all (`prescription_date`) | 222 | 840 | 593 | 704 | 840 | 857 | 991 | 888 | 567 | 6,502 |
| PSR `surgery_recommended='yes'` | 2 | 68 | 73 | 48 | 69 | 74 | 75 | 69 | 55 | 533 |
| `kx_prescription_records` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `kx_appointment_records` | 2 | 31 | 42 | 41 | 37 | 37 | 37 | 34 | 31 | 292 |
| `surgery_cases` by `created_at` | 7 | 36 | 42 | 49 | 38 | 35 | 41 | 77 | 92 | 417 |
| `surgery_cases` by `planned_surgery_date` | 6 | 31 | 38 | 42 | 41 | 35 | 42 | 45 | 35 | 315 |
| `surgery_cases` by `ot__start_at` (slot, not done-time) | 6 | 22 | 32 | 30 | **11** | **11** | 19 | 19 | 24 (4 future) | 174 |
| `surgery_cases.admission__discharged_at` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| `kx_clinical_template_ot_notes` (`created_at`) | 0 | 42 | 55 | 63 | 62 | 41 | 57 | 51 | 16 | 387 |
| `kx_billing_records` Surgery/Procedure/IP Package/Cardiology lines by order week (mb-ipd) | 176 | 690 | 647 | 810 | 763 | 580 | 678 | 564 | 170 | 5,078 |
| `kx_ip_admissions` (`admission_date_time`) | 43 | 182 | 181 | 205 | 198 | 162 | 196 | 170 | 96 | 1,433 |
| `kx_discharge_summary_records` (`discharge_date_time`) | 27 | 122 | 100 | 128 | 123 | 105 | 112 | 108 | 41 | 866 |
| `kx_discharged_completed_patients` (`discharge_date`) | 42 | 168 | 133 | 181 | 163 | 127 | 158 | 144 | 67 | 1,183 |
| `cdmss_discharge_extracts` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 4 |

Low or zero weeks:
- **27 Jul and 21 Sep** are 2- and 4-day buckets. **The last week of OT notes (16) and discharge summaries (41) is low because both post late**; mb-ot: the OT-note sync last ran 24 Sep 07:49, so a note-less recent day is not a missing note.
- **`kx_prescription_records`: a dead feed** (last row 26 Apr 2026), not a gap.
- **`surgery_cases.ot__start_at` 11/week on 24 and 31 Aug (22-32 elsewhere): slot under-recording, not fewer surgeries** (mb-ot follow-up). Non-cancelled cases by planned-date week have an OT slot 76-83% through 17 Aug, 26% (24 Aug), 31% (31 Aug), then 46/49/60%; admissions (33 and 33) and OT notes (62 and 41) stay normal, and 24 and 23 admitted cases had no slot. The person entering slots changes across those weeks (one person through 17 Aug; different people from 31 Aug and 7 Sep). **The cause is mb-ot's inference, not verified.** For 24 Aug - 14 Sep use the OT-note `created_at` or `admitted_at` as the done-date, not the slot.
- **Cases created rise from about 40 to 77 and 92 in the last two weeks: this is entirely new auto-created cases** (mb-ot follow-up). `source = PRESCRIBED` is 0 through the week of 7 Sep, then 28 and 52; `MANUAL` stays 41-49 a week. All 80 PRESCRIBED cases (81 since; one more arrived) come from ONE `created_by` that is not an employee or a doctor and is never the treating doctor (an automated creator), and **they are exactly the platform-Rx-URL cases at row level** (mb-ot follow-up: 81 PRESCRIBED = 81 platform-URL, 336 MANUAL with no platform URL plus 2 with no URL; no overlap in either direction; 88 manual cases were also created from 14 Sep). `case_type` is filled from 7 Sep; `MEDICAL_MANAGEMENT` only from 14 Sep. Their `planned_surgery_date` is filled on only 45/77 and 37/92.
- **Queue consults ramp from 646 to about 1,050 a week through August.** The deterministic key (section 3) starts resolving on 11-14 Aug, so the queue and the service-request layer look like they went live in mid-August. **That is an inference from two coincident dates, not verified.**
- **Two near-empty days are real holidays or closures, not gaps: 15 Aug has 3 completed consults and 14 Sep has 3** (neighbouring days 103-256; 13 Sep, a Sunday, has 32). The 14 Sep cause is inferred (the refuter reads it as a holiday like 15 Aug); I did not check a calendar. The week of 14 Sep in the table is low for that reason, and the key was 3 of 3 on that day.
- **OT notes: 0 in the 27 Jul bucket** (1-2 Aug); I did not check for notes before 3 Aug.

## 6. Rx to booking (`surgery_cases`)

`surgery_cases.prescription_uid` is empty in all 417. Substitute links (non-cancelled cases, n = 399):

| Link | Cases | Note |
|---|---|---|
| Rx uid embedded in `prescription_document_url` | 102 (98 non-cancelled): 71 from 80 platform `even-prod-prescription` URLs, 31 from other URL forms that embed an Rx uid | 98% have the case's treating doctor = Rx doctor; booking minus Rx `timestamp` p10 3.9, p50 16.3, p90 5,531 min |
| Same patient, same doctor, Rx within [booking-1 d, booking+10 min] | 115 | median gap to nearest same-doctor Rx 78 min (p25 10, p75 3,840); 66% within a day, 88% within 7 days |
| Same patient, any doctor, Rx within 30 days before booking | 188 | so **211 non-cancelled bookings have no platform Rx for the patient in the prior 30 days** |

`prescription_document_url` over all 417: 335 `odd_uploads` (a manual photo or PDF), 80 platform Rx, 2 empty. mb-ot: **81% of cases are manual counsellor entries** (`source = MANUAL`), so an OT booking does not imply "advised in this visit".

Before and after 14 Sep (weekly funnel of non-cancelled cases by creation week; columns count cases for which the linked record exists in its expected window):

| Week | Cases | Rx same doc ≤1 d | Platform-URL Rx | Slot recorded | OT note | KX admission | Final discharge |
|---|---|---|---|---|---|---|---|
| 27 Jul | 7 | 2 | 0 | 4 | 0 | 6 | 6 |
| 3 Aug | 35 | 4 | 0 | 27 | 17 | 30 | 30 |
| 10 Aug | 39 | 1 | 0 | 29 | 16 | 32 | 32 |
| 17 Aug | 48 | 4 | 0 | 33 | 32 | 44 | 44 |
| 24 Aug | 35 | 2 | 0 | 2 | 27 | 30 | 30 |
| 31 Aug | 34 | 7 | 0 | 13 | 21 | 30 | 30 |
| 7 Sep | 37 | 5 | 0 | 20 | 24 | 31 | 30 |
| 14 Sep | 74 | 35 | 25 | 23 | 24 | 35 | 31 |
| 21 Sep | 89 | 55 | 45 | 16 | 5 | 19 | 7 |

Cases created before 14 Sep: 236, of which 25 have a same-doctor Rx within a day (29 any doctor); from 14 Sep: 163, of which 90 (95). **Case-to-Rx by id works for about the last 10 days of cases, because from 14 Sep the cases are the automated PRESCRIBED ones (section 5): the Rx link is by construction.** Earlier cases are all manual counsellor entries and link by patient + date. The last row's low OT-note / discharge counts are posting lag.

**Consequence for labels (mb-ot):** a PRESCRIBED case is a lead created from an Rx, not evidence that a booking decision was made; the doctor-advised signal is already the Rx flag (section 7) and adds nothing. Keep a PRESCRIBED case in the truth set only if a later OT note or admission exists for the patient. Before 14 Sep every case is a manual counsellor entry.

`surgery_cases-case_history` (mb-ot follow-up) is an append-only event log: 419 of 419 window cases have history (median 7 rows, max 15; summary and actor 100% filled). Categories, rows / cases: ADMISSION 504 / 305, LEAD 447 / 419, FINANCIAL_COUNSELLING 409 / 330, PAC 404 / 283, SPOC_CHANGES 351 / 320, CLINICAL_HANDOVER 333 / 322, REMARK 229 / 191, OT 186 / 174, LSQ 40 / 25, BILLING 6 / 6. It gives event times per case (lead, counselling, PAC, admission, OT) that the case row itself lacks; not yet profiled for the actual operation time.

## 7. Advised-procedure flags, both ways, and negatives

Two signals mark "the doctor advised a procedure" on the Rx, and they overlap only partly (lead probe; structured flag counted by its child row's `_create_time` in window):

| | Rx |
|---|---|
| Doctor-entered `requires_surgery_or_procedure = true` (dpipe plan of management) | 517 |
| Model-read PSR `surgery_recommended = 'yes'` | 533 |
| Both | 418 |
| Structured only | 99 |
| PSR only | 115 |
| Either | 632 |

**What follows a doctor-advised procedure (structured flag, 517 Rx, 462 patients; lead, 24 Sep).** Same patient, within 30 days after the flag (case within [-1, +30] d; OT note and admission matched by uhid):

| Flags | n | Case | of which MANUAL case | OT note | KX admission | Any of case / note / admission | None of the three |
|---|---|---|---|---|---|---|---|
| **Dated 1-25 Aug (full 30-day follow-up inside the window)** | **192** | 34 (18%) | 33 | 44 (23%) | 62 (32%) | 65 (34%) | **127 (66%)** |
| Dated before 14 Sep (follow-up truncated for flags after 25 Aug) | 383 | 68 | 62 | 72 | 105 | 120 (31%) | 263 (69%) |
| Dated from 14 Sep (follow-up truncated) | 134 | 79 (67 PRESCRIBED) | 17 | 9 | 17 | 81 | 53 |
| All | 517 | 147 | 79 | 81 | 122 | 201 (39%) | 316 (61%) |

Read the first row; the others are censored by the window end (a flag on 20 Sep has 4 days of follow-up). **About two thirds of doctor-advised procedures show no case, OT note or admission for the patient within 30 days: a large candidate-negative pool (127 in the first 25 days).** Cautions: an admission is not necessarily surgical; the advised procedure may be a minor OPD procedure done the same day with no note or admission, or done elsewhere; the OT-note table lags about a day. So this is a pool to sample negatives from, not a count of "advised and not done". **From 14 Sep, 67 of the 79 flagged-and-cased Rx are followed by an auto-created PRESCRIBED case, which the flag itself probably triggers: that outcome is circular with the flag and must not be used as "booked".** The Rx uids used are in `~/eta-data/surgical-chain/dpipe_flag_rx_uids.json` (box only; 0600, so other sessions cannot read it).

- **Booking, forwards:** PSR `yes` flags with a non-cancelled case for the same patient in [flag-1 d, flag+30 d]: 155 of 533 (Aug 1-Sep 13: 75 of 409; Sep 14-24: 80 of 124), so about **378 advised-not-booked** by that flag. Backwards: cases with a PSR `yes` for the same patient in the 30 days before booking: 144 of 399 (before 14 Sep 55 of 236; from 14 Sep 89 of 163). I have not yet run the structured flag against bookings.
- **PSR reads hospital-OPD Rx, selected by Rx type, not by specialty** (mb-rx, 1-24 Sep): HOSPITAL_GP 2,199 of 2,943 (75%), HOSPITAL_PHYSIO 317 of 337, HOSPITAL_GYNAECOLOGY_ASSESSMENT 352 of 476, HOSPITAL_PAEDIATRIC 119 of 326; platform types almost never (GENERAL_PRACTITIONER 9 of 7,112). By speciality: General Surgery 78%, Urology 72%, GI Surgery 99%, Ortho 39%, Internal Medicine 36%. **The unread quarter of hospital GP Rx is unexplained, so PSR recall there is unknown, and a missing PSR row is not a "no".** The structured flag is a doctor's own entry and is the safer basis for "advised"; PSR is the second opinion. `patient_need_hospitalization` is not an advised-admission signal (mb-rx: UNKNOWN 22,302, NULL 3,041, NO 1,229, UNSURE 375, YES 100), and `requires_medical_admission` has 22 true in three weeks.
- **CT angiography (V's 12:10 scope), Rx side (mb-rx):** in `further_investigation`, "CT Coronary Angio Scan" 27 rows, a calcium-screening variant 1, a lower-limb CT angiogram 1; other "angio" names in the window are MRI angio and one plain coronary angiography and must not count. Rx with any "angio" name 1-14 a week, CT-only 0-11 a week: **a thin slice.** Match on `investigation__uid` (master `medical_investigations`), not the name. **Inpatient side (mb-ipd):** name hits for CT angiography or angioplasty on 23 IP Package lines (20 visits), 7 IP Radiology (5 visits), 6 IP Surgery (4 visits). **Was the CT angiography done? Not answerable from Metabase (mb-rx follow-up, 30 CT-angio Rx, 28 patients, regex on names so odd spellings like "CTA" are missed):** carts are not the route (`individuals-investigation_carts` is dead since 21 May; the live `accounts-account_investigation_carts` is per account, lab and home-collection style, and its Rx link `booking_trigger__prescription_uid` is 0% before 31 Aug then 15-30%); only 3 carts reference those Rx (2 DRAFT, 1 BOOKED). The booked-service surface is `chart_service_request` (`prescription_uid`, `individual_uid`, `service_metadata__medical_investigation_uid`, status ladder PRESCRIBED, DRAFT/REQUESTED, BOOKED/PENDING_CHECKIN, COMPLETED, or CANCELLED). For the 28 patients: 20 requests for 18 patients, all created with the Rx (PRESCRIBED 16, DRAFT 3, CANCELLED 1); **BOOKED 0, COMPLETED 0**; no later completed CT of any kind that follows their first CT-angio Rx. **A PRESCRIBED request is created with the Rx, the same lead pattern as PRESCRIBED cases: it is not evidence of booking.** `chart_service_request.prescription_uid` is filled on only 15-23% of requests (9 of 54 completed CT requests), so a completed scan cannot usually be tied back to its Rx by uid; it needs patient + investigation uid + time. The hospital radiology system may sit outside these requests (`chart_radiology_order` is dead: 9 rows, Sep-Oct 2025), and the latest Rx have had little time. **So CT angiography is usable as an advised-intervention signal (the order on the Rx) and not as a done label from Metabase**; done-evidence would have to come from billing (the inpatient lines above) or from a source not yet found.
- **Where procedures show up after the fact (mb-ipd):** of 882 `ip_admission` encounters, 323 have an IP Package line, 256 any Surgery line (206 a named, non-overhead procedure), 506 either (57%, includes deliveries and day-care). `Surgery` lines mix OT overhead (theatre, anaesthetist, assistant fee) with named procedures; `IP Package` lines are named packages. **Billing says a surgery was billed on this admission; it does not say when.**

## 8. OT note, admission, discharge

- OT note to admission: `encounter_id` matches for 386 of 387 notes. Admissions with an OT note: 355 of 1,433 (the rest are medical stays or notes not yet synced).
- **Notes and bookings are two different surgical populations** (mb-ot, my numbers agree within a few rows): of 387 notes, **211 have no `surgery_cases` row at all**, 176 reach some case for the patient, 99 reach a case that has an OT slot, 97 of those within 3 days of the slot. Conversely 95 of 174 slotted cases have a note within 3 days. The 288 notes with no slotted case are consistent with day-care, minor procedures and cases not booked through the OT module (mb-ot's inference; not verified). A note-first chain has no booking; a case-first chain misses about 45% of slotted cases for lack of a note.
- `ot__status = COMPLETED` does **not** mean done: it is set on every case with a slot, including 4 future slots. `status = ADMITTED` with `ot__status = PENDING` occurs on 106 cases. **Use the OT note or the discharge table as done-evidence.**
- 387 notes are 356 encounters: some encounters have 2 or more notes; **dedupe by `encounter_id` before counting surgeries.**
- Discharge: `ipd_no` = `encounter_id` (865/866). Coverage of `ip_admission` (mb-ipd): 97% have a discharge summary, but only 29 of 551 `er_admission`. Summary is written before the patient leaves: `discharge_summary_final_date_time` median 3.1 h before the discharge timestamp (p90 0.3 h); `created_on` median 16.4 h before. **No discharge tables carry a diagnosis or a procedure.**
- **Reverse coverage, OT note back to the Rx, per de-duplicated encounter** (387 notes are 351 distinct encounters with an admission and a resolvable patient, 343 patients; Rx pulled by patient from 15 Jun): Rx for the same patient within 1 day before admission 38 (11%), 7 days 109 (31%), **30 days 147 (42%)**, 60 days 157 (45%). eta-refuter-2 reproduced this independently (42/31/11%, same 351). My first pass counted notes, not encounters (164 of 382, 43%); the per-encounter figure is the one to quote. **58% of surgeries have no platform Rx in the prior 30 days**, so they reached surgery some other way (referral, external prescription, hospital-side record) and cannot be tied to a recorded OPD consult from this data.

## 9. Identity and doctor mapping

- Patient: `individuals.uid` is the key; `individuals.kx_uhid` maps HIS tables to it (no uhid maps to two individuals in 1,422 checked).
- Doctor: Even uid (`doctor_uid`, `DOCTOR_UID`, `treating_doctor_uid` = `doctors.uid` 417/417) on queue, Rx, cases; HIS ids and names on admissions, OT notes, billing. mb-ot: OT-note doctor ids do **not** match `doctors.karexpert_metadata__uid` (0/387) but appear as text inside `doctors.karexpert_metadata__practitioner_id_by_hospital` for 45 of 71 distinct ids (63%). mb-ipd: billing performer and treating-doctor codes are in other formats (numeric, `DR-nn`). mb-ot follow-up on OT `surgeon` to doctor uid (385 notes with a surgeon): the name route (strip Dr/Mr/Prof and punctuation; exact, else token-subset) gives 217 unique, 44 ambiguous, 124 unmatched; the HIS-id route gives 201 of 387; **either route resolves a unique doctor for 313 of 387 (81%)**. mb-ot did not check that the two routes agree where both resolve (both unique for 98), so treat name-only as medium confidence. My earlier crude test (3 of 50) is superseded and should be ignored.
- Room: nothing in Metabase. hist-miner: doctor-to-room has no stored source; tape exists on 24 of 51 days (1 Aug - 20 Sep). The room comes from the audio side, in P1.

## 10. Reconciliation of the four sets of numbers

| Item | Lead | Scout | Resolution |
|---|---|---|---|
| Rx rows in window | 26,979 | mb-rx 26,988 | Window edge (9 rows). Immaterial; the weekly rows in section 5 are the lead's. |
| **OT notes with no `surgery_cases` row** | 293 (I had written "no case row") | mb-ot 211 no case at all; 288 no case with a slot | **My earlier statement was wrong.** 293 was notes with no case whose slot falls within [-1 d, +2 d]. Correct figures: 211 no case at all; 288 no slotted case; 94 (mine) / 97 (mb-ot, ±3 d) linked to a slot. Corrected in the bus and here. |
| "Surgical population is 4x larger by note" | 4x | mb-ot ~2x (55 notes/week vs ~20 slots/week) | 2x is right (387 notes vs 171-174 slots). I had compared notes to the slotted cases that link, not to all slots. |
| Case status counts | FINANCIAL_DONE 50, FINANCIAL_PENDING 2 | mb-ot 51 and 1 | Window boundary, one row. |
| Cases with an OT slot | 171 by `created_at` | mb-ot 171 by `created_at`; 174 by slot week | Different keys, both correct. |
| Rx-to-visit key | consult_uid matches no queue id (my first test) | mb-rx consult_uid = calendar event `uid` | Both true. The queue does reach `consult_uid`, through `chart_service_request` (section 3); I had tested `SERVICE_REQUEST_UID` against `consult_uid` directly, which is a different id. |
| Admissions with discharge summary | 654 of 1,063 before 10 Sep (all encounters) | mb-ipd 97% of `ip_admission`, 29 of 551 `er_admission` | Mine mixed ER; the ER rows explain the gap. |

## 11. P1 design constraints (Fable ruling 123 adopted eta-refuter-2 #355)

1. **Circularity.** Record per chain whether the procedure-name match contributed to the link, and compute a **link score without the procedure question** (complaint, medications, time, doctor). Truth labels are computed only on chains linked independently of the thing being labelled. Now that 83% of visits have a deterministic Rx key, the visit-to-Rx link needs no content at all; only the visit-to-recording step needs it.
2. **Negatives.** Matched samples from the same doctors and weeks: (a) advised-not-booked (structured flag with no booking; PSR-only and structured-only kept as separate strata because the two flags disagree on 214 Rx), (b) surgical-clinic visits with no procedure advised.
3. **Margin fixed before results.** Second-best drawn from the same doctor's same day. **Report how many visits have only one candidate:** 3.7% are the doctor's only consult that day (a margin means nothing there); 3.3% have 2 or more candidate Rx by the heuristic (fewer with the consult key).
4. **Scope.** Operations plus interventions including CT angiography; imaging-only stays out (ruling 84). The CT angiography slice is thin (section 7).
5. **Yield ceiling.** Before recording coverage: 42% of surgeries (per encounter) have a platform Rx in the prior 30 days; 83% of consults carry the deterministic key; 24 of 51 days have tape. Only the first two are measured here.
6. **Auto-created cases.** From 14 Sep a PRESCRIBED case is not a booking decision (section 6): do not let its existence label a visit as "booked".
7. **Report every P1 result split by link route** (eta-refuter-2): deterministic key (from 14 Aug, 83% of visits) versus the patient + doctor + date heuristic (before that). With the key, visit-to-Rx needs no content, so circularity lives only in visit-to-recording.
8. **Time windows.** Pin on the queue step; never assume Rx follows consult end; widen the audio window by 10 minutes each side; treat the OT note `created_at` as done-time and billing `order_date_time` as visit-level only.

## 12. Open items

- **Answered since v1:** investigation carts and "was the CT angiography booked" (carts are not the route; no BOOKED or COMPLETED CT angio found; section 7); the 24 and 31 Aug slot dip (slot under-recording, section 5); the mid-September case jump (auto-created PRESCRIBED cases, exactly the platform-Rx-URL cases, sections 5-6); surgeon name to doctor uid (81% unique by either route, section 9); PSR selection (by Rx type, section 7); calendar event to queue token (through `chart_service_request`, section 3); the structured flag against bookings, notes and admissions (section 7); `surgery_cases-case_history` profiled (section 6).
- Where the discharge summary body (diagnosis, procedure) lives for the window: not in any `kx_*` table; possibly only as PDF (mb-ipd).
- A complete HIS-doctor-id to Even-uid map, and whether the name route and the id route agree on the same doctor where both resolve.
- Where the queue `SERVICE_REQUEST_UID` points before 11 Aug; why the key ramps 11-14 Aug.
- Done-evidence for an outpatient CT angiography (none in Metabase, section 7): matching a CT-angio Rx to a hospital-side bill or report (mb-ipd's billing lines are inpatient); `prescription_history` for the edit trail; the actual operation time from `case_history` OT events; per-hospital split of the 19.7k Rx with no queue consult; note-versus-case procedure agreement (needs the P1 text match).
