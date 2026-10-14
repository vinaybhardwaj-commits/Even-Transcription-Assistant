// CALC.v1.8 — ABCD² (TIA → 2-day / 7-day stroke risk). Johnston et al. Lancet 2007.
// Total 0-7.

export type Abcd2ClinicalFeature = 'unilateral_weakness' | 'speech_disturbance_no_weakness' | 'other';
export type Abcd2Duration        = 'ge_60min' | '10_to_59min' | 'lt_10min';

export type Abcd2Inputs = {
  age_ge_60: boolean;
  bp_ge_140_90: boolean;
  clinical: Abcd2ClinicalFeature;
  duration: Abcd2Duration;
  diabetes: boolean;
};

export type Abcd2Band = 'low' | 'moderate' | 'high';

export type Abcd2Result = {
  score: number;
  element_points: { age: number; bp: number; clinical: number; duration: number; diabetes: number };
  band: Abcd2Band;
  band_label: string;
};

function scoreClinical(c: Abcd2ClinicalFeature): number {
  if (c === 'unilateral_weakness') return 2;
  if (c === 'speech_disturbance_no_weakness') return 1;
  return 0;
}

function scoreDuration(d: Abcd2Duration): number {
  if (d === 'ge_60min') return 2;
  if (d === '10_to_59min') return 1;
  return 0;
}

export function computeAbcd2(i: Abcd2Inputs): Abcd2Result {
  const ep = {
    age:      i.age_ge_60 ? 1 : 0,
    bp:       i.bp_ge_140_90 ? 1 : 0,
    clinical: scoreClinical(i.clinical),
    duration: scoreDuration(i.duration),
    diabetes: i.diabetes ? 1 : 0,
  };
  const score = ep.age + ep.bp + ep.clinical + ep.duration + ep.diabetes;

  let band: Abcd2Band;
  let band_label: string;
  if (score <= 3)      { band = 'low';      band_label = 'Low risk (1.0% 2-day stroke risk)'; }
  else if (score <= 5) { band = 'moderate'; band_label = 'Moderate risk (4.1% 2-day stroke risk)'; }
  else                 { band = 'high';     band_label = 'High risk (8.1% 2-day stroke risk)'; }

  return { score, element_points: ep, band, band_label };
}
