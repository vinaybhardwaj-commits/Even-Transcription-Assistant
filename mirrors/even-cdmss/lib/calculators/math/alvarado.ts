// CALC.v1.8 — Alvarado (MANTRELS) score for acute appendicitis.
// Total 0-10. Tenderness in RLQ (T) and Leukocytosis (L) each contribute 2 points; rest contribute 1.

export type AlvaradoInputs = {
  migration_rlq:        boolean;  // M
  anorexia:             boolean;  // A
  nausea_vomiting:      boolean;  // N
  tenderness_rlq:       boolean;  // T   +2
  rebound_pain:         boolean;  // R
  elevated_temp:        boolean;  // E
  leukocytosis:         boolean;  // L   +2
  shift_to_left:        boolean;  // S
};

export type AlvaradoBand = 'unlikely' | 'compatible' | 'probable' | 'very_likely';

export type AlvaradoResult = {
  score: number;
  element_points: {
    migration_rlq: number; anorexia: number; nausea_vomiting: number;
    tenderness_rlq: number; rebound_pain: number; elevated_temp: number;
    leukocytosis: number; shift_to_left: number;
  };
  band: AlvaradoBand;
  band_label: string;
};

export function computeAlvarado(i: AlvaradoInputs): AlvaradoResult {
  const ep = {
    migration_rlq:    i.migration_rlq    ? 1 : 0,
    anorexia:         i.anorexia         ? 1 : 0,
    nausea_vomiting:  i.nausea_vomiting  ? 1 : 0,
    tenderness_rlq:   i.tenderness_rlq   ? 2 : 0,
    rebound_pain:     i.rebound_pain     ? 1 : 0,
    elevated_temp:    i.elevated_temp    ? 1 : 0,
    leukocytosis:     i.leukocytosis     ? 2 : 0,
    shift_to_left:    i.shift_to_left    ? 1 : 0,
  };
  const score = Object.values(ep).reduce((a, b) => a + b, 0);

  let band: AlvaradoBand;
  let band_label: string;
  if (score <= 4)      { band = 'unlikely';    band_label = 'Appendicitis unlikely — consider discharge'; }
  else if (score <= 6) { band = 'compatible';  band_label = 'Appendicitis compatible — observe'; }
  else if (score <= 8) { band = 'probable';    band_label = 'Appendicitis probable — surgical consult'; }
  else                 { band = 'very_likely'; band_label = 'Appendicitis very likely — surgery'; }

  return { score, element_points: ep, band, band_label };
}
