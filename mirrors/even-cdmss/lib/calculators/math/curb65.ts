// CALC.v1.8 — CURB-65, community-acquired pneumonia severity (Lim et al. Thorax 2003).
// Total 0-5. Mortality bands per BTS.

export type Curb65Inputs = {
  confusion: boolean;        // new disorientation OR AMTS ≤8
  urea_high: boolean;        // urea >7 mmol/L (BUN >19 mg/dL)
  rr_ge_30:  boolean;
  bp_low:    boolean;        // SBP <90 OR DBP ≤60
  age_ge_65: boolean;
};

export type Curb65Band = 'outpatient' | 'short_inpatient' | 'hospitalize_consider_icu';

export type Curb65Result = {
  score: number;
  element_points: { confusion: number; urea: number; rr: number; bp: number; age: number };
  band: Curb65Band;
  band_label: string;
};

export function computeCurb65(i: Curb65Inputs): Curb65Result {
  const ep = {
    confusion: i.confusion ? 1 : 0,
    urea:      i.urea_high ? 1 : 0,
    rr:        i.rr_ge_30  ? 1 : 0,
    bp:        i.bp_low    ? 1 : 0,
    age:       i.age_ge_65 ? 1 : 0,
  };
  const score = ep.confusion + ep.urea + ep.rr + ep.bp + ep.age;

  let band: Curb65Band;
  let band_label: string;
  if (score <= 1)      { band = 'outpatient';              band_label = 'Outpatient treatment (low mortality 1.5%)'; }
  else if (score === 2){ band = 'short_inpatient';         band_label = 'Short inpatient or supervised outpatient (mortality 9.2%)'; }
  else                 { band = 'hospitalize_consider_icu';band_label = 'Hospitalize, consider ICU (mortality 22%)'; }

  return { score, element_points: ep, band, band_label };
}
