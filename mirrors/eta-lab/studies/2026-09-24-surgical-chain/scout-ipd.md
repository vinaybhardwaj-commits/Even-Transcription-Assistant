# scout-ipd: IPD admissions, discharge, day-care/procedure billing (mb-ipd, 24 Sep ~15:00 IST)

Read-only Metabase (box key). Window: 1 Aug to 24 Sep 2026 (IST). Aggregates and shape probes only. No patient identifiers in this file; nothing was pulled to the box, since no row samples were needed. Every query was date-filtered and run one at a time.

Databases: `13` = "Firestore to Postgres (prod)" (all kx_* HIS mirrors, claims, surgery_*); `16` = "Even Hospital Ops (Postgres)" (rh_* tables).
Week = ISO Monday week in IST. The first row (w/c 27 Jul) and last row (w/c 21 Sep, data to 24 Sep ~14:00) are partial.

## Summary for the linker
1. **The IPD spine is `kx_ip_admissions` (db13).** One row per encounter, keyed by `encounter_id` = `identifier` (formats `IPNO-nnn`, `IP-nnnn`, `ERN-nnn`) plus `uhid`. It carries doctor ids and names, department, admission timestamp and payer. 1,433 rows in the window: 882 `ip_admission` and 551 `er_admission`.
2. **The discharge summary table has NO procedure or diagnosis text.** `kx_discharge_summary_records` holds only metadata: ipd_no, uhid, discharge type, admission and discharge times, created/modified, doctor team and speciality. Whether a summary exists and when it was finalised is usable; what was done is not.
3. **Where procedures live for the window:**
   - **`kx_billing_records` (db13)**: item lines, service_type `Surgery`, `IP Package`, `Procedure`, `Cardiology`, `Radiology`. This is the only full-coverage source of a named procedure. It can be joined to admissions with 100% match (859/859 visits).
   - `ipd_claims_v1` (insurer claims only, tiny): `procedure_name`, `diagnosis`, ICD.
   - `rh_ehbr_ipd_detail` (db16) has `procedure` and `final_diagnosis`, but ends 18 Jun 2026. **0 rows in the window.** Useful only for historic backfill (Dec 2025 to 18 Jun 2026).
4. **Billing lines do NOT pin the operation time.** Surgery-line `order_date_time` is a median ~2 h after admission and P90 ~25 h. Package lines are ~0 h. Billed (`bill_date_time`) is ~61 h after order, close to discharge. Treat billing as visit-level "a surgery was billed on this admission", not OT date/time. The exact OT timestamp has to come from the OT notes or booking scout (mb-ot).
5. **Doctor key gap.** Admissions use UUID-style HIS doctor ids (`admitting_doctor_id`, `current_treating_doctor_id`, plus name text). Billing carries `perform_by`/`perform_by_code`/`treating_doctor_code` in different code formats (numeric, `DR-nn`, other). A doctor mapping table between them still has to be found, which is a job for the linker (OPD doctor ids).

## Tables

### kx_ip_admissions (db13), the admission spine
- Keys: `encounter_id` (= `identifier`, 1433 distinct of 1433 rows), `uhid`, `uid` (mirror doc id), `hospital_uid` (2 hospitals), `admission_request_no` (empty in the window).
- Timestamps: `admission_date_time`, `created_at`, `modified_at`, `current_bed_occupy_time`, `_create_time`, `_update_time`.
- Doctors: `admitting_doctor`, `admitting_doctor_id`, `admitting_doctor_speciality`, `current_treating_doctor`, `current_treating_doctor_id`, `current_treating_doctor_speciality`; departments: `admitting_department_name`, `treating_department_name` and `_sub_department_name`.
- Other: `encounter_type` (ip_admission/er_admission), `event` (direct_admission / er_to_ip / empty for ER), `payer_*`, `lead_source`, `referral_name`, `ward`, `bed`, `is_part_of_care_plan`.
- Fill: doctor id, treating doctor id and admitting speciality are 100% filled in every week.
- Weekly rows by admission time: 27Jul 43, 3Aug 182, 10Aug 181, 17Aug 205, 24Aug 198, 31Aug 162, 7Sep 196, 14Sep 170, 21Sep 96 (partial).
- Distinct uhids per week are lower, e.g. 151 of 182 in the 3Aug week, so a patient can have several encounters (an ER admission followed by an IP admission).

### kx_discharged_completed_patients (db13), the discharge fact
- Keys: `encounter_id`, `uhid`. Same doctor and department fields as admissions.
- Timestamps: `admission_date_time`, `discharge_date`, `discharge_intimation_date_and_time`, `discharge_summary_final_date_time`, `expected_discharge_date_and_time`, `actual_los_in_days`.
- Also: `discharge_type_value`, `discharge_status_name`, `discharge_remarks` (free text, ~8% filled).
- Weekly rows by discharge date: 27Jul 42, 3Aug 168, 10Aug 133, 17Aug 181, 24Aug 163, 31Aug 127, 7Sep 158, 14Sep 144, 21Sep 67.
- Fill: `discharge_summary_final_date_time` about 75% (e.g. 126 of 168, 104 of 133); all other key fields 100%.
- Coverage: 96% of ip_admissions in the window (846 of 882) are here; only 245 of 551 er_admissions (the rest were converted to IP or are still in house).
- Rows are `status = Discharged`, one per encounter.

### kx_discharge_summary_records (db13), the discharge-summary event (no clinical text)
- Keys: `ipd_no` (same format as encounter_id), `uhid`, `membership_id`.
- Timestamps: `admission_date_time`, `discharge_date_time`, `created_on`, `modified_time`. Also `status` (Final 99.8%, Draft 2 rows), `discharge_type` (Normal ~93%, DAMA, LAMA, Expired, Referral), `admitting_doctor_team`, `treating_doctor_team`, `*_speciality`.
- No diagnosis, procedure or summary body.
- Weekly rows by discharge time: 27Jul 27, 3Aug 122, 10Aug 100, 17Aug 128, 24Aug 123, 31Aug 105, 7Sep 112, 14Sep 108, 21Sep 41. Fill of all metadata fields is 100%.
- Coverage: 852 of 882 ip_admissions (97%) but only 29 of 551 er_admissions.
- Lag: `created_on` is a median 16.4 h BEFORE `discharge_date_time` (P90 2.3 h before). `discharge_summary_final_date_time` (in the discharged table) is a median 3.1 h before the discharge timestamp (P90 0.3 h before). So the summary is written before the patient leaves.

### kx_patient_discharge_tat_reports (db13)
- Keys: `admission_no`, `uhid`. Timing checkpoints (initiate_discharge, nursing clearance, bed vacant, bill ready).
- More than one row per admission (n rows > distinct `admission_no`, e.g. 310 rows for 162 admissions in the 3Aug week). It is a status timeline, not a fact table.
- In the window `discharge_time`, `bill_ready_time` and `discharge_summary_final_date_time` are 0% filled and only `initiate_discharge_date_time` is filled. Not useful for the chain; use `kx_discharged_completed_patients`.

### kx_billing_records (db13), the procedure source
- Keys: `visit_id_admission_id` (= encounter_id, 859 of 859 distinct billing visits matched admissions on encounter_id, identifier and uhid), `uhid`, `service_item_code`, `service_item_name`, `billing_service_codes`, `standard_codes`.
- Doctors: `perform_by(_code)`, `order_by(_department/_speciality)`, `treating_doctor_code`, `treating_doctor_team`, `admitting_doctor_code`.
- Timestamps: `order_date_time`, `bill_date_time`, `admission_date_time`, `discharge_date_time`.
- Window lines by patient_type and service_type (bill date): IP Procedure 2,703 lines/559 visits; IP Surgery 1,221/279; IP IP Package 385/335; IP Radiology 559/294; IP Cardiology 450/281; ER Procedure 432/252; IP Pharmacy 50,109/833 (ignore). OP billing here is tiny (336 OP Consultation lines in 8 weeks) and is not the OPD source.
- Weekly lines for IP+ER Surgery/Procedure/IP Package/Cardiology by order week: 27Jul 176, 3Aug 690, 10Aug 647, 17Aug 810, 24Aug 763, 31Aug 580, 7Sep 678, 14Sep 564, 21Sep 170. Every listed field, including code, name, performer, orderer, standard code and order time, is 100% filled.
- `Surgery` lines mix OT overhead (Operation Theatre Charges, Anaesthetist Charges, Assistant Surgeon Fee, OT charges) with named procedures (e.g. LAPAROSCOPIC URETEROLYSIS, LAPAROSCOPIC SALPINGECTOMY, PERITONECTOMY, DIAGNOSTIC HYSTEROSCOPY).
- `IP Package` lines are named packages (LSCS, Haemorrhoidectomy, Circumcision day care, Varicose veins laser/RFA, Lap cholecystectomy, Coronary angiogram, Normal delivery).
- Of 882 ip_admissions in the window: 323 have an IP Package line, 256 have any Surgery line (206 with a named, non-overhead procedure), and 506 have either a package or a named surgery. That is 57% of IP admissions, and includes deliveries and day-care.
- CT angiography and angioplasty name hits: 23 IP Package lines (20 visits), 7 IP Radiology (5 visits), 6 IP Surgery (4 visits).
- `Procedure` lines are bedside nursing charges (GRBS, IV cannulation, nebulisation, dressing, catheterisation). Do not use them as surgery evidence.
- `Cardiology` lines are ECG, 2D echo, TMT, Holter. Not interventions.

### ipd_claims_v1 / ipd_claims_v2 / ipd_claims / medical_ipd_claims (db13), insurer claims cross-check
- `ipd_claims_v1`: `procedure_name`, `diagnosis`, `diagnosis_primary_icd_code`, `treatment_type`, `treatmentundertaken`, `admission_date`, `discharge_date`, `uhidno`, `membership_id`. In the window it has only 85 rows, all created in one 17 Aug import: 3Aug 33, 10Aug 34, 17Aug 6, 24Aug 1, 31Aug 2, 7Sep 1, plus 8 in the 27Jul week. Procedure and diagnosis are ~100% filled. This is insured members only, so it is a spot cross-check and not scale.
- `ipd_claims` and `ipd_claims_v2`: 0 rows in the window (legacy).
- `medical_ipd_claims`: 25 to 129 rows per week (838 in total), with `discharge_date` filled but diagnosis, ICD and treatment_type are ~0% filled. No use for procedure.

### rh_ehbr_ipd_detail and rh_ehbr_ipd_detail_pre20260731 (db16)
- Fields: `procedure`, `final_diagnosis`, `admitting_consultant`, `speciality`, `discharge_by_doctor`, `admission_no`, `uhid`, `admission_date`, `discharge_date` (text), charges.
- Fill: `procedure` and `final_diagnosis` are 100% filled where rows exist.
- Coverage: admission dates run from 2025-12-09 to 2026-06-18; 1,450 rows loaded once on 4 Aug 2026. **0 rows in the window.** Historic backfill only (May 223, Jun 136 rows).

## Lags measured
| from | to | median | P90 |
|---|---|---|---|
| admission | first Surgery line order (n=256 visits) | 2.0 h | 25 h |
| admission | first named (non-overhead) Surgery line | 2.9 h | not measured |
| admission | first Surgery or IP Package line (n=551) | 0 h | 32 h |
| Surgery line order | bill posted | 61 h | not measured |
| Surgery line order | discharge | 58 h | not measured |
| summary finalised | discharge time | -3.1 h | -0.3 h |
| summary created_on | discharge time | -16.4 h | -2.3 h |

Negative = before the discharge timestamp.

## Related tables noticed, not scouted (other rows own them)
- mb-ot: `surgery_cases` (115 fields, plus `surgery_cases-case_history`, `surgery_cases__ot__confirmation_pdfs`), `surgeries`, `surgery_packages`, `mv_surgery_conversion`, `medical_procedures` (procedure master: `service_code`, `name`, `department`), and in db16 `rh_surgery_leads`, `rh_surgery_leads_meta`, `rh_surgery_lead_payment`, `rh_surgery_fu_alerted`.
- mb-rx: `prescription_surgery_recommendation`, `account_client_data__prescribed_services__*`.
- Readmission tables (`readmission_*`) hold discharge summary FILES for insured claims, not text fields. Not scouted.

## Open questions for Fable and linker
- Where is the actual discharge summary body (diagnosis, procedure) for the window? Not in any kx_* table found here; only in file/PDF form or elsewhere.
- Is there a mapping between the HIS doctor id (uuid-style) and the OPD doctor id and billing performer codes?
- OP visits in `kx_billing_records` are very sparse, so OPD check-in and consult times must come from the linker's OPD scout.
