// CALC.1 — eGFR math (pure functions). PRD §4.1.
//
// CKD-EPI 2021 race-free is the displayed primary (locked decision #9).
// Cockcroft-Gault always computes in parallel; both push to Drugs context.
// No race coefficient anywhere.

export type Sex = 'F' | 'M';

export type EgfrInputs = {
  age: number;               // years
  sex: Sex;
  scr_mg_dl: number;         // serum creatinine in mg/dL
  weight_kg?: number;        // required for Cockcroft-Gault
};

export type EgfrResult = {
  ckdepi_2021: number;       // mL/min/1.73 m²
  cockcroft_gault: number | null;  // mL/min; null if weight not provided
  stage: CkdStage;           // staging from CKD-EPI 2021
  conservative_for_nti: number;    // the lower of the two (used for narrow-therapeutic-window drugs)
};

export type CkdStage = 'G1' | 'G2' | 'G3a' | 'G3b' | 'G4' | 'G5';

// CKD-EPI 2021 (race-free), Inker et al. NEJM 2021.
//   κ = 0.7 if female else 0.9
//   α = -0.241 if female else -0.302
//   eGFR = 142 × min(SCr/κ, 1)^α
//               × max(SCr/κ, 1)^(-1.200)
//               × 0.9938^age
//               × (1.012 if female else 1)
export function ckdEpi2021(inputs: EgfrInputs): number {
  const { age, sex, scr_mg_dl } = inputs;
  const kappa = sex === 'F' ? 0.7 : 0.9;
  const alpha = sex === 'F' ? -0.241 : -0.302;
  const ratio = scr_mg_dl / kappa;
  const minTerm = Math.pow(Math.min(ratio, 1), alpha);
  const maxTerm = Math.pow(Math.max(ratio, 1), -1.200);
  const ageTerm = Math.pow(0.9938, age);
  const sexTerm = sex === 'F' ? 1.012 : 1;
  const egfr = 142 * minTerm * maxTerm * ageTerm * sexTerm;
  return Math.round(egfr * 10) / 10;
}

// Cockcroft-Gault. Requires weight in kg.
//   CrCl = ((140 - age) × weight) / (72 × SCr) × (0.85 if female)
export function cockcroftGault(inputs: EgfrInputs): number | null {
  const { age, sex, scr_mg_dl, weight_kg } = inputs;
  if (!weight_kg || weight_kg <= 0) return null;
  const base = ((140 - age) * weight_kg) / (72 * scr_mg_dl);
  const sexCoef = sex === 'F' ? 0.85 : 1;
  return Math.round(base * sexCoef * 10) / 10;
}

// CKD stage from eGFR (used for CKD-EPI value, per KDIGO 2024).
export function stageFromEgfr(egfr: number): CkdStage {
  if (egfr >= 90) return 'G1';
  if (egfr >= 60) return 'G2';
  if (egfr >= 45) return 'G3a';
  if (egfr >= 30) return 'G3b';
  if (egfr >= 15) return 'G4';
  return 'G5';
}

// Compute both equations + stage. Single entry point used by the route.
export function computeEgfr(inputs: EgfrInputs): EgfrResult {
  const ckdepi = ckdEpi2021(inputs);
  const cg = cockcroftGault(inputs);
  const stage = stageFromEgfr(ckdepi);
  const conservative = cg !== null ? Math.min(ckdepi, cg) : ckdepi;
  return {
    ckdepi_2021: ckdepi,
    cockcroft_gault: cg,
    stage,
    conservative_for_nti: Math.round(conservative * 10) / 10,
  };
}

// µmol/L → mg/dL conversion (per PRD §4.1 input table).
export function umolLtoMgDl(scr_umol_l: number): number {
  return Math.round((scr_umol_l / 88.4) * 100) / 100;
}
