// CALC.v1.8 — SOFA (Sepsis-related Organ Failure Assessment), Vincent et al. Intensive Care Med 1996.
// 6 organ systems, each 0-4. Total 0-24. Optional qSOFA secondary chip.

export type SofaResp =
  | 'gt_400' | '301_400' | '201_300' | '101_200_mv' | 'le_100_mv';
export type SofaCoag =
  | 'gt_150' | '101_150' | '51_100' | '21_50' | 'le_20';
export type SofaLiver =
  | 'lt_1_2' | '1_2_to_1_9' | '2_0_to_5_9' | '6_0_to_11_9' | 'gt_12';
export type SofaCv =
  | 'map_ge_70' | 'map_lt_70' | 'dopamine_le_5_or_dobutamine'
  | 'dopamine_gt_5_or_norepi_le_0_1' | 'dopamine_gt_15_or_norepi_gt_0_1';
export type SofaCns =
  | '15' | '13_14' | '10_12' | '6_9' | 'lt_6';
export type SofaRenal =
  | 'lt_1_2' | '1_2_to_1_9' | '2_0_to_3_4' | '3_5_to_4_9_or_uo_lt_500' | 'gt_5_or_uo_lt_200';

export type SofaInputs = {
  respiration:    SofaResp;
  coagulation:    SofaCoag;
  liver:          SofaLiver;
  cardiovascular: SofaCv;
  cns:            SofaCns;
  renal:          SofaRenal;

  // Optional qSOFA — flags positive when ≥2 of 3 are true.
  qsofa_rr_ge_22:        boolean;
  qsofa_altered_mental:  boolean;
  qsofa_sbp_le_100:      boolean;
};

export type SofaBand = 'low' | 'moderate' | 'severe' | 'very_high';

export type SofaResult = {
  score: number;
  element_points: { respiration: number; coagulation: number; liver: number; cardiovascular: number; cns: number; renal: number };
  band: SofaBand;
  band_label: string;
  qsofa_score: 0 | 1 | 2 | 3;
  qsofa_positive: boolean;
};

function scoreResp(r: SofaResp): number {
  if (r === 'gt_400') return 0;
  if (r === '301_400') return 1;
  if (r === '201_300') return 2;
  if (r === '101_200_mv') return 3;
  return 4;
}
function scoreCoag(c: SofaCoag): number {
  if (c === 'gt_150') return 0;
  if (c === '101_150') return 1;
  if (c === '51_100') return 2;
  if (c === '21_50') return 3;
  return 4;
}
function scoreLiver(l: SofaLiver): number {
  if (l === 'lt_1_2') return 0;
  if (l === '1_2_to_1_9') return 1;
  if (l === '2_0_to_5_9') return 2;
  if (l === '6_0_to_11_9') return 3;
  return 4;
}
function scoreCv(c: SofaCv): number {
  if (c === 'map_ge_70') return 0;
  if (c === 'map_lt_70') return 1;
  if (c === 'dopamine_le_5_or_dobutamine') return 2;
  if (c === 'dopamine_gt_5_or_norepi_le_0_1') return 3;
  return 4;
}
function scoreCns(c: SofaCns): number {
  if (c === '15') return 0;
  if (c === '13_14') return 1;
  if (c === '10_12') return 2;
  if (c === '6_9') return 3;
  return 4;
}
function scoreRenal(r: SofaRenal): number {
  if (r === 'lt_1_2') return 0;
  if (r === '1_2_to_1_9') return 1;
  if (r === '2_0_to_3_4') return 2;
  if (r === '3_5_to_4_9_or_uo_lt_500') return 3;
  return 4;
}

export function computeSofa(i: SofaInputs): SofaResult {
  const ep = {
    respiration:    scoreResp(i.respiration),
    coagulation:    scoreCoag(i.coagulation),
    liver:          scoreLiver(i.liver),
    cardiovascular: scoreCv(i.cardiovascular),
    cns:            scoreCns(i.cns),
    renal:          scoreRenal(i.renal),
  };
  const score = ep.respiration + ep.coagulation + ep.liver + ep.cardiovascular + ep.cns + ep.renal;

  let band: SofaBand;
  let band_label: string;
  if (score <= 6)        { band = 'low';       band_label = 'Low mortality (<10%)'; }
  else if (score <= 9)   { band = 'moderate';  band_label = 'Moderate mortality (15-20%)'; }
  else if (score <= 12)  { band = 'severe';    band_label = 'Severe organ dysfunction (40-50%)'; }
  else                   { band = 'very_high'; band_label = 'Very high mortality (>50%)'; }

  const qsofa_count =
    (i.qsofa_rr_ge_22 ? 1 : 0) +
    (i.qsofa_altered_mental ? 1 : 0) +
    (i.qsofa_sbp_le_100 ? 1 : 0);
  const qsofa_score = qsofa_count as 0 | 1 | 2 | 3;
  const qsofa_positive = qsofa_count >= 2;

  return { score, element_points: ep, band, band_label, qsofa_score, qsofa_positive };
}
