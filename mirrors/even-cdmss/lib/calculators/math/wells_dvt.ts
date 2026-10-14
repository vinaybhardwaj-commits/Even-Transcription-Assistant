// CALC.v1.8 — Wells DVT score (Wells et al. 2003 modified two-tier / classic three-tier).
// 9 positives (+1 each) and 1 negative (-2). Total can range -2 to +9.

export type WellsDvtInputs = {
  active_cancer:        boolean;
  paralysis_paresis:    boolean;
  bedridden_or_surg:    boolean;
  localized_tenderness: boolean;
  entire_leg_swollen:   boolean;
  calf_swelling_3cm:    boolean;
  pitting_edema:        boolean;
  collateral_veins:     boolean;
  previous_dvt:         boolean;
  alt_dx_as_likely:     boolean;        // −2 if true
};

export type WellsDvtBand = 'low' | 'moderate' | 'high';

export type WellsDvtResult = {
  score: number;
  band: WellsDvtBand;
  band_label: string;
};

export function computeWellsDvt(i: WellsDvtInputs): WellsDvtResult {
  let score = 0;
  if (i.active_cancer)        score += 1;
  if (i.paralysis_paresis)    score += 1;
  if (i.bedridden_or_surg)    score += 1;
  if (i.localized_tenderness) score += 1;
  if (i.entire_leg_swollen)   score += 1;
  if (i.calf_swelling_3cm)    score += 1;
  if (i.pitting_edema)        score += 1;
  if (i.collateral_veins)     score += 1;
  if (i.previous_dvt)         score += 1;
  if (i.alt_dx_as_likely)     score -= 2;

  let band: WellsDvtBand;
  let band_label: string;
  if (score <= 0)      { band = 'low';      band_label = 'Low probability (~5%)'; }
  else if (score <= 2) { band = 'moderate'; band_label = 'Moderate probability (~17%)'; }
  else                 { band = 'high';     band_label = 'High probability (~53%)'; }

  return { score, band, band_label };
}
