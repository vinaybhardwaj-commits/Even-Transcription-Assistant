# scout-rx: prescriptions / advice / advised procedures / investigation orders

Scout `mb-rx`, 24 Sep 2026, read-only. Metabase db 13 through `studies/2026-09-24-surgery-30/mb.py` (single SELECT only, key never printed).
Window: 1 Aug – 24 Sep 2026 (weeks start Monday, IST; the week of 27 Jul holds only 1–2 Aug, and the week of 21 Sep is partial).
Names, fields and counts only. No identifiers, and no samples were pulled, so nothing was written to `~/eta-data/surgical-chain/`.
"Filled" means non-NULL and non-empty-string; I first counted only non-NULL, which overstated it.

## 0. Findings

1. **`individuals-prescriptions` is the hub.** About 3.2–3.7k Rx a week (26,988 over the window, 13,667 patients), and every Rx carries `doctor_uid` and a patient id.
2. **Patient key:** `_parent_id` (`_path` = `/individuals/{patient_uid}/prescriptions/{rx_uid}`, both segments match on 100% of rows).
3. **Rx → visit key:** `individuals-prescriptions.consult_uid` = `accounts-members-calendar_events.uid`. It matched 300 of 300 sampled Rx (the earliest 300 by timestamp of 14–24 Sep, GP types; not a random sample). About 98% of Rx have a `consult_uid`.
   - The event row carries slot `start_time`/`end_time`, `doctor_uid`, `doctor_name`, `status`, `booking_type`, `consult_facility_info__*`, and a back-link `prescription_uid`. That back-link is filled on about 66–69% of events.
   - `consult_uid` matches none of `queue_tokens`, `queue_token_steps`, `queue_token_links`, `appointment_schedules`, `chart_appointment`, `kx_appointment_records`, `accounts-members-opd_visits`, `cdmss_opd_audits` or `cdmss_opd_triage`. It matched `chart_service_request.service_metadata__consult_uid` for about 10% of a sample of 300, so that table is not the key.
   - Linking calendar events to queue tokens or rooms is the linker's OPD scope, and I did not test it.
4. **Timestamps pin the consult window. Rx `timestamp` is consult START, not end.**
   - `timestamp` is the doc creation time (`_create_time` is about 0.6 s later). It sits at the start of the consult: median -0.5 min against `dpipe_prescription_pipeline.doctor_start_time`, p10 -9.0 min.
   - `updated_at` is the last save, and it lands at the consult end (see section 4).
   - So the recording window to match is **[Rx.timestamp, Rx.updated_at]**, a median 11.8 min for GP and 6.8 min for hospital GP.
   - The requested "lag from consult end to Rx created_at" is therefore negative: the Rx is created at the start of the consult.
5. **Advised procedure or surgery is available in three places, all joinable to the Rx (section 3):**
   - the structured plan flag `requires_surgery_or_procedure`;
   - the LLM-derived `prescription_surgery_recommendation`;
   - CT angiography orders in `further_investigation`.
   - `booked_services` holds only TEST, PACKAGE, REFERRAL and MEDICINE, so procedures are not booked through it.
6. **Dead or stale for this window:** `kx_prescription_records` (18,935 rows, `_create_time` 22 Aug 2025 – 26 Apr 2026, 0 in window), `kx_eprescriptions` (1 row, Aug 2025), and the always-empty Rx fields listed in section 1 (`kx_encounter_id`, `ip_uid`, `emr_id`, `doc_id`, `consult_type`). Do not build on them.

## 1. `individuals-prescriptions` (hub)

Key fields: `uid`; `_parent_id` (patient); `doctor_uid`; `doctor_name_with_speciality`; `type_of_prescription`; `timestamp`; `updated_at` (text, `YYYY-MM-DD HH:MM:SS +ZZZZ`, 92% filled in Sept, cast with `::timestamptz`); `uploaded_at`; `is_draft`; `consult_uid`; `parent_prescription_uid`; `patient_need_hospitalization`; `requires_medical_admission`; `medical_admission_note`; `not_booked_reason__*`.

Mix in the window: GENERAL_PRACTITIONER 16,257; HOSPITAL_GP 6,157; DIETARY 1,181; HOSPITAL_GYNAECOLOGY_ASSESSMENT 1,025; HOSPITAL_PAEDIATRIC 667; PHYSIO 555 + HOSPITAL_PHYSIO 650; other 496. Consult-like types are GENERAL_PRACTITIONER and HOSPITAL_GP.

| week (Mon) | Rx | draft % | `consult_uid` % | `doctor_uid` % | `requires_medical_admission` filled % |
|---|---|---|---|---|---|
| 27 Jul (partial) | 701 | 8.3 | 96.6 | 100 | 0.0 |
| 3 Aug | 3,565 | 11.0 | 98.5 | 100 | 0.0 |
| 10 Aug | 3,161 | 13.4 | 98.8 | 100 | 0.1 |
| 17 Aug | 3,483 | 11.4 | 98.7 | 100 | 0.0 |
| 24 Aug | 3,434 | 11.4 | 98.9 | 100 | 37.4 |
| 31 Aug | 3,377 | 11.8 | 98.6 | 100 | 91.2 |
| 7 Sep | 3,737 | 11.0 | 99.0 | 100 | 92.3 |
| 14 Sep | 3,220 | 11.0 | 97.9 | 100 | 92.7 |
| 21 Sep (partial, to 24 Sep) | 2,315 | 10.7 | 98.2 | 100 | 92.8 |

- `requires_medical_admission` only exists from about 27 Aug. Rx with it TRUE per week: 9 (7 Sep), 10 (14 Sep), 3 (21 Sep), 0 before.
- Always empty (0%): `kx_encounter_id`, `ip_uid`, `emr_id`, `doc_id`, `consult_type` (on the Rx; it is filled on the dpipe copy). Do not use these as joins.
- **Text fields.** Where the words are:
  - `general_practitioner_prescription__presenting_complaints`: 97.3% (Sept, GP types).
  - `general_practitioner_prescription__plan_of_management` (the management plan and advice text): about 87.5–90.9%.
  - `general_practitioner_prescription__examination`: 18.3%.
  - `medications`: about 52–55%.
  - `diagnosis_icd_codes`: about 74–79%.
  - `structured_general_advice`: about 14–19%.
  - `patient_need_hospitalization` is non-NULL on 87–92% of Rx, but that is not a usable signal: over the window it is UNKNOWN 22,302, NULL 3,041, NO 1,229, UNSURE 375, YES 100. (The "87–92% filled" reading counts UNKNOWN as filled; an earlier draft of this file and my first bus post did not say so.)
  - **Empty or near-empty:** `general_advice` 0%, `doctor_notes` about 0%, `reason_for_consultation` 0%, top-level `presenting_complaints`/`assessments` about 3–5%.
  - `free_text` fell from about 8–11% (to 31 Aug) to 3.6% (7 Sep), 0.7% (14 Sep) and 0.2% (21 Sep), so it cannot be relied on for recent weeks.
- **Lag distributions** (Sept, non-draft):
  - `uploaded_at - timestamp`: p10/p50/p90/p99 = 3.5 / 11.5 / 44.8 / 442 min (`uploaded_at` filled on about 86–92% of rows).
  - GENERAL_PRACTITIONER `updated_at - timestamp`: p10 3.9, p50 11.8, p90 33.3, p99 204 min (n 6,317).
  - HOSPITAL_GP `updated_at - timestamp`: p10 1.6, p50 6.8, p90 23.5, p99 about 2,023 min (n 2,902; the p99 is a few late edits).

## 2. Child tables of the Rx (join `child._parent_id = individuals-prescriptions.uid`)

| table | key fields | fill | note |
|---|---|---|---|
| `individuals-prescriptions__further_investigation` | `investigation__name`, `investigation__uid`, `investigation__type` (TEST / PACKAGE), `urgent`, `fasting`, `instruction`, `not_recommended`, `date`, `is_completed` | name 100%, uid 98.6–100% | 2.1–2.5k rows and 1.0–1.2k Rx a week (about 31–35% of Rx). 15,063 TEST rows (767 distinct) + 3,839 PACKAGE rows (39 distinct) in the window. |
| `individuals-prescriptions__booked_services` | `type`, `name`, `uid`, `doctor_uid`, `external_service_code` | name 100% | types: TEST 6,131; PACKAGE 2,170; REFERRAL 1,397; MEDICINE 801. No procedure or surgery type. |
| `individuals-prescriptions__refer_to` | `specialist_type__name`, `specialist_type__is_in_house`, `doctor_name`, `notes`, `recommended_by_even`, `is_completed` | | Rx with at least one referral 600–750 a week (about 17–21%); of those, in-house 255–350 a week. |
| `individuals-prescriptions__structured_general_advice` | `general_advice` (text) | | about 14–19% of Rx. |
| `individuals-prescriptions__doctor_notes`, `__visit_notes` | `note`, `symptoms_notes` | about 0% / gynae only | not useful for surgical chains. |

`individuals-prescriptions-prescription_history` has the same columns as the hub and appears to keep versions of each Rx. I did not measure it. It would be the place to reconstruct the edit trail if the final-save time is not enough.

## 3. Advised procedure / surgery / admission signals (all join to the Rx)

**(a) `dpipe_prescription_pipeline__plan_of_management`**: structured doctor entry.
- Fields: `requires_surgery_or_procedure` (bool), `surgery_or_procedure_recommendation` (jsonb array of objects with keys `surgery_or_procedure` (a name), `notes`, `scheduled_date`, `ai_metadata`), `diagnosis__diagnosis_or_impression`, `diagnosis__treatment_plan`, `management_plan`, `is_not_required`.
- Join: `child._parent_id = dpipe_prescription_pipeline._id`, which equals the Rx `uid` (4,792 of 4,797 rows since 15 Sep). `dpipe.presc_uid` also equals the Rx `uid` (100% of 6,511 tested).
- Rx with `requires_surgery_or_procedure` = true per week: 17 (27 Jul partial), 67, 61, 32, 57, 68, 81, 78, 54 (21 Sep partial). About 77–96% of those carry a non-empty recommendation array. Since 1 Sep there are 258 named `surgery_or_procedure` entries, 65 with `notes`, and 23 with a `scheduled_date`.
- `management_plan` filled 88–90%; `diagnosis__icd_code` is about 0% here.

**(b) `prescription_surgery_recommendation`**: LLM-derived flags per Rx.
- Fields: `surgery_recommended` (yes/no/null/''), `surgery_type`, `surgery_confidence`, `surgery_likely`, `admission_recommended`, `admission_type`, `surgery_source`, `prescription_uid`, `prescription_date`, `visit_id`.
- `prescription_date` is DATE-ONLY text (`YYYY-MM-DD`), so match by IST date, not by timestamp (as in `EXTRACTS.md`).
- `prescription_uid` = Rx `uid` on 100% of the 533 rows with `surgery_recommended='yes'`, and `patient_uhid` is 100% filled. `visit_id` is only 2–5% filled, so it is not a usable key.
- Rows a week: 593–991. "yes" rows a week: 68, 73, 48, 69, 74, 75, 69, 55 (3 Aug – 21 Sep); a `surgery_type` is present on about 79–87% of them. `admission_recommended='yes'` is 5–23 a week.
- It covers only about 19–28% of Rx, so a missing row is not a "no".
- **How PSR picks Rx** (1–24 Sep, Rx joined by `prescription_uid`): it follows the Rx **type**, not the speciality.
  - `HOSPITAL_GP` 2,199 of 2,943 (75%); `HOSPITAL_GYNAECOLOGY_ASSESSMENT` 352 of 476; `HOSPITAL_GYNAECOLOGY_OBSTETRICS` 106 of 114; `HOSPITAL_PHYSIO` 317 of 337; `HOSPITAL_PAEDIATRIC` 119 of 326.
  - Platform types are almost never read: `GENERAL_PRACTITIONER` 9 of 7,112, `DIETARY` 0 of 458, `PHYSIO` 0 of 189.
  - By speciality (the text in trailing parentheses of `doctor_name_with_speciality`): General Surgery 186 of 240 (78%), Urology 161 of 225 (72%), Neurology 79 of 79, Gastroenterology Surgery 70 of 71, Cardiology Non-Interventional 107 of 137, Cardiology Interventional 60 of 111, Orthopaedician 459 of 1,164 (39%), Internal Medicine 696 of 1,910 (36%), General Physician 39 of 3,679 (1%).
  - So PSR is effectively "hospital OPD Rx". About a quarter of hospital GP Rx are still unread, and I did not find why. Recall on those is unknown.
- **PSR test arrays (`radiology_tests`, `cardiology_tests`, `lab_tests`, `tests`)** are sparse: `radiology_tests` is non-empty on only 3–8% of rows and `cardiology_tests` on 0–2%. CT-type angio mentions in them: 0, 0, 0, 0, 1, 5, 4, 5, 4 per week (27 Jul – 21 Sep), and 0–10 a week for any "angio" name. The counts are small and I did not check the overlap with `further_investigation`, so use `further_investigation` (section 3c) as the primary source.

**(c) CT angiography and other angio orders** (`further_investigation.investigation__name`):
- CT-type names: "CT Coronary Angio Scan" (27 rows in the window), "C T Coronary Angio Calcium Screening" (1), "CT SCAN LOWER LIMB ANGIOGRAM" (1).
- The other "angio" names in the window are MRI angio orders, plus "Coronary Angiography" (1). Do not count those as CT angio.
- Rx with any "angio" name per week: 1, 5, 4, 3, 4, 14, 4, 12, 6. CT-only rows per week: 0, 1, 1, 1, 1, 11, 2, 7, 4. That is small, so the CT angio slice will be thin.
- The master catalogue is `medical_investigations` (`uid`, `name`, `department`, `karexpert_code`, `opd_service_category`). Matching by `investigation__uid` is safer than by name.

**(d)** `individuals-prescriptions.requires_medical_admission` and `medical_admission_note`: see the table above (a handful a week, from late Aug).

## 4. The Rx → calendar-event → consult window

`accounts-members-calendar_events` (joined by `uid = Rx.consult_uid`). Fields: `start_time`, `end_time` (slot), `consult_timing_metadata__start_timestamp` and `__end_timestamp` (text), `status`, `booking_type`, `doctor_uid`, `doctor_name`, `prescription_uid`, `consult_facility_info__name`/`__department`/`__facility__type`, `karexpert_metadata__external_appointment_id`, `surgery_booking_meta__action`, `is_no_show`.

- Events a week: 3.1k (partial) – 4.8k. `doctor_uid` 100%. Back-link `prescription_uid` 60–69%. Actual consult start/end filled 65–77%. `karexpert_metadata__external_appointment_id` and `surgery_booking_meta__action` are 0% filled in this window.
- Mix in September: REGULAR/ACTIVE 10.2k (3.4k of them EVEN_HOSPITAL); CANCELED 2.1k; NO_SHOW 1.1k; RESCHEDULED 0.7k; EVEN_CONSULTS 1.2k; a few HEALTH_CORNER and MANAGED_CARE. Many events are teleconsults or non-hospital, and the facility type is null for most of them. Use `facility__type = 'EVEN_HOSPITAL'` for in-person hospital OPD.
- Bounded join, Rx of 14–24 Sep (GP types) with events of 10–24 Sep (n = 1,040 hospital, 3,133 facility-null, 6 clinic). Median (p10..p90), in minutes:
  - Rx `timestamp` minus the actual start: +0.02 (0.02..0.14) for hospital, +0.02 for null. The **actual start equals Rx creation to about 1 s**.
  - Rx `updated_at` minus the actual end: -0.07 (-0.55..+7.2) for hospital, -0.08 (-0.47..+20.4) for null. The **actual end is about the Rx last-save**.
  - Rx `timestamp` minus the slot start: +8.2 (-33.7..+73.3) for hospital, -0.9 (-9.8..+3.4) for null. So the slot start is a poor pin for hospital OPD, where queues run late.
  - Rx `timestamp` minus the actual end: -6.0 (-16.6..0.0) hospital, -11.6 (-22.2..-4.2) null. This is the requested "consult end to Rx created_at" lag, and it is negative because the Rx is opened at the start.
- **Caveat.** `consult_timing_metadata` appears to be derived from the Rx create and save times, and is not an independent clock. So the window [Rx.timestamp, Rx.updated_at] is the doctor's Rx-editing window. It may not equal the time the patient was in the room. A doctor who opens the Rx late, or finishes it after the patient leaves (the `updated_at` p90 is 23–33 min after the start), shifts the window. Room and door times need the queue tokens (linker scope) or the audio.

## 4b. Reconciliation with `SCHEMA.md` (linker, v1)

- **Agrees:** Rx `timestamp` = consult start (linker: `timestamp - called_at` p50 +0.02 min; mine: +0.02 min against the calendar actual start and -0.5 min against `doctor_start_time`); `updated_at` = last write, near the consult close; `kx_prescription_records` is dead; `kx_encounter_id`/`ip_uid`/`emr_id` are empty; PSR joins to the Rx by `prescription_uid` and `visit_id` is unusable; 533 PSR "yes" rows.
- **Adds or differs:** SCHEMA.md §2 says `consult_uid` "matches no queue uid/token/service-request". That is true of those tables, but `consult_uid` **does** equal `accounts-members-calendar_events.uid` (300 of 300 sampled). So there is a shared visit id between the Rx and the calendar event. Whether a calendar event links to a queue token (and so to the linker's `called_at`/`completed_at` pin) is untested. It could give the linker a doctor-independent key in place of the (patient, doctor, IST date) match, which is unique for 96.7% of visits.
- **Minor:** `_parent_id` = `_parent_doc_id` on 2,512 of 2,512 Rx (20–24 Sep), so the two patient-key spellings are the same. Rx counts differ by a handful at the window edge (26,988 here, 26,979 there).
- **Answers to §10 for `mb-rx`:** CT angio and other interventions are in `further_investigation` (section 3c), the plan-of-management array (3a) and, thinly, the PSR test arrays (3b). PSR selection is by Rx type (3b). `patient_need_hospitalization` is 100 YES in the window and is not a usable advised-admission signal; `requires_medical_admission` (from about 27 Aug) has only 22 true across 3 weeks.

## 5. What is not here

- Rx text with a named operation in free text is not extracted. The plan-of-management and structured advice text is there for Jev, but I did not read any text, as it is PHI.
- I did not test `prescription_history` or the doctor master (`doctors`). The cart route is now covered in section 6.
- Failed or unproductive queries: an unbounded `EXISTS` join to `chart_service_request` timed out at 180 s (no full scans are used now), and one query had a wrong column (`refer_to.uid` does not exist), fixed.

## 6. Follow-up, 24 Sep ~16:10 (linker #440): investigation carts and "was the CT angio actually booked"

Read-only, counts only, no link scoring. Window 1 Aug – 24 Sep. This supersedes the "not tested" item about carts in section 5.

**6.1 Cart tables**
- `individuals-investigation_carts` is **dead**: 10,680 rows, last `_create_time` 21 May 2026, 0 rows in the window.
- The live table is `accounts-account_investigation_carts` (77,192 rows, current to 24 Sep). It is per **account** (`_path` = `/accounts/{account}/account_investigation_carts/{cart}`), not per patient. The patient is the member on the item (`__cart_items.selected_member_uids`), so a cart is not directly a patient key.
- Cart → Rx link: `booking_trigger__prescription_uid`. It is **0% before 31 Aug**, then 15.1% (31 Aug week), 24.3%, 26.9%, 29.5% (21 Sep, partial). `booking_trigger__type` is filled on exactly the same rows (all `EVEN_CONSULTATION`) and `booking_trigger__doctor_uid` is 0%.
- Carts a week: 1.2–2.0k (305 in the 2-day 27 Jul bucket). Items array non-empty 12–16% to 24 Aug, then 24–35%. An uploaded-prescription array (`prescriptions`, external uploads, not platform Rx) is 5–6% to 24 Aug, then 19–32%. `order_details__meta_order_id` is 0.0–0.4%.
- September mix (carts): DRAFT with no trigger 4,634; triggered `HOME_COLLECTION` BOOKED 693 / DRAFT 409 / ABANDONED 74 / FAILURE 22; triggered `NETWORK_VISIT` BOOKED 229 / DRAFT 142 / ABANDONED 9; untriggered BOOKED 153. These are lab and home-collection style orders.

**6.2 CT angio Rx (from `further_investigation`, CT-type names): 30 Rx, 28 patients, 3 distinct investigation uids**
(regex `(\mct\M|c t).*angio|angio.*\mct\M`; it would miss unusual spellings such as "CTA" or "C.T.")

| route | result |
|---|---|
| Cart with `booking_trigger__prescription_uid` = one of the 30 Rx | 3 carts for 2 Rx (2 DRAFT, 1 BOOKED). Only 25 of the 30 Rx fall on/after 31 Aug, when the trigger link exists at all |
| Cart item whose `service__uid` is one of the 3 CT-angio investigation uids | 3 items in 3 carts, any patient |
| **`chart_service_request` by `prescription_uid` = one of the 30 Rx** | 41 rows (every service on those Rx, not only the angio) for **20 of 30 Rx**; statuses PRESCRIBED, DRAFT, CANCELLED and one COMPLETED |
| **`chart_service_request` by patient AND the CT-angio investigation uid** | **20 rows for 18 of 28 patients**, all 20 carrying an Rx uid from the set. Status: PRESCRIBED 16, DRAFT 3, CANCELLED 1, **BOOKED 0, COMPLETED 0** |
| Any later-stage CT request (REQUESTED / BOOKED / PENDING_CHECKIN / COMPLETED, any CT service) for the 28 patients | 6 rows for 6 patients, **all COMPLETED, none with an angio name, none created on/after that patient's first CT-angio Rx** (string comparison of IST timestamps). So none looks like the ordered angio being done |

**6.3 `chart_service_request` is the booked-service surface (and cart is not)**
- Fields that link it: `prescription_uid`, `individual_uid` (100% filled), `service_metadata__medical_investigation_uid` (57–74%), `service_metadata__medical_procedure_uid` (2–5%, so it also carries procedures), `service__name`, `service__modality`, `status`, `ris_order__status`, `created_at` (text), `occurrence_period__*`, `service_metadata__consult_uid` (the visit key, see section 4b).
- Status ladder for CT-modality requests: PRESCRIBED → (DRAFT / REQUESTED) → BOOKED / PENDING_CHECKIN → COMPLETED (`ris_order__status` REPORTED or SENT), or CANCELLED. 1 Aug – 24 Sep, CT modality: PRESCRIBED 77, COMPLETED 81, DRAFT 57, CANCELLED 49, BOOKED 21, PENDING_CHECKIN 5, REQUESTED 9.
- **`prescription_uid` is filled on only 15–23% of all requests** (weekly), and on 9 of 54 CT requests that are COMPLETED and REPORTED. So **a completed scan usually cannot be tied back to its Rx by `prescription_uid`**. Matching a done CT to an Rx needs patient + investigation uid + time, not the Rx uid.
- A request in status PRESCRIBED is created together with the Rx (all 20 angio rows carry the Rx uid). It is a lead from the Rx, the same pattern linker found for PRESCRIBED `surgery_cases`, and it is **not** evidence that the scan was booked.
- Weekly volume of all requests: 4.4–7.6k (the first and last weeks are partial); COMPLETED about 2.2–4.0k a week.

**6.4 Reading**
- In Metabase, none of the 28 CT-angio patients has a BOOKED or COMPLETED CT-angio request, and none has a later completed CT of any kind. That does not show the scan was not done: the hospital radiology system may be outside the platform's service requests (`chart_radiology_order` is dead: 9 rows, Sept–Oct 2025; `kx_prescription_records` is dead), and the latest Rx have had little time to be booked. The IPD/billing cross-check belongs to `mb-ipd`.
- So CT angio is **usable as an advised-intervention signal** (order on the Rx), and **not usable as a "done" label** from Metabase as far as I found.
- Not done: matching a CT angio Rx to a hospital-side bill or report; the cart→hospital-OPD route for radiology (carts here are lab-style); `prescription_history`; `medical_procedure_uid` requests (mb-ot's procedure-master scope).

## 7. Ruling 164 (Fable 17:26): plain-CT radiology done sources and join keys

Read-only, counts only, no link scoring. Window 1 Aug – 24 Sep. "Plain CT" here = a CT name that does not match `angio|calcium|mri|pet`. The name regex `(^|[^a-z])(ct|c\.?t\.?)([^a-z]|$)` is a name match; match on investigation uid where possible.

**7.1 Usable done sources (live)**

| source | what counts | patient key | time | fill and volume | gap |
|---|---|---|---|---|---|
| `chart_service_request` (platform hospital service requests; RIS provider MEDSYNAPSES) | `status='COMPLETED'` and CT modality (`service_metadata__modality` or `service__modality` = 'CT'), name not angio/calcium | `individual_uid` (100%; = `individuals.uid`) | `occurrence_period__start` (100% filled), or `created_at` | Completed CT by week 3 Aug – 21 Sep: 3, 2, 1, 3, 8, 19, 33, 15; **plain: 3, 2, 1, 2, 6, 6, 13, 6 (39 total)**; the rest are calcium-score scans (45). `hospital_info__hospital_uid` 100%. `ris_order__status` (REPORTED/SENT) is 0–67% until 24 Aug and 100% from 31 Aug | `prescription_uid` is filled on only 0–50% of these rows by week (weekly counts are tiny; 13–18% in September), so match by patient + investigation uid + time. Order-time statuses: PRESCRIBED (created with the Rx, a lead only), DRAFT, REQUESTED, BOOKED, PENDING_CHECKIN, then COMPLETED / CANCELLED |
| `kx_billing_records` (HIS bill lines) | plain-CT lines (`sub_department='CT Scan'` or a CT-scan-type item name), `status='Sale'` | `uhid` (100%) → `individuals.kx_uhid` → `individuals.uid` (57 of 59 resolved) | `bill_date_time`, `order_date_time` (both 100%) | **88 plain-CT lines**, weekly 1–25 (all CT-like); by patient type IP 70 lines / 50 patients, ER 17 / 11, **OP 1**. `visit_id_admission_id` 100% | Inpatient and emergency only: OP has 14,140 lines but only 7 radiology lines. Its `service_request_id` is a HIS-internal UUID and matches **0 of 87** platform service-request uids, so the bill joins by patient, not by request |

**7.2 Reports and other tables (context)**
- `chart_diagnostic_report` (category RADIOLOGY): 834 reports in the window, each with `based_on` = exactly one service-request uid (834 of 834 matched). Modality X-ray 407, ultrasound 370, CT 57 (all COMPLETED; 16 plain, 41 angio/calcium). It is a report artefact of the same completed requests, and adds no CT beyond them.
- `individuals-radiology_reports` (6,952 in window): platform-patient radiology bookings and uploads with `network_hospital__*` (external network hospitals). Not in-house, and not examined further.
- Not tested: `chart_invoice` (has `service_request_uids`, `individual_uid`, `hospital_info__hospital_uid`; 20,341 in window) and `dpipe_radiology_booking_flow` (booking funnel: member, facility, slot).

**7.3 Dead or unusable for this window**
- `kx_radiology_reports` (HIS radiology reports; the best structure: `uhid`, `service_date`, `service_name`, `sub_department` = 'CT Scan', `body_part`, `treating_ordering_doctor`, `visit_id`, `order_no`, `accession_no`): 2,908 rows loaded **once on 27 Aug** (7 minutes), `service_date` from Jul 2025 to **13 Jul 2026**, nothing after. So 0 rows in our window. In Jun–Jul it shows 14–22 plain CTs a week. **A refresh of this table would be the complete in-house CT record.**
- `chart_radiology_order` (9 rows, Sep–Oct 2025), `chart_radiology_report` (0 rows), `kx_prescription_records` (last row Apr 2026), `kx_op_billings` (only offline OP bills: 44–83 a week, about 0 CT lines).

**7.4 Coverage: what each source can and cannot see**
- Overlap weeks (Jun–Jul 2026): HIS plain CT 14–22 a week against 2–7 a week completed in `chart_service_request`. So the platform table appears to hold **roughly a third of in-house CTs** in those weeks. I could not check this for Aug–Sep because the HIS report table stops in July. Cause not established (CTs ordered directly in the HIS are the obvious guess).
- Outpatient CT is essentially **not billed** in `kx_billing_records` in this window (1 OP CT line), so a bill source covers inpatient and emergency CTs only.

**7.5 Feasibility count (not a link score)**: Rx (from `further_investigation`) that order a plain CT, against a done record for the same patient within [-1, +30] days of the Rx `timestamp`.
- **102 Rx, 90 patients, 27 investigation uids** (about 13 Rx a week).
- Done via platform service request: **20 of 102**. Done via HIS bill: **0**. Union: 20.
- Rx on or before 24 Aug (a full +30 days, 32 Rx): **0 with a done record**. All 20 hits sit in the 70 Rx from 25 Aug on, most of which have under 30 days of follow-up (20 of 70).
- So for early-August plain-CT orders there is no done evidence in Metabase at all, most likely because completed-CT service requests are 1–3 a week in August against 6–13 a week in September (same weeks: RIS status 0–67% filled in August, 100% from 31 Aug). Cause not established.

**7.6 Suggested label tiers (mine, not a ruling)**: done = a COMPLETED plain-CT service request (or an HIS plain-CT bill line) for the same patient within [-1, +30] d; a weaker "in progress" tier for REQUESTED / BOOKED / PENDING_CHECKIN; never PRESCRIBED or DRAFT (a lead from the Rx, as for `surgery_cases`). Absence of a done record is not a negative before September, and probably not after either (7.4).

**7.7 Name reconciliation (linker #631: 120 Rx / 107 patients against my 102 / 90)**, counts and catalogue names only, Rx `timestamp` 1 Aug – 24 Sep.

| rule on `further_investigation.investigation__name` | Rx | patients |
|---|---|---|
| A. mine in 7.5: "CT" as its own word, not `angio\|calcium\|mri\|pet` | 102 | 90 |
| B. A plus the names that carry CT inside one word: **"NCCT SCAN Brain" (5 Rx), "NCCT SCAN KUB" (1), "HRCT SCAN Thorax" (1), "CECT Thorax" (1)** | 110 | 98 |
| C. B minus three names that are not plain CT scans of the usual kind: **"CT Venogram" (1), "CT SCAN AORTOGRAM" (1), "CT SCAN Enterography" (1)** | 107 | 95 |
| D. PSR test arrays (`radiology_tests`, `cardiology_tests`, `lab_tests`, `tests`), same rule as B: 67 Rx, of which **21 are not in B**; union with B | 131 | |

- The 8-Rx difference between A and B is my regex missing "NCCT", "CECT" and "HRCT" names: they are real plain CTs and belong in.
- The venogram and aortogram are vascular contrast studies, the same family as CT angiography (referred out, ruling 163). I would exclude them. Enterography is a bowel CT and is arguable; I would keep it.
- The remaining gap to linker's 120 is 10 (against B) or 13 (against C); PSR arrays could account for it, since D adds 21. I did not have linker's list, so this is not confirmed. PSR arrays are LLM-extracted test lists, not orders, so an Rx that appears only there is a weaker "advised".
- Repeat orders inflate Rx against patients: "CT LEFT HAND" is 16 Rx for 6 patients.
- The section 7.5 feasibility counts (20 of 102 done; 0 of 32 mature) used rule A. They were not re-run under B, C or D.

**7.8 The 12-Rx gap closed (linker #646: 119 Rx / 106 patients against my 107 / 95).** Same window and field as 7.7.
- **Cause 1, 11 Rx: names spelled "C T ..." with a space.** My regex knew "CT" and "C.T" but not "C T": "C T Scan Temporal Bones" (4 Rx), "C T Scan Brain without Contrast" (3), "C T Scan Whole Abdomen" (2), "C T Scan of Para Nasal Sinuses" (1), "C T Colonoscopy" (1). The spaced pattern is `(^|[^a-z])c[ .]{1,2}t([^a-z]|$)`. ("C T Coronary Angio Calcium Screening" also has this spelling, and stays out as angio/calcium.)
- **Cause 2, 1 Rx: "CT SCAN Enterography"**, which I had dropped in 7.7 (rule C) and linker keeps. It is a bowel CT.
- 107 + 11 + 1 = 119 Rx; the patient counts also match at 106. Rule: word CT, NCCT, CECT, HRCT or spaced "C T", excluding `angio|calcium|mri|pet|venogra|aortogra|arteriogra|portogra`.
- Judgment calls left in: "C T Colonoscopy" (1 Rx, probably a CT colonography) and "CT SCAN Enterography" (1 Rx). Without either the count is 118 Rx / 105 patients.
- **A false positive to avoid:** a `tomograph` term also matches "X-Ray Pantomography (Opg)" (an X-ray, 1 Rx). It is not in the rule above.
- The 7.7 comparison (110 / 107 and the PSR-array note) is superseded by this rule. The PSR-array extras were not re-counted and did not enter linker's count.

## 8. Ruling 183 (voice linkage): calendar event uid → Rx items for matched consults

Read-only, counts only. Helper (no PHI in it): `studies/2026-09-24-surgical-chain/rx_items_by_consult.py` (untracked). `python3 rx_items_by_consult.py IN.txt ~/eta-data/voice-linkage/out.json [--since 2026-08-01]` or `rx_items(consult_uids, since)`. It refuses to write output outside `~/eta-data/`.

**Path.** consult uid (= calendar event `accounts-members-calendar_events.uid`) → `individuals-prescriptions` where `consult_uid` = that uid and `type_of_prescription` in (GENERAL_PRACTITIONER, HOSPITAL_GP) → child tables on `_parent_id` = Rx `uid`:
- **drugs:** `individuals-prescriptions__medications` (`brand_name`, `generic_name`, `strength`, `dosage`, `frequency`, `duration`, `route_of_administration`, `instruction_to_patient`);
- **tests:** `individuals-prescriptions__further_investigation` (`investigation__name`, `investigation__uid`, `investigation__type` TEST/PACKAGE, `instruction`, `urgent`, `fasting`, `included_tests`, `not_recommended`);
- **referrals:** `individuals-prescriptions__refer_to` (`specialist_type__name`, `notes`);
- **advice text:** `individuals-prescriptions__structured_general_advice` (`general_advice`).
- Rx-level fields: `doctor_uid` (the doctor to confirm), `timestamp` (consult start), `updated_at` (last save, about consult end), `is_draft`, `_parent_id` (patient).
- `individuals-prescriptions__diagnoses__medicines` has 35 rows since 1 Sep and `__assessments__diagnosis__medicines` 0: not used.

**Fill of drug rows** (36,882 rows, 1 Aug – 24 Sep): brand 100%, generic 66%, strength 64%, dosage 82%, frequency 97%, duration 96%, route 82%, patient instruction 72%. Match spoken names on brand and generic together (the generic is often missing).

**Circularity check.** Item-level `ai_metadata__ai_filled` is true on 0.4% of drug rows, 0.5% of investigation rows and 1.2% of advice rows, so the drug and test lists are essentially clinician-entered. Rx-level GP free-text fields carry `ai_field_metadata` on 78% of Rx (which fields, and whether the AI drew on the consult audio, is not verified), so do not treat plan-of-management or complaint text as independent evidence.

**Test** (150 ACTIVE events, 14–24 Sep, first by start time; ids only in `~/eta-data/voice-linkage/`):
- 123 of 150 events (82%) reach a consult-type Rx by `consult_uid` (122 with one Rx, 1 with two).
- The other 27: 10 have only a PHYSIO Rx (not a doctor consult), 17 have no Rx of any type.
- The calendar back-link `prescription_uid` (133 of 150 filled) equals the found Rx on 123 of 123 where a consult-type Rx exists, 0 disagreements.
- The 124 Rx carry 207 drug rows (92 Rx with at least one drug) and 75 test rows (43 Rx with at least one test). So about a quarter of consult Rx have no drug rows: for those, step 3 has nothing to count.
- Regular consults are the norm in the sample (facility type null on all 27 misses); hospital OPD consults that skip the queue reach the Rx the same way.

**7.9 Plain-CT investigation uid list (linker #653), 25 Sep.** File on the box only: `~/eta-data/surgical-chain/plain_ct_investigation_uids.json` (0600; catalogue uids and names, no patient data; not in git).
- `in_window_uids`: the 33 investigation uids behind the 119 name-rule Rx (with each name and its Rx count).
- `master_catalogue_matches`: 169 `medical_investigations` entries matching the same name rule (155 with modality CT, 4 disabled), for orders not yet seen.
- `additional_master_entries_not_matched_by_regex`: 2 plain multi-detector CT entries (names with "MDCT"; the regex misses them). None was ordered in the window.
- **Uid rule against name rule:** 118 Rx / 105 patients by the 33 uids, 119 / 106 by name. The 1 Rx difference is a matched row with an **empty `investigation__uid`**, so keep the name rule as a fallback for empty uids.
- PET-CT entries stay excluded (not plain CT under ruling 164). The other CT-modality names in the master not matched by the regex are not scans ("Testing Radiology", drug susceptibility test, biopsy gun charges, "Advanced Cardiac Check").
