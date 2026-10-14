# Pre-op Risk Agent — PAC field coverage (B3 deliverable)

**Measured 26 Aug 2026 against live db13**, by parsing every row of
`kx_clinical_template_pac_reports` through `lib/preop-pac-map-core.ts`. This table replaces
the ILIKE text-scan estimates in PRD §4, which counted mentions of a WORD in the flattened
`note` render rather than the presence of a FIELD in `component_json`.

- PAC reports parsed: 95 (parse errors 0) · in the surgical cohort: 52
- Facility spread (cohort reports by hospital uid): vZmEPseTKP3vS3DrZzrv=52 · F8jrPHlVTWsvNtB1Iz0k=2
- Reports yielding >=1 instrument input: 47/95 all · 11/52 cohort

Two of the estimates were wrong by an order of magnitude, in the module's favour:

| Field | PRD §4 text-scan estimate | Measured from the mapped field |
|---|---|---|
| ASA physical status | 5 / 95 | **89 / 95** (47 / 52 in the surgical cohort) |
| Mallampati class | 0 / 95 | **65 / 95** (27 / 52 in the surgical cohort) |

The scan was looking for the strings "ASA" and "Mallampati". The template stores neither:
ASA is a roman-numeral token under the anaesthesia-plan section, and Mallampati is written
`MP 1` / `MP 2` / `MP 3`. Both are decoded from their value domain alone and both are
therefore marked **provisional** and wired to **no instrument** — they are displayed and
nothing more until an anaesthetist confirms the reading.

## Every mapped field

`feeds` names the instrument inputs a field can supply. An empty `feeds` is a display-only
field — every `verbatim` read is display-only by construction (a test enforces it), because
inferring a clinical fact from prose is the B5 extraction rail, not this map.

| Field | Label | Section | Read | Conf. | All (95) | Cohort (52) | Feeds | Top values |
|---|---|---|---|---|---|---|---|---|
| pac_diagnosis | Diagnosis | (header) | verbatim | certain | 85 | 44 |  |  |
| pac_procedure | Planned procedure | (header) | verbatim | certain | 92 | 50 |  |  |
| pac_age | Age recorded at PAC | (header) | numeric | certain | 93 | 50 |  |  |
| pac_sex | Sex recorded at PAC | (header) | enum | certain | 95 | 52 |  |  |
| pac_header_note | LMP / date note | (header) | verbatim | provisional | 10 | 6 |  |  |
| pac_allergies | Allergies | Allergies | verbatim | certain | 47 | 35 |  |  |
| pac_vitals | Vital signs | Vital sign | json | certain | 23 | 8 |  |  |
| pac_vitals_note | Vitals note | Vital sign | verbatim | certain | 40 | 33 |  |  |
| pac_vitals_note_2 | Vitals note (second box) | Vital sign | verbatim | certain | 22 | 3 |  |  |
| pac_social | Social history | Social History | enum | certain | 6 | 3 |  | Alcohol×3 Smoking×3 |
| pac_social_note | Social history note | Social History | verbatim | certain | 16 | 6 |  |  |
| pac_cvs_ros | Cardiovascular review | Review of Systems | enum | certain | 34 | 1 | ischaemic_heart_disease, myocardial_infarction, congestive_heart_failure | WNL×30 MI×4 Angina×2 |
| pac_cvs_htn | Hypertension (review) | Review of Systems | enum | certain | 12 | 10 |  | HTN×12 |
| pac_cvs_note | Cardiovascular note | Review of Systems | verbatim | certain | 11 | 10 |  |  |
| pac_cvs_flag_a | Cardiovascular flag A | Review of Systems | boolean | provisional | 62 | 35 |  |  |
| pac_cvs_flag_b | Cardiovascular flag B | Review of Systems | boolean | provisional | 62 | 35 |  |  |
| pac_gi_ros | Gastrointestinal review | Gastrointestinal System | enum | certain | 31 | 1 | peptic_ulcer_disease, mild_liver_disease | WML×30 Ulcers×1 |
| pac_gi_findings | Gastrointestinal findings | Gastrointestinal System | enum | certain | 4 | 1 |  | Others×2 Bleeding Problem×2 Cholelithisis×1 |
| pac_gi_note | Gastrointestinal note | Gastrointestinal System | verbatim | certain | 3 | 2 |  |  |
| pac_pulm_ros | Pulmonary review | Pulmonary System | enum | certain | 33 | 3 | copd_or_pneumonia, chronic_pulmonary_disease | WNL×25 Others×4 Pneumonia×2 Bronchial Asthma×1 |
| pac_pulm_note | Pulmonary note | Pulmonary System | verbatim | certain | 8 | 3 |  |  |
| pac_msk_ros | Musculoskeletal review | Muscular and Skeleton System | enum | certain | 2 | 2 |  | Others×2 |
| pac_msk_note | Musculoskeletal note | Muscular and Skeleton System | verbatim | certain | 2 | 2 |  |  |
| pac_renal_ros | Renal review | Renal System and G.U.Tract | enum | certain | 29 | 0 | moderate_severe_renal_disease | WNL×29 |
| pac_renal_findings | Renal findings | Renal System and G.U.Tract | enum | certain | 2 | 1 |  | Others×1 ARF×1 |
| pac_renal_note | Renal note | Renal System and G.U.Tract | verbatim | certain | 5 | 3 |  |  |
| pac_cns_ros | Central nervous system review | Central Nervous System | enum | certain | 25 | 3 | cerebrovascular_disease | WNL×22 Others×3 |
| pac_cns_findings | Central nervous system findings | Central Nervous System | enum | certain | 1 | 1 |  | Depression×1 |
| pac_endo_ros | Endocrine review | Endocrine System | enum | certain | 37 | 8 | diabetes_mellitus, diabetes_uncomplicated, insulin_treated_diabetes, diabetes_end_organ_damage | WNL×24 NIDDM×8 Hypothyroidism×6 |
| pac_endo_findings | Endocrine findings | Endocrine System | enum | certain | 1 | 1 |  | Others×1 |
| pac_endo_note | Endocrine note | Endocrine System | verbatim | certain | 10 | 7 |  |  |
| pac_other_history | Other medical history | Other Medical History | verbatim | certain | 63 | 40 |  |  |
| pac_meds_cardio | Cardiovascular medication | Medication History | enum | certain | 9 | 7 | hypertension_on_medication | Anti Hypertensive×9 Anti Platelet×3 |
| pac_meds_endo | Endocrine / anticoagulant medication | Medication History | enum | certain | 7 | 3 | diabetes_mellitus | Oral Hypoglycemic×7 Anti Coagulant×1 |
| pac_meds_flag | Medication flag | Medication History | boolean | provisional | 63 | 35 |  |  |
| pac_meds_note | Medication note | Medication History | verbatim | certain | 8 | 2 |  |  |
| pac_prev_anaesthetic | Previous anaesthetic | Previous Anesthetics | enum | certain | 29 | 20 |  | GA×22 LA×8 IV Sedation×1 |
| pac_prev_anaesthetic_problem | Previous anaesthetic problem | Previous Anesthetics | boolean | provisional | 63 | 35 |  |  |
| pac_prev_anaesthetic_note | Previous anaesthetic note | Previous Anesthetics | verbatim | certain | 29 | 17 |  |  |
| pac_examination | Physical examination | Physicial Examination | verbatim | certain | 42 | 19 |  |  |
| pac_mallampati | Mallampati class | Airway | enum | provisional | 65 | 27 |  | MP 2×31 MP 1×19 MP 3×15 Teeth×2 |
| pac_airway_flags | Airway flags | Airway | enum | certain | 2 | 0 |  | Overbite×2 MH Distance×2 Neck×2 |
| pac_airway_note | Airway note | Airway | verbatim | certain | 13 | 9 |  |  |
| pac_cardiac_exam | Cardiac examination | Cardiac | enum | certain | 63 | 26 |  | S1 S2 Normal×56 S1 S2 +×6 Diastolic Murmer×1 |
| pac_cardiac_exam_note | Cardiac examination note | Cardiac | verbatim | certain | 1 | 0 |  |  |
| pac_lung_added_sounds | Added lung sounds | Lungs(Added Sounds) | enum | certain | 8 | 0 |  | Others×7 Crepts×1 |
| pac_lung_exam | Lung examination | Lungs(Added Sounds) | verbatim | certain | 58 | 23 |  |  |
| pac_lung_side | Lung findings side | Lungs(Added Sounds) | enum | certain | 43 | 19 |  |  |
| pac_other_findings | Other findings | Other Findings | verbatim | certain | 4 | 2 |  |  |
| pac_investigations | Investigations | Investigations | json | certain | 18 | 3 |  |  |
| pac_investigations_note | Investigations note | Investigations | verbatim | certain | 33 | 17 |  |  |
| pac_investigations_note_2 | Investigations note (second box) | Investigations | verbatim | certain | 8 | 5 |  |  |
| pac_preop_orders | Pre-op orders | Pre OP Orders | enum | certain | 5 | 2 |  | Pt advised regarding BT×5 ABTS for exchange donors×1 T & H×1 T & C×1 |
| pac_preop_orders_note | Pre-op orders note | Pre OP Orders | verbatim | certain | 1 | 1 |  |  |
| pac_premedication | Pre-medication / fasting | Pre Medication | verbatim | certain | 86 | 50 |  |  |
| pac_premedication_2 | Pre-medication (second box) | Pre Medication | verbatim | certain | 9 | 4 |  |  |
| pac_anaesthesia_type | Type of anaesthesia | Type of Anesthesia | enum | certain | 87 | 48 |  | General×47 Regional×42 MAC×3 |
| pac_asa | ASA physical status | Type of Anesthesia | enum | provisional | 89 | 47 |  | I×42 II×33 III×15 E×3 |
| pac_anaesthesia_plan | Anaesthesia plan | Type of Anesthesia | verbatim | certain | 11 | 2 |  |  |
| pac_vte_factors_a | VTE risk factors (patient) | Type of Anesthesia | enum | certain | 13 | 5 |  | Age 41 to 60 Yrs×9 BMI >25 Kg/m2×2 Vericose Veins×2 Serios lung disease, including pneumonia (< 1month)×1 |
| pac_vte_factors_b | VTE risk factors (surgery) | Type of Anesthesia | enum | certain | 9 | 5 |  | Arthoscopic surgery×4 Age 61 to 74 Yrs×3 Major open surgery (>45 Min)×2 Laproscopic surgery (>45 Min)×1 |
| pac_vte_factors_c | VTE risk factors (age ≥ 75) | Type of Anesthesia | enum | certain | 3 | 2 |  | Age >=75 Yrs×3 |
| pac_vte_factors_d | VTE risk factors (arthroplasty) | Type of Anesthesia | enum | certain | 1 | 0 |  | Elective arthroplasty×1 |
| pac_vte_factors_e | VTE risk factors (other) | Type of Anesthesia | verbatim | certain | 1 | 1 |  |  |
| pac_vte_score | VTE risk score | VTE risk score | verbatim | certain | 14 | 10 |  |  |
| pac_vte_points | VTE risk points | VTE risk score | numeric | certain | 2 | 1 |  |  |
| pac_education | Patient educated for | Patient educated for: | enum | certain | 86 | 46 |  | Anaesthesia plan dis with pt.×86 Risks and benefits discussed×86 All questions answered×84 Inasive montioring explained×4 |
| pac_conclusion | Conclusion / plan | Patient educated for: | verbatim | certain | 83 | 51 |  |  |

## Instrument inputs produced

- instrument inputs produced across all 95: diabetes_mellitus×39 | ischaemic_heart_disease×36 | myocardial_infarction×34 | diabetes_uncomplicated×32 | insulin_treated_diabetes×32 | peptic_ulcer_disease×31 | mild_liver_disease×30 | congestive_heart_failure×30 | moderate_severe_renal_disease×29 | copd_or_pneumonia×28 | chronic_pulmonary_disease×27 | diabetes_end_organ_damage×24 | cerebrovascular_disease×22 | hypertension_on_medication×9 | creatinine_over_2×8
- unmapped keys still seen: wdwf×95 | BJGHYF×95 | ASDFGH×95 | DD8DAAA×95 | APAPA×95 | SQAZ×95

## What this means for V

- **47 of 95 reports yield at least one instrument input — but only 11 of the 52 in the
  surgical cohort.** The review-of-systems block, which is the part that feeds the
  instruments, is filled far more often on PACs outside the surgical cohort than inside it.
  That is a capture-behaviour finding, not a mapping one.
- **Functional status is not capturable from this template.** mFI-5's ripening input lives
  in the physical-examination box as prose ("Conscious and alert", "not ambulating since 15
  days"). B3 will not read it; B5's extraction rail is where it belongs.
- **The template carries its own creatinine** in the investigations array — 8 reports, with
  reference ranges that confirm the mg/dL scale. That is a second, independent route to
  RCRI's renal factor beside the Eka lab feed.
- **The VTE section is a Caprini instrument in waiting** — the risk-factor checkboxes and
  the computed score are both mapped and both display-only, exactly as PRD §3 anticipated.
- **Six template keys have never been filled** in 95 reports. They are mapped rather than
  ignored, so the day one is used it appears here instead of arriving as an unknown key.

---

## Addendum · refreshed 27 Aug 2026 (B7)

The KareXpert scraper fetches daily around 06:47 IST and was a day behind when the table
above was measured. Re-pulled through the same code path (`lib/preop-pac-map-core.ts`
over every row of `kx_clinical_template_pac_reports`) on 27 Aug. **The table above is not
superseded — nothing about the MAP changed. What changed is the corpus underneath it.**

| | 26 Aug | 27 Aug |
|---|---|---|
| PAC reports in the table | 95 | **98** |
| …bridged to an Even individual | 95 | **95** (98 reports / 97 patients; 3 UHIDs still unbridged) |
| …in the surgical cohort | 52 | **54** |
| Reports yielding ≥1 instrument input | 47 / 95 · 11 / 52 cohort | **49 / 98 · 12 / 54 cohort** |
| Parse errors | 0 | **0** |
| Template keys still unmapped | 0 | **0** |

The cohort's headline finding is unchanged and is the number V should carry into any
decision about the extraction rail: **only about a fifth of PAC reports on surgical
patients fill the review-of-systems block the instruments read** (12 of 54). Two more
reports landed and one more of them was filled.

The two corrected estimates hold and both grew: **ASA 92/98 (49/54 cohort)**, **Mallampati
67/98 (28/54)**. Both remain `provisional` and wired to no instrument.

### The six verbatim fields the B5 extraction rail reads

These are the boxes `preop-pac-map-core.ts` deliberately refuses to interpret, and they are
therefore exactly the substrate B5 was built for. Fill rates as of 27 Aug:

| Field | All (98) | Cohort (54) |
|---|---|---|
| pac_other_history | 65 | **41** |
| pac_examination | 43 | 19 |
| pac_airway_note | 14 | 10 |
| pac_cvs_note | 11 | 10 |
| pac_endo_note | 10 | 7 |
| pac_meds_note | 9 | 3 |

`pac_other_history` is where the comorbidity narratives live and is the only one of the six
with cohort reach worth the name. The B7 pack measures what the rail actually gets out of
them.
