// CALC.v1.8 — TIMI risk score for UA / NSTEMI (Antman et al. JAMA 2000).
// 7 binary items, total 0-7. Per-score 14-day all-cause mortality / MI / urgent revasc rates.

export type TimiInputs = {
  age_ge_65:           boolean;
  ge_3_risk_factors:   boolean;
  known_cad_50:        boolean;
  asa_in_7d:           boolean;
  severe_angina_24h:   boolean;
  elevated_markers:    boolean;
  st_dev_0_5:          boolean;
};

export type TimiBand = 'low' | 'intermediate' | 'high';

export type TimiResult = {
  score: number;
  band: TimiBand;
  band_label: string;
};

export function computeTimi(i: TimiInputs): TimiResult {
  let score = 0;
  if (i.age_ge_65)         score += 1;
  if (i.ge_3_risk_factors) score += 1;
  if (i.known_cad_50)      score += 1;
  if (i.asa_in_7d)         score += 1;
  if (i.severe_angina_24h) score += 1;
  if (i.elevated_markers)  score += 1;
  if (i.st_dev_0_5)        score += 1;

  // Per-score MACE bands from the original TIMI 11B/ESSENCE derivation cohorts.
  let band: TimiBand;
  let band_label: string;
  if (score <= 1)       { band = 'low';          band_label = `Low risk (${score === 0 || score === 1 ? '4.7%' : '4.7%'} 14-day MACE)`; }
  else if (score === 2) { band = 'low';          band_label = 'Low risk (8.3% 14-day MACE)'; }
  else if (score === 3) { band = 'intermediate'; band_label = 'Intermediate risk (13.2% 14-day MACE)'; }
  else if (score === 4) { band = 'intermediate'; band_label = 'Intermediate risk (19.9% 14-day MACE)'; }
  else if (score === 5) { band = 'high';         band_label = 'High risk (26.2% 14-day MACE)'; }
  else                  { band = 'high';         band_label = 'High risk (40.9% 14-day MACE)'; }

  return { score, band, band_label };
}
