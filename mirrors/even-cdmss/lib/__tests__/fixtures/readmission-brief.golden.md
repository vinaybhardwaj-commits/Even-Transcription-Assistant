# Readmission case brief — Asha Khan · UH-77812 · 58F

Care-manager copy · advisory throughout · dedup key `IP-2026-0101|IP-2026-0342`

## Part 1 — Intern presentation

### Why this case
- Lane: Clearest signal · fast bounce — fast return to the same team [finding row]
- Finding class: Even → Even [finding row]
- Gap: 4.0 days [finding row]
- Situation · Unplanned return [audit finding]

### Index stay
- Department: Orthopaedics [finding row]
- Treating doctor: Dr R Menon [finding row]
- Discharge date: 1 Jun 2026 [finding row]
- Payer: Even [finding row]
- Diagnosis: Fracture neck of femur (L) [discharge summary — first stay]
- Indication: Displaced intracapsular fracture [discharge summary — first stay]
- Procedure: Cemented hemiarthroplasty [discharge summary — first stay]
- Course: Uneventful stay; mobilised day 2; wound clean at discharge. [discharge summary — first stay]
- Investigations: Hb 10.2; CRP 48 [discharge summary — first stay]
- Treatments: IV cefuroxime 48h [discharge summary — first stay]
- Medications: Enoxaparin 40 mg OD; Paracetamol 650 mg TDS [discharge summary — first stay]
- Risk factors: T2DM [discharge summary — first stay]
- Disposition: Home [discharge summary — first stay]
- Follow-up: OPD in 2 weeks [discharge summary — first stay]

### Interval
- 4.0 days between index discharge (1 Jun 2026) and return (5 Jun 2026) [finding row]

### Return
- Department: Orthopaedics [finding row]
- Treating doctor: Dr S Iyer [finding row]
- Admit date: 5 Jun 2026 [finding row]
- Payer: Even [finding row]
- Care-manager follow-up form held: Patient called on day 3 — fever and wound discharge; advised to return. Contact [number withheld]. [care-manager follow-up form, patient-reported]
- Diagnosis: Superficial SSI [discharge summary — return stay]
- Course: Wound opened and washed; culture-directed antibiotics. [discharge summary — return stay]
- Investigations: CRP 132; Wound swab: MRSA [discharge summary — return stay]
- Treatments: IV vancomycin [discharge summary — return stay]

### Artefacts
| Artefact | State |
|---|---|
| Discharge summary — first stay | present |
| Discharge summary — return stay | present |
| Lab results | present |
| Operative notes | present |
| Pre-anaesthesia check | none |
| Ward progress notes | empty — rows exist, no usable text |
| Care-manager follow-up form | present |
| Hospital bill | present |

### Assessment
- Medical justification: Needs adjudication [audit finding]
  - Reason: passes agree on the label but cite disjoint evidence [audit finding]
- Preventable injury: Suspected (rule readmit-judgement/1) [audit finding]
  - Omission: surgical site infection — late culture, wound discharge — moderate danger, moderate confidence [audit finding]
- Negligence: Unknown — advisory — not a court or council finding [audit finding]
  - Exculpatory: patient non-adherent to dressing advice — uncorroborated [audit finding]
- Stability at discharge: contradicted · evidence track: lab_corroborated · lab tier: tier1 [audit finding]
- Return stay bill: ₹96,450 [finding row]

### Looked for and not found
- pac_note — no row in db13 for this stay/window [audit finding]
- progress_note — 3 row(s) exist but none carries usable text [audit finding]

## Part 2 — Actuarial / low-value-care

- Payer: Even–Even (index Even → return Even) [finding row]
- Bill: Return stay bill: ₹96,450 — hospital bill, net of refunds. [hospital bill, db13]
- Index stay bill — 52 line(s) [hospital bill, db13]

| Service | Net ₹ | Source |
|---|---|---|
| IP Package | ₹1,50,000 | [hospital bill, db13] |
| Pharmacy | ₹21,500 | [hospital bill, db13] |
| Investigations | ₹8,600 | [hospital bill, db13] |
| Room Rent | ₹6,400 | [hospital bill, db13] |
| Refund | ₹-2,500 | [hospital bill, db13] |
| Total | ₹1,84,000 | [hospital bill, db13] |

- Return stay bill — 38 line(s) [hospital bill, db13]

| Service | Net ₹ | Source |
|---|---|---|
| Surgery | ₹45,000 | [hospital bill, db13] |
| Pharmacy | ₹28,950 | [hospital bill, db13] |
| Room Rent | ₹12,000 | [hospital bill, db13] |
| Investigations | ₹10,500 | [hospital bill, db13] |
| Total | ₹96,450 | [hospital bill, db13] |

- Candidate pattern: Unplanned same-condition return after Cemented hemiarthroplasty with 1 documentation omission(s) — candidate for Even Adjudicated LVC review.
- What we cannot say:
  - No policy rule follows from n=1 — one case is a case, not a pattern.
  - This is not a court or council finding; every judgement above is advisory and human-decided.
  - Ratification of any low-value-care pattern belongs to the LVC board, not to this brief.
