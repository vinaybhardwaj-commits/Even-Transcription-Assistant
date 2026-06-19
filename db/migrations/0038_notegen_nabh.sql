-- =====================================================================
-- Migration 0038 — NoteGen NABH floor (reference data for live coverage).
-- Folded verbatim from MedNoteGen db/seed/nabh_requirements_seed.sql
-- (NABH 6th ed, 2025). 70 fields: OT 35 / discharge 21 / OPD Rx 14.
-- note_type here is MedNoteGen's own taxonomy (ot_note/discharge_summary/
-- opd_rx); the coverage layer maps EvenScribe note_types onto these in P1.
-- =====================================================================

-- ============================================================================
-- MedNoteGen — nabh_requirements seed
-- NABH 6th edition (January 2025).  EHRC accreditation edition: 6th.
-- ----------------------------------------------------------------------------
-- This is the deterministic NABH "field floor" injected into every AI-generated
-- question schema. The model may ADD procedure-specific clinical fields; it can
-- never DROP a mandatory field below. A note cannot be finalized until every
-- mandatory field is answered, or (where allow_na = true) explicitly marked
-- N/A with a reason.
--
-- Clause references are NABH 6th ed. Confirmed sub-clauses: COP.14.e (operative
-- note), COP.13.f (OT->ICU transfer), AAC.14 / AAC.14.f (discharge summary),
-- MOM.4 / MOM.4.b (prescription), MOM.1.a (Medication Safety Officer — n/a here).
-- Where a sub-clause letter was not independently confirmed, the chapter+standard
-- is cited (e.g. "AAC.14") and should be refined against the printed 6th-ed text.
-- ============================================================================

-- ---------- DDL ----------
CREATE TABLE IF NOT EXISTS nabh_requirements (
    id            TEXT PRIMARY KEY,
    note_type     TEXT NOT NULL CHECK (note_type IN ('ot_note','discharge_summary','opd_rx')),
    section       TEXT NOT NULL,
    sort_order    INTEGER NOT NULL,
    field_key     TEXT NOT NULL,
    label         TEXT NOT NULL,
    input_type    TEXT NOT NULL,          -- text | textarea | number | select | multiselect | toggle | date | time | datetime | drug_list | signature
    options       JSONB,                  -- for select/multiselect
    unit          TEXT,
    mandatory     BOOLEAN NOT NULL DEFAULT TRUE,
    allow_na      BOOLEAN NOT NULL DEFAULT FALSE,  -- may be marked "N/A with reason"
    default_value TEXT,                   -- smart default the doctor confirms/overrides
    conditional_on TEXT,                  -- e.g. 'implant_used=true' ; null = always shown
    standard_ref  TEXT NOT NULL,          -- NABH 6th-ed clause
    help_text     TEXT,
    UNIQUE (note_type, field_key)
);

-- ============================================================================
-- 1) OT / OPERATIVE NOTE  — Care of Patients (COP.13 perioperative, COP.14 procedures/operative note)
-- ============================================================================
INSERT INTO nabh_requirements
(id, note_type, section, sort_order, field_key, label, input_type, options, unit, mandatory, allow_na, default_value, conditional_on, standard_ref, help_text) VALUES
-- Identifiers
('ot_patient_name','ot_note','identifiers',10,'patient_name','Patient name','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e','Every record entry carries name, date, time, signature.'),
('ot_uhid','ot_note','identifiers',20,'uhid','UHID','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e',NULL),
('ot_age_sex','ot_note','identifiers',30,'age_sex','Age / Sex','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e',NULL),
('ot_ip_no','ot_note','identifiers',40,'ip_no','IP number','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e',NULL),
('ot_date_surgery','ot_note','identifiers',50,'date_of_surgery','Date of surgery','date',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e',NULL),
('ot_time_start','ot_note','identifiers',60,'time_start','Start time','time',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e',NULL),
('ot_time_end','ot_note','identifiers',70,'time_end','End time','time',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e',NULL),
-- Surgical team
('ot_surgeon','ot_note','team',80,'primary_surgeon','Primary surgeon','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e','The person who performed the procedure.'),
('ot_assistant','ot_note','team',90,'assistant_surgeon','Assistant surgeon','text',NULL,NULL,FALSE,TRUE,NULL,NULL,'COP.14.e',NULL),
('ot_anaesthetist','ot_note','team',100,'anaesthetist','Anaesthetist','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.13','Anaesthesia administered by qualified personnel; recorded.'),
-- Diagnosis & procedure
('ot_preop_dx','ot_note','diagnosis',110,'preop_diagnosis','Pre-operative diagnosis','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.13',NULL),
('ot_procedure','ot_note','procedure',120,'procedure_performed','Procedure performed','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e','Name of the procedure.'),
-- Anaesthesia & prophylaxis
('ot_anaes_type','ot_note','anaesthesia',130,'anaesthesia_type','Type of anaesthesia','select','["General","Spinal","Epidural","Combined spinal-epidural","Regional block","Local","MAC/Sedation"]',NULL,TRUE,FALSE,NULL,NULL,'COP.13',NULL),
('ot_abx','ot_note','anaesthesia',140,'antibiotic_prophylaxis','Antibiotic prophylaxis','text',NULL,NULL,TRUE,TRUE,NULL,NULL,'COP.13','Surgical antibiotic prophylaxis (drug/dose/timing) or N/A.'),
-- Consent
('ot_consent','ot_note','consent',150,'consent_ref','Informed consent obtained (reference)','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.13','Valid informed consent before the procedure.'),
-- WHO Surgical Safety Checklist
('ot_ssc_signin','ot_note','safety_checklist',160,'ssc_signin','Surgical Safety Checklist — Sign-in done','toggle',NULL,NULL,TRUE,FALSE,'true',NULL,'COP.13','WHO checklist before induction.'),
('ot_ssc_timeout','ot_note','safety_checklist',170,'ssc_timeout','Surgical Safety Checklist — Time-out done','toggle',NULL,NULL,TRUE,FALSE,'true',NULL,'COP.13','WHO checklist before incision.'),
('ot_ssc_signout','ot_note','safety_checklist',180,'ssc_signout','Surgical Safety Checklist — Sign-out done','toggle',NULL,NULL,TRUE,FALSE,'true',NULL,'COP.13','WHO checklist before patient leaves OT.'),
-- Operative detail
('ot_findings','ot_note','operative',190,'operative_findings','Operative findings','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e','Key findings.'),
('ot_steps','ot_note','operative',200,'operative_steps','Salient steps of the procedure','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e','Salient steps of the procedure.'),
-- Implant / device traceability
('ot_implant_used','ot_note','implant',210,'implant_used','Implant / prosthesis / mesh used?','toggle',NULL,NULL,TRUE,FALSE,'false',NULL,'COP.14','Implant traceability required if used.'),
('ot_implant_detail','ot_note','implant',220,'implant_detail','Implant details (type/size/make)','text',NULL,NULL,TRUE,FALSE,NULL,'implant_used=true','COP.14',NULL),
('ot_implant_lot','ot_note','implant',230,'implant_lot','Implant lot / batch number','text',NULL,NULL,TRUE,FALSE,NULL,'implant_used=true','COP.14','Affix sticker to record where available.'),
-- Specimen / HPE
('ot_specimen_sent','ot_note','specimen',240,'specimen_sent','Specimen sent for histopathology (HPE)?','toggle',NULL,NULL,TRUE,FALSE,'false',NULL,'COP.14','Record HPE sent or not.'),
('ot_specimen_detail','ot_note','specimen',250,'specimen_detail','Specimen details','text',NULL,NULL,TRUE,FALSE,NULL,'specimen_sent=true','COP.14',NULL),
-- Blood loss
('ot_blood_loss','ot_note','blood_loss',260,'blood_loss_ml','Estimated blood loss','number',NULL,'mL',TRUE,FALSE,NULL,NULL,'COP.13',NULL),
('ot_blood_products','ot_note','blood_loss',270,'blood_products','Blood products transfused','text',NULL,NULL,TRUE,TRUE,'Nil',NULL,'COP.13','Nil, or product + units.'),
-- Counts
('ot_counts','ot_note','counts',280,'counts_correct','Sponge / instrument / needle counts correct','toggle',NULL,NULL,TRUE,FALSE,'true',NULL,'COP.13','Confirmed at sign-out.'),
-- Complications
('ot_complications','ot_note','complications',290,'complications','Intra/post-op complications','textarea',NULL,NULL,TRUE,FALSE,'Nil',NULL,'COP.14.e','Record complications or explicit "Nil".'),
('ot_conversion','ot_note','complications',300,'conversion_to_open','Conversion to open procedure','toggle',NULL,NULL,TRUE,FALSE,'false',NULL,'COP.14.e',NULL),
-- Post-op care
('ot_postop_plan','ot_note','postop',310,'postop_plan','Post-operative plan of care','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e','Post-procedure care.'),
('ot_postop_advice','ot_note','postop',320,'postop_advice','Post-operative advice','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e',NULL),
('ot_urgent_care','ot_note','postop',330,'urgent_care_instructions','When/how to seek urgent care','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e',NULL),
-- Sign-off
('ot_signature','ot_note','signoff',340,'surgeon_signature','Surgeon name & signature','signature',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e','Name, date, time, signature.'),
('ot_signed_dt','ot_note','signoff',350,'signed_datetime','Date & time of signature','datetime',NULL,NULL,TRUE,FALSE,NULL,NULL,'COP.14.e',NULL);

-- ============================================================================
-- 2) DISCHARGE SUMMARY — Access, Assessment & Continuity of Care (AAC.14)
--    Six mandatory content groups (AAC.14.a–f).
-- ============================================================================
INSERT INTO nabh_requirements
(id, note_type, section, sort_order, field_key, label, input_type, options, unit, mandatory, allow_na, default_value, conditional_on, standard_ref, help_text) VALUES
-- Group 1: identifiers
('ds_patient_name','discharge_summary','identifiers',10,'patient_name','Patient name','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_uhid','discharge_summary','identifiers',20,'uhid','UHID','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_treating_doctor','discharge_summary','identifiers',30,'treating_doctor','Treating doctor','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_date_adm','discharge_summary','identifiers',40,'date_admission','Date of admission','date',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_date_dis','discharge_summary','identifiers',50,'date_discharge','Date of discharge','date',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
-- Group 2: reason / findings / diagnosis / condition at discharge
('ds_reason','discharge_summary','clinical',60,'reason_admission','Reason for admission','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_findings','discharge_summary','clinical',70,'significant_findings','Significant findings','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_diagnosis','discharge_summary','clinical',80,'diagnosis','Diagnosis','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_condition','discharge_summary','clinical',90,'condition_at_discharge','Condition at discharge','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
-- Group 3: investigations / procedures / meds administered / treatment
('ds_investigations','discharge_summary','course',100,'investigations','Investigation results','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_procedures','discharge_summary','course',110,'procedures_performed','Procedures performed','textarea',NULL,NULL,TRUE,TRUE,'Nil',NULL,'AAC.14',NULL),
('ds_meds_admin','discharge_summary','course',120,'medications_administered','Medications administered','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_treatment','discharge_summary','course',130,'treatment_given','Other treatment given','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
-- Group 4: follow-up advice / discharge meds / instructions (understandable)
('ds_followup','discharge_summary','followup',140,'followup_advice','Follow-up advice','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14','In language the patient understands.'),
('ds_dis_meds','discharge_summary','followup',150,'discharge_medication','Discharge medication','drug_list',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_instructions','discharge_summary','followup',160,'patient_instructions','Patient instructions','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14','Understandable manner.'),
-- Group 5: urgent care
('ds_urgent','discharge_summary','followup',170,'urgent_care_instructions','When & how to obtain urgent care','textarea',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
-- Group 6: outcome / cause of death
('ds_outcome','discharge_summary','outcome',180,'outcome','Discharge outcome','select','["Discharged","Discharged against medical advice (LAMA)","Referred/Transferred","Death"]',NULL,TRUE,FALSE,'Discharged',NULL,'AAC.14','Summary given for all, including LAMA.'),
('ds_cod','discharge_summary','outcome',190,'cause_of_death','Cause of death','textarea',NULL,NULL,TRUE,FALSE,NULL,'outcome=Death','AAC.14','Include in case of death.'),
-- Sign-off
('ds_signature','discharge_summary','signoff',200,'doctor_signature','Doctor name & signature','signature',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL),
('ds_signed_dt','discharge_summary','signoff',210,'signed_datetime','Date & time of signature','datetime',NULL,NULL,TRUE,FALSE,NULL,NULL,'AAC.14',NULL);

-- ============================================================================
-- 3) OPD PRESCRIPTION — Management of Medication (MOM.4 / MOM.4.b)
-- ============================================================================
INSERT INTO nabh_requirements
(id, note_type, section, sort_order, field_key, label, input_type, options, unit, mandatory, allow_na, default_value, conditional_on, standard_ref, help_text) VALUES
('rx_patient_name','opd_rx','identifiers',10,'patient_name','Patient name','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'MOM.4',NULL),
('rx_uhid','opd_rx','identifiers',20,'uhid','UHID','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'MOM.4',NULL),
('rx_age_sex','opd_rx','identifiers',30,'age_sex','Age / Sex','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'MOM.4','Age needed for safe dosing.'),
('rx_weight','opd_rx','identifiers',40,'weight_kg','Weight','number',NULL,'kg',FALSE,TRUE,NULL,NULL,'MOM.4','Required for paediatric / weight-based dosing.'),
('rx_date','opd_rx','identifiers',50,'date','Date','date',NULL,NULL,TRUE,FALSE,NULL,NULL,'MOM.4','Clear, dated.'),
('rx_time','opd_rx','identifiers',60,'time','Time','time',NULL,NULL,TRUE,FALSE,NULL,NULL,'MOM.4','Timed.'),
('rx_allergies','opd_rx','safety',70,'known_allergies','Known allergies','text',NULL,NULL,TRUE,FALSE,'Nil known',NULL,'MOM.4','Allergy status documented before prescribing.'),
('rx_diagnosis','opd_rx','clinical',80,'diagnosis','Clinical diagnosis / indication','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'MOM.4',NULL),
-- Drug list: each item must carry name, route, dose, frequency, duration (MOM.4.b)
('rx_drugs','opd_rx','medication',90,'drugs','Medications','drug_list','{"item_fields":["drug_name","route","dose","frequency","duration"]}',NULL,TRUE,FALSE,NULL,NULL,'MOM.4.b','Each drug: name, route, dose, frequency, duration. CAPITALS; no error-prone abbreviations.'),
('rx_investigations','opd_rx','advice',100,'investigations_advised','Investigations advised','textarea',NULL,NULL,FALSE,TRUE,NULL,NULL,'MOM.4',NULL),
('rx_followup','opd_rx','advice',110,'followup','Follow-up advice','text',NULL,NULL,FALSE,TRUE,NULL,NULL,'MOM.4',NULL),
('rx_prescriber','opd_rx','signoff',120,'prescriber_name','Prescriber name','text',NULL,NULL,TRUE,FALSE,NULL,NULL,'MOM.4','Named.'),
('rx_reg_no','opd_rx','signoff',130,'prescriber_reg_no','Prescriber registration no.','text',NULL,NULL,FALSE,TRUE,NULL,NULL,'MOM.4',NULL),
('rx_signature','opd_rx','signoff',140,'prescriber_signature','Prescriber signature','signature',NULL,NULL,TRUE,FALSE,NULL,NULL,'MOM.4','Signed.');

-- ============================================================================
-- End of seed.  Counts: OT 35 fields · Discharge 21 fields · OPD Rx 14 fields.
-- ============================================================================

INSERT INTO schema_migrations (version, name)
VALUES (38, '0038_notegen_nabh')
ON CONFLICT DO NOTHING;
