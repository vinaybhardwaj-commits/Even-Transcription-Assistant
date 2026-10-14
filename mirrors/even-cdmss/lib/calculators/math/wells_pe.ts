// CALC.v1.8 — Wells PE score (Wells et al. Ann Intern Med 2001 / 2006 simplification still in use).
// Decimal weights. Both three-tier and two-tier bands reported.

export type WellsPeInputs = {
  dvt_signs:           boolean;   // +3
  pe_most_likely_dx:   boolean;   // +3
  hr_gt_100:           boolean;   // +1.5
  immob_or_surgery:    boolean;   // +1.5
  prior_dvt_or_pe:     boolean;   // +1.5
  hemoptysis:          boolean;   // +1
  malignancy:          boolean;   // +1
};

export type WellsPeThreeTier = 'low' | 'moderate' | 'high';
export type WellsPeTwoTier   = 'unlikely' | 'likely';

export type WellsPeResult = {
  score: number;                  // floats permitted (e.g. 4.5)
  three_tier: WellsPeThreeTier;
  three_tier_label: string;
  two_tier: WellsPeTwoTier;
  two_tier_label: string;
};

export function computeWellsPe(i: WellsPeInputs): WellsPeResult {
  let s = 0;
  if (i.dvt_signs)         s += 3;
  if (i.pe_most_likely_dx) s += 3;
  if (i.hr_gt_100)         s += 1.5;
  if (i.immob_or_surgery)  s += 1.5;
  if (i.prior_dvt_or_pe)   s += 1.5;
  if (i.hemoptysis)        s += 1;
  if (i.malignancy)        s += 1;

  // Avoid binary-float oddities (3 × 1.5 = 4.5 reliably, but show 0.5-step rounding).
  const score = Math.round(s * 10) / 10;

  let three_tier: WellsPeThreeTier;
  let three_tier_label: string;
  if (score < 2)      { three_tier = 'low';      three_tier_label = 'Low pretest probability (~3.6%)'; }
  else if (score <= 6){ three_tier = 'moderate'; three_tier_label = 'Moderate pretest probability (~20.5%)'; }
  else                { three_tier = 'high';     three_tier_label = 'High pretest probability (~66.7%)'; }

  let two_tier: WellsPeTwoTier;
  let two_tier_label: string;
  if (score <= 4)     { two_tier = 'unlikely';   two_tier_label = 'PE unlikely (consider PERC / D-dimer)'; }
  else                { two_tier = 'likely';     two_tier_label = 'PE likely (CTPA)'; }

  return { score, three_tier, three_tier_label, two_tier, two_tier_label };
}
