// CALC.1 — static fallback strings per PRD §15.6.
// Loaded when the LLM bridge is unreachable; tooltips fall back to these.
// CI lint (TODO post-CALC.1) asserts every field key in every calculator's config
// has a corresponding fallback string here. New field without fallback → CI fail.

import type { CalculatorName } from './types';

// Per-field tooltip fallbacks.
export const TOOLTIP_FALLBACKS: Record<CalculatorName, Record<string, string>> = {
  egfr: {
    age:        'Age in years. Used in both CKD-EPI 2021 and Cockcroft-Gault.',
    sex:        'Biological sex. Both equations apply a sex-specific coefficient.',
    scr_mg_dl:  'Most recent stable serum creatinine in mg/dL. Use today\'s steady-state value; if SCr is changing >0.3 mg/dL in 48 h, this is AKI and the equations\' steady-state assumption is violated.',
    scr_umol_l: 'Same as mg/dL but in SI units. Internal conversion: mg/dL = µmol/L ÷ 88.4.',
    weight_kg:  'Actual body weight in kg. Required only for Cockcroft-Gault. For obese patients, IBW or adjusted body weight is sometimes preferred — see your renal pharmacy reference.',
    equation:   'CKD-EPI 2021 (race-free) is the current KDIGO standard for staging. Cockcroft-Gault is still what most drug-dosing references cite — both compute in parallel so the renal context push to Drugs carries both.',
  },
  news2: {
    rr:           'Respiratory rate in breaths/min, counted over a full 60 s when abnormal. NEWS2 scoring breaks: ≤8, 9-11, 12-20, 21-24, ≥25.',
    spo2_scale:   'Scale 2 is used when target SpO2 is 88-92 % — typically known Type 2 respiratory failure / chronic CO2 retainers on home oxygen. Otherwise use Scale 1.',
    spo2:         'Pulse oximetry % on room air or current supplemental O2.',
    o2_supp:      'On any form of supplemental oxygen at the time of vitals. Adds 2 points to the score.',
    temp_c:       'Tympanic, oral, or axillary temperature in °C. NEWS2 scoring breaks at ≤35.0, 35.1-36.0, 36.1-38.0, 38.1-39.0, ≥39.1.',
    sbp:          'Systolic blood pressure in mmHg. Score breaks: ≤90, 91-100, 101-110, 111-219, ≥220.',
    hr:           'Heart rate in bpm. Score breaks: ≤40, 41-50, 51-90, 91-110, 111-130, ≥131.',
    consciousness:'AVPU + new-onset Confusion (C). Anything other than Alert scores 3 — including new confusion in a previously alert patient.',
  },
  abg: {
    ph:       'Arterial pH from the ABG. Normal 7.35-7.45.',
    paco2:    'Arterial PaCO2 in mmHg. Normal 35-45.',
    hco3:     'Calculated or measured bicarbonate in mEq/L. Normal 22-26.',
    pao2:     'Arterial PaO2 in mmHg. Required only if you want the P/F ratio or A-a gradient.',
    fio2:     'Inspired oxygen fraction (0.21 for room air, 1.0 for 100 % O2). Required for P/F and A-a.',
    na:       'Serum sodium in mEq/L. Required to compute the anion gap.',
    cl:       'Serum chloride in mEq/L. Required to compute the anion gap.',
    albumin:  'Serum albumin in g/dL. Corrects the anion gap (add 2.5 × (4.0 − albumin) for every g/dL below 4.0).',
    lactate:  'Serum lactate in mmol/L. >4 is a sepsis red flag and triggers the SSC 1-h bundle.',
    k:        'Serum potassium in mEq/L. Not used in standard ABG interpretation but narrows the differential (e.g. type 1 RTA tends to be hypokalemic).',
  },
  hyponatremia: {
    na:                       'Serum sodium in mEq/L.',
    serum_osm:                'Serum osmolality in mOsm/kg. The single most useful disambiguator — confirms or rules out pseudohyponatremia and hypertonic hyponatremia. Always send paired with serum Na when investigating hyponatremia.',
    glucose:                  'Serum glucose in mg/dL. Needed to compute the corrected Na (subtract 1.6 per 100 mg/dL above 100).',
    urine_na:                 'Spot urine Na in mEq/L. <30 suggests appropriate ADH response (volume depletion or low effective arterial volume); ≥30 suggests inappropriate natriuresis (SIADH, salt-wasting, diuretic, adrenal insufficiency).',
    urine_osm:                'Spot urine osmolality in mOsm/kg. >100 in the setting of hypotonicity is inappropriate concentration (SIADH); <100 suggests primary polydipsia or beer potomania.',
    volume_status:            'Clinical assessment. Hypovolemic: dry MM, ↑HR, orthostatic ↓BP, JVD low or absent. Euvolemic: no edema, no JVD elevation, normal MM. Hypervolemic: edema, JVD elevated, S3, pulmonary crackles.',
    meds:                     'Tick all current. Thiazides, SSRIs, carbamazepine, MDMA, NSAIDs, and ACE-Is are the most common offenders.',
    recent_ivf:               'Hypotonic IV fluid in the last 24-48 h is a frequent iatrogenic cause, especially post-operatively.',
    tsh:                      'TSH in mIU/L. Hypothyroidism is a less common but classic euvolemic-hyponatremia cause.',
    cortisol:                 'AM cortisol in µg/dL. <5 suggests adrenal insufficiency; >15 generally excludes; 5-15 ambiguous — ACTH stim test.',
    suspect_adrenal_insuff:   'Flag if clinical features fit (hypotension, hyperpigmentation, eosinophilia, hyponatremia + hyperkalemia, Addisonian crisis history).',
    weight_kg:                'Used to estimate total body water for the free-water deficit calculation.',
    sex:                      'TBW = 0.6 × weight (M) or 0.5 × weight (F).',
  },
  sepsis_bundle: {
    recognition_time:             'When was sepsis first recognized (suspected infection + organ dysfunction, OR qSOFA ≥2, OR sepsis alert fired)? Pre-filled with now; use the Backdate chip if recognized earlier.',
    weight_kg:                    'Patient weight in kg. Required to compute the 30 mL/kg crystalloid target if hypotension or lactate ≥4 triggers the fluid requirement.',
    lactate_done:                 'Serum lactate measured (any time after recognition). Bundle element 1.',
    cultures_done:                'Blood cultures × 2 drawn BEFORE first antibiotic dose. Yield drops sharply post-abx.',
    abx_given:                    'Broad-spectrum antibiotics administered. The single biggest mortality lever inside the 1-h window.',
    hypotension_or_lactate_high:  'MAP <65 mmHg OR lactate ≥4 mmol/L. Gates the 30 mL/kg fluid requirement.',
    fluids_done:                  '30 mL/kg crystalloid (or phenotype-tailored equivalent in cardiac/renal-limited patients) given. Required only if the hypotension/lactate gate is met.',
    fluid_volume_ml:              'Actual volume infused so far in mL. For audit only.',
    vasopressors_started:         'Norepinephrine (or equivalent) started. Required when MAP remains <65 after the initial fluid bolus.',
    qsofa:                        'qSOFA score if already computed elsewhere in this session. Consumed for the sidebar context.',
    sofa:                         'Full SOFA score if computed.',
  },
  // v1.8 S1 — fallbacks are minimal because the calculators ship a `staticTooltip`
  // on every FormField; the tooltip route falls through to those whenever this map
  // is empty. Keeping an empty per-field block satisfies the Record<CalculatorName, …>
  // type contract without duplicating the per-field copy already in the components.
  nihss:     {},
  abcd2:     {},
  curb65:    {},
  wells_dvt: {},
  wells_pe:  {},
  heart:     {},
  timi:      {},
  sofa:      {},
  qtc:       {},
  alvarado:  {},
};

// Synthesis-section fallbacks (LLM-native calculators only). Used when bridge is down.
// These are not full synthesis — just a single sentence per section + a redirect to Ask.
export const SYNTHESIS_FALLBACKS: Record<'abg' | 'hyponatremia' | 'sepsis_bundle', Record<string, string>> = {
  abg: {
    primary_disorder: 'Synthesis unavailable. The deterministic interpretation above names the primary disorder; open Ask with these inputs for a fuller discussion when the bridge is back.',
    compensation:     'Synthesis unavailable. See deterministic compensation check above.',
    anion_gap:        'Synthesis unavailable. See deterministic AG and delta-delta above.',
    differential:     'Synthesis unavailable. Open Ask with these inputs for a ranked differential when the bridge is back.',
    next_workup:      'Synthesis unavailable.',
    red_flags:        'Synthesis unavailable. Use clinical judgment on the pH and lactate values above.',
  },
  hyponatremia: {
    classification:           'Synthesis unavailable. The deterministic classification (tonicity + volume status) is above.',
    severity_acuity:          'Synthesis unavailable. ODS risk factors above are static; assess clinically.',
    correction_rate_guidance: 'Synthesis unavailable. Safe ceiling reference: 8 mEq/L per 24 h (≤6 if any ODS risk factor).',
    differential:             'Synthesis unavailable. Open Ask with these inputs when the bridge is back.',
    next_workup:              'Synthesis unavailable.',
    discriminating_signs:     'Synthesis unavailable. Review the inputs above.',
  },
  sepsis_bundle: {
    sidebar: 'Educational sidebar unavailable — bridge offline. Bundle status and countdown are unaffected; the sidebar will return when the bridge is back.',
  },
};

// Result-card interpretation fallbacks (deterministic calculators — eGFR, NEWS2).
// One paragraph per calculator. Used when the llama 8b interpretation call fails.
export const INTERPRETATION_FALLBACKS: Record<'egfr' | 'news2', (deterministic: Record<string, unknown>) => string> = {
  egfr: (d) => {
    const egfr = d.ckdepi_2021_ml_min_173 as number | undefined;
    const stage = d.stage as string | undefined;
    return `eGFR ${egfr ?? '?'} mL/min/1.73 m² (${stage ?? 'stage unknown'}). Interpretation paragraph unavailable — bridge offline. ` +
      (egfr !== undefined && egfr < 60
        ? 'Reduced eGFR — review all current drugs for renal dose adjustment, avoid NSAIDs, hold metformin if eGFR <30, use contrast cautiously.'
        : egfr !== undefined && egfr < 30
        ? 'Severely reduced eGFR — nephrology referral if not already involved; many drugs contraindicated or require significant dose reduction.'
        : 'Normal-range eGFR — confirm stability over time.');
  },
  news2: (d) => {
    const score = d.score as number | undefined;
    if (score === undefined) return 'Score unavailable.';
    if (score === 0) return `NEWS2 ${score} — low risk. Minimum 12-hourly vitals.`;
    if (score <= 4) return `NEWS2 ${score} — low risk. Minimum 4-6 hourly vitals; consider escalation if a single parameter scores 3.`;
    if (score === 5 || score === 6) return `NEWS2 ${score} — medium risk. Urgent registrar review, vitals at least hourly, consider critical-care input.`;
    return `NEWS2 ${score} — high risk. Emergency response (rapid response / MET) and consideration of continuous monitoring + critical-care transfer.`;
  },
};
