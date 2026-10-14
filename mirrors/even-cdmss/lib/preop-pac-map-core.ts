/**
 * lib/preop-pac-map-core.ts — the ONE KareXpert PAC template's opaque keys, mapped to
 * semantic fields (PRD v1.1-LOCKED §9 dep 1; Build Plan B3).
 *
 * NO database, NO fetch, NO clock, NO model.
 *
 * ── HOW THE KEYS WERE DECODED (not guessed) ──────────────────────────────────────
 * `component_json` is an ORDERED array of { name, valueString }. Most names are opaque
 * ('OKDLKD', 'WWW8S'), but the array interleaves SECTION LABEL entries — keys matching
 * `TF-####` / `TMP-###` whose valueString is literal section text ("Airway", "Endocrine
 * System", "Type of Anesthesia"). A label applies to every field between it and the next
 * label, so ORDER decodes position, and the VALUE DOMAIN over all 95 live reports decodes
 * meaning. Every entry below records which of the three it was established by:
 *   · key_name        — the key is already legible ('Age', 'Others  Specify')
 *   · value_domain    — the set of values over 95 reports identifies the field
 *                       (a field whose only values are MP 1 / MP 2 / MP 3 is Mallampati)
 *   · section_position— the section label plus being the only field of its type in it
 * and a CONFIDENCE. Two high-value fields are marked `provisional`: they are decoded from
 * their value domain alone, the `note` render contains no label to cross-check them
 * against (measured: ZERO of the 95 notes contain the string "ASA" or "Mallampati"), and
 * so neither is wired to an instrument. They are display-only until an anaesthetist
 * confirms them. Nothing provisional can move a score.
 *
 * ── THE D4 BOUNDARY, STRICTLY ────────────────────────────────────────────────────
 * This file performs DETERMINISTIC READS ONLY: numerics, booleans, coded enumerable
 * values, and verbatim text for display. A ticked "MI" checkbox in the cardiovascular
 * review of systems is a coded value and feeds RCRI. The diagnosis free-text line
 * "CHRONIC HEP B, PORTAL THROMBOSIS…" is NOT read for clinical facts — inferring an
 * instrument input from prose is the B5 extraction rail, behind its own flag. Every
 * verbatim field below is carried for display and feeds nothing.
 *
 * ── THE ONE NEGATIVE ASSERTION ───────────────────────────────────────────────────
 * A ticked "WNL" (within normal limits) on a system's review is read as that system's
 * conditions being ABSENT. It is the only rule here that turns a coded value into a
 * negative, and it is what lets a PAC RESOLVE the ranges the booking form opened
 * (Amendment A1-1: HEART_DISEASE opens both cardiac factors). It is not a default:
 * over 95 reports the cardiovascular review is ticked WNL 30 times and left blank 40,
 * so a WNL is a deliberate act. Flagged for V.
 */

import type { Observation, PreopInputId } from './preop-assemble-core';

export const PREOP_PAC_MAP_VERSION = 'preop-pac-map/1';

/** The single template this map is written for. A different name must not be parsed. */
export const PAC_TEMPLATE_NAME = 'Doctor Preoperative Anesthesia evaluation(PAC)';

export type PacReadType = 'verbatim' | 'numeric' | 'boolean' | 'enum' | 'json';
export type PacDecodedBy = 'key_name' | 'value_domain' | 'section_position';
export type PacConfidence = 'certain' | 'provisional';

/** One coded value and the instrument inputs it deterministically implies. */
export interface PacEnumRule {
  /** the value token as the template writes it, trimmed and upper-cased for matching */
  token: string;
  /** what a clinician sees */
  label: string;
  present?: PreopInputId[];
  absent?: PreopInputId[];
}

export interface PacFieldSpec {
  /** the opaque key in component_json */
  key: string;
  /** the semantic id this module uses */
  id: string;
  label: string;
  /** the template section label the key sits under */
  section: string;
  read: PacReadType;
  decodedBy: PacDecodedBy;
  confidence: PacConfidence;
  /** coded values and what they imply. Absent ⇒ the field feeds no instrument. */
  rules?: PacEnumRule[];
  /** a short note for the coverage table and the build report */
  note?: string;
}

const H = '(header)';

/**
 * THE MAP. Ordered as the template renders, so a reader can follow it beside a real PAC.
 * `rules` is present only where a field feeds an instrument; everything else is display.
 */
export const PAC_MAP: PacFieldSpec[] = [
  // ── header ────────────────────────────────────────────────────────────────────
  { key: 'iu87', id: 'pac_diagnosis', label: 'Diagnosis', section: H, read: 'verbatim', decodedBy: 'value_domain', confidence: 'certain',
    note: 'free text — display only; reading conditions out of it is B5 extraction' },
  { key: 'za', id: 'pac_procedure', label: 'Planned procedure', section: H, read: 'verbatim', decodedBy: 'value_domain', confidence: 'certain' },
  { key: 'Age', id: 'pac_age', label: 'Age recorded at PAC', section: H, read: 'numeric', decodedBy: 'key_name', confidence: 'certain',
    note: 'DELIBERATELY not wired to the age input — the episode\'s dob-derived age is the stronger fact and is present on 19/19. Carried to flag a mismatch.' },
  { key: 'yudo', id: 'pac_sex', label: 'Sex recorded at PAC', section: H, read: 'enum', decodedBy: 'value_domain', confidence: 'certain' },
  { key: 'hgf_hg', id: 'pac_header_note', label: 'LMP / date note', section: H, read: 'verbatim', decodedBy: 'section_position', confidence: 'provisional',
    note: 'values are dates and menstrual-history lines; unlabelled in the template' },

  // ── allergies ─────────────────────────────────────────────────────────────────
  { key: 'Allergies222', id: 'pac_allergies', label: 'Allergies', section: 'Allergies', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── vitals ────────────────────────────────────────────────────────────────────
  { key: 'svxn8976', id: 'pac_vitals', label: 'Vital signs', section: 'Vital sign', read: 'json', decodedBy: 'value_domain', confidence: 'certain',
    note: 'nested KareXpert vitals JSON: BP, pulse, SpO2, respiration, temperature, weight, height, BMI — each with units and reference range' },
  { key: 'svxn89976', id: 'pac_vitals_note', label: 'Vitals note', section: 'Vital sign', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'k8976', id: 'pac_vitals_note_2', label: 'Vitals note (second box)', section: 'Vital sign', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── social history ────────────────────────────────────────────────────────────
  { key: 'DD5F8S', id: 'pac_social', label: 'Social history', section: 'Social History', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: 'Smoking / Alcohol — feeds no Slice-1 instrument; STOP-BANG and ARISCAT are S2' },
  { key: 'SC8V5V', id: 'pac_social_note', label: 'Social history note', section: 'Social History', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── review of systems: cardiovascular ─────────────────────────────────────────
  { key: 'SD2DC', id: 'pac_cvs_ros', label: 'Cardiovascular review', section: 'Review of Systems', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: 'the ONE field that can resolve the cardiac ranges a booking HEART_DISEASE opens (A1-1)',
    rules: [
      { token: 'MI', label: 'Myocardial infarction', present: ['ischaemic_heart_disease', 'myocardial_infarction'] },
      { token: 'ANGINA', label: 'Angina', present: ['ischaemic_heart_disease'] },
      { token: 'WNL', label: 'Within normal limits', absent: ['ischaemic_heart_disease', 'congestive_heart_failure', 'myocardial_infarction'] },
    ] },
  { key: 'CDC58VVZ', id: 'pac_cvs_htn', label: 'Hypertension (review)', section: 'Review of Systems', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: 'the DIAGNOSIS of hypertension. mFI-5 scores hypertension REQUIRING MEDICATION, which is the medication-history field below — this one alone does not score it.' },
  { key: 'SD85D', id: 'pac_cvs_note', label: 'Cardiovascular note', section: 'Review of Systems', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'X1C1C2XX', id: 'pac_cvs_flag_a', label: 'Cardiovascular flag A', section: 'Review of Systems', read: 'boolean', decodedBy: 'section_position', confidence: 'provisional',
    note: 'false on all 62 filled reports — meaning undetermined, carried so it is not silently dropped' },
  { key: 'F2C5F2', id: 'pac_cvs_flag_b', label: 'Cardiovascular flag B', section: 'Review of Systems', read: 'boolean', decodedBy: 'section_position', confidence: 'provisional',
    note: 'false on all 62 filled reports — meaning undetermined' },

  // ── gastrointestinal ──────────────────────────────────────────────────────────
  { key: 'D5F4C25', id: 'pac_gi_ros', label: 'Gastrointestinal review', section: 'Gastrointestinal System', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: "the template's normal token here is 'WML', a typo for WNL, present on 30 reports — matched literally",
    rules: [
      { token: 'ULCERS', label: 'Ulcers', present: ['peptic_ulcer_disease'] },
      { token: 'WML', label: 'Within normal limits', absent: ['peptic_ulcer_disease', 'mild_liver_disease'] },
      { token: 'WNL', label: 'Within normal limits', absent: ['peptic_ulcer_disease', 'mild_liver_disease'] },
    ] },
  { key: 'Q8Q8', id: 'pac_gi_findings', label: 'Gastrointestinal findings', section: 'Gastrointestinal System', read: 'enum', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'D52V', id: 'pac_gi_note', label: 'Gastrointestinal note', section: 'Gastrointestinal System', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── pulmonary ─────────────────────────────────────────────────────────────────
  { key: 'D2C5C25', id: 'pac_pulm_ros', label: 'Pulmonary review', section: 'Pulmonary System', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    rules: [
      { token: 'BRONCHIAL ASTHMA', label: 'Bronchial asthma', present: ['copd_or_pneumonia', 'chronic_pulmonary_disease'] },
      { token: 'TUBERCULOSIS', label: 'Tuberculosis', present: ['chronic_pulmonary_disease'] },
      { token: 'PNEUMONIA', label: 'Pneumonia', present: ['copd_or_pneumonia'] },
      { token: 'WNL', label: 'Within normal limits', absent: ['copd_or_pneumonia', 'chronic_pulmonary_disease'] },
    ] },
  { key: 'S258', id: 'pac_pulm_note', label: 'Pulmonary note', section: 'Pulmonary System', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── musculoskeletal ───────────────────────────────────────────────────────────
  { key: 'QW25D', id: 'pac_msk_ros', label: 'Musculoskeletal review', section: 'Muscular and Skeleton System', read: 'enum', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'SD25D', id: 'pac_msk_note', label: 'Musculoskeletal note', section: 'Muscular and Skeleton System', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── renal ─────────────────────────────────────────────────────────────────────
  { key: 'SD', id: 'pac_renal_ros', label: 'Renal review', section: 'Renal System and G.U.Tract', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    rules: [{ token: 'WNL', label: 'Within normal limits', absent: ['moderate_severe_renal_disease'] }] },
  { key: 'DSDMZNX', id: 'pac_renal_findings', label: 'Renal findings', section: 'Renal System and G.U.Tract', read: 'enum', decodedBy: 'section_position', confidence: 'certain',
    note: 'ARF is ACUTE renal failure and is deliberately NOT mapped to Charlson\'s moderate-or-severe CHRONIC renal disease — display only' },
  { key: 'SD987F', id: 'pac_renal_note', label: 'Renal note', section: 'Renal System and G.U.Tract', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── central nervous system ────────────────────────────────────────────────────
  { key: 'DS87F', id: 'pac_cns_ros', label: 'Central nervous system review', section: 'Central Nervous System', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    rules: [{ token: 'WNL', label: 'Within normal limits', absent: ['cerebrovascular_disease'] }] },
  { key: 'MNBLFOH4', id: 'pac_cns_findings', label: 'Central nervous system findings', section: 'Central Nervous System', read: 'enum', decodedBy: 'section_position', confidence: 'certain' },

  // ── endocrine ─────────────────────────────────────────────────────────────────
  { key: 'S8F4S', id: 'pac_endo_ros', label: 'Endocrine review', section: 'Endocrine System', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: 'NIDDM is the field that RESOLVES what the booking form cannot say — non-insulin-dependent diabetes settles RCRI\'s insulin factor as absent (A1-1)',
    rules: [
      { token: 'NIDDM', label: 'Non-insulin-dependent diabetes', present: ['diabetes_mellitus', 'diabetes_uncomplicated'], absent: ['insulin_treated_diabetes'] },
      { token: 'IDDM', label: 'Insulin-dependent diabetes', present: ['diabetes_mellitus', 'diabetes_uncomplicated', 'insulin_treated_diabetes'] },
      { token: 'HYPOTHYROIDISM', label: 'Hypothyroidism', present: [] },
      { token: 'WNL', label: 'Within normal limits', absent: ['diabetes_mellitus', 'diabetes_uncomplicated', 'diabetes_end_organ_damage', 'insulin_treated_diabetes'] },
    ] },
  { key: 'ED85F', id: 'pac_endo_findings', label: 'Endocrine findings', section: 'Endocrine System', read: 'enum', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'SS8F', id: 'pac_endo_note', label: 'Endocrine note', section: 'Endocrine System', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── other history ─────────────────────────────────────────────────────────────
  { key: 'Q9D5V2', id: 'pac_other_history', label: 'Other medical history', section: 'Other Medical History', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain',
    note: 'free text on 63 reports — the richest history source in the template, and entirely B5 territory' },

  // ── medication history ────────────────────────────────────────────────────────
  { key: 'Q6D5F', id: 'pac_meds_cardio', label: 'Cardiovascular medication', section: 'Medication History', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: 'the medication half of mFI-5\'s hypertension item, which A1-1 left to B5 — the PAC settles it deterministically when it is ticked',
    rules: [
      { token: 'ANTI HYPERTENSIVE', label: 'Antihypertensive', present: ['hypertension_on_medication'] },
      { token: 'ANTI PLATELET', label: 'Antiplatelet', present: [] },
    ] },
  { key: 'JHGF', id: 'pac_meds_endo', label: 'Endocrine / anticoagulant medication', section: 'Medication History', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: 'an oral hypoglycaemic confirms diabetes but does NOT settle the insulin question — no insulin token exists in this template\'s 95 reports',
    rules: [
      { token: 'ORAL HYPOGLYCEMIC', label: 'Oral hypoglycaemic', present: ['diabetes_mellitus'] },
      { token: 'ANTI COAGULANT', label: 'Anticoagulant', present: [] },
    ] },
  { key: 'S25C25', id: 'pac_meds_flag', label: 'Medication flag', section: 'Medication History', read: 'boolean', decodedBy: 'section_position', confidence: 'provisional' },
  { key: 'SC85FA', id: 'pac_meds_note', label: 'Medication note', section: 'Medication History', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── previous anaesthetics ─────────────────────────────────────────────────────
  { key: 'VCBX', id: 'pac_prev_anaesthetic', label: 'Previous anaesthetic', section: 'Previous Anesthetics', read: 'enum', decodedBy: 'value_domain', confidence: 'certain' },
  { key: 'q8c5c', id: 'pac_prev_anaesthetic_problem', label: 'Previous anaesthetic problem', section: 'Previous Anesthetics', read: 'boolean', decodedBy: 'section_position', confidence: 'provisional' },
  { key: 'x5s8d', id: 'pac_prev_anaesthetic_note', label: 'Previous anaesthetic note', section: 'Previous Anesthetics', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── examination ───────────────────────────────────────────────────────────────
  { key: 'OKGS', id: 'pac_examination', label: 'Physical examination', section: 'Physicial Examination', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain',
    note: 'where functional status WOULD live if it were captured — it is prose ("Conscious and alert", "not ambulating since 15 days"), so B3 cannot read it and mFI-5\'s functional item stays unknown' },
  { key: 'OKDLKD', id: 'pac_mallampati', label: 'Mallampati class', section: 'Airway', read: 'enum', decodedBy: 'value_domain', confidence: 'provisional',
    note: 'values are MP 1 / MP 2 / MP 3 (+ Teeth). DISPLAY ONLY — feeds no Slice-1 instrument, and the PRD recorded Mallampati as 0/95 because its text scan looked for the word, not the code' },
  { key: 'S4D5D2', id: 'pac_airway_flags', label: 'Airway flags', section: 'Airway', read: 'enum', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'Others  Specify', id: 'pac_airway_note', label: 'Airway note', section: 'Airway', read: 'verbatim', decodedBy: 'key_name', confidence: 'certain' },
  { key: 'poiuyt', id: 'pac_cardiac_exam', label: 'Cardiac examination', section: 'Cardiac', read: 'enum', decodedBy: 'value_domain', confidence: 'certain' },
  { key: 'ad5z', id: 'pac_cardiac_exam_note', label: 'Cardiac examination note', section: 'Cardiac', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'hyftgg', id: 'pac_lung_added_sounds', label: 'Added lung sounds', section: 'Lungs(Added Sounds)', read: 'enum', decodedBy: 'section_position', confidence: 'certain' },
  { key: 's85da', id: 'pac_lung_exam', label: 'Lung examination', section: 'Lungs(Added Sounds)', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'asoiuytg', id: 'pac_lung_side', label: 'Lung findings side', section: 'Lungs(Added Sounds)', read: 'enum', decodedBy: 'value_domain', confidence: 'certain' },
  { key: 'elocjf', id: 'pac_other_findings', label: 'Other findings', section: 'Other Findings', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── investigations ────────────────────────────────────────────────────────────
  { key: 'okhufuv', id: 'pac_investigations', label: 'Investigations', section: 'Investigations', read: 'json', decodedBy: 'value_domain', confidence: 'certain',
    note: 'a KareXpert result array: serviceItemName, value, referenceRange{low,high}. The ONLY numeric instrument input the PAC carries — creatinine.' },
  { key: 'plmzaq852', id: 'pac_investigations_note', label: 'Investigations note', section: 'Investigations', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'fcko', id: 'pac_investigations_note_2', label: 'Investigations note (second box)', section: 'Investigations', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── orders and plan ───────────────────────────────────────────────────────────
  { key: 'opsud', id: 'pac_preop_orders', label: 'Pre-op orders', section: 'Pre OP Orders', read: 'enum', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'Q8D2S', id: 'pac_preop_orders_note', label: 'Pre-op orders note', section: 'Pre OP Orders', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'Q2D5F', id: 'pac_premedication', label: 'Pre-medication / fasting', section: 'Pre Medication', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'Q8S5A', id: 'pac_premedication_2', label: 'Pre-medication (second box)', section: 'Pre Medication', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },

  // ── anaesthesia plan ──────────────────────────────────────────────────────────
  { key: 'Q8888', id: 'pac_anaesthesia_type', label: 'Type of anaesthesia', section: 'Type of Anesthesia', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: 'General / Regional / MAC' },
  { key: 'WWW8S', id: 'pac_asa', label: 'ASA physical status', section: 'Type of Anesthesia', read: 'enum', decodedBy: 'value_domain', confidence: 'provisional',
    note: 'values over 95 reports are exactly I / II / III / IV plus the E emergency modifier, distributed I 42 · II 31 · III 11 · IV 1 — the ASA-PS scale and nothing else in anaesthesia looks like it. DISPLAY ONLY, awaiting an anaesthetist\'s confirmation; the PRD recorded ASA as 5/95 because its text scan looked for the letters "ASA".' },
  { key: 'W8S5SSS', id: 'pac_anaesthesia_plan', label: 'Anaesthesia plan', section: 'Type of Anesthesia', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'a2z52s5d2', id: 'pac_vte_factors_a', label: 'VTE risk factors (patient)', section: 'Type of Anesthesia', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: 'Caprini factor checkboxes (Age bands, BMI > 25, pregnancy, varicose veins, lung disease) — seeds the S2 Caprini instrument, feeds nothing in Slice 1' },
  { key: 'aaaaa8s5s', id: 'pac_vte_factors_b', label: 'VTE risk factors (surgery)', section: 'Type of Anesthesia', read: 'enum', decodedBy: 'value_domain', confidence: 'certain',
    note: 'Caprini surgery-type factors (arthroscopic, laparoscopic > 45 min, major open > 45 min)' },
  { key: 'SSSSDWW', id: 'pac_vte_factors_c', label: 'VTE risk factors (age ≥ 75)', section: 'Type of Anesthesia', read: 'enum', decodedBy: 'value_domain', confidence: 'certain' },
  { key: 'SIDIFJ', id: 'pac_vte_factors_d', label: 'VTE risk factors (arthroplasty)', section: 'Type of Anesthesia', read: 'enum', decodedBy: 'value_domain', confidence: 'certain' },
  { key: 'as888888888d', id: 'pac_vte_factors_e', label: 'VTE risk factors (other)', section: 'Type of Anesthesia', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'A2D5D2', id: 'pac_vte_score', label: 'VTE risk score', section: 'VTE risk score', read: 'verbatim', decodedBy: 'section_position', confidence: 'certain',
    note: 'e.g. "Very Low 1-2/Early Ambulation + IPC" — the PRD\'s named seed for S2 Caprini' },
  { key: 'POEYRT', id: 'pac_vte_points', label: 'VTE risk points', section: 'VTE risk score', read: 'numeric', decodedBy: 'section_position', confidence: 'certain' },

  // ── keys the template carries but no anaesthetist has ever filled ─────────────
  // Present in all 95 payloads, non-empty in NONE of them. Mapped rather than ignored,
  // so that the day one of them is used it appears in the coverage table as display text
  // instead of arriving as a silent unknown key.
  { key: 'wdwf', id: 'pac_unused_investigations', label: 'Investigations (unused box)', section: 'Investigations', read: 'verbatim', decodedBy: 'section_position', confidence: 'provisional', note: 'never filled in 95 reports' },
  { key: 'BJGHYF', id: 'pac_unused_premed_a', label: 'Pre-medication (unused box A)', section: 'Pre Medication', read: 'verbatim', decodedBy: 'section_position', confidence: 'provisional', note: 'never filled in 95 reports' },
  { key: 'ASDFGH', id: 'pac_unused_premed_b', label: 'Pre-medication (unused box B)', section: 'Pre Medication', read: 'verbatim', decodedBy: 'section_position', confidence: 'provisional', note: 'never filled in 95 reports' },
  { key: 'DD8DAAA', id: 'pac_unused_anaes_a', label: 'Anaesthesia (unused box A)', section: 'Type of Anesthesia', read: 'verbatim', decodedBy: 'section_position', confidence: 'provisional', note: 'never filled in 95 reports' },
  { key: 'APAPA', id: 'pac_unused_anaes_b', label: 'Anaesthesia (unused box B)', section: 'Type of Anesthesia', read: 'verbatim', decodedBy: 'section_position', confidence: 'provisional', note: 'never filled in 95 reports' },
  { key: 'SQAZ', id: 'pac_unused_anaes_c', label: 'Anaesthesia (unused box C)', section: 'Type of Anesthesia', read: 'verbatim', decodedBy: 'section_position', confidence: 'provisional', note: 'never filled in 95 reports' },

  // ── conclusion ────────────────────────────────────────────────────────────────
  { key: 'IFJUT85', id: 'pac_education', label: 'Patient educated for', section: 'Patient educated for:', read: 'enum', decodedBy: 'section_position', confidence: 'certain' },
  { key: 'QQQWWW_g', id: 'pac_conclusion', label: 'Conclusion / plan', section: 'Patient educated for:', read: 'verbatim', decodedBy: 'value_domain', confidence: 'certain',
    note: 'the LAST free-text box, and where "PATIENT CAN BE TAKEN FOR SURGERY" is written when it is written at all. Quoted verbatim in the case-page banner, never paraphrased and never replaced.' },
];

/** Template metadata and UI plumbing that carries no clinical meaning. */
export const PAC_IGNORED_KEYS: ReadonlySet<string> = new Set([
  'confidential', 'templateName', 'templateType', 'title', 'role', 'module',
  'specialisation', 'specialisation_code', 'speciality_id', 'fav_templateId',
  'currentTreatingDoctorSpecialityId', 'tag_data',
  'Allergies220', 'Allergies221',
]);

const BY_KEY = new Map(PAC_MAP.map((f) => [f.key, f]));
export const pacFieldForKey = (key: string): PacFieldSpec | undefined => BY_KEY.get(key);

// ── parsing ─────────────────────────────────────────────────────────────────────

export interface PacVital { type: string; label: string; value: number | null; unit: string | null; refLow: number | null; refHigh: number | null }
export interface PacLab { name: string; valueText: string; value: number | null; refLow: number | null; refHigh: number | null }

export interface PacFieldValue {
  id: string;
  key: string;
  label: string;
  section: string;
  read: PacReadType;
  confidence: PacConfidence;
  /** enum tokens, trimmed — [] for non-enum reads */
  tokens: string[];
  text: string | null;
  number: number | null;
  bool: boolean | null;
}

export interface ParsedPac {
  templateName: string | null;
  fields: Record<string, PacFieldValue>;
  vitals: PacVital[];
  investigations: PacLab[];
  /** the conclusion box, quoted verbatim; null when the anaesthetist left it empty */
  conclusion: string | null;
  /** keys present in the payload that this map does not know — never silently dropped */
  unmappedKeys: string[];
  /** section labels seen, in order — proof the template is the one we mapped */
  sections: string[];
  parseError: string | null;
}

const SECTION_KEY = /^(TF-|TMP-)/;

/** A valueString is one of: a JSON array of tokens, 'true'/'false', a number, or text. */
function readValue(raw: string): { tokens: string[]; text: string | null; number: number | null; bool: boolean | null } {
  const v = (raw ?? '').trim();
  if (!v) return { tokens: [], text: null, number: null, bool: null };
  if (v === 'true' || v === 'false') return { tokens: [], text: null, number: null, bool: v === 'true' };
  if (v.startsWith('[')) {
    try {
      const arr = JSON.parse(v) as unknown[];
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
        return { tokens: (arr as string[]).map((x) => x.trim()).filter(Boolean), text: null, number: null, bool: null };
      }
    } catch { /* not a token array — fall through to text */ }
  }
  const n = Number(v);
  return { tokens: [], text: v, number: Number.isFinite(n) && v.length < 12 ? n : null, bool: null };
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The nested vitals JSON. Tolerant: a broken payload yields [] and never throws. */
export function parsePacVitals(raw: string | null): PacVital[] {
  if (!raw) return [];
  try {
    const o = JSON.parse(raw) as { vitalsName?: Array<Record<string, unknown>> };
    return (o.vitalsName ?? []).map((v) => ({
      type: String(v.vitalType_id ?? ''),
      label: String(v.name ?? v.vitalType ?? v.vitalType_id ?? ''),
      value: num(v.value),
      unit: v.units == null || v.units === '' ? null : String(v.units),
      refLow: num(v.referenceRangeFrom),
      refHigh: num(v.referenceRangeTo),
    })).filter((v) => v.type);
  } catch { return []; }
}

/** The investigations result array. Tolerant in the same way. */
export function parsePacInvestigations(raw: string | null): PacLab[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => {
      const rr = (x.referenceRange ?? {}) as Record<string, unknown>;
      const valueText = x.value == null ? '' : String(x.value);
      return {
        name: String(x.serviceItemName ?? '').trim(),
        valueText,
        value: num(valueText),
        refLow: num(rr.low),
        refHigh: num(rr.high),
      };
    }).filter((l) => l.name);
  } catch { return []; }
}

/**
 * Parse one PAC payload. Blank-tolerant by construction: a missing key is a field that
 * is simply absent from `fields`, an unparseable payload returns an empty parse WITH the
 * reason, and an unknown key is listed rather than dropped.
 */
export function parsePacComponentJson(componentJson: string | null | undefined): ParsedPac {
  const empty: ParsedPac = {
    templateName: null, fields: {}, vitals: [], investigations: [],
    conclusion: null, unmappedKeys: [], sections: [], parseError: null,
  };
  if (!componentJson) return { ...empty, parseError: 'no component_json on the report' };
  let arr: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(componentJson) as unknown;
    if (!Array.isArray(parsed)) return { ...empty, parseError: 'component_json is not an array' };
    arr = parsed as Array<Record<string, unknown>>;
  } catch (e) {
    return { ...empty, parseError: `component_json did not parse: ${String((e as Error).message).slice(0, 120)}` };
  }

  const out: ParsedPac = { ...empty, fields: {}, vitals: [], investigations: [], unmappedKeys: [], sections: [] };
  for (const e of arr) {
    const key = typeof e.name === 'string' ? e.name : '';
    if (!key) continue;
    const raw = e.valueString == null ? '' : String(e.valueString);
    if (key === 'templateName' || key === 'title') { if (raw) out.templateName ??= raw; continue; }
    if (SECTION_KEY.test(key)) { if (raw) out.sections.push(raw); continue; }
    if (PAC_IGNORED_KEYS.has(key)) continue;

    const spec = BY_KEY.get(key);
    if (!spec) { if (!out.unmappedKeys.includes(key)) out.unmappedKeys.push(key); continue; }
    if (!raw) continue;                                   // blank field — simply absent

    if (spec.read === 'json') {
      if (spec.id === 'pac_vitals') out.vitals = parsePacVitals(raw);
      if (spec.id === 'pac_investigations') out.investigations = parsePacInvestigations(raw);
      continue;
    }
    const v = readValue(raw);
    // A checkbox group left unticked serialises as `false`; that is "not recorded", not
    // "recorded as no". Only a ticked token or real text is a field the PAC filled in.
    if (v.bool === false && spec.read === 'enum') continue;
    out.fields[spec.id] = {
      id: spec.id, key, label: spec.label, section: spec.section, read: spec.read,
      confidence: spec.confidence, tokens: v.tokens, text: v.text, number: v.number, bool: v.bool,
    };
  }
  const concl = out.fields.pac_conclusion?.text ?? null;
  out.conclusion = concl ? concl.trim() : null;
  return out;
}

// ── mapped fields → instrument inputs ───────────────────────────────────────────

/** Creatinine names as db13 writes them inside the PAC investigations array. */
const PAC_CREATININE = /creatinin/i;
const PAC_CREATININE_EXCLUDE = /ratio/i;

/**
 * Every instrument input the PAC deterministically supports, as PAC-sourced observations.
 * ONLY coded values and numerics reach this function; verbatim fields never do.
 *
 * `observedAt` is the report's own created_at — the PAC's evidence is as of when the
 * anaesthetist wrote it, not when we read it.
 */
export function pacObservations(parsed: ParsedPac, observedAt: string | null, ref: string | null): Observation[] {
  const out: Observation[] = [];
  const push = (inputId: PreopInputId, status: 'present' | 'absent', detail: string, value?: number) =>
    out.push({ inputId, status, detail, value: value ?? null, source: 'PAC', provenanceRef: ref, observedAt });

  for (const spec of PAC_MAP) {
    if (!spec.rules?.length || spec.confidence !== 'certain') continue;
    const f = parsed.fields[spec.id];
    if (!f || !f.tokens.length) continue;
    for (const token of f.tokens) {
      const t = token.trim().toUpperCase();
      const rule = spec.rules.find((r) => r.token === t);
      if (!rule) continue;
      for (const id of rule.present ?? []) push(id, 'present', `PAC ${spec.label.toLowerCase()}: ${rule.label}`);
      for (const id of rule.absent ?? []) push(id, 'absent', `PAC ${spec.label.toLowerCase()}: ${rule.label}`);
    }
  }

  // The one numeric instrument input the template carries. The reference range is the
  // unit check: a creatinine reported against 0.5–1.3 is mg/dL, and anything whose range
  // does not look like mg/dL is skipped rather than compared against the wrong scale.
  for (const lab of parsed.investigations) {
    if (!PAC_CREATININE.test(lab.name) || PAC_CREATININE_EXCLUDE.test(lab.name)) continue;
    if (lab.value == null) continue;
    const mgdl = lab.refHigh == null || (lab.refHigh > 0.5 && lab.refHigh < 5);
    if (!mgdl) continue;
    push('creatinine_over_2', lab.value > 2.0 ? 'present' : 'absent',
      `PAC investigations: ${lab.name} ${lab.valueText}`, lab.value);
  }
  return out;
}

/** Height/weight/BMI for the case page. Display only — no instrument reads them. */
export function pacBodyMetrics(parsed: ParsedPac): { heightCm: number | null; weightKg: number | null; bmi: number | null } {
  const pick = (t: string) => parsed.vitals.find((v) => v.type === t)?.value ?? null;
  const heightCm = pick('height');
  const weightKg = pick('weight');
  const bmi = pick('BMI') ?? (heightCm && weightKg ? Number((weightKg / ((heightCm / 100) ** 2)).toFixed(1)) : null);
  return { heightCm, weightKg, bmi };
}

/** Does the PAC's own recorded age disagree with the episode's dob-derived age? */
export function pacAgeMismatch(parsed: ParsedPac, episodeAge: number | null): number | null {
  const pacAge = parsed.fields.pac_age?.number ?? null;
  if (pacAge == null || episodeAge == null) return null;
  const d = Math.abs(pacAge - episodeAge);
  return d >= 2 ? d : null;      // a one-year drift is a birthday, not a data problem
}
