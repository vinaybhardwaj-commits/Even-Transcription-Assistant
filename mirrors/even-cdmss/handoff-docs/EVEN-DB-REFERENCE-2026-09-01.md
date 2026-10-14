# Even data layer reference (2026-09-01)

**Type:** evidence document. The IPD Episode Audit PRD cites this file.
**Scope:** Metabase database 13 (KX hospital mirror plus Even-native chart tables), and the CDMSS audit database (Neon, reached through the CDMSS Lab connector `audit_query`).
**Status of facts:** every number below is MEASURED by a live query on 2026-09-01, except where the text says SAMPLED or ASSUMED.

---

## 0. Read this first: two traps

### 0.1 The Metabase connector serves stale cached results

On 2026-09-01 the first `SELECT COUNT(*)` against `kx_clinical_template_progress_reports` returned **148 rows / 59 patients**, with a maximum `fetched_at` of 2026-07-28. A later identical query returned **1,434 rows / 461 patients**, with a maximum `fetched_at` of 2026-09-01. The table did not change between the two reads.

Metabase caches query results. Always run a count twice, or add a changing predicate, before you trust it.

Any analysis in earlier notes that used the 148-row figure is void. This includes the first authorship breakdown of progress notes.

### 0.2 `_create_time` is not clinical time

In every `kx_clinical_template_*` table, `_create_time` and `_update_time` record when the mirror wrote the row. They are not when the clinician wrote the note. Five notes for encounter IP-1281 share a `_create_time` range of three seconds.

Use these instead:

- `progressnote_date_time` inside `component_json`
- `g_creation_time` and `g_modify_time` (epoch milliseconds, top level)

A timeline built on `_create_time` is wrong and looks correct.

---

## 1. Database 13: KX hospital mirror

Firestore-to-Postgres mirror. Every `kx_*` table carries the same sync columns: `_id`, `_path`, `_doc_id`, `_create_time`, `_update_time`, `_collection_name`, `_parent_path`, `_parent_id`, `_parent_doc_id`, `_backfill_version`, plus `x_trace_id` and `x_trace_metadata`.

The mirror accumulates. It does not roll off. Progress notes cover 37 unbroken days from 2026-07-27 to 2026-09-01. Deleted documents move to companion `tombstone:*` tables, so the mirror is not destructive.

### 1.1 Progress notes

`kx_clinical_template_progress_reports` — 46 columns.

| Measure | Value |
|---|---|
| Rows | 1,434 |
| Distinct `_doc_id` | 1,434 (no duplicates) |
| Distinct `uhid` | 461 |
| Distinct `patient_id` | 461 (1:1 with `uhid`) |
| Distinct `encounter_id` | 480 |
| Null or empty `uhid` | 0 |
| `fetched_at` range | 2026-07-27 13:07 to 2026-09-01 05:19 IST |
| Days covered | 37, continuous |

Volume grew from about 30 notes per day in late July to about 50 per day in late August.

Facility split:

| `facility_id` | Notes | Patients | Encounters | Notes per encounter | Distinct authors |
|---|---|---|---|---|---|
| `61eb8030-2daa-11f1-ac4d-6e52f174b1a4-58` | 750 | 292 | 299 | 2.51 | 29 |
| `9bdefff0-fd87-11ef-a182-9a1957157d81-30` | 684 | 170 | 181 | 3.78 | 28 |

Top-level columns beyond the sync set: `uid`, `facility_id`, `patient_id`, `encounter_id`, `uhid`, `template_id`, `template_name`, `template_version`, `status`, `patient_name`, `patient_age`, `patient_gender`, `admitting_doctor`, `admitting_doctor_id`, `current_treating_doctor`, `current_treating_doctor_id`, `ordering_doctor_name`, `ordering_doctor_id`, `finalized_by_username`, `ward`, `bed_no`, `title`, `template_type`, `g_creation_time`, `g_modify_time`, `component_json`, `template_json`, `raw_record`, `fetched_at`.

`SELECT *` on this table returns more than 600,000 characters for 50 rows. `component_json`, `template_json`, and `raw_record` hold the bulk. Always select named columns.

### 1.2 Structure of `component_json`

A JSON array of `{"name": ..., "valueString": ...}` objects, stored as `text`. Cast to `jsonb` and use `jsonb_array_elements` to read it.

Clinical narrative sits in fields named `T-3`, `T-35`, and `T-2`. These are opaque template field identifiers. To resolve them to human labels you must read `template_json`.

`template_version` is null on 145 of the 148 rows in the earlier sample and 1 on the other 3. Version pinning is therefore unreliable.

Four fields are present on every row and empty on every row: `esfewqf`, `Inver43`, `fycjtkuvyj`, `liubf`. These are test artifacts left in a live clinical template.

`title`, `templateId`, `templateType`, and `templateName` appeared on only 64 of 148 sampled rows. The two facilities run drifted template schemas.

Other fields: `speciality`, `speciality_code`, `speciality_id`, `visit_type`, `visit_type_id`, `priority`, `priority_code`, `serviceType`, `service_type_code`, `department_id`, `department_name`, `subDepartment_id`, `subDepartment_name`, `doctor`, `doctor_id`, `role`, `specialisation`, `module`, `progressnote_date_time`, `patient_remarks`, `tag_data`, `care_type`, `observationId`, `patientType`, `isDischarge`.

SAMPLED (148 rows, needs re-running on 1,434): `patient_remarks` non-empty on 33 percent of rows. `tag_data` non-empty on 58 percent.

### 1.3 Authorship: who actually writes the note

SAMPLED on the stale 148-row set. The pattern is strong but the counts need a re-run.

`finalized_by_username` is the only field that names the person who wrote and signed the note. Every other person field carries the treating consultant: `doctor` and `doctor_id` inside `component_json`, plus top-level `current_treating_doctor`, `current_treating_doctor_id`, `ordering_doctor_name`, `ordering_doctor_id`, and `admitting_doctor`.

Role split in the sample: RMO 120, Doctor 27, Dietician 1.

On all 120 RMO rows, `finalized_by_username` differed from `current_treating_doctor`. On Doctor-role rows it usually matched. The field behaves consistently.

Three cautions:

1. `finalized_by_username` is a display-name string. No identifier column exists for the author. Joins on it are free-text joins.
2. Name hygiene is already broken. One row reads `Dr Dietician` where the real author is a named dietician. Spelling drifts, for example `Dr. Testperson Alpha` against the unpunctuated house style.
3. Role is a property of the note, not of the person. Dr Testperson Beta appears as both `Doctor` and `RMO`. Derive role per note.

No counter-signature field exists. "Finalized" means the author finalized it. The record holds no evidence of consultant review.

### 1.4 Order stream: `kx_billing_records`

This is the most useful table in the mirror for audit work. It is a timestamped order stream, not only a bill.

| Measure | Value |
|---|---|
| Columns | 144 |
| Rows | 254,501 |
| Encounters joined on `visit_id_admission_id = encounter_id` | 458 of 480 (95%) |
| Encounters joined on `uhid` | 469 of 480 |
| Encounters with `item_type = 'Drug'` | 415 of 480 (86%) |
| Rows with non-null `order_date_time` | 100% |
| Rows with populated `order_by` | about 92% |

Order columns: `order_no`, `order_date_time`, `order_by`, `order_by_department`, `order_by_speciality`, `order_by_sub_department`, `ordered_item_code`, `ordered_item_name`, `ordered_qty`, `quantity`, `service_request_id`, `service_priority`, `service_type`, `service_item_code`, `service_item_name`, `item_type`, `item_category`, `item_sub_category`, `billing_service_codes`, `chargeable_service`, `bill_no`, `bill_date_time`, `admission_date_time`, `discharge_date_time`.

`item_type` values seen: Drug, Consumable, Surgical, General, Consignment, Implant, FMCG.

`item_category` values seen on drug rows: GASTROINTESTINAL, ANTIBIOTICS, PROTON PUMP INHIBITOR, ANALGESIC/ANTIPYRETIC, ANESTHETIC AGENTS, RESPIRATORY AGENT, LOCAL ANESTHETIC, NUTRITION, ANALGESICS, CARDIOVASCULAR AGENTS, ANALGESIC / ANTI-INFLAMMATORY, ANTI-INFECTIVE, HORMONAL AGENTS, GENERAL ANESTHETIC, TOPICAL ANTIBIOTIC, ANTIHISTAMINES, NEUROLOGY, LAXATIVE, NUTRITIONAL SUPPLEMENT, ANTIBIOTIC, ANTIHYPERTENSIVE, SUPPLEMENT, ELECTROLYTE SUPPLEMENT, ANALGESIC/OPIOID, ANTIDIABETIC, DIURETIC, TOPICAL, STEROIDS, SEDATIVE.

**Known defect: 61,333 rows with `item_type = 'Drug'` have a blank `item_category`.** Only 59 encounters look antibiotic-flagged for this reason, which understates reality. Repair the category by joining `ordered_item_code` to `kx_medicine_items.item_code`.

Two limits to state in any output built on this table:

1. Billing records the order time and the charge. It does not record administration. You cannot say a drug was given, or when.
2. Two category names exist for the same idea, for example ANTIBIOTIC and ANTIBIOTICS. Normalize before you group.

### 1.5 Medicine master: `kx_medicine_items`

2,866 rows, 43 columns. Use it to repair the blank categories above.

Useful columns: `item_code`, `item_name`, `item_display_name`, `item_category`, `item_sub_category`, `item_type`, `formulary_item`, `even_medicine_uid`, `item_flags`, `avg_consumption_item`, `upload_item_code`.

`even_medicine_uid` is the bridge to Even-side medicine identity.

### 1.6 Labs: `kx_lab_reports`

49 columns, 33,153 rows.

Join on `visit_id = encounter_id` gives 442 of 480 encounters (92%). The `uhid` join gives 451 but is less precise.

**This table holds no result values.** It is order and report metadata only.

Columns: `uhid`, `visit_id`, `order_no`, `accession_no`, `ref_order_no`, `service_name`, `service_date`, `booking_date_time`, `sample_collection_date_time`, `sample_acknowledge_date_time`, `report_date`, `treating_ordering_doctor`, `verifying_doctor`, `verified_by`, `lab_name`, `collection_mode`, `collection_center`, `refer_by`, `refer_type`, `description`, `icd_diagnosis`, `icd_o_diagnosis`, `standard_codes`, `priority`, `patient_type`, `sub_department`, `ward`, `bed_no`, `tray_code`, `tag`, `hospital_uid`, `modified_by`.

You can audit what was ordered, when the sample was collected, and turnaround to report. You cannot audit whether an abnormal value was acted on.

### 1.7 Coverage of the rest of the inpatient chain

Measured against the 480 encounters that have progress notes.

| Table | Columns | Rows | Coverage | Join key |
|---|---|---|---|---|
| `kx_ip_admissions` | 106 | 1,337 | **480 (100%)** | `encounter_id` |
| `kx_discharge_summary_records` | 35 | 2,439 | 472 (98%) | `uhid` only |
| `kx_billing_records` | 144 | 254,501 | 458 (95%) | `visit_id_admission_id` |
| `kx_discharged_completed_patients` | 96 | — | 459 (96%) | `encounter_id` |
| `kx_lab_reports` | 49 | 33,153 | 442 (92%) | `visit_id` |
| `kx_clinical_template_shift_handovers` | 50 | 1,434 | 354 (74%) | `encounter_id` |
| `kx_clinical_template_ot_notes` | 49 | 904 | 200 (42%) | `encounter_id` |
| `kx_ip_transfers` | 50 | — | 148 (31%) | `encounter_id` |
| `kx_appointment_records` | 61 | — | 134 (28%) | `uhid` |
| `kx_clinical_template_initial_assessment_adults` | 139 | 168 | 119 (25%) | `encounter_id` |
| `kx_clinical_template_pac_reports` | 47 | — | 37 (8%) | `encounter_id` |
| `kx_radiology_reports` | 44 | — | 24 by `uhid`, 1 by `visit_id` | `uhid` |
| `kx_prescription_records` | 86 | — | 9 (2%) | `uhid` |

Two structural problems in that table:

1. **`kx_discharge_summary_records` carries `uhid` but no `encounter_id`.** About 19 patients in the window have more than one admission. A naive `uhid` join attaches the wrong summary to them. Disambiguate against `kx_ip_admissions` admission and discharge timestamps.
2. **Radiology is effectively absent.** `chart_radiology_report` also has zero rows. Treat radiology as unavailable.

### 1.8 Shift handovers

`kx_clinical_template_shift_handovers` — 1,434 rows across 354 encounters.

`component_json` fields and their non-empty counts:

| Field | Non-empty | Of |
|---|---|---|
| `nursing_handover` | 1,384 | 1,434 (97%) |
| `nursing_receiving` | 1,362 | 1,434 (95%) |
| `nhc05`, `TF-2158` | 1,434 | 1,434 |
| `nhc13` | 1,185 | 1,434 |
| `nhc15` | 1,096 | 1,434 |
| `nhc16` | 989 | 1,434 |
| `nhc01` | 974 | 1,434 |
| `tag_data` | 549 | 1,431 |
| `confidential`, `fav_templateId` | 0 | — |

`nursing_handover` and `nursing_receiving` hold real shift-by-shift narrative at high fill rate. The `nhc*` and `TF-*` fields are opaque and need `template_json` to resolve.

### 1.9 Tables that look useful and are not

- `kx_eprescriptions` and its child tables carry `encounter_id`, but overlap with the 480 inpatient encounters is **zero**. Outpatient only.
- `kx_op_pharmacy_billings` and `kx_op_billings` carry `encounter_id`, overlap **zero**. Outpatient only.
- `kx_prescription_records` reaches 9 of 480 encounters. Not usable.

For inpatient medication, use `kx_billing_records`.

---

## 2. Database 13: the Even-native layer

Tables named `chart_*` and `individuals-*`. FHIR-shaped. This is a different clinical system from KX.

| Table | Rows | Patient or encounter keys |
|---|---|---|
| `chart_service_request` | 101,625 | `encounter__identifier` (ARRAY), `individual_uid`, `subject__uid` |
| `individuals-observations` | 155,362 | — |
| `individuals-individual_vitals_records` | 8,330 | — |
| `chart_diagnostic_report` | 6,431 | `encounter_id` (text), `subject` |
| `chart_medication_request` | 5,290 | `encounter` (text), `subject__uid` |
| `chart_care_plan` | 4,365 | `encounter`, `subject__*` |
| `chart_medication` | 0 | — |
| `chart_radiology_report` | 0 | — |

**This layer does not join to the KX inpatient episodes.** Its encounter namespace is `EPD-*` (sample value `EPD-6611`). KX inpatient encounters are `IP-*` and `IPNO-*`. Overlap with the 480 inpatient encounters measured **zero** across `chart_diagnostic_report`, `chart_medication_request`, and `chart_service_request`.

The layer holds what KX lacks: observations with values, vitals, and structured medication requests. Any bridge must run at patient identity level (`uhid` against `subject__uid` or `individual_uid`), not encounter level. That is the MemberState linkage problem and it is out of scope for inpatient episode audit.

Type traps when you query it:

- `chart_service_request.encounter__identifier` is `text[]`. Use `= ANY(...)`.
- `chart_medication_request.subject__identifier` is `text[]`, but `chart_medication_request.encounter` is plain `text`.
- Table names with a hyphen need double quotes, for example `"individuals-observations"`.

---

## 3. CDMSS audit database (Neon)

Reached through the CDMSS Lab connector, tool `audit_query`. Read-only. SELECT and WITH only, single statement, LIMIT 500 maximum, audit-logged.

95 tables in `public`.

PHI-bearing tables are blocked: `traces`, `trace_events`, `appropriateness_runs`, `ccb_briefs`, `care_track_assignments`, `opd_audit_feedback`. Use the de-identified views `v_trace_summary` and `v_appropriateness_summary`, and the `feedback_*` tools.

### 3.1 OPD note audits

`opd_note_audits` — 40 columns. 25,397 notes carry a PDQI-9 block. 25 engine versions from 0.1 to 0.81.14.

Current engine `opd-note-audit/0.81.8`: 7,163 notes, 78 doctors.

| Score | Average |
|---|---|
| `note_quality_index` (composite) | 80.07 |
| `score_prescribing_safety` | 91.94 |
| `completeness_pct` | 91.5 |
| `score_documentation` | 91.47 |
| `score_patient_centred` | 91.12 |
| `score_appropriateness` | 69.53 |
| `score_note_quality` | 62.82 |

The composite discriminates poorly. Documentation, prescribing safety, and patient-centredness all sit near 91 and barely move across engine versions. Signal lives in `score_note_quality` and `score_appropriateness`.

PDQI-9 averages across all 25,397 notes, scale 1 to 5:

| Attribute | Average |
|---|---|
| succinct | 4.38 |
| comprehensible | 4.12 |
| accurate | 3.80 |
| organized | 3.76 |
| internally_consistent | 3.74 |
| up_to_date | 3.27 |
| useful | 2.68 |
| synthesized | 2.54 |
| thorough | 2.48 |

Notes score high on brevity and readability and low on thoroughness, synthesis, and usefulness.

Low-value-care sub-tags added in engine 0.81.8, on the `lvc_category` key of low-value findings: `antibiotic`, `imaging`, `supplement_polypharmacy`, `therapeutic_duplication`, `systemic_steroid`, `gi_ppi_prokinetic`, `antihistamine_allergy`, `nsaid_analgesic`, `cough_cold_fdc`, `cough_expectorant`, `unindicated_investigation`, `other`.

Several `kx_billing_records.item_category` values map onto these tags directly. ANTIBIOTICS maps to `antibiotic`. PROTON PUMP INHIBITOR maps to `gi_ppi_prokinetic`. STEROIDS maps to `systemic_steroid`. ANTIHISTAMINES maps to `antihistamine_allergy`. SUPPLEMENT and NUTRITIONAL SUPPLEMENT map to `supplement_polypharmacy`.

### 3.2 IPD tables

| Table | Columns | Rows |
|---|---|---|
| `ipd_discharge_audits` | 30 | 345 |
| `ipd_gold_adjudication` | 7 | 197 |
| `ipd_gold_union_candidates` | 12 | 195 |
| `ipd_audit_feedback` | 9 | 16 |
| `episode_states` | 8 | 216 |
| `episode_recon_ratings` | 10 | 72 |
| `record_versions` | 7 | 18 |
| `concordance_runs` | 15 | 1 |

`ipd_discharge_audits` columns: `id` (uuid), `audited_at`, `app_source`, `document_id`, `ip_uid`, `member_id`, `speciality`, `discharge_type`, `los_days`, `discharged_at`, `de_identified`, `care_value_index`, `band`, `score_appropriateness`, `score_efficiency`, `score_safety`, `score_cost`, `score_documentation`, `score_patient_centred`, `completeness_pct`, `n_findings`, `n_low_value`, `n_context_dependent`, `findings` (jsonb), `suggestions` (jsonb), `billed_total`, `engine_version`, `model`, `trace_id`, `report` (jsonb).

This engine differs from the OPD engine in three ways that matter:

1. It is episode-scoped. It carries `ip_uid`, `los_days`, `discharged_at`, `discharge_type`.
2. It carries `member_id`. The OPD engine has no member link.
3. It has a third verdict class, `n_context_dependent`. The OPD engine has only findings and low-value.

It has **no author field**. Only `speciality`.

### 3.3 Supporting reference tables

Grounding material for guideline-based reasoning: `kb_topics` (23 columns), `kb_resources`, `kb_chunk_entities`, `kb_unit_centroids`, `mksap_chunks`, `lvc_recommendations` (25 columns), `lvc_recommendation_proposals`, `lvc_concepts`, `lvc_concept_rulings`, `lvc_ratifications`, `formulary` (19 columns), `ddi_reference`, `icd_master`.

Governance and scoring: `scoring_policy_versions`, `scoring_policy_drafts`, `provenance_tier_snapshots`, `audit_suppression`, `opd_gov_signal`, `doctor_directory`, `doctor_roster`, `doctor_operational_metrics`.

### 3.4 Appropriateness runs

`v_appropriateness_summary` holds 47 runs. Modes: `check`, `audit`, `pathway`. `doc_type` values: `discharge_summary`, `opd_rx`, and null. The `pathway` mode already exists and produces findings.

---

## 4. Join recipes

Inpatient episode spine, keyed on `encounter_id`:

```sql
-- episode base
FROM kx_ip_admissions a
LEFT JOIN kx_clinical_template_progress_reports pn ON pn.encounter_id = a.encounter_id
LEFT JOIN kx_clinical_template_shift_handovers sh  ON sh.encounter_id = a.encounter_id
LEFT JOIN kx_clinical_template_ot_notes ot         ON ot.encounter_id = a.encounter_id
LEFT JOIN kx_clinical_template_initial_assessment_adults ia ON ia.encounter_id = a.encounter_id
LEFT JOIN kx_discharged_completed_patients dc      ON dc.encounter_id = a.encounter_id
```

Orders:

```sql
LEFT JOIN kx_billing_records b ON b.visit_id_admission_id = a.encounter_id
LEFT JOIN kx_medicine_items mi ON mi.item_code = b.ordered_item_code
```

Labs:

```sql
LEFT JOIN kx_lab_reports l ON l.visit_id = a.encounter_id
```

Discharge summary needs date disambiguation because it has no encounter key:

```sql
LEFT JOIN LATERAL (
  SELECT d.* FROM kx_discharge_summary_records d
  WHERE d.uhid = a.uhid
  ORDER BY abs(extract(epoch FROM (d._create_time - a.discharge_date_time)))
  LIMIT 1
) ds ON true
```

Reading `component_json`:

```sql
SELECT r.encounter_id,
       MAX(CASE WHEN e->>'name'='progressnote_date_time' THEN e->>'valueString' END) AS note_time,
       MAX(CASE WHEN e->>'name'='role'   THEN e->>'valueString' END) AS author_role,
       MAX(CASE WHEN e->>'name'='T-3'    THEN e->>'valueString' END) AS narrative_1
FROM kx_clinical_template_progress_reports r,
     LATERAL jsonb_array_elements(r.component_json::jsonb) e
GROUP BY r._doc_id, r.encounter_id
```

---

## 5. Open questions

1. Is the initial assessment at 25 percent a mirror gap or a documentation gap? The answer changes what a blinded ideal course can be built from.
2. What do `T-3`, `T-35`, `T-2`, `nhc01`, `nhc05`, `nhc13`, `nhc15`, `nhc16`, and `TF-2158` mean? Resolve from `template_json` and record the mapping here.
3. Why is `template_version` null on almost every progress note?
4. Can `uhid` bridge to `subject__uid` in the Even-native layer, and at what match rate?
5. Do the two facilities run different template versions, and does that explain the schema drift in `component_json`?
