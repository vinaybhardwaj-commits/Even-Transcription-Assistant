// CALC.2 — NEWS2 math per Royal College of Physicians 2017 standard.
// Pure functions, no LLM, no IO.

export type Spo2Scale = 1 | 2;
export type Consciousness = 'A' | 'V' | 'P' | 'U' | 'C';   // C = new-onset confusion (NEWS2 2017)

export type News2Inputs = {
  rr: number;                          // breaths/min
  spo2_scale: Spo2Scale;               // 1 = standard; 2 = target 88-92% (COPD/Type 2 RF)
  spo2: number;                        // %
  o2_supp: boolean;                    // on supplemental O2
  temp_c: number;                      // °C
  sbp: number;                         // mmHg
  hr: number;                          // bpm
  consciousness: Consciousness;
};

export type News2ElementPoints = {
  rr: number;
  spo2: number;
  o2_supp: number;
  temp: number;
  sbp: number;
  hr: number;
  consciousness: number;
};

export type News2Band = 'low' | 'low-medium' | 'medium' | 'high';

export type News2Result = {
  score: number;                       // 0-20 typical
  band: News2Band;
  element_points: News2ElementPoints;
  any_single_three: boolean;           // single parameter scoring 3 — bumps low to medium per NEWS2 2017
};

// ---------- per-element scorers ----------

function scoreRr(rr: number): number {
  if (rr <= 8) return 3;
  if (rr <= 11) return 1;
  if (rr <= 20) return 0;
  if (rr <= 24) return 2;
  return 3;
}

function scoreSpo2Scale1(spo2: number): number {
  if (spo2 <= 91) return 3;
  if (spo2 <= 93) return 2;
  if (spo2 <= 95) return 1;
  return 0;
}

// Scale 2 (target 88-92%, typically COPD with chronic CO2 retention).
// Per the RCP NEWS2 2017 chart: depends on whether O2 is being given when SpO2 ≥93.
function scoreSpo2Scale2(spo2: number, o2_supp: boolean): number {
  if (spo2 <= 83) return 3;
  if (spo2 <= 85) return 2;
  if (spo2 <= 87) return 1;
  if (spo2 <= 92) return 0;
  // 93+ scoring depends on O2 status. On air, target is met → 0. On O2, supratherapeutic.
  if (!o2_supp) return 0;
  if (spo2 <= 94) return 1;
  if (spo2 <= 96) return 2;
  return 3;
}

function scoreO2Supp(o2_supp: boolean): number {
  return o2_supp ? 2 : 0;
}

function scoreTemp(temp_c: number): number {
  if (temp_c <= 35.0) return 3;
  if (temp_c <= 36.0) return 1;
  if (temp_c <= 38.0) return 0;
  if (temp_c <= 39.0) return 1;
  return 2;
}

function scoreSbp(sbp: number): number {
  if (sbp <= 90) return 3;
  if (sbp <= 100) return 2;
  if (sbp <= 110) return 1;
  if (sbp <= 219) return 0;
  return 3;
}

function scoreHr(hr: number): number {
  if (hr <= 40) return 3;
  if (hr <= 50) return 1;
  if (hr <= 90) return 0;
  if (hr <= 110) return 1;
  if (hr <= 130) return 2;
  return 3;
}

function scoreConsciousness(c: Consciousness): number {
  return c === 'A' ? 0 : 3;  // any deviation from Alert (including new-onset confusion C) scores 3
}

// ---------- combiner ----------

export function computeNews2(inputs: News2Inputs): News2Result {
  const ep: News2ElementPoints = {
    rr: scoreRr(inputs.rr),
    spo2: inputs.spo2_scale === 2 ? scoreSpo2Scale2(inputs.spo2, inputs.o2_supp) : scoreSpo2Scale1(inputs.spo2),
    o2_supp: scoreO2Supp(inputs.o2_supp),
    temp: scoreTemp(inputs.temp_c),
    sbp: scoreSbp(inputs.sbp),
    hr: scoreHr(inputs.hr),
    consciousness: scoreConsciousness(inputs.consciousness),
  };
  const score = ep.rr + ep.spo2 + ep.o2_supp + ep.temp + ep.sbp + ep.hr + ep.consciousness;
  const any_single_three = Object.values(ep).some((v) => v === 3);

  // RCP NEWS2 2017 risk bands:
  //   0           → low
  //   1-4         → low-medium (escalate to nurse-in-charge if any single param = 3)
  //   5-6         → medium (urgent registrar review)
  //   ≥7          → high (emergency response)
  // Any single parameter scoring 3 bumps low-medium to medium per the RCP escalation algorithm.
  let band: News2Band;
  if (score === 0) band = 'low';
  else if (score <= 4) band = any_single_three ? 'medium' : 'low-medium';
  else if (score <= 6) band = 'medium';
  else band = 'high';

  return { score, band, element_points: ep, any_single_three };
}


// ---------- Element direction labels (for LLM prompt + UI) ----------
// PRD CALC.2 fixup: NEWS2 penalizes deviation in BOTH directions for several elements
// (Temp, SBP, HR, RR), so a points value alone doesn't tell you which way to look.
// Naming the direction prevents the llama interpretation from mis-describing a
// hypothermic patient as having a high temperature.

export function elementDirectionLabels(i: News2Inputs): Record<string, string> {
  const rr = i.rr <= 8 ? 'bradypnea' : i.rr >= 21 ? 'tachypnea' : 'normal';
  const spo2 = i.spo2 <= 95 ? 'hypoxemia' : 'normal';
  const temp = i.temp_c <= 35.0 ? 'severe hypothermia' : i.temp_c <= 36.0 ? 'mild hypothermia' : i.temp_c <= 38.0 ? 'normothermic' : i.temp_c <= 39.0 ? 'low-grade fever' : 'high fever';
  const sbp = i.sbp <= 90 ? 'hypotension' : i.sbp <= 110 ? 'low-normal' : i.sbp <= 219 ? 'normal' : 'hypertensive crisis range';
  const hr = i.hr <= 40 ? 'severe bradycardia' : i.hr <= 50 ? 'bradycardia' : i.hr <= 90 ? 'normal' : i.hr <= 110 ? 'mild tachycardia' : i.hr <= 130 ? 'tachycardia' : 'severe tachycardia';
  const cs = i.consciousness === 'A' ? 'alert' : i.consciousness === 'V' ? 'responsive to voice' : i.consciousness === 'P' ? 'responsive to pain only' : i.consciousness === 'U' ? 'unresponsive' : 'new-onset confusion';
  return { rr, spo2, temp, sbp, hr, consciousness: cs };
}
