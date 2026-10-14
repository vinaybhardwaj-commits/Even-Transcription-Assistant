-- 0034_lvc_ratified_wording.sql — LVC JUDGE PINNING PRD v1.0 §3 (D-5), 10 Aug 2026.
--
-- Applied in-app via POST /api/admin/migrate-lvc-wording (admin-gated), which builds the SAME
-- statements from lib/lvc-ratified-wording.ts with bound parameters. This file is the
-- version-controlled reference; keep the two in sync (lib/__tests__/lvc-ratified-wording.test.ts
-- asserts every precondition text appears here byte-for-byte).
--
-- WHAT IT DOES. Seven preconditions replaced with V's ratified wording, two records retired.
-- Every touched row is stamped ratified_by = 'V (Dr Vinay Bhardwaj)', ratified_at = 2026-08-10.
--
-- IDEMPOTENT. Every statement carries an IS DISTINCT FROM guard, so re-running changes zero rows.
--
-- DATA-ONLY. No DDL. It depends on migrations/0005 (the table) and 0024 (ratified_by /
-- ratified_at) already being applied.
--
-- ⚠️ INFERRED. Written without a live DB; validate column names against the live schema before
-- running (the build report lists every string verbatim).
--
-- 'retired' is the status value the PRD ratifies. migrations/0005 documents the vocabulary as
-- active | superseded | withdrawn and there is no CHECK constraint; every reader filters
-- status = 'active', so a retired row simply stops being recalled.

-- §3.1 — ehrc-f283f2c4-7739-46e2-b5c8-997d89a79f5c
UPDATE lvc_recommendations
   SET precondition = $txt$Applies when the note documents (a) an acute upper-respiratory illness of 10 days or less — cough, sore throat, nasal block, coryza, or a diagnosis of URI / common cold / viral fever / acute pharyngitis / acute bronchitis — AND (b) a systemic antibiotic is prescribed. The recommendation applies unless the note documents a specific bacterial feature: radiographic or examination-confirmed pneumonia, streptococcal pharyngitis confirmed by RADT or culture, acute bacterial sinusitis (symptoms ≥10 days without improvement, or double-worsening), acute otitis media, or immunosuppression. If none of those bacterial features is written in the note, treat them as absent and conclude the recommendation APPLIES — do not answer "insufficient information" because the note is thin. Does not apply if no systemic antibiotic was prescribed, if the illness is documented as lasting more than 10 days, or if any bacterial feature above is documented.$txt$,
       ratified_by  = 'V (Dr Vinay Bhardwaj)',
       ratified_at  = '2026-08-10T00:00:00Z'::timestamptz,
       updated_at   = now()
 WHERE id = 'ehrc-f283f2c4-7739-46e2-b5c8-997d89a79f5c'
   AND (precondition IS DISTINCT FROM $txt$Applies when the note documents (a) an acute upper-respiratory illness of 10 days or less — cough, sore throat, nasal block, coryza, or a diagnosis of URI / common cold / viral fever / acute pharyngitis / acute bronchitis — AND (b) a systemic antibiotic is prescribed. The recommendation applies unless the note documents a specific bacterial feature: radiographic or examination-confirmed pneumonia, streptococcal pharyngitis confirmed by RADT or culture, acute bacterial sinusitis (symptoms ≥10 days without improvement, or double-worsening), acute otitis media, or immunosuppression. If none of those bacterial features is written in the note, treat them as absent and conclude the recommendation APPLIES — do not answer "insufficient information" because the note is thin. Does not apply if no systemic antibiotic was prescribed, if the illness is documented as lasting more than 10 days, or if any bacterial feature above is documented.$txt$
     OR ratified_by  IS DISTINCT FROM 'V (Dr Vinay Bhardwaj)'
     OR ratified_at  IS DISTINCT FROM '2026-08-10T00:00:00Z'::timestamptz);

-- §3.2 — ehrc-f8b0572d-b082-48ec-9774-b7b8970aeb1c
UPDATE lvc_recommendations
   SET precondition = $txt$Applies when the note documents a treatment plan, a prescription, or a transfer/hand-off of care, AND the note contains neither (a) safety-netting advice — any statement of warning signs, red-flag symptoms, or circumstances that should prompt the patient to return or seek urgent care — nor (b) a follow-up instruction — any review date, review interval, referral for review, or "return if not improving" — nor (c) any instruction on how the response to a prescribed treatment is to be monitored. Any such instruction, however brief, means the recommendation does not apply. This is a deliberate inverted trigger: the absent documentation IS the finding, so an empty advice/follow-up field must be read as genuinely missing, not as unknown. If the note documents no treatment, no prescription and no hand-off, the recommendation does not apply.$txt$,
       ratified_by  = 'V (Dr Vinay Bhardwaj)',
       ratified_at  = '2026-08-10T00:00:00Z'::timestamptz,
       updated_at   = now()
 WHERE id = 'ehrc-f8b0572d-b082-48ec-9774-b7b8970aeb1c'
   AND (precondition IS DISTINCT FROM $txt$Applies when the note documents a treatment plan, a prescription, or a transfer/hand-off of care, AND the note contains neither (a) safety-netting advice — any statement of warning signs, red-flag symptoms, or circumstances that should prompt the patient to return or seek urgent care — nor (b) a follow-up instruction — any review date, review interval, referral for review, or "return if not improving" — nor (c) any instruction on how the response to a prescribed treatment is to be monitored. Any such instruction, however brief, means the recommendation does not apply. This is a deliberate inverted trigger: the absent documentation IS the finding, so an empty advice/follow-up field must be read as genuinely missing, not as unknown. If the note documents no treatment, no prescription and no hand-off, the recommendation does not apply.$txt$
     OR ratified_by  IS DISTINCT FROM 'V (Dr Vinay Bhardwaj)'
     OR ratified_at  IS DISTINCT FROM '2026-08-10T00:00:00Z'::timestamptz);

-- §3.5 — cwus-acr-002
UPDATE lvc_recommendations
   SET precondition = $txt$Applies when the note orders MRI or CT of the spine — any region, including whole-spine or multi-region "screening" studies — for pain being evaluated for a possible spinal cause. The recommendation applies unless the note documents at least one of: focal or progressive neurological deficit, radiculopathy, neurogenic claudication, saddle anaesthesia, bowel or bladder dysfunction, major trauma, cancer history, unexplained weight loss, fever or suspected spinal infection, IV drug use, immunosuppression, or a specific spinal procedure already planned for which the scan is required. A red flag that is not written in the note is absent for this purpose: conclude the recommendation APPLIES rather than "insufficient information". Prior workup for non-spinal causes is not required for this recommendation to apply. Does not apply when no spinal MRI or CT is ordered, or when any listed red flag is documented.$txt$,
       ratified_by  = 'V (Dr Vinay Bhardwaj)',
       ratified_at  = '2026-08-10T00:00:00Z'::timestamptz,
       updated_at   = now()
 WHERE id = 'cwus-acr-002'
   AND (precondition IS DISTINCT FROM $txt$Applies when the note orders MRI or CT of the spine — any region, including whole-spine or multi-region "screening" studies — for pain being evaluated for a possible spinal cause. The recommendation applies unless the note documents at least one of: focal or progressive neurological deficit, radiculopathy, neurogenic claudication, saddle anaesthesia, bowel or bladder dysfunction, major trauma, cancer history, unexplained weight loss, fever or suspected spinal infection, IV drug use, immunosuppression, or a specific spinal procedure already planned for which the scan is required. A red flag that is not written in the note is absent for this purpose: conclude the recommendation APPLIES rather than "insufficient information". Prior workup for non-spinal causes is not required for this recommendation to apply. Does not apply when no spinal MRI or CT is ordered, or when any listed red flag is documented.$txt$
     OR ratified_by  IS DISTINCT FROM 'V (Dr Vinay Bhardwaj)'
     OR ratified_at  IS DISTINCT FROM '2026-08-10T00:00:00Z'::timestamptz);

-- §3.6 — cwus-acr-003
UPDATE lvc_recommendations
   SET precondition = $txt$Applies when the note orders a knee MRI for a knee injury the note describes as recent or acute (presenting within days of the injury), and no knee radiograph is documented as already performed. The recommendation applies unless the note documents at least one of: joint effusion or haemarthrosis, inability to bear weight, a positive ligamentous or meniscal test (Lachman, anterior drawer, pivot shift, McMurray), a locked or blocked knee, bony tenderness meeting the Ottawa Knee Rule, or surgery already planned. Findings not written in the note are absent for this purpose — a note that records an acute knee injury and an MRI order but no such examination finding means the recommendation APPLIES, not "insufficient information". Does not apply when the knee problem is chronic, atraumatic, or long-standing; when the note does not describe a recent injury; when radiographs are already documented; or when any listed finding is present.$txt$,
       ratified_by  = 'V (Dr Vinay Bhardwaj)',
       ratified_at  = '2026-08-10T00:00:00Z'::timestamptz,
       updated_at   = now()
 WHERE id = 'cwus-acr-003'
   AND (precondition IS DISTINCT FROM $txt$Applies when the note orders a knee MRI for a knee injury the note describes as recent or acute (presenting within days of the injury), and no knee radiograph is documented as already performed. The recommendation applies unless the note documents at least one of: joint effusion or haemarthrosis, inability to bear weight, a positive ligamentous or meniscal test (Lachman, anterior drawer, pivot shift, McMurray), a locked or blocked knee, bony tenderness meeting the Ottawa Knee Rule, or surgery already planned. Findings not written in the note are absent for this purpose — a note that records an acute knee injury and an MRI order but no such examination finding means the recommendation APPLIES, not "insufficient information". Does not apply when the knee problem is chronic, atraumatic, or long-standing; when the note does not describe a recent injury; when radiographs are already documented; or when any listed finding is present.$txt$
     OR ratified_by  IS DISTINCT FROM 'V (Dr Vinay Bhardwaj)'
     OR ratified_at  IS DISTINCT FROM '2026-08-10T00:00:00Z'::timestamptz);

-- §3.7 — cwus-acp-002
UPDATE lvc_recommendations
   SET precondition = $txt$Applies when the note orders a lumbar-spine or spine MRI for low back pain that the note describes as chronic, recurrent, or lasting more than about 6 weeks. The recommendation applies unless the note documents at least one of: radiculopathy or focal neurological deficit, cauda-equina features (saddle anaesthesia, bowel or bladder dysfunction), major trauma, cancer history, unexplained weight loss, fever or suspected spinal infection, IV drug use, immunosuppression, a spinal injection or surgery already planned, or a completed and failed trial of conservative care (physiotherapy, structured exercise, or an adequate analgesic trial). Any of these not written in the note is absent for this purpose — conclude the recommendation APPLIES. If the note does not describe the back pain as chronic, recurrent, or longer than about 6 weeks, the recommendation does not apply (undocumented duration is a definite "does not apply", not "insufficient information").$txt$,
       ratified_by  = 'V (Dr Vinay Bhardwaj)',
       ratified_at  = '2026-08-10T00:00:00Z'::timestamptz,
       updated_at   = now()
 WHERE id = 'cwus-acp-002'
   AND (precondition IS DISTINCT FROM $txt$Applies when the note orders a lumbar-spine or spine MRI for low back pain that the note describes as chronic, recurrent, or lasting more than about 6 weeks. The recommendation applies unless the note documents at least one of: radiculopathy or focal neurological deficit, cauda-equina features (saddle anaesthesia, bowel or bladder dysfunction), major trauma, cancer history, unexplained weight loss, fever or suspected spinal infection, IV drug use, immunosuppression, a spinal injection or surgery already planned, or a completed and failed trial of conservative care (physiotherapy, structured exercise, or an adequate analgesic trial). Any of these not written in the note is absent for this purpose — conclude the recommendation APPLIES. If the note does not describe the back pain as chronic, recurrent, or longer than about 6 weeks, the recommendation does not apply (undocumented duration is a definite "does not apply", not "insufficient information").$txt$
     OR ratified_by  IS DISTINCT FROM 'V (Dr Vinay Bhardwaj)'
     OR ratified_at  IS DISTINCT FROM '2026-08-10T00:00:00Z'::timestamptz);

-- §3.8 — cwus-aace-003
UPDATE lvc_recommendations
   SET precondition = $txt$Applies when the note orders a 25-hydroxyvitamin D level in an adult. The recommendation applies unless the note documents at least one of: osteoporosis or osteopenia, fragility or low-trauma fracture, chronic kidney disease, malabsorption (coeliac disease, inflammatory bowel disease, chronic pancreatitis, bariatric or gastric surgery), abnormal calcium or phosphate, hyperparathyroidism, chronic liver disease, rickets or osteomalacia, long-term glucocorticoid, anticonvulsant or antiretroviral therapy, documented bone pain or proximal muscle weakness, or investigation of recurrent falls. Non-specific complaints alone — fatigue, tiredness, generalised body ache — do NOT count as an indication. An indication that is not written in the note is absent for this purpose: conclude the recommendation APPLIES rather than "insufficient information". Does not apply when no vitamin D test is ordered or when any listed indication is documented.$txt$,
       ratified_by  = 'V (Dr Vinay Bhardwaj)',
       ratified_at  = '2026-08-10T00:00:00Z'::timestamptz,
       updated_at   = now()
 WHERE id = 'cwus-aace-003'
   AND (precondition IS DISTINCT FROM $txt$Applies when the note orders a 25-hydroxyvitamin D level in an adult. The recommendation applies unless the note documents at least one of: osteoporosis or osteopenia, fragility or low-trauma fracture, chronic kidney disease, malabsorption (coeliac disease, inflammatory bowel disease, chronic pancreatitis, bariatric or gastric surgery), abnormal calcium or phosphate, hyperparathyroidism, chronic liver disease, rickets or osteomalacia, long-term glucocorticoid, anticonvulsant or antiretroviral therapy, documented bone pain or proximal muscle weakness, or investigation of recurrent falls. Non-specific complaints alone — fatigue, tiredness, generalised body ache — do NOT count as an indication. An indication that is not written in the note is absent for this purpose: conclude the recommendation APPLIES rather than "insufficient information". Does not apply when no vitamin D test is ordered or when any listed indication is documented.$txt$
     OR ratified_by  IS DISTINCT FROM 'V (Dr Vinay Bhardwaj)'
     OR ratified_at  IS DISTINCT FROM '2026-08-10T00:00:00Z'::timestamptz);

-- §3.9 — cwus-aace-004
UPDATE lvc_recommendations
   SET precondition = $txt$Applies when the note orders a vitamin B12 level. The recommendation applies unless the note documents at least one of: unexplained anaemia or raised MCV / macrocytosis, peripheral neuropathy or paraesthesia, cognitive decline or memory complaint, glossitis, known or suspected pernicious anaemia, metformin therapy, long-term proton-pump-inhibitor or H2-blocker use, strict vegetarian or vegan diet, malabsorption (coeliac disease, inflammatory bowel disease), gastric or bariatric surgery, or alcohol dependence. A symptom or risk factor that is not written in the note is absent for this purpose: conclude the recommendation APPLIES rather than "insufficient information". Does not apply when no B12 test is ordered or when any listed symptom or risk factor is documented.$txt$,
       ratified_by  = 'V (Dr Vinay Bhardwaj)',
       ratified_at  = '2026-08-10T00:00:00Z'::timestamptz,
       updated_at   = now()
 WHERE id = 'cwus-aace-004'
   AND (precondition IS DISTINCT FROM $txt$Applies when the note orders a vitamin B12 level. The recommendation applies unless the note documents at least one of: unexplained anaemia or raised MCV / macrocytosis, peripheral neuropathy or paraesthesia, cognitive decline or memory complaint, glossitis, known or suspected pernicious anaemia, metformin therapy, long-term proton-pump-inhibitor or H2-blocker use, strict vegetarian or vegan diet, malabsorption (coeliac disease, inflammatory bowel disease), gastric or bariatric surgery, or alcohol dependence. A symptom or risk factor that is not written in the note is absent for this purpose: conclude the recommendation APPLIES rather than "insufficient information". Does not apply when no B12 test is ordered or when any listed symptom or risk factor is documented.$txt$
     OR ratified_by  IS DISTINCT FROM 'V (Dr Vinay Bhardwaj)'
     OR ratified_at  IS DISTINCT FROM '2026-08-10T00:00:00Z'::timestamptz);

-- §3.3 — ehrc-fe8f229b-d818-4e40-a360-367fa85bfb02 — retire: duplicate of 3.2 — superseded by the merged safety-netting record (D-5a)
UPDATE lvc_recommendations
   SET status      = 'retired',
       ratified_by = 'V (Dr Vinay Bhardwaj)',
       ratified_at = '2026-08-10T00:00:00Z'::timestamptz,
       updated_at  = now()
 WHERE id = 'ehrc-fe8f229b-d818-4e40-a360-367fa85bfb02'
   AND (status      IS DISTINCT FROM 'retired'
     OR ratified_by IS DISTINCT FROM 'V (Dr Vinay Bhardwaj)'
     OR ratified_at IS DISTINCT FROM '2026-08-10T00:00:00Z'::timestamptz);

-- §3.4 — ehrc-cdfcf3bc-b737-4058-91af-600b5ca414fd — retire: undocumented-ICD-code rec: self-contradictory, and coding gaps are already handled as informational (D-5b)
UPDATE lvc_recommendations
   SET status      = 'retired',
       ratified_by = 'V (Dr Vinay Bhardwaj)',
       ratified_at = '2026-08-10T00:00:00Z'::timestamptz,
       updated_at  = now()
 WHERE id = 'ehrc-cdfcf3bc-b737-4058-91af-600b5ca414fd'
   AND (status      IS DISTINCT FROM 'retired'
     OR ratified_by IS DISTINCT FROM 'V (Dr Vinay Bhardwaj)'
     OR ratified_at IS DISTINCT FROM '2026-08-10T00:00:00Z'::timestamptz);
