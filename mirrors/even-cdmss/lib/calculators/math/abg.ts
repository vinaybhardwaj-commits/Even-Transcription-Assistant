// CALC.3 — ABG / acid-base deterministic math. PRD §4.3.
// Pure functions. No LLM, no IO. All compensation formulae from Adrogue-Madias
// and Harrison's Internal Medicine references — standard ICU/EM curriculum.

export type AbgInputs = {
  pH: number;
  paco2: number;             // mmHg
  hco3: number;              // mEq/L
  pao2?: number;             // mmHg, optional
  fio2?: number;             // 0.21-1.0, optional
  na?: number;               // mEq/L, optional but needed for AG
  cl?: number;               // mEq/L, optional but needed for AG
  albumin?: number;          // g/dL, optional, corrects AG if <4.0
  lactate?: number;          // mmol/L, optional
  k?: number;                // mEq/L, optional
};

export type PrimaryDisorder =
  | 'normal'
  | 'metabolic_acidosis'
  | 'metabolic_alkalosis'
  | 'respiratory_acidosis_acute'
  | 'respiratory_acidosis_chronic'
  | 'respiratory_alkalosis_acute'
  | 'respiratory_alkalosis_chronic'
  | 'mixed';

export type AnionGapState = 'normal' | 'high' | 'low' | 'unknown';

export type CompensationVerdict =
  | 'appropriate'
  | 'under_compensated'
  | 'over_compensated'
  | 'mixed_disorder'
  | 'not_applicable';

export type AbgResult = {
  primary_disorder: PrimaryDisorder;
  primary_disorder_label: string;
  compensation: {
    verdict: CompensationVerdict;
    expected_range: string;        // human-readable, e.g. "19.5-23.5 mmHg PaCO2"
    measured: number | null;
    formula: string | null;        // which formula was applied
  };
  anion_gap: {
    state: AnionGapState;
    ag_value: number | null;
    corrected_ag: number | null;   // for albumin
    albumin_correction_applied: boolean;
  };
  delta_delta: {
    ratio: number | null;
    interpretation: string | null;
  };
  oxygenation: {
    pf_ratio: number | null;
    pf_band: 'normal' | 'mild' | 'moderate' | 'severe' | null;   // Berlin ARDS thresholds
    aa_gradient: number | null;
    aa_expected: number | null;
  };
  raw: AbgInputs;
};

// ---------- Primary disorder ----------

function classifyPrimary(pH: number, paco2: number, hco3: number): { disorder: PrimaryDisorder; label: string } {
  // Normal pH window (allow ±0.02 tolerance for "normal" or compensated calls)
  const pHLow = 7.35;
  const pHHigh = 7.45;

  if (pH >= pHLow && pH <= pHHigh && paco2 >= 35 && paco2 <= 45 && hco3 >= 22 && hco3 <= 26) {
    return { disorder: 'normal', label: 'No acid-base disorder identified' };
  }

  if (pH < pHLow) {
    // acidemia
    if (hco3 < 22 && paco2 > 45) return { disorder: 'mixed', label: 'Mixed metabolic + respiratory acidosis' };
    if (hco3 < 22) return { disorder: 'metabolic_acidosis', label: 'Metabolic acidosis' };
    if (paco2 > 45) return { disorder: 'respiratory_acidosis_acute', label: 'Respiratory acidosis (assumed acute)' };
    return { disorder: 'metabolic_acidosis', label: 'Metabolic acidosis' };  // default
  }
  if (pH > pHHigh) {
    // alkalemia
    if (hco3 > 26 && paco2 < 35) return { disorder: 'mixed', label: 'Mixed metabolic + respiratory alkalosis' };
    if (hco3 > 26) return { disorder: 'metabolic_alkalosis', label: 'Metabolic alkalosis' };
    if (paco2 < 35) return { disorder: 'respiratory_alkalosis_acute', label: 'Respiratory alkalosis (assumed acute)' };
    return { disorder: 'metabolic_alkalosis', label: 'Metabolic alkalosis' };
  }

  // pH in normal range but PaCO2/HCO3 abnormal → compensated process
  if (paco2 > 45 && hco3 > 26) return { disorder: 'respiratory_acidosis_chronic', label: 'Compensated respiratory acidosis (likely chronic)' };
  if (paco2 < 35 && hco3 < 22) return { disorder: 'respiratory_alkalosis_chronic', label: 'Compensated respiratory alkalosis (likely chronic)' };
  if (hco3 < 22 && paco2 < 35) return { disorder: 'metabolic_acidosis', label: 'Compensated metabolic acidosis' };
  if (hco3 > 26 && paco2 > 45) return { disorder: 'metabolic_alkalosis', label: 'Compensated metabolic alkalosis' };
  return { disorder: 'normal', label: 'Within normal limits' };
}

// ---------- Compensation ----------

function checkCompensation(primary: PrimaryDisorder, paco2: number, hco3: number): AbgResult['compensation'] {
  switch (primary) {
    case 'metabolic_acidosis': {
      // Winters' formula: expected PaCO2 = (1.5 × HCO3) + 8 ± 2
      const expectedLo = 1.5 * hco3 + 8 - 2;
      const expectedHi = 1.5 * hco3 + 8 + 2;
      let verdict: CompensationVerdict;
      if (paco2 >= expectedLo && paco2 <= expectedHi) verdict = 'appropriate';
      else if (paco2 > expectedHi) verdict = 'mixed_disorder';   // concurrent respiratory acidosis
      else verdict = 'mixed_disorder';                            // concurrent respiratory alkalosis (over-compensation)
      return {
        verdict,
        expected_range: `${expectedLo.toFixed(1)}-${expectedHi.toFixed(1)} mmHg PaCO2`,
        measured: paco2,
        formula: "Winters: expected PaCO2 = (1.5 × HCO3) + 8 ± 2",
      };
    }
    case 'metabolic_alkalosis': {
      // Expected PaCO2 = HCO3 + 15 (rough); rise of 0.7 mmHg per 1 mEq/L rise in HCO3 from 24
      const expectedLo = hco3 + 15 - 5;
      const expectedHi = hco3 + 15 + 5;
      let verdict: CompensationVerdict;
      if (paco2 >= expectedLo && paco2 <= expectedHi) verdict = 'appropriate';
      else if (paco2 > expectedHi) verdict = 'mixed_disorder';
      else verdict = 'mixed_disorder';
      return {
        verdict,
        expected_range: `${expectedLo.toFixed(1)}-${expectedHi.toFixed(1)} mmHg PaCO2 (approximate)`,
        measured: paco2,
        formula: "expected PaCO2 ≈ HCO3 + 15 (approximate)",
      };
    }
    case 'respiratory_acidosis_acute': {
      // expected HCO3 rise = (PaCO2 - 40) × 0.1, from baseline 24
      const expected = 24 + (paco2 - 40) * 0.1;
      const tol = 2;
      const verdict: CompensationVerdict = Math.abs(hco3 - expected) <= tol ? 'appropriate' : 'mixed_disorder';
      return {
        verdict,
        expected_range: `${(expected - tol).toFixed(1)}-${(expected + tol).toFixed(1)} mEq/L HCO3 (acute)`,
        measured: hco3,
        formula: "acute: ΔHCO3 = ΔPaCO2 × 0.1",
      };
    }
    case 'respiratory_acidosis_chronic': {
      const expected = 24 + (paco2 - 40) * 0.35;
      const tol = 3;
      const verdict: CompensationVerdict = Math.abs(hco3 - expected) <= tol ? 'appropriate' : 'mixed_disorder';
      return {
        verdict,
        expected_range: `${(expected - tol).toFixed(1)}-${(expected + tol).toFixed(1)} mEq/L HCO3 (chronic)`,
        measured: hco3,
        formula: "chronic: ΔHCO3 = ΔPaCO2 × 0.35",
      };
    }
    case 'respiratory_alkalosis_acute': {
      const expected = 24 - (40 - paco2) * 0.2;
      const tol = 2;
      const verdict: CompensationVerdict = Math.abs(hco3 - expected) <= tol ? 'appropriate' : 'mixed_disorder';
      return {
        verdict,
        expected_range: `${(expected - tol).toFixed(1)}-${(expected + tol).toFixed(1)} mEq/L HCO3 (acute)`,
        measured: hco3,
        formula: "acute: ΔHCO3 = ΔPaCO2 × 0.2",
      };
    }
    case 'respiratory_alkalosis_chronic': {
      const expected = 24 - (40 - paco2) * 0.5;
      const tol = 3;
      const verdict: CompensationVerdict = Math.abs(hco3 - expected) <= tol ? 'appropriate' : 'mixed_disorder';
      return {
        verdict,
        expected_range: `${(expected - tol).toFixed(1)}-${(expected + tol).toFixed(1)} mEq/L HCO3 (chronic)`,
        measured: hco3,
        formula: "chronic: ΔHCO3 = ΔPaCO2 × 0.5",
      };
    }
    case 'mixed':
    case 'normal':
    default:
      return { verdict: 'not_applicable', expected_range: 'N/A', measured: null, formula: null };
  }
}

// ---------- Anion gap (with albumin correction) ----------

function computeAnionGap(na?: number, cl?: number, hco3?: number, albumin?: number) {
  if (na === undefined || cl === undefined || hco3 === undefined) {
    return { state: 'unknown' as AnionGapState, ag_value: null, corrected_ag: null, albumin_correction_applied: false };
  }
  const ag = na - (cl + hco3);
  let corrected = ag;
  let albCorr = false;
  if (albumin !== undefined && albumin < 4.0) {
    corrected = ag + 2.5 * (4.0 - albumin);
    albCorr = true;
  }
  const finalAg = albCorr ? corrected : ag;
  const state: AnionGapState =
    finalAg > 12 ? 'high'
    : finalAg < 8 ? 'low'
    : 'normal';
  return {
    state,
    ag_value: Math.round(ag * 10) / 10,
    corrected_ag: Math.round(corrected * 10) / 10,
    albumin_correction_applied: albCorr,
  };
}

// ---------- Delta-delta ----------

function computeDeltaDelta(agState: AnionGapState, ag: number | null, hco3: number) {
  if (agState !== 'high' || ag === null) return { ratio: null, interpretation: null };
  const deltaAg = ag - 12;
  const deltaHco3 = 24 - hco3;
  if (deltaHco3 === 0) return { ratio: null, interpretation: 'cannot compute (HCO3 = 24)' };
  const ratio = Math.round((deltaAg / deltaHco3) * 100) / 100;
  let interp: string;
  if (ratio < 1) interp = 'concurrent normal-AG metabolic acidosis (delta-delta <1)';
  else if (ratio <= 2) interp = 'pure high-AG metabolic acidosis (delta-delta 1-2)';
  else interp = 'concurrent metabolic alkalosis or pre-existing high HCO3 (delta-delta >2)';
  return { ratio, interpretation: interp };
}

// ---------- Oxygenation (P/F + A-a) ----------

function computeOxygenation(pao2?: number, fio2?: number, paco2?: number) {
  let pfRatio: number | null = null;
  let pfBand: AbgResult['oxygenation']['pf_band'] = null;
  let aa: number | null = null;
  let aaExpected: number | null = null;

  if (pao2 !== undefined && fio2 !== undefined && fio2 > 0) {
    pfRatio = Math.round(pao2 / fio2);
    // Berlin ARDS thresholds (inclusive-high boundaries: mild 200<P/F≤300, moderate 100<P/F≤200,
    // severe ≤100 — V ruling 13 Jul 2026; only the two inner boundaries are strict-greater):
    pfBand = pfRatio >= 300 ? 'normal' : pfRatio > 200 ? 'mild' : pfRatio > 100 ? 'moderate' : 'severe';

    if (paco2 !== undefined) {
      const pao2Alveolar = (fio2 * 713) - (paco2 / 0.8);
      aa = Math.round((pao2Alveolar - pao2) * 10) / 10;
    }
  }
  return { pf_ratio: pfRatio, pf_band: pfBand, aa_gradient: aa, aa_expected: aaExpected };
}

// ---------- Main entry ----------

export function interpretAbg(inputs: AbgInputs): AbgResult {
  const primary = classifyPrimary(inputs.pH, inputs.paco2, inputs.hco3);
  const compensation = checkCompensation(primary.disorder, inputs.paco2, inputs.hco3);
  const ag = computeAnionGap(inputs.na, inputs.cl, inputs.hco3, inputs.albumin);
  const dd = computeDeltaDelta(ag.state, ag.corrected_ag ?? ag.ag_value, inputs.hco3);
  const oxy = computeOxygenation(inputs.pao2, inputs.fio2, inputs.paco2);

  return {
    primary_disorder: primary.disorder,
    primary_disorder_label: primary.label,
    compensation,
    anion_gap: ag,
    delta_delta: dd,
    oxygenation: oxy,
    raw: inputs,
  };
}
