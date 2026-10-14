// CALC.v1.8 — HEART score for chest pain (Six et al. Crit Pathw Cardiol 2008).
// 5 items × 0-2 each. Total 0-10.

export type HeartHistory       = 'slightly_suspicious' | 'moderately_suspicious' | 'highly_suspicious';
export type HeartEcg           = 'normal' | 'non_specific_changes' | 'significant_st_deviation';
export type HeartAge           = 'lt_45' | '45_to_64' | 'ge_65';
export type HeartRiskFactors   = 'none' | '1_to_2' | 'ge_3_or_known_cad';
export type HeartTroponin      = 'le_normal' | '1_to_3x_normal' | 'gt_3x_normal';

export type HeartInputs = {
  history:        HeartHistory;
  ecg:            HeartEcg;
  age:            HeartAge;
  risk_factors:   HeartRiskFactors;
  troponin:       HeartTroponin;
};

export type HeartBand = 'low' | 'moderate' | 'high';

export type HeartResult = {
  score: number;
  element_points: { history: number; ecg: number; age: number; risk_factors: number; troponin: number };
  band: HeartBand;
  band_label: string;
};

function scoreHistory(h: HeartHistory): number {
  if (h === 'slightly_suspicious') return 0;
  if (h === 'moderately_suspicious') return 1;
  return 2;
}
function scoreEcg(e: HeartEcg): number {
  if (e === 'normal') return 0;
  if (e === 'non_specific_changes') return 1;
  return 2;
}
function scoreAge(a: HeartAge): number {
  if (a === 'lt_45') return 0;
  if (a === '45_to_64') return 1;
  return 2;
}
function scoreRisk(r: HeartRiskFactors): number {
  if (r === 'none') return 0;
  if (r === '1_to_2') return 1;
  return 2;
}
function scoreTrop(t: HeartTroponin): number {
  if (t === 'le_normal') return 0;
  if (t === '1_to_3x_normal') return 1;
  return 2;
}

export function computeHeart(i: HeartInputs): HeartResult {
  const ep = {
    history:      scoreHistory(i.history),
    ecg:          scoreEcg(i.ecg),
    age:          scoreAge(i.age),
    risk_factors: scoreRisk(i.risk_factors),
    troponin:     scoreTrop(i.troponin),
  };
  const score = ep.history + ep.ecg + ep.age + ep.risk_factors + ep.troponin;

  let band: HeartBand;
  let band_label: string;
  if (score <= 3)      { band = 'low';      band_label = 'Low risk (1.7% 6-week MACE — discharge candidate)'; }
  else if (score <= 6) { band = 'moderate'; band_label = 'Moderate risk (16.6% 6-week MACE — admit for further workup)'; }
  else                 { band = 'high';     band_label = 'High risk (50.1% 6-week MACE — invasive strategy)'; }

  return { score, element_points: ep, band, band_label };
}
