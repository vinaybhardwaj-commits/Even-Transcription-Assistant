// CALC.4 — hyponatremia workup deterministic math. PRD §4.4.
// Locked decisions #10, #11, #12 baked in:
//   #10: hard ceiling number with ODS-risk factors enumerated
//   #11: fluid TYPE may be named; volume/rate never
//   #12: no acuity-specific branching; same output structure regardless of Na

export type VolumeStatus = 'hypovolemic' | 'euvolemic' | 'hypervolemic' | 'unsure';
export type MedFlag = 'thiazide' | 'ssri' | 'carbamazepine' | 'mdma' | 'nsaid' | 'ace_arb' | 'ppi' | 'desmopressin';

export type HyponatremiaInputs = {
  na: number;                       // mEq/L
  serum_osm?: number;               // mOsm/kg
  glucose: number;                  // mg/dL
  urine_na?: number;                // mEq/L (spot)
  urine_osm?: number;               // mOsm/kg (spot)
  volume_status: VolumeStatus;
  meds: MedFlag[];                  // ticked from checklist
  recent_ivf?: boolean;
  tsh?: number;                     // mIU/L
  cortisol?: number;                // µg/dL (AM)
  suspect_adrenal_insuff?: boolean;
  k?: number;                       // mEq/L
  bun?: number;                     // mg/dL (for serum-osm estimation)
  weight_kg?: number;
  sex?: 'F' | 'M';
};

export type Tonicity = 'hypotonic' | 'isotonic' | 'hypertonic' | 'unknown';

export type HyponatremiaResult = {
  corrected_na: number;             // glucose-corrected
  pseudohyponatremia_flag: boolean;
  tonicity: Tonicity;
  serum_osm_estimated: number | null;   // if not provided, calculated; else null
  volume_status: VolumeStatus;
  free_water_deficit_l: number | null;  // null if weight missing
  ods_risk: boolean;
  ods_risk_factors: string[];
  correction_ceiling_24h_meq_l: number;     // 8 standard
  ods_ceiling_24h_meq_l: number;            // 6 conservative
  severity_label: 'mild' | 'moderate' | 'severe';   // by Na, not for branching output — for analytics
};

// ---------- Glucose correction (Katz) ----------
// corrected_na = measured + 1.6 * ((glucose - 100) / 100)
// Switch to Hillier (2.4×) for very high glucose >400 per UpToDate convention.
function correctNa(na: number, glucose: number): number {
  if (glucose <= 100) return Math.round(na * 10) / 10;
  const factor = glucose > 400 ? 2.4 : 1.6;
  const corrected = na + factor * ((glucose - 100) / 100);
  return Math.round(corrected * 10) / 10;
}

// ---------- Estimated serum osmolality (if not measured) ----------
// 2 × Na + glucose/18 + BUN/2.8
function estimatedOsm(na: number, glucose: number, bun?: number): number {
  return Math.round((2 * na + glucose / 18 + (bun ?? 14) / 2.8) * 10) / 10;
}

// ---------- Tonicity ----------
function classifyTonicity(osm: number): Tonicity {
  if (osm < 275) return 'hypotonic';
  if (osm <= 295) return 'isotonic';
  return 'hypertonic';
}

// ---------- Free-water deficit ----------
// TBW × (1 - actual_Na / 140)
function freeWaterDeficit(corrected_na: number, weight_kg?: number, sex?: 'F' | 'M'): number | null {
  if (!weight_kg) return null;
  const tbwFactor = sex === 'F' ? 0.5 : 0.6;
  const tbw = weight_kg * tbwFactor;
  // We want EXCESS water (since hyponatremic). Deficit = TBW × (current/desired - 1), but
  // for hypoNa it's negative. The clinically used number is the EXCESS:
  // excess_water_l = TBW × (1 - current_na / 140)
  const excess = tbw * (1 - corrected_na / 140);
  return Math.round(excess * 100) / 100;
}

// ---------- ODS risk ----------
// Risk factors per Adrogue-Madias 2017 + AAFP guidance:
//   Na < 105 mEq/L                  (chronicity proxy)
//   K < 3 mEq/L                     (hypokalemia is independent risk)
//   chronic alcohol use, malnutrition, liver failure  (not in our input schema)
//   adrenal insufficiency           (uses suspect_adrenal_insuff flag as proxy)
function computeOdsRisk(inputs: HyponatremiaInputs, corrected_na: number) {
  const factors: string[] = [];
  if (corrected_na < 105) factors.push(`Na ${corrected_na} (<105 — chronicity proxy)`);
  if (inputs.k !== undefined && inputs.k < 3) factors.push(`K ${inputs.k} (<3 — hypokalemia)`);
  if (inputs.suspect_adrenal_insuff) factors.push('Suspected adrenal insufficiency');
  return { ods_risk: factors.length > 0, ods_risk_factors: factors };
}

// ---------- Severity label (analytics only — output structure is the same) ----------
function severityLabel(na: number): 'mild' | 'moderate' | 'severe' {
  if (na >= 130) return 'mild';
  if (na >= 120) return 'moderate';
  return 'severe';
}

// ---------- Entry ----------
export function interpretHyponatremia(inputs: HyponatremiaInputs): HyponatremiaResult {
  const corrected = correctNa(inputs.na, inputs.glucose);

  let osm: number;
  let osmEstimated: number | null = null;
  if (inputs.serum_osm !== undefined) {
    osm = inputs.serum_osm;
  } else {
    osm = estimatedOsm(inputs.na, inputs.glucose, inputs.bun);
    osmEstimated = osm;
  }

  const tonicity = classifyTonicity(osm);
  // Pseudohyponatremia = measured Na low, but osm normal/high (no true hypotonicity)
  const pseudo = tonicity !== 'hypotonic';

  const fwd = freeWaterDeficit(corrected, inputs.weight_kg, inputs.sex);
  const ods = computeOdsRisk(inputs, corrected);

  return {
    corrected_na: corrected,
    pseudohyponatremia_flag: pseudo,
    tonicity,
    serum_osm_estimated: osmEstimated,
    volume_status: inputs.volume_status,
    free_water_deficit_l: fwd,
    ods_risk: ods.ods_risk,
    ods_risk_factors: ods.ods_risk_factors,
    correction_ceiling_24h_meq_l: 8,
    ods_ceiling_24h_meq_l: 6,
    severity_label: severityLabel(corrected),
  };
}
