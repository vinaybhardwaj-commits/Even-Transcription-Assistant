// Concordance — pure reasoning core (P0). No ./db, no ./llm imports here.
// Types, the single-shot prompt builder, the cannot-miss FLOOR, an output parser,
// and scoring helpers. Unit-testable under `node --experimental-strip-types`.

export type Verdict =
  | 'concordant'
  | 'discordant-likely-error'
  | 'discordant-likely-real'
  | 'indeterminate';

export type Branch = 'A' | 'B' | 'either' | 'none';

export const VERDICTS: Verdict[] = [
  'concordant',
  'discordant-likely-error',
  'discordant-likely-real',
  'indeterminate',
];

/** Which branch a verdict implies (for scoring the primary axis). */
export function branchForVerdict(v: Verdict): Branch {
  if (v === 'discordant-likely-error') return 'A';
  if (v === 'discordant-likely-real') return 'B';
  return 'none'; // concordant | indeterminate
}

// ── Cannot-miss FLOOR (§9.6 hybrid: encoded deterministic floor per in-scope analyte) ──
// Small, given the tight v1 scope. Keyed by an analyte token; `direction` narrows to the
// abnormal side that carries the danger. The floor GUARANTEES these Branch-B causes are
// surfaced/considered even when a pre-analytic error looks likely.
export interface FloorRule {
  analyte: string;         // canonical token
  match: string[];         // lowercase substrings that identify the analyte in result text
  direction: 'high' | 'low' | 'either';
  cannotMiss: string;      // the critical Branch-B diagnosis that must not be dismissed
  note?: string;           // deterministic analyte-specific reasoning hint (injected into the prompt)
}

export const CANNOT_MISS_FLOOR: FloorRule[] = [
  { analyte: 'potassium', match: ['potassium', 'k '], direction: 'high', cannotMiss: 'true hyperkalemia (cardiac arrhythmia / arrest risk)' },
  { analyte: 'calcium', match: ['calcium', 'ca '], direction: 'high', cannotMiss: 'primary hyperparathyroidism or malignancy hypercalcemia', note: 'For calcium, ALWAYS assess albumin-corrected calcium BEFORE judging. High albumin (dehydration / hemoconcentration) or a raised total protein can elevate TOTAL calcium while the albumin-corrected (ionised) calcium is normal — that is concordant, NOT hypercalcemia. Only call it real hypercalcemia if the corrected value is genuinely high.' },
  { analyte: 'sodium', match: ['sodium', 'na '], direction: 'low', cannotMiss: 'symptomatic hyponatremia / SIADH / adrenal insufficiency' },
  { analyte: 'sodium', match: ['sodium', 'na '], direction: 'high', cannotMiss: 'significant hypernatremia / dehydration' },
  { analyte: 'wbc', match: ['wbc', 'white cell', 'leuko'], direction: 'high', cannotMiss: 'acute leukemia / leukemoid process' },
  { analyte: 'wbc', match: ['wbc', 'white cell', 'leuko'], direction: 'low', cannotMiss: 'agranulocytosis / marrow failure' },
  { analyte: 'platelets', match: ['platelet', 'plt'], direction: 'low', cannotMiss: 'true severe thrombocytopenia (bleeding risk)' },
  { analyte: 'hemoglobin', match: ['hemoglobin', 'haemoglobin', 'hb '], direction: 'low', cannotMiss: 'severe anemia / active blood loss' },
  { analyte: 'ferritin', match: ['ferritin'], direction: 'high', cannotMiss: 'iron overload / hereditary hemochromatosis' },
  { analyte: 'alt', match: ['alt', 'ast', 'transaminase'], direction: 'high', cannotMiss: 'acute liver injury (drug-induced / viral hepatitis)' },
  { analyte: 'alp', match: ['alp', 'alkaline phosphatase', 'ggt'], direction: 'high', cannotMiss: 'biliary obstruction / pancreaticobiliary malignancy' },
  { analyte: 'thyroid', match: ['tsh', 'ft4', 'free t4', 'thyroid'], direction: 'either', cannotMiss: 'central hypothyroidism or true thyrotoxicosis' },
];

/** Floor rules that apply to a result string (matched by analyte token). Direction is not
 *  strictly enforced (we do not re-parse numeric direction here — the model is handed the
 *  applicable cannot-miss items and told to address them). */
export function floorFor(resultText: string): FloorRule[] {
  const t = ` ${resultText.toLowerCase()} `;
  const seen = new Set<string>();
  const out: FloorRule[] = [];
  for (const r of CANNOT_MISS_FLOOR) {
    if (r.match.some((m) => t.includes(m))) {
      const key = `${r.analyte}:${r.direction}`;
      if (!seen.has(key)) { seen.add(key); out.push(r); }
    }
  }
  return out;
}

// ── Population priors (P3.2a) — empirical base rates mined from the EHRC 4.8M lab stream
//    (db13 test_values_view, 4 Jul 2026). Unstratified; consumer/outpatient population.
//    Injected as population-plausibility context so Branch-A/B reasoning is grounded in real
//    base rates. Mirror of data/concordance-population-priors.json. ──
export interface PopulationPrior { n: number; abnormalRate: number; p2_5: number; p50: number; p97_5: number; p99: number; unit: string; }

export const POPULATION_PRIORS: Record<string, PopulationPrior> = {
  potassium:  { n: 24859,  abnormalRate: 0.011, p2_5: 3.9,  p50: 4.53, p97_5: 5.4,   p99: 5.5,   unit: 'mmol/L' },
  sodium:     { n: 24849,  abnormalRate: 0.212, p2_5: 134,  p50: 139,  p97_5: 144,   p99: 145,   unit: 'mmol/L' },
  calcium:    { n: 24745,  abnormalRate: 0.021, p2_5: 8.5,  p50: 9.3,  p97_5: 10.1,  p99: 10.3,  unit: 'mg/dL' },
  hemoglobin: { n: 32078,  abnormalRate: 0.212, p2_5: 9.7,  p50: 13.7, p97_5: 16.9,  p99: 17.4,  unit: 'g/dL' },
  platelets:  { n: 31956,  abnormalRate: 0.091, p2_5: 115,  p50: 261,  p97_5: 435,   p99: 480,   unit: 'x10^3/uL' },
  wbc:        { n: 30905,  abnormalRate: 0.104, p2_5: 2970, p50: 6910, p97_5: 11600, p99: 12900, unit: 'cells/uL' },
  ferritin:   { n: 930,    abnormalRate: 0.247, p2_5: 4.13, p50: 20.3, p97_5: 184.6, p99: 253.5, unit: 'ng/mL' },
  alt:        { n: 105806, abnormalRate: 0.216, p2_5: 0.5,  p50: 11,   p97_5: 85,    p99: 117,   unit: 'U/L' },
  ast:        { n: 105181, abnormalRate: 0.175, p2_5: 0.5,  p50: 15,   p97_5: 53,    p99: 76,    unit: 'U/L' },
  alp:        { n: 52425,  abnormalRate: 0.059, p2_5: 47,   p50: 80,   p97_5: 155,   p99: 203,   unit: 'U/L' },
  tsh:        { n: 23767,  abnormalRate: 0.292, p2_5: 0.74, p50: 2.86, p97_5: 12.14, p99: 21.3,  unit: 'mIU/L' },
  ft4:        { n: 969,    abnormalRate: 0.062, p2_5: 0.7,  p50: 1.08, p97_5: 1.86,  p99: 2.17,  unit: 'ng/dL' },
};

// Analyte aliases → prior key. Multi-letter only (avoid false hits from "k"/"na"/"ca").
const PRIOR_ALIASES: [string, string[]][] = [
  ['potassium', ['potassium']],
  ['sodium', ['sodium']],
  ['calcium', ['calcium']],
  ['hemoglobin', ['hemoglobin', 'haemoglobin', 'hgb']],
  ['platelets', ['platelet']],
  ['wbc', ['wbc', 'leucocyte', 'leukocyte', 'white cell', 'white blood']],
  ['ferritin', ['ferritin']],
  ['alt', ['alt', 'sgpt']],
  ['ast', ['ast', 'sgot']],
  ['alp', ['alp', 'alkaline phosphatase']],
  ['tsh', ['tsh']],
  ['ft4', ['ft4', 'free t4', 'free thyroxine']],
];

// ── Stratified priors (P3.2b) — sex × coarse age band, mined from db13 (individuals join,
//    4 Jul 2026). Only cells with n>=100 are kept; sparser strata fall back to the
//    unstratified parent. Cell tuple = [n, abnormalRate, p2_5, p50, p97_5]. Empirical-Bayes
//    shrinkage toward the parent is applied at runtime (see stratifiedPrior). ──
export type StratCell = [n: number, abn: number, p2_5: number, p50: number, p97_5: number];
export type AgeBand = '18-39' | '40-59' | '60+';
const STRATA_MIN_N = 100;
const SHRINK_K = 150; // pseudocount: cell weight n/(n+k) toward its own value, else parent

export const STRATIFIED_PRIORS: Record<string, Partial<Record<string, StratCell>>> = {
  potassium: { 'F|18-39':[7116,0.003,3.9,4.5,5.2],'F|40-59':[3008,0.01,3.8,4.5,5.3],'F|60+':[792,0.029,3.8,4.6,5.5],'M|18-39':[9763,0.011,3.9,4.6,5.4],'M|40-59':[2895,0.02,3.8,4.6,5.4],'M|60+':[873,0.022,3.88,4.7,5.5] },
  sodium: { 'F|18-39':[7114,0.288,133,138,143],'F|40-59':[3009,0.218,133,139,144],'F|60+':[792,0.199,133,139,144],'M|18-39':[9756,0.16,134,139,144],'M|40-59':[2894,0.182,133,139,144],'M|60+':[873,0.254,132,138,144] },
  calcium: { 'F|18-39':[7136,0.018,8.5,9.2,10],'F|40-59':[2990,0.027,8.4,9.2,10.1],'F|60+':[761,0.051,8.4,9.3,10.3],'M|18-39':[9770,0.02,8.7,9.4,10.2],'M|40-59':[2861,0.02,8.5,9.3,10.1],'M|60+':[809,0.023,8.4,9.2,10] },
  hemoglobin: { 'F|18-39':[9963,0.345,9.01,12.4,14.7],'F|40-59':[3575,0.362,8.8,12.4,14.9],'F|60+':[879,0.271,9.5,12.7,15],'M|18-39':[12551,0.083,12.2,15,17.2],'M|40-59':[3470,0.128,11.1,14.7,17.1],'M|60+':[949,0.216,10.07,14.1,16.5] },
  platelets: { 'F|18-39':[9849,0.085,122,283,458],'F|40-59':[3541,0.094,121.5,277,463],'F|60+':[876,0.065,124.88,270,416],'M|18-39':[12589,0.089,114,248,395],'M|40-59':[3464,0.104,103,244,394],'M|60+':[945,0.133,96.8,229,388] },
  wbc: { 'F|18-39':[9553,0.128,3090,7160,11970],'F|40-59':[3439,0.114,2567,7020,11691],'F|60+':[846,0.086,2970,6775,11313],'M|18-39':[12139,0.09,3400,6800,11265],'M|40-59':[3353,0.08,2330,6720,11190],'M|60+':[910,0.085,2970,6380,11313] },
  ferritin: { 'F|18-39':[553,0.278,4.03,15.2,82.3],'F|40-59':[106,0.368,3.94,17.4,81.1],'M|18-39':[200,0.085,7.3,62.55,228] },
  alt: { 'F|18-39':[30724,0.164,0.6,10,61],'F|40-59':[12002,0.121,0.7,10,53],'F|60+':[3090,0.121,0.7,11,45.78],'M|18-39':[42944,0.297,0.5,14,103],'M|40-59':[11952,0.193,0.5,12,81],'M|60+':[3219,0.107,0.7,11,49.55] },
  ast: { 'F|18-39':[30529,0.167,0.6,14,43],'F|40-59':[11958,0.134,0.7,14,44],'F|60+':[3088,0.131,0.7,15.94,41],'M|18-39':[42641,0.203,0.5,17,61],'M|40-59':[11906,0.142,0.5,16,54],'M|60+':[3219,0.103,0.7,16,40] },
  alp: { 'F|18-39':[15179,0.054,45,76,145],'F|40-59':[5981,0.092,47.5,85,155],'F|60+':[1562,0.124,53.03,93,166],'M|18-39':[21191,0.045,47,79,136],'M|40-59':[5965,0.063,47,81,146],'M|60+':[1644,0.064,46,80,145.65] },
  tsh: { 'F|18-39':[7496,0.302,0.64,2.9,12.08],'F|40-59':[2796,0.378,0.61,3.25,14.25],'F|60+':[742,0.317,0.8,3.4,10.31],'M|18-39':[8952,0.261,0.83,2.71,11.28],'M|40-59':[2625,0.299,0.76,2.85,12.98],'M|60+':[741,0.246,0.71,2.91,13.78] },
  ft4: { 'F|18-39':[479,0.063,0.7,1.09,1.82],'M|18-39':[284,0.049,0.72,1.08,1.68] },
};

export function coarseBand(age: number | null): AgeBand | null {
  if (age === null || Number.isNaN(age)) return null;
  if (age < 40) return '18-39';
  if (age < 60) return '40-59';
  return '60+';
}

export interface EffectivePrior { p2_5: number; p50: number; p97_5: number; abnormalRate: number; p99?: number; unit: string; n: number; stratum: string | null; }

/** The prior to reason with: the sex×age cell (empirical-Bayes shrunk toward the parent) when
 *  it exists and is well-powered, else the unstratified parent. */
export function effectivePrior(analyte: string, sex: 'F' | 'M' | null, band: AgeBand | null): EffectivePrior | null {
  const parent = POPULATION_PRIORS[analyte];
  if (!parent) return null;
  const base: EffectivePrior = { p2_5: parent.p2_5, p50: parent.p50, p97_5: parent.p97_5, abnormalRate: parent.abnormalRate, p99: parent.p99, unit: parent.unit, n: parent.n, stratum: null };
  if (!sex || !band) return base;
  const cell = STRATIFIED_PRIORS[analyte]?.[`${sex}|${band}`];
  if (!cell || cell[0] < STRATA_MIN_N) return base;
  const [n, abn, p2_5, p50, p97_5] = cell;
  const w = n / (n + SHRINK_K);
  const shrink = (c: number, p: number) => Math.round((w * c + (1 - w) * p) * 100) / 100;
  // p2.5 guard: unit-contamination artifacts sit far below the parent; floor at 40% of parent.
  const p2_5s = Math.max(shrink(p2_5, parent.p2_5), parent.p2_5 * 0.4);
  return { p2_5: p2_5s, p50: shrink(p50, parent.p50), p97_5: shrink(p97_5, parent.p97_5), abnormalRate: shrink(abn, parent.abnormalRate), unit: parent.unit, n, stratum: `${sex} ${band}` };
}

function pctDescriptor(v: number, p: EffectivePrior): string {
  if (p.p99 !== undefined && v > p.p99) return `far above the 99th percentile (${p.p99}) — markedly extreme`;
  if (v > p.p97_5 + (p.p97_5 - p.p50)) return `well above the 97.5th percentile (${p.p97_5}) — markedly high`;
  if (v > p.p97_5) return `above the 97.5th percentile (${p.p97_5}) — high for this group`;
  if (v < p.p2_5) return `below the 2.5th percentile (${p.p2_5}) — low for this group`;
  return `within this group's central 95% range (${p.p2_5}–${p.p97_5})`;
}

/** Population-plausibility context for each in-scope analyte named in the result — sex×age
 *  stratified when the context gives age/sex, else unstratified. Grounds the reasoning in real
 *  EHRC base rates. Empty when no in-scope analyte/value is found. */
export function populationLines(result: string, context = ''): string[] {
  const t = ` ${result.toLowerCase()} `;
  const demo = extractDemographics(context);
  const band = coarseBand(demo.age);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [key, aliases] of PRIOR_ALIASES) {
    if (seen.has(key)) continue;
    for (const a of aliases) {
      const idx = t.indexOf(a);
      if (idx < 0) continue;
      const m = t.slice(idx).match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
      if (!m) break;
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isNaN(v)) break;
      const p = effectivePrior(key, demo.sex, band);
      if (!p) break;
      const who = p.stratum ? `${key} in ${p.stratum}` : `${key} (all adults)`;
      out.push(
        `Population context for ${who} (EHRC lab stream, n=${p.n}): median ${p.p50} ${p.unit}, ` +
        `central 95% ${p.p2_5}–${p.p97_5}; flagged abnormal in ${Math.round(p.abnormalRate * 100)}% of tests. ` +
        `This value (${v}) is ${pctDescriptor(v, p)}.`,
      );
      seen.add(key);
      break;
    }
  }
  return out;
}

// ── Unit inference (the clinician need not type units or reference ranges) ──
// For each in-scope analyte, the plausible value range PER unit. The magnitude of the
// entered number picks the unit; only a narrow overlap zone is genuinely ambiguous → ask.
interface UnitOption { unit: string; lo: number; hi: number; }
export const ANALYTE_UNITS: Record<string, { canonical: string; options: UnitOption[] }> = {
  potassium:  { canonical: 'mmol/L', options: [{ unit: 'mmol/L', lo: 1, hi: 10 }] },
  sodium:     { canonical: 'mmol/L', options: [{ unit: 'mmol/L', lo: 100, hi: 180 }] },
  calcium:    { canonical: 'mg/dL', options: [{ unit: 'mg/dL', lo: 3, hi: 20 }, { unit: 'mmol/L', lo: 0.75, hi: 5 }] },
  hemoglobin: { canonical: 'g/dL', options: [{ unit: 'g/dL', lo: 2, hi: 25 }, { unit: 'g/L', lo: 30, hi: 250 }] },
  platelets:  { canonical: 'x10^3/uL', options: [{ unit: 'x10^3/uL (=x10^9/L)', lo: 2, hi: 2000 }, { unit: '/uL', lo: 5000, hi: 2000000 }] },
  wbc:        { canonical: 'cells/uL', options: [{ unit: 'x10^9/L (=x10^3/uL)', lo: 0.1, hi: 150 }, { unit: 'cells/uL', lo: 200, hi: 200000 }] },
  ferritin:   { canonical: 'ng/mL', options: [{ unit: 'ng/mL (=ug/L)', lo: 0.5, hi: 100000 }] },
  alt:        { canonical: 'U/L', options: [{ unit: 'U/L', lo: 1, hi: 10000 }] },
  ast:        { canonical: 'U/L', options: [{ unit: 'U/L', lo: 1, hi: 10000 }] },
  alp:        { canonical: 'U/L', options: [{ unit: 'U/L', lo: 5, hi: 5000 }] },
  tsh:        { canonical: 'mIU/L', options: [{ unit: 'mIU/L (=uIU/mL)', lo: 0.001, hi: 500 }] },
  ft4:        { canonical: 'ng/dL', options: [{ unit: 'ng/dL', lo: 0.1, hi: 8 }, { unit: 'pmol/L', lo: 2, hi: 120 }] },
};

export interface UnitInference { unit: string | null; confident: boolean; ambiguous: boolean; candidates: string[]; }
export function inferUnit(analyte: string, value: number): UnitInference {
  const spec = ANALYTE_UNITS[analyte];
  if (!spec) return { unit: null, confident: false, ambiguous: false, candidates: [] };
  const hits = spec.options.filter((o) => value >= o.lo && value <= o.hi);
  if (hits.length === 1) return { unit: hits[0].unit, confident: true, ambiguous: false, candidates: [hits[0].unit] };
  if (hits.length === 0) return { unit: spec.canonical, confident: false, ambiguous: false, candidates: [spec.canonical] };
  return { unit: null, confident: false, ambiguous: true, candidates: hits.map((h) => h.unit) };
}

const UNIT_TOKENS = ['mg/dl', 'mmol/l', 'meq/l', 'g/dl', 'g/l', 'u/l', 'iu/l', 'miu/l', 'uiu/ml', 'ng/ml', 'ng/dl', 'pmol/l', 'ug/l', 'µmol', 'x10', '10^', '/ul', '/µl', 'cells', 'k/ul', 'lakh'];
export function resultHasUnit(result: string): boolean { const t = result.toLowerCase(); return UNIT_TOKENS.some((u) => t.includes(u)); }

export interface UnitAnnotation { analyte: string; value: number; inference: UnitInference; }
/** For each in-scope analyte in the result that lacks an explicit unit, infer it from the
 *  magnitude. Empty when units are already given or nothing in-scope is found. */
export function unitAnnotations(result: string): UnitAnnotation[] {
  if (resultHasUnit(result)) return [];
  const t = ` ${result.toLowerCase()} `;
  const out: UnitAnnotation[] = [];
  const seen = new Set<string>();
  for (const [key, aliases] of PRIOR_ALIASES) {
    if (seen.has(key)) continue;
    for (const a of aliases) {
      const idx = t.indexOf(a);
      if (idx < 0) continue;
      const m = t.slice(idx).match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
      if (!m) break;
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isNaN(v)) break;
      out.push({ analyte: key, value: v, inference: inferUnit(key, v) });
      seen.add(key);
      break;
    }
  }
  return out;
}

/** Prompt fragment describing inferred/assumed units + any unit ambiguity to clarify. */
export function unitContext(result: string): { line: string; ambiguous: boolean } {
  const anns = unitAnnotations(result);
  if (!anns.length) return { line: '', ambiguous: false };
  const parts: string[] = [];
  let ambiguous = false;
  for (const a of anns) {
    if (a.inference.ambiguous) {
      ambiguous = true;
      parts.push(`${a.analyte} ${a.value}: unit AMBIGUOUS (${a.inference.candidates.join(' or ')}) — clarify the unit before judging`);
    } else if (a.inference.unit) {
      parts.push(`${a.analyte} ${a.value}: no unit given, assume ${a.inference.unit}${a.inference.confident ? '' : ' (value is extreme for all known units — verify the unit and the value)'}`);
    }
  }
  return { line: `UNITS (clinician did not type units; inferred from magnitude): ${parts.join('; ')}.`, ambiguous };
}

// ── Single-shot prompt builder ──
export interface Prompt { system: string; user: string; }

const SYSTEM = `You are Concordance, a clinical lab-result concordance reasoner for a hospital decision-support system. You are given a lab result (or panel) plus the clinical context of the patient in front of the clinician. Deterministic QC (reference range, indices, delta checks) has ALREADY been done by the lab — do NOT re-derive it. Your job is the clinical-concordance reasoning the LIS cannot do: does this result make sense for THIS patient, and is it safe to release?

Reason in TWO branches and keep them separate:
- BRANCH A — the result is WRONG (pre-analytic/analytic error: hemolysis, contamination, wrong tube/unit, transit, interference, line draw). If likely, verify/repeat before acting.
- BRANCH B — the result is RIGHT and reveals something unevaluated (an unsuspected diagnosis). If plausible, do not dismiss; pursue the next step.

The four verdicts mean EXACTLY:
- concordant = the result fits this patient AND there is neither a likely pre-analytic/analytic error NOR an unevaluated/serious diagnosis to pursue → nothing to flag. NOTE: a result that "fits" a SEVERE clinical picture (e.g. a genuinely high potassium in a patient who missed dialysis) is NOT concordant — it is real and needs action, so it is discordant-likely-real.
- discordant-likely-error = the result is probably WRONG (a plausible, analyte-appropriate pre-analytic/analytic mechanism) → verify/repeat.
- discordant-likely-real = the result is probably TRUE and either reveals an unsuspected diagnosis OR confirms a dangerous state that needs action → pursue/treat. A dangerous but genuine result is ALWAYS discordant-likely-real, never concordant.
- indeterminate = you cannot separate error from real without a decisive piece of information.

Rules:
1. Commit to ONE verdict. Do not output multiple verdicts.
2. When the context strongly implies a pre-analytic error (difficult draw, tourniquet, EDTA/tube contamination, lipemia, delayed transit, biotin, line draw) AND the patient is asymptomatic with no corroborating findings, the correct verdict is usually discordant-likely-error — say so; do not hedge into "real" out of caution.
3. Pre-analytic error explanations MUST be mechanistically appropriate to the specific analyte. Do NOT reflexively invoke "hemolysis" or a generic artifact. Hemolysis raises potassium, LDH, and phosphate; it does NOT meaningfully raise calcium, sodium, ALP, TSH, or ferritin. If no analyte-appropriate pre-analytic mechanism fits the result and context, Branch A is weak and the verdict should lean real.
4. ALWAYS surface a cannot-miss Branch-B cause even when Branch-A looks likely. Never let a benign/error explanation mask a serious real one.
5. ANTI-ANCHORING: the stated context must NOT push you to dismiss a genuinely dangerous result. The same value can be an artifact in one patient and a critical real finding in another (e.g. symptoms, ECG changes, or a missed dialysis session make a high potassium real and urgent → discordant-likely-real).
6. Name the single DECISIVE GAP — the one unknown that would most change releasability — and a short VoI ledger. Surface the cheapest high-value action first (e.g. a hemolysis index on the existing sample BEFORE a re-draw). The decisive gap must be relevant to THIS analyte (do not propose a hemolysis index for calcium).
7. Confidence is capped by high-value unknowns. State the cap reason.
8. Scope honesty: you reason about concordance, not analytic truth — you cannot catch a wrong result that is internally consistent and clinically plausible (e.g. a wrong-patient panel). Say so when relevant.
9. Advisory only — a "concordant" verdict is NOT authorization to release; the clinician decides.

Output in EXACTLY this structure, one label per line:
VERDICT: <concordant | discordant-likely-error | discordant-likely-real | indeterminate>  (exactly one)
CONFIDENCE: <low | moderate | high> — <why it is capped>
BRANCH A (error): <most plausible pre-analytic/analytic causes for THIS result + evidence for/against>
BRANCH B (real): <most plausible true causes + the mandatory cannot-miss cause + evidence for/against>
DECISIVE GAP: <the single most decision-changing unknown>
VoI LEDGER: <bullets — gap · who-knows(report/you/lab) · how-to-resolve · impact · worth-chasing?>
NEXT STEP: <the single recommended action: repeat / which test / release / urgent-treat>
GROUNDING: <cite guideline/corpus where used, else label as clinical-reasoning>`;

export function buildConcordancePrompt(result: string, context: string): Prompt {
  const floor = floorFor(result);
  const floorLine = floor.length
    ? `\n\nCANNOT-MISS FLOOR for this analyte (you MUST explicitly address whether each is excluded, in Branch B): ${floor.map((f) => f.cannotMiss).join('; ')}.`
    : '';
  const notes = floor.map((f) => f.note).filter(Boolean);
  const notesLine = notes.length ? `\n\nANALYTE RULES (deterministic — apply before judging): ${notes.join(' ')}` : '';
  const unit = unitContext(result);
  const unitLine = unit.line ? `\n\n${unit.line}${unit.ambiguous ? ' If a unit is ambiguous, the verdict is indeterminate and the DECISIVE GAP is the unit — do not guess.' : ''}` : '';
  const pop = populationLines(result, context);
  const popLine = pop.length ? `\n\nPOPULATION CONTEXT (real EHRC base rates — informational calibration ONLY; how extreme a value is does NOT by itself decide error vs real. The clinical context and analyte-appropriate error mechanisms decide the branch. A suggestive pre-analytic story still points to error even when the value is extreme):\n- ${pop.join('\n- ')}` : '';
  const user = `RESULT: ${result}\nCONTEXT: ${context}${unitLine}${floorLine}${notesLine}${popLine}`;
  return { system: SYSTEM, user };
}

// ── Output parser ──
export interface ParsedConcordance {
  verdict: Verdict | null;
  multipleVerdicts: boolean;
  confidence: 'low' | 'moderate' | 'high' | null;
  confidenceCapped: boolean;
  branchAText: string;
  branchBText: string;
  decisiveGap: string;
  voiText: string;
  nextStep: string;
  grounding: string;
  branch: Branch;      // derived from verdict
  raw: string;
}

function section(text: string, label: RegExp, next: RegExp[]): string {
  const start = text.search(label);
  if (start < 0) return '';
  const after = text.slice(start).replace(label, '');
  let end = after.length;
  for (const n of next) {
    const i = after.search(n);
    if (i >= 0 && i < end) end = i;
  }
  return after.slice(0, end).trim();
}

const HEADERS = {
  verdict: /VERDICT\s*:/i,
  confidence: /CONFIDENCE\s*:/i,
  branchA: /BRANCH\s*A[^:]*:/i,
  branchB: /BRANCH\s*B[^:]*:/i,
  decisive: /DECISIVE\s*GAP\s*:/i,
  voi: /VoI\s*LEDGER\s*:/i,
  next: /NEXT\s*STEP\s*:/i,
  grounding: /GROUNDING\s*:/i,
};

export function parseConcordance(raw: string): ParsedConcordance {
  const all = Object.values(HEADERS);
  const verdictLine = section(raw, HEADERS.verdict, all);
  const found = VERDICTS.filter((v) => verdictLine.toLowerCase().includes(v));
  // "discordant-likely-error" contains "...-error"; ensure exact-ish detection order
  const verdict = (found[0] as Verdict) || null;
  const multipleVerdicts = found.length > 1;

  const confText = section(raw, HEADERS.confidence, all);
  const cl = confText.toLowerCase();
  const confidence = cl.includes('high') ? 'high' : cl.includes('moderate') || cl.includes('medium') ? 'moderate' : cl.includes('low') ? 'low' : null;
  const confidenceCapped = /cap|unknown|pending|await|limit/i.test(confText);

  return {
    verdict,
    multipleVerdicts,
    confidence,
    confidenceCapped,
    branchAText: section(raw, HEADERS.branchA, all),
    branchBText: section(raw, HEADERS.branchB, all),
    decisiveGap: section(raw, HEADERS.decisive, all),
    voiText: section(raw, HEADERS.voi, all),
    nextStep: section(raw, HEADERS.next, all),
    grounding: section(raw, HEADERS.grounding, all),
    branch: verdict ? branchForVerdict(verdict) : 'none',
    raw,
  };
}

// ── Scoring ──
export interface CaseExpectation {
  id: string;
  category: 'branchA' | 'branchB' | 'control' | 'edge';
  expectedVerdict: Verdict;
  expectedBranch: Branch;
  decisiveGapKeywords: string[];   // any-of match against decisiveGap+voi+nextStep
  cannotMissKeywords?: string[];   // any-of match against branchB text
}

export interface CaseScore {
  id: string;
  verdictMatch: boolean;
  branchMatch: boolean;
  decisiveGapHit: boolean;
  cannotMissCovered: boolean | null;
  overFlagged: boolean;           // control marked discordant
  committedSingleVerdict: boolean;
  notes: string[];
}

function anyKeyword(hay: string, keys: string[]): boolean {
  const h = hay.toLowerCase();
  return keys.some((k) => h.includes(k.toLowerCase()));
}

export function scoreCase(exp: CaseExpectation, p: ParsedConcordance): CaseScore {
  const notes: string[] = [];
  const verdictMatch = p.verdict === exp.expectedVerdict;
  const branchMatch = p.branch === exp.expectedBranch;
  const gapHay = `${p.decisiveGap}\n${p.voiText}\n${p.nextStep}`;
  const decisiveGapHit = anyKeyword(gapHay, exp.decisiveGapKeywords);
  const cannotMissCovered = exp.cannotMissKeywords && exp.cannotMissKeywords.length
    ? anyKeyword(p.branchBText, exp.cannotMissKeywords)
    : null;
  const overFlagged = exp.category === 'control' && (p.verdict === 'discordant-likely-error' || p.verdict === 'discordant-likely-real');

  if (!verdictMatch) notes.push(`verdict ${p.verdict ?? 'NONE'} ≠ expected ${exp.expectedVerdict}`);
  if (p.multipleVerdicts) notes.push('emitted multiple verdicts');
  if (cannotMissCovered === false) notes.push('cannot-miss cause not surfaced in Branch B');
  if (overFlagged) notes.push('control OVER-FLAGGED');

  return {
    id: exp.id,
    verdictMatch,
    branchMatch,
    decisiveGapHit,
    cannotMissCovered,
    overFlagged,
    committedSingleVerdict: !p.multipleVerdicts && p.verdict !== null,
    notes,
  };
}

export interface BankSummary {
  n: number;
  verdictAccuracy: number;
  branchAccuracy: number;
  decisiveGapHitRate: number;
  cannotMissCoverage: number;   // over cases that specify cannotMissKeywords
  controlOverFlagRate: number;  // over controls
  committedRate: number;
}

export function summarize(scores: CaseScore[]): BankSummary {
  const n = scores.length || 1;
  const controls = scores.filter((s) => s.overFlagged !== undefined && s.id.startsWith('C'));
  const cmScored = scores.filter((s) => s.cannotMissCovered !== null);
  const controlsAll = scores.filter((s) => s.id.startsWith('C'));
  return {
    n: scores.length,
    verdictAccuracy: scores.filter((s) => s.verdictMatch).length / n,
    branchAccuracy: scores.filter((s) => s.branchMatch).length / n,
    decisiveGapHitRate: scores.filter((s) => s.decisiveGapHit).length / n,
    cannotMissCoverage: cmScored.length ? cmScored.filter((s) => s.cannotMissCovered).length / cmScored.length : 1,
    controlOverFlagRate: controlsAll.length ? controls.filter((s) => s.overFlagged).length / controlsAll.length : 0,
    committedRate: scores.filter((s) => s.committedSingleVerdict).length / n,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 — adaptive interview loop (pure core: state, stopping rule, prompt builders,
// parsers, transcript→context). All LLM-touching wrappers live in concordance.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type WhoKnows = 'report' | 'you' | 'lab';

export interface BeliefItem { cause: string; branch: 'A' | 'B'; weight: number; }
export interface InterviewTurn { question: string; whoKnows: WhoKnows; why: string; options: string[]; answer: string; }
export interface OpenGap { gap: string; whoKnows: WhoKnows; voiImpact: 'high' | 'med' | 'low'; }

export interface InterviewState {
  result: string;
  context0: string;
  belief: BeliefItem[];
  turns: InterviewTurn[];
  openGaps: OpenGap[];
  status: 'seeding' | 'asking' | 'stopped';
  askedCount: number;
  leadConfidence: number;   // confidence in the leading explanation given answers so far (0-1)
  unknownStreak: number;    // consecutive "I don't have this" answers
}

export interface InterviewOpts {
  cap: number;              // hard ceiling on questions
  stopThreshold: number;    // stop once leadConfidence clears this
  maxUnknownStreak: number; // stop when this many answers in a row are "I don't have this" (info-starved)
}
export const DEFAULT_INTERVIEW_OPTS: InterviewOpts = { cap: 6, stopThreshold: 0.7, maxUnknownStreak: 2 };

export function initInterview(result: string, context0: string): InterviewState {
  return { result, context0, belief: [], turns: [], openGaps: [], status: 'seeding', askedCount: 0, leadConfidence: 0, unknownStreak: 0 };
}

export function normalizeBelief(items: BeliefItem[]): BeliefItem[] {
  const sum = items.reduce((s, i) => s + (i.weight > 0 ? i.weight : 0), 0);
  if (sum <= 0) return items.map((i) => ({ ...i, weight: items.length ? 1 / items.length : 0 }));
  return items.map((i) => ({ ...i, weight: Math.max(i.weight, 0) / sum }));
}

export function topBelief(b: BeliefItem[]): BeliefItem | null {
  if (!b.length) return null;
  return [...b].sort((a, c) => c.weight - a.weight)[0];
}

/** An answer that means "I don't have this" — first-class, never stalls.
 *  Tolerant of "don't"/"do not" and "not have/known/measured/available/recorded". */
export function isUnknownAnswer(answer: string): boolean {
  return /^\s*(unknown|i (don'?t|do not) have|(don'?t|do not) have|not (available|measured|known|recorded|have|sure|documented)|n\/?a|no data|(don'?t|do not) know)\b/i.test(answer);
}

export interface NextQuestion { stop: boolean; question: string; whoKnows: WhoKnows; why: string; options: string[]; confidence?: number; }

/** Deterministic stop (the economy levers): cap reached, the leading explanation clears the
 *  confidence threshold, or the interview is info-starved (a run of "I don't have this").
 *  The LLM's explicit STOP token is handled by the driver; this is the deterministic net. */
export function shouldStop(state: InterviewState, opts: InterviewOpts = DEFAULT_INTERVIEW_OPTS): boolean {
  if (state.status === 'stopped') return true;
  if (state.askedCount >= opts.cap) return true;
  if (state.leadConfidence >= opts.stopThreshold) return true;
  if (state.unknownStreak >= opts.maxUnknownStreak) return true;
  const top = topBelief(state.belief);
  return !!top && top.weight >= opts.stopThreshold;
}

/** Record an answered turn; an "I don't have this" answer becomes a high-VoI open gap and
 *  extends the unknown streak. The question's self-reported confidence updates leadConfidence. */
export function recordTurn(state: InterviewState, nq: NextQuestion, answer: string, newBelief?: BeliefItem[]): InterviewState {
  const turn: InterviewTurn = { question: nq.question, whoKnows: nq.whoKnows, why: nq.why, options: nq.options, answer };
  const unknown = isUnknownAnswer(answer);
  const openGaps = unknown
    ? [...state.openGaps, { gap: nq.question, whoKnows: nq.whoKnows, voiImpact: 'high' as const }]
    : state.openGaps;
  const belief = newBelief && newBelief.length ? normalizeBelief(newBelief) : state.belief;
  const leadConfidence = typeof nq.confidence === 'number' && !Number.isNaN(nq.confidence) ? nq.confidence : state.leadConfidence;
  return {
    ...state,
    turns: [...state.turns, turn],
    askedCount: state.askedCount + 1,
    openGaps,
    belief,
    leadConfidence,
    unknownStreak: unknown ? state.unknownStreak + 1 : 0,
  };
}

/** Transcript → the context string handed to the P0 verdict engine at stop. */
export function toVerdictContext(state: InterviewState): string {
  const lines: string[] = [state.context0.trim()];
  const answered = state.turns.filter((t) => !isUnknownAnswer(t.answer));
  if (answered.length) {
    lines.push('', 'Interview findings (established facts — weight these):');
    for (const t of answered) lines.push(`- ${t.question} -> ${t.answer}`);
  }
  if (state.openGaps.length) {
    lines.push('', 'Asked but not available. Judge on the evidence PRESENT; a suggestive established finding can justify a verdict on its own. Only cap confidence for a gap that is genuinely decision-critical and unresolved:');
    for (const g of state.openGaps) lines.push(`- ${g.gap} (ask: ${g.whoKnows})`);
  }
  return lines.join('\n');
}

// ── Prompt builders + parsers (pure) ──
export function buildSeedPrompt(result: string, context: string): Prompt {
  const floor = floorFor(result);
  const floorLine = floor.length ? ` Ensure these cannot-miss TRUE (branch B) causes appear: ${floor.map((f) => f.cannotMiss).join('; ')}.` : '';
  const system = `You are Concordance, seeding a cause differential for a lab result BEFORE an adaptive interview. List the most plausible causes that this result is (A) WRONG — a pre-analytic/analytic error that must be mechanistically appropriate to the analyte — or (B) RIGHT and revealing/confirming something. Assign each a prior weight 0-1 (they need not sum to 1).${floorLine}
Output ONLY one cause per line, pipe-separated: the branch letter (A or B), then the weight, then the cause. Example:
B|0.5|primary hyperparathyroidism
A|0.2|EDTA contamination
Give 4-8 lines. No headers, no prose.`;
  const unit = unitContext(result);
  const unitLine = unit.line ? `\n${unit.line}` : '';
  const pop = populationLines(result, context);
  const popLine = pop.length ? `\nPOPULATION BASE RATES: ${pop.join(' ')}` : '';
  return { system, user: `RESULT: ${result}\nCONTEXT: ${context}${unitLine}${popLine}` };
}

/** Tolerant of field order and a stray leading label (e.g. "BRANCH|B|0.4|cause"). */
export function parseSeed(raw: string): BeliefItem[] {
  const out: BeliefItem[] = [];
  for (const ln of raw.split('\n')) {
    if (!ln.includes('|')) continue;
    const parts = ln.split('|').map((s) => s.trim()).filter(Boolean);
    const branch = parts.find((p) => /^[AB]$/i.test(p));
    const wStr = parts.find((p) => /^[0-9]*\.?[0-9]+$/.test(p));
    if (!branch || !wStr) continue;
    const cause = parts
      .filter((p) => p !== branch && p !== wStr && !/^branch$/i.test(p))
      .sort((a, b) => b.length - a.length)[0];
    if (!cause) continue;
    out.push({ branch: branch.toUpperCase() as 'A' | 'B', weight: parseFloat(wStr), cause });
  }
  return normalizeBelief(out);
}

export function buildNextQuestionPrompt(state: InterviewState): Prompt {
  const beliefStr = state.belief.map((b) => `${b.branch}|${b.weight.toFixed(2)}|${b.cause}`).join('\n') || '(unseeded)';
  const asked = state.turns.map((t) => `- ${t.question} -> ${t.answer}`).join('\n') || '(none yet)';
  const floorNote = floorFor(state.result).map((f) => f.note).filter(Boolean).join(' ');
  const system = `You are running an ADAPTIVE clinical interview to decide whether a lab result is concordant/releasable. Choose the SINGLE next question that best DISCRIMINATES among the current candidate causes (maximise information gain) — never generic history.
Prioritise the TOP 1-2 causes in CURRENT BELIEF: ask the question whose answer would most confirm or exclude the single most likely cause first. If the top cause is a pre-analytic error (branch A), ask the specific sample/draw question that would reveal it (e.g. was the ven-puncture difficult, is there a hemolysis/lipemia index, was the right tube used) — do not skip to rare causes while the leading one is untested.
Do NOT re-ask anything already answered or already stated in the context, and do NOT ask a second question about a theme you already probed (sample handling / pre-analytic processing counts as ONE theme — ask it once).${floorNote ? ' ' + floorNote : ''}
Tag whoKnows: report (already knowable from the report or order) | you (the clinician at the bedside) | lab (sample provenance / pre-analytic). Give a one-line why (which causes it separates) and 2-4 quick answer options.
Output the single word STOP as the QUESTION when ANY of these hold: (a) you are already confident in the leading explanation; (b) the recent answers have been "I don't have this" and another question won't change releasability — it is better to return a verdict with the open gap than to keep asking; (c) every high-value discriminator has been asked.
Also report CONFIDENCE: your probability (0-1) in the single leading explanation GIVEN THE ANSWERS SO FAR.
Output EXACTLY, one per line:
QUESTION: <one question, or the word STOP>
WHOKNOWS: <report|you|lab>
WHY: <one line>
OPTIONS: <opt1 | opt2 | opt3>
CONFIDENCE: <0-1>`;
  const unit = unitContext(state.result);
  const unitLine = unit.ambiguous ? `\nUNIT UNRESOLVED: ${unit.line} If this has not been answered yet, ask the UNIT as the next question (whoKnows: report).` : '';
  return { system, user: `RESULT: ${state.result}\nCONTEXT: ${state.context0}${unitLine}\nCURRENT BELIEF:\n${beliefStr}\nALREADY ASKED:\n${asked}` };
}

export function parseNextQuestion(raw: string): NextQuestion {
  const heads = [HEADERS_Q.q, HEADERS_Q.wk, HEADERS_Q.why, HEADERS_Q.opt, HEADERS_Q.conf];
  const q = section(raw, HEADERS_Q.q, heads).trim();
  const confRaw = section(raw, HEADERS_Q.conf, heads).match(/[0-9]*\.?[0-9]+/);
  const confidence = confRaw ? Math.min(1, Math.max(0, parseFloat(confRaw[0]))) : undefined;
  if (!q || /^stop\b/i.test(q)) return { stop: true, question: '', whoKnows: 'you', why: '', options: [], confidence };
  const wk = section(raw, HEADERS_Q.wk, heads).toLowerCase();
  const whoKnows: WhoKnows = wk.includes('report') ? 'report' : wk.includes('lab') ? 'lab' : 'you';
  const why = section(raw, HEADERS_Q.why, heads).trim();
  const options = section(raw, HEADERS_Q.opt, heads).split('|').map((s) => s.trim()).filter(Boolean).slice(0, 4);
  return { stop: false, question: q, whoKnows, why, options, confidence };
}

const HEADERS_Q = {
  q: /QUESTION\s*:/i,
  wk: /WHOKNOWS\s*:/i,
  why: /WHY\s*:/i,
  opt: /OPTIONS\s*:/i,
  conf: /CONFIDENCE\s*:/i,
};

// ─────────────────────────────────────────────────────────────────────────────
// P2 — capture-and-wall run record (pure, de-identified). No identifiers, no raw
// context/answers, no per-patient key. This is Track-2 registry material only.
// ─────────────────────────────────────────────────────────────────────────────

export const CONCORDANCE_ENGINE = 'concordance/0.2';

export interface ConcordanceRunRecord {
  analytes: string[];
  verdict: Verdict | null;
  branch: Branch;
  confidence: 'low' | 'moderate' | 'high' | null;
  askedCount: number;
  unknownCount: number;
  whoReport: number;
  whoYou: number;
  whoLab: number;
  ageBand: string | null;
  sex: 'F' | 'M' | null;
  mode: 'interview' | 'single-shot';
  engine: string;
}

/** Coarse, de-identified demographics from the intake context (best-effort; null when unsure). */
export function extractDemographics(context: string): { age: number | null; ageBand: string | null; sex: 'F' | 'M' | null } {
  const compact = context.match(/\b(\d{1,3})\s*(?:-?\s*year[s-]*old\s*)?([MF])\b/i); // "56F", "44 M", "70-year-old F"
  const ageWord = context.match(/\b(\d{1,3})\s*(?:years?\b|yo\b|y\/o\b|-year-old)/i);
  const sexWord = context.match(/\b(female|woman|male|man)\b/i);
  let age: number | null = compact ? parseInt(compact[1], 10) : ageWord ? parseInt(ageWord[1], 10) : null;
  if (age !== null && (age < 0 || age > 120)) age = null;
  let sex: 'F' | 'M' | null = compact ? (compact[2].toUpperCase() as 'F' | 'M') : null;
  if (!sex && sexWord) sex = /female|woman/i.test(sexWord[1]) ? 'F' : 'M';
  const ageBand = age === null ? null : `${Math.floor(age / 10) * 10}-${Math.floor(age / 10) * 10 + 9}`;
  return { age, ageBand, sex };
}

/** Build the walled, de-identified run record from an interview state (or a single-shot). */
export function buildRunRecord(
  result: string,
  context: string,
  parsed: ParsedConcordanceLike,
  mode: 'interview' | 'single-shot',
  interview?: InterviewState,
): ConcordanceRunRecord {
  const analytes = Array.from(new Set(floorFor(result).map((f) => f.analyte)));
  const { ageBand, sex } = extractDemographics(context);
  const turns = interview?.turns ?? [];
  const who = { report: 0, you: 0, lab: 0 };
  for (const t of turns) who[t.whoKnows] += 1;
  return {
    analytes,
    verdict: parsed.verdict,
    branch: parsed.verdict ? branchForVerdict(parsed.verdict) : 'none',
    confidence: parsed.confidence,
    askedCount: interview?.askedCount ?? 0,
    unknownCount: interview?.openGaps.length ?? 0,
    whoReport: who.report,
    whoYou: who.you,
    whoLab: who.lab,
    ageBand,
    sex,
    mode,
    engine: CONCORDANCE_ENGINE,
  };
}

/** Minimal shape needed from a parsed verdict (ParsedConcordance satisfies this). */
export interface ParsedConcordanceLike { verdict: Verdict | null; confidence: 'low' | 'moderate' | 'high' | null; }
