/**
 * v1.7 Sprint G — 55 seed example questions weighted to EHRC OT case mix
 * (Aug 2025–May 2026: 46% Gen Surg, 15% Ortho, 7% ENT, 3-3-3% Uro/OB-GYN/Gastro,
 *  plus medical-side specialties for breadth). See PRD Appendix A.
 */
export type Surface = 'ask' | 'ddx' | 'coach';
export type Seed = { question: string; specialty: string; surface?: Surface };

export const EXAMPLE_QUESTION_SEED: Seed[] = [
  // General Surgery — heavy weight (15 questions, ~27%)
  { specialty: 'General Surgery', question: 'Indications for laser hemorrhoidopexy vs stapler hemorrhoidectomy in grade III internal hemorrhoids' },
  { specialty: 'General Surgery', question: 'Preoperative workup for laparoscopic cholecystectomy in a patient with suspected choledocholithiasis' },
  { specialty: 'General Surgery', question: 'Antibiotic prophylaxis regimen for clean elective surgery vs contaminated bowel surgery' },
  { specialty: 'General Surgery', question: 'Management of pilonidal sinus — primary closure vs Limberg flap vs Bascom procedure' },
  { specialty: 'General Surgery', question: 'When is mesh repair preferred over Bassini for inguinal hernia in young adults' },
  { specialty: 'General Surgery', question: 'EVLT vs RFA vs traditional stripping for great saphenous vein insufficiency — recurrence rates and complications' },
  { specialty: 'General Surgery', question: 'Postoperative pain management after laser hemorrhoidectomy — multimodal protocol' },
  { specialty: 'General Surgery', question: 'Indications for laparoscopic vs open repair of umbilical hernia in adults' },
  { specialty: 'General Surgery', question: 'DVT prophylaxis in elective laparoscopic surgery — when to use mechanical vs pharmacological' },
  { specialty: 'General Surgery', question: 'Management of grade IV hemorrhoids with prolapse — surgical options and recurrence rates' },
  { specialty: 'General Surgery', question: 'Workup of a 45y with painless rectal bleeding — algorithm before assuming hemorrhoids' },
  { specialty: 'General Surgery', question: 'Anal fissure management — lateral internal sphincterotomy vs botulinum toxin vs GTN ointment' },
  { specialty: 'General Surgery', question: 'Lipoma excision under local anaesthesia — patient selection and technique pearls' },
  { specialty: 'General Surgery', question: 'Phimosis in adults — when to circumcise vs preputioplasty vs topical steroids' },
  { specialty: 'General Surgery', question: 'Postop wound infection after lap chole — risk factors and prevention bundle' },

  // Orthopedics (8, ~15%)
  { specialty: 'Orthopedics', question: 'Indications for total knee replacement vs unicompartmental in osteoarthritis' },
  { specialty: 'Orthopedics', question: 'Bilateral TKR — single-stage vs staged — patient selection criteria and complications' },
  { specialty: 'Orthopedics', question: 'ACL reconstruction graft choice — hamstring vs BTB vs allograft in a 30y athlete' },
  { specialty: 'Orthopedics', question: 'Postop DVT prophylaxis after total hip replacement — duration and agent selection' },
  { specialty: 'Orthopedics', question: 'Frozen shoulder in a diabetic — conservative vs arthroscopic capsular release timing' },
  { specialty: 'Orthopedics', question: 'When to remove orthopedic implants — fracture healing criteria plus patient symptoms' },
  { specialty: 'Orthopedics', question: 'Periprosthetic joint infection workup after TKR — when to aspirate, when to revise' },
  { specialty: 'Orthopedics', question: 'Pain management protocol after TKR — multimodal including adductor canal block' },

  // ENT (4, ~7%)
  { specialty: 'ENT', question: 'Indications for FESS in chronic rhinosinusitis with nasal polyps — when conservative fails' },
  { specialty: 'ENT', question: 'Adenotonsillectomy criteria in pediatric OSA — Paradise criteria vs polysomnography' },
  { specialty: 'ENT', question: 'Endoscopic CSF leak repair — preop localization and graft choice' },
  { specialty: 'ENT', question: 'Septoplasty + turbinoplasty in chronic nasal obstruction — patient selection and outcomes' },

  // Urology (3)
  { specialty: 'Urology', question: 'Workup and management of a 5mm vs 10mm vs 15mm ureteric calculus' },
  { specialty: 'Urology', question: 'RIRS vs ESWL vs PCNL for renal stones — size-based algorithm' },
  { specialty: 'Urology', question: 'BPH workup before TURP — IPSS, uroflowmetry, prostate volume thresholds' },

  // OB-GYN (3)
  { specialty: 'OB-GYN', question: 'TLH vs open hysterectomy — indications, contraindications, complication profiles' },
  { specialty: 'OB-GYN', question: 'LSCS in a previous LSCS patient — VBAC eligibility and uterine rupture risk' },
  { specialty: 'OB-GYN', question: 'Postpartum hemorrhage management — uterotonic algorithm and surgical escalation' },

  // Gastro (2)
  { specialty: 'Gastro', question: 'Acute cholecystitis severity grading (Tokyo) and timing of cholecystectomy' },
  { specialty: 'Gastro', question: 'ERCP for CBD stones — pre-procedure workup and post-ERCP pancreatitis prevention' },

  // Cardiology (3)
  { specialty: 'Cardiology', question: 'First-line management of HFrEF NYHA III — quadruple therapy initiation order' },
  { specialty: 'Cardiology', question: 'New-onset AFib in a 65y — rate vs rhythm plus anticoagulation decision (CHA2DS2-VASc)' },
  { specialty: 'Cardiology', question: 'NSTEMI workup and risk stratification — HEART score and TIMI in the ED' },

  // Pulm (2)
  { specialty: 'Pulm', question: 'Empiric antibiotics for community-acquired pneumonia in a 70y with COPD' },
  { specialty: 'Pulm', question: 'COPD exacerbation management — when to escalate to systemic steroids and antibiotics' },

  // Neuro (2)
  { specialty: 'Neuro', question: 'Acute ischemic stroke workup in the first 4.5h — tPA eligibility and contraindications' },
  { specialty: 'Neuro', question: 'First unprovoked seizure in an adult — workup and AED initiation criteria' },

  // ID (2)
  { specialty: 'ID', question: 'Sepsis bundle for an adult presenting with suspected urosepsis — 1h and 3h goals' },
  { specialty: 'ID', question: 'Surgical antibiotic prophylaxis duration — when 24h is too long and when to continue' },

  // Endo (2)
  { specialty: 'Endo', question: 'DKA management — fluid and insulin algorithm, when to add dextrose' },
  { specialty: 'Endo', question: 'Subclinical hypothyroidism in a 50y woman — when to treat with levothyroxine' },

  // Renal (2)
  { specialty: 'Renal', question: 'Workup for hyponatremia, serum osmolality 268 — algorithm by volume status' },
  { specialty: 'Renal', question: 'Acute kidney injury in a postoperative patient — pre-renal vs intrinsic vs post-renal workup' },

  // Heme (2)
  { specialty: 'Heme', question: 'Anticoagulation reversal — DOACs vs warfarin in the bleeding patient' },
  { specialty: 'Heme', question: 'Iron deficiency anemia workup in a 55y male — when to scope' },

  // EM (2)
  { specialty: 'EM', question: 'Anaphylaxis management — epinephrine dosing, biphasic risk, observation period' },
  { specialty: 'EM', question: 'Chest pain risk stratification in the ED — HEART pathway vs traditional rule-out' },

  // Psych (1)
  { specialty: 'Psych', question: 'Acute delirium in a postoperative elderly patient — workup and pharmacologic approach' },

  // Peds (1)
  { specialty: 'Peds', question: 'Pediatric fever without source in a 6m–24m — workup tiers and disposition' },

  // General (1)
  { specialty: 'General', question: 'Perioperative antiplatelet management — when to hold aspirin and clopidogrel before surgery' },
];

// v1.7b — case-stem seeds for /ddx (clinical presentations)
export const DDX_SEEDS: Seed[] = [
  { specialty: 'General Surgery', surface: 'ddx', question: '62y M with sudden-onset RLQ pain, fever 38.4°C, anorexia x 18hr; tender McBurney, guarding' },
  { specialty: 'General Surgery', surface: 'ddx', question: '45y F with painless rectal bleeding x 3 months, mild anaemia (Hb 10.2), occasional constipation' },
  { specialty: 'General Surgery', surface: 'ddx', question: '38y M with intermittent groin swelling that reduces on lying down, dragging pain on prolonged standing' },
  { specialty: 'General Surgery', surface: 'ddx', question: '55y M with progressive dysphagia to solids x 2 months, 5 kg weight loss, smoker, no reflux history' },
  { specialty: 'General Surgery', surface: 'ddx', question: '29y F postpartum day 4 with calf swelling, pain on dorsiflexion, low-grade fever' },
  { specialty: 'General Surgery', surface: 'ddx', question: '44y M with severe perianal pain on defecation, fresh streak bleeding, sentinel skin tag visible' },
  { specialty: 'General Surgery', surface: 'ddx', question: '60y M with painless obstructive jaundice x 3 weeks, palpable gallbladder, weight loss 6 kg' },
  { specialty: 'General Surgery', surface: 'ddx', question: '32y F with right-sided breast lump, mobile, firm, no nipple discharge, no family history' },
  { specialty: 'General Surgery', surface: 'ddx', question: '70y M post-laparoscopic cholecystectomy day 2 with worsening abdominal distension, low UOP, tachycardia' },
  { specialty: 'General Surgery', surface: 'ddx', question: '48y M with intermittent claudication at 100m, absent pedal pulses, ABI 0.6, diabetic' },
  { specialty: 'Orthopedics', surface: 'ddx', question: '65y F post-fall on outstretched hand with wrist pain and dinner-fork deformity' },
  { specialty: 'Orthopedics', surface: 'ddx', question: '42y M with progressive low back pain radiating to right leg below knee, worse on coughing' },
  { specialty: 'Orthopedics', surface: 'ddx', question: '58y M known TKR 4 years ago with new-onset knee pain, warmth, low-grade fever x 2 weeks' },
  { specialty: 'Orthopedics', surface: 'ddx', question: '28y F athlete with sudden knee pop during pivot, hemarthrosis, anterior drawer positive' },
  { specialty: 'Orthopedics', surface: 'ddx', question: '75y F with hip pain after fall, shortened externally rotated leg, unable to bear weight' },
  { specialty: 'ENT', surface: 'ddx', question: '35y M with unilateral nasal obstruction x 6 months, recurrent epistaxis, post-nasal mass' },
  { specialty: 'ENT', surface: 'ddx', question: '8y M with sleep-disordered breathing, mouth breathing, recurrent tonsillitis x 4 episodes/year' },
  { specialty: 'ENT', surface: 'ddx', question: '52y F with unilateral hearing loss + tinnitus x 3 months, no vertigo, Weber lateralises away' },
  { specialty: 'Cardiology', surface: 'ddx', question: '58y M with crushing retrosternal chest pain x 2hr, diaphoresis, ST elevation V2-V4 on ECG' },
  { specialty: 'Cardiology', surface: 'ddx', question: '70y F with progressive exertional dyspnoea + bilateral leg oedema x 4 weeks, S3 gallop' },
  { specialty: 'Cardiology', surface: 'ddx', question: '42y F with intermittent palpitations + presyncope, ECG shows irregularly irregular narrow-complex tachycardia' },
  { specialty: 'Pulmonology', surface: 'ddx', question: '55y M smoker with chronic productive cough x 6 months, progressive dyspnoea, barrel chest' },
  { specialty: 'Pulmonology', surface: 'ddx', question: '30y F with sudden pleuritic chest pain + dyspnoea post-long flight, tachycardia, normal CXR' },
  { specialty: 'Endocrinology', surface: 'ddx', question: '48y F with weight gain, cold intolerance, dry skin, constipation, hoarseness x 6 months' },
  { specialty: 'Endocrinology', surface: 'ddx', question: '35y M with polyuria, polydipsia, weight loss, fasting glucose 320 mg/dL, ketones positive' },
  { specialty: 'Endocrinology', surface: 'ddx', question: '26y F with palpitations, tremor, heat intolerance, exophthalmos, diffuse goitre' },
  { specialty: 'Neurology', surface: 'ddx', question: '72y M with sudden right hemiparesis + aphasia 90 min ago, BP 180/100' },
  { specialty: 'Neurology', surface: 'ddx', question: '32y F with thunderclap headache + photophobia, neck stiffness, brief LOC' },
  { specialty: 'Neurology', surface: 'ddx', question: '55y F with progressive proximal muscle weakness + rash on knuckles + face' },
  { specialty: 'Gastroenterology', surface: 'ddx', question: '45y F with epigastric burning pain relieved by meals, NSAID use, intermittent melaena' },
  { specialty: 'Gastroenterology', surface: 'ddx', question: '30y M with chronic diarrhoea + abdominal pain + 8 kg weight loss + perianal fistula' },
  { specialty: 'OB-GYN', surface: 'ddx', question: '28y F G2P1 at 8 weeks with severe lower abdominal pain + spotting + dizziness, BHCG positive' },
  { specialty: 'OB-GYN', surface: 'ddx', question: '55y F postmenopausal with new vaginal bleeding x 2 weeks, no HRT, BMI 32' },
  { specialty: 'Infectious disease', surface: 'ddx', question: '25y M traveller returning from East Africa with fever, headache, jaundice x 5 days' },
  { specialty: 'General Medicine', surface: 'ddx', question: '65y diabetic with worsening confusion + fever + dysuria x 24hr, BP 90/60' },
];

// v1.7b — teaching-prompt seeds for /coach (Socratic openers)
export const COACH_SEEDS: Seed[] = [
  { specialty: 'Cardiology', surface: 'coach', question: 'Teach me how to approach a patient with chest pain in the ED — risk stratification end-to-end' },
  { specialty: 'General Surgery', surface: 'coach', question: 'Walk me through the decision tree for acute abdomen in a 65-year-old' },
  { specialty: 'Endocrinology', surface: 'coach', question: 'Coach me on DKA management — diagnosis, fluids, insulin, electrolyte gotchas' },
  { specialty: 'Neurology', surface: 'coach', question: 'Teach me thunderclap headache workup — what I must not miss and why' },
  { specialty: 'Pulmonology', surface: 'coach', question: 'Walk me through suspected pulmonary embolism — risk scoring, imaging choice, treatment' },
  { specialty: 'General Surgery', surface: 'coach', question: 'Coach me on the indications for laparoscopic vs open cholecystectomy' },
  { specialty: 'Orthopedics', surface: 'coach', question: 'Teach me how to interpret a hip X-ray after fall — fractures vs dislocations vs prosthetic issues' },
  { specialty: 'Cardiology', surface: 'coach', question: 'Walk me through ECG read of a STEMI — territories, mimics, time-to-PCI logic' },
  { specialty: 'ENT', surface: 'coach', question: 'Coach me on epistaxis management — anterior vs posterior, when to ENT-refer' },
  { specialty: 'Pulmonology', surface: 'coach', question: 'Teach me asthma vs COPD vs ACO differentiation in a 60y smoker with dyspnoea' },
  { specialty: 'Endocrinology', surface: 'coach', question: 'Walk me through thyroid storm — clinical features, triggers, beta-blocker + PTU sequencing' },
  { specialty: 'Neurology', surface: 'coach', question: 'Coach me on acute stroke management — tPA window, contraindications, post-tPA monitoring' },
  { specialty: 'Infectious disease', surface: 'coach', question: 'Teach me sepsis bundle — within hour 1, hour 3, hour 6' },
  { specialty: 'General Surgery', surface: 'coach', question: 'Walk me through the operative consent for laparoscopic cholecystectomy — risks I must name' },
  { specialty: 'Gastroenterology', surface: 'coach', question: 'Coach me on upper GI bleed — Glasgow-Blatchford, OGD timing, transfusion thresholds' },
  { specialty: 'Cardiology', surface: 'coach', question: 'Teach me atrial fibrillation rate vs rhythm control — when to switch' },
  { specialty: 'Orthopedics', surface: 'coach', question: 'Walk me through TKR pre-op assessment — comorbidities + anaesthesia + DVT prophylaxis' },
  { specialty: 'OB-GYN', surface: 'coach', question: 'Coach me on antepartum haemorrhage — placenta praevia vs abruption clinical distinction' },
  { specialty: 'Endocrinology', surface: 'coach', question: 'Teach me the workup of an incidentaloma — adrenal vs pituitary vs thyroid' },
  { specialty: 'Pulmonology', surface: 'coach', question: 'Walk me through interpreting an ABG — primary disorder + compensation + acid-base shortcuts' },
  { specialty: 'General Medicine', surface: 'coach', question: 'Coach me on hyponatraemia workup — volume status + osmolality + targeted Rx' },
  { specialty: 'Cardiology', surface: 'coach', question: 'Teach me the difference between systolic and diastolic heart failure in management' },
  { specialty: 'Neurology', surface: 'coach', question: 'Walk me through Parkinson disease diagnosis criteria and first-line management' },
  { specialty: 'ENT', surface: 'coach', question: 'Coach me on chronic rhinosinusitis with polyps — medical vs surgical step-up' },
  { specialty: 'General Surgery', surface: 'coach', question: 'Teach me hernia recurrence prevention — mesh choice, technique, patient factors' },
];
