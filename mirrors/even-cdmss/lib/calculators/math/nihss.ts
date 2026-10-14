// CALC.v1.8 — NIHSS (NIH Stroke Scale). 11 items, total 0-42.
// Source: NINDS / AHA Stroke Scale, current ASA training packet.
// All inputs are integer enums; total is the simple sum.

export type NihssInputs = {
  loc:               0 | 1 | 2 | 3;        // 1a level of consciousness
  loc_questions:     0 | 1 | 2;            // 1b month + age
  loc_commands:      0 | 1 | 2;            // 1c open/close eyes + grip
  gaze:              0 | 1 | 2;
  visual_fields:     0 | 1 | 2 | 3;
  facial_palsy:      0 | 1 | 2 | 3;
  motor_arm_left:    0 | 1 | 2 | 3 | 4;
  motor_arm_right:   0 | 1 | 2 | 3 | 4;
  motor_leg_left:    0 | 1 | 2 | 3 | 4;
  motor_leg_right:   0 | 1 | 2 | 3 | 4;
  limb_ataxia:       0 | 1 | 2;
  sensory:           0 | 1 | 2;
  language:          0 | 1 | 2 | 3;
  dysarthria:        0 | 1 | 2;
  extinction:        0 | 1 | 2;
};

export type NihssBand = 'no_stroke' | 'minor' | 'moderate' | 'moderate_severe' | 'severe';

export type NihssResult = {
  score: number;
  band: NihssBand;
  band_label: string;
};

export function computeNihss(i: NihssInputs): NihssResult {
  const score =
    i.loc + i.loc_questions + i.loc_commands +
    i.gaze + i.visual_fields + i.facial_palsy +
    i.motor_arm_left + i.motor_arm_right +
    i.motor_leg_left + i.motor_leg_right +
    i.limb_ataxia + i.sensory + i.language + i.dysarthria + i.extinction;

  // Standard NINDS-derived severity bands.
  let band: NihssBand;
  let band_label: string;
  if (score === 0)        { band = 'no_stroke';       band_label = 'No stroke symptoms'; }
  else if (score <= 4)    { band = 'minor';           band_label = 'Minor stroke'; }
  else if (score <= 15)   { band = 'moderate';        band_label = 'Moderate stroke'; }
  else if (score <= 20)   { band = 'moderate_severe'; band_label = 'Moderate to severe stroke'; }
  else                    { band = 'severe';          band_label = 'Severe stroke'; }

  return { score, band, band_label };
}
