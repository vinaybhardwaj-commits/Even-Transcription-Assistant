/**
 * lib/preop-instruments-core.ts — the three Slice-1 instruments as PURE arithmetic
 * (CDMSS-PREOP-RISK-AGENT-PRD-v1.1-LOCKED §3, §8; Build Plan B1).
 *
 * NO database, NO fetch, NO clock, NO model. Given tri-state inputs this module returns
 * a number (or a pair of numbers) and nothing else. That is the whole point of the
 * module: PRD §7's inviolable invariant — "a model may propose an INPUT or write PROSE
 * about a computed result; it may never contribute a point of score" — is only provable
 * because the arithmetic lives here, where no model can reach it.
 *
 * THE TRI-STATE RULE (PRD §8, mandatory). Every input is present | absent | unknown.
 *   · no unknowns            ⇒ kind 'point'          (lo === hi)
 *   · some unknowns          ⇒ kind 'range'          lo = every unknown resolved ABSENT
 *                                                    hi = every unknown resolved PRESENT
 *                              plus the missing-input list, so the card can name what
 *                              would tighten the score and where it comes from.
 *   · every input unknown    ⇒ kind 'not_computable' (the §8 floor; "should be ~never"
 *                              given booking coverage — an empty episode, not a thin one)
 * The lower bound is the CONFIRMED bound. Nothing in this file ever guesses a value:
 * an unknown input is carried as unknown all the way to the display.
 *
 * PUBLISHED SOURCES (the numbers are the published ones, not house numbers):
 *   · RCRI — Lee et al. 1999. Six equally-weighted factors; risk of major cardiac
 *     complication by class: I 0.4% · II 0.9% · III 6.6% · IV 11%.
 *   · mFI-5 — the 5-item modified frailty index (functional status, DM, COPD/pneumonia,
 *     CHF, hypertension on medication), 1 point each.
 *   · Charlson — the 19 weighted categories (1/2/3/6) plus the age adjustment
 *     (<50: 0 · 50-59: 1 · 60-69: 2 · 70-79: 3 · 80+: 4).
 *
 * The mockup (PREOP-RISK-AGENT-MOCKUP-v1, V-approved 26 Aug) hand-computed four cases
 * from these same published instruments and its footer states they "are the arithmetic
 * the pure cores must reproduce exactly". lib/__tests__/preop-instruments-core.test.ts
 * reproduces all four, including Shobha's v1 -> v2 -> v3 range progression.
 */

/** Every instrument input is tri-state. There is no fourth state and no default. */
export type Tri = 'present' | 'absent' | 'unknown';

export type InstrumentId = 'rcri' | 'mfi5' | 'charlson';

/** Bumped when the arithmetic or the factor sets change (A/B boundary, forward-only). */
export const PREOP_INSTRUMENTS_VERSION = 'preop-instruments/1';

/** One row of an instrument's factor table (mockup §2 renders exactly these columns). */
export interface FactorRow {
  /** stable id — also the missing-input id and the assembler's input id */
  id: string;
  /** the factor-table label, verbatim as the mockup prints it */
  label: string;
  status: Tri;
  /** points contributed at the CONFIRMED (lower) bound — an unknown contributes 0 */
  points: number;
  /** points contributed at the upper bound — what this factor is worth if present */
  maxPoints: number;
}

export interface InstrumentScore {
  instrument: InstrumentId;
  kind: 'point' | 'range' | 'not_computable';
  /** null only when not_computable */
  lo: number | null;
  hi: number | null;
  /** ids of the unknown inputs, in factor-table order — the "what would tighten this" list */
  missing: string[];
  factors: FactorRow[];
}

// ── shared mechanics ────────────────────────────────────────────────────────────

/**
 * Fold a factor table into a score. The ONLY place the tri-state rule is implemented,
 * so RCRI, mFI-5 and Charlson cannot drift from each other.
 */
function fold(instrument: InstrumentId, factors: FactorRow[]): InstrumentScore {
  const missing = factors.filter((f) => f.status === 'unknown').map((f) => f.id);
  if (missing.length === factors.length) {
    // The §8 floor: nothing at all is known. Not a range from 0 to the maximum — a
    // refusal. A range implies a confirmed lower bound and there is none.
    return { instrument, kind: 'not_computable', lo: null, hi: null, missing, factors };
  }
  const lo = factors.reduce((n, f) => n + f.points, 0);
  const hi = factors.reduce((n, f) => n + (f.status === 'unknown' ? f.maxPoints : f.points), 0);
  return { instrument, kind: lo === hi ? 'point' : 'range', lo, hi, missing, factors };
}

/** A binary (1-point) factor row. */
function bin(id: string, label: string, status: Tri, weight = 1): FactorRow {
  return { id, label, status, points: status === 'present' ? weight : 0, maxPoints: weight };
}

// ── RCRI (Lee) ──────────────────────────────────────────────────────────────────

export interface RcriInputs {
  /** intraperitoneal, intrathoracic or suprainguinal-vascular surgery */
  highRiskSurgery: Tri;
  ischaemicHeartDisease: Tri;
  congestiveHeartFailure: Tri;
  cerebrovascularDisease: Tri;
  insulinTreatedDiabetes: Tri;
  /** serum creatinine > 2.0 mg/dL */
  creatinineOver2: Tri;
}

export const RCRI_FACTOR_LABELS = {
  high_risk_surgery: 'High-risk surgery',
  ischaemic_heart_disease: 'Ischaemic heart disease',
  congestive_heart_failure: 'Congestive heart failure',
  cerebrovascular_disease: 'Cerebrovascular disease',
  insulin_treated_diabetes: 'Insulin-treated diabetes',
  creatinine_over_2: 'Creatinine > 2.0 mg/dL',
} as const;

export type RcriFactorId = keyof typeof RCRI_FACTOR_LABELS;

export function computeRcri(i: RcriInputs): InstrumentScore {
  return fold('rcri', [
    bin('high_risk_surgery', RCRI_FACTOR_LABELS.high_risk_surgery, i.highRiskSurgery),
    bin('ischaemic_heart_disease', RCRI_FACTOR_LABELS.ischaemic_heart_disease, i.ischaemicHeartDisease),
    bin('congestive_heart_failure', RCRI_FACTOR_LABELS.congestive_heart_failure, i.congestiveHeartFailure),
    bin('cerebrovascular_disease', RCRI_FACTOR_LABELS.cerebrovascular_disease, i.cerebrovascularDisease),
    bin('insulin_treated_diabetes', RCRI_FACTOR_LABELS.insulin_treated_diabetes, i.insulinTreatedDiabetes),
    bin('creatinine_over_2', RCRI_FACTOR_LABELS.creatinine_over_2, i.creatinineOver2),
  ]);
}

export type RcriClass = 'I' | 'II' | 'III' | 'IV';

/** Lee's published class + major-cardiac-complication risk. Not a house number. */
export function rcriClass(score: number): { klass: RcriClass; riskPct: number } {
  if (score <= 0) return { klass: 'I', riskPct: 0.4 };
  if (score === 1) return { klass: 'II', riskPct: 0.9 };
  if (score === 2) return { klass: 'III', riskPct: 6.6 };
  return { klass: 'IV', riskPct: 11 };
}

// ── mFI-5 ───────────────────────────────────────────────────────────────────────

export interface Mfi5Inputs {
  /** partially or totally DEPENDENT functional status (independent scores 0) */
  functionalStatusDependent: Tri;
  diabetesMellitus: Tri;
  copdOrPneumonia: Tri;
  congestiveHeartFailure: Tri;
  hypertensionOnMedication: Tri;
}

export const MFI5_FACTOR_LABELS = {
  functional_status_dependent: 'Functional status (dependent)',
  diabetes_mellitus: 'Diabetes mellitus',
  copd_or_pneumonia: 'COPD / pneumonia',
  congestive_heart_failure: 'Congestive heart failure',
  hypertension_on_medication: 'Hypertension (on medication)',
} as const;

export type Mfi5FactorId = keyof typeof MFI5_FACTOR_LABELS;

export function computeMfi5(i: Mfi5Inputs): InstrumentScore {
  return fold('mfi5', [
    bin('functional_status_dependent', MFI5_FACTOR_LABELS.functional_status_dependent, i.functionalStatusDependent),
    bin('diabetes_mellitus', MFI5_FACTOR_LABELS.diabetes_mellitus, i.diabetesMellitus),
    bin('copd_or_pneumonia', MFI5_FACTOR_LABELS.copd_or_pneumonia, i.copdOrPneumonia),
    bin('congestive_heart_failure', MFI5_FACTOR_LABELS.congestive_heart_failure, i.congestiveHeartFailure),
    bin('hypertension_on_medication', MFI5_FACTOR_LABELS.hypertension_on_medication, i.hypertensionOnMedication),
  ]);
}

// ── age-adjusted Charlson ───────────────────────────────────────────────────────

/** The 19 published categories with their published weights. Order = factor-table order. */
export const CHARLSON_CATEGORIES = [
  { id: 'myocardial_infarction', label: 'Myocardial infarction', weight: 1 },
  { id: 'congestive_heart_failure', label: 'Congestive heart failure', weight: 1 },
  { id: 'peripheral_vascular_disease', label: 'Peripheral vascular disease', weight: 1 },
  { id: 'cerebrovascular_disease', label: 'Cerebrovascular disease', weight: 1 },
  { id: 'dementia', label: 'Dementia', weight: 1 },
  { id: 'chronic_pulmonary_disease', label: 'Chronic pulmonary disease', weight: 1 },
  { id: 'connective_tissue_disease', label: 'Connective tissue disease', weight: 1 },
  { id: 'peptic_ulcer_disease', label: 'Peptic ulcer disease', weight: 1 },
  { id: 'mild_liver_disease', label: 'Mild liver disease', weight: 1 },
  { id: 'diabetes_uncomplicated', label: 'Diabetes, uncomplicated', weight: 1 },
  { id: 'hemiplegia', label: 'Hemiplegia', weight: 2 },
  { id: 'moderate_severe_renal_disease', label: 'Moderate or severe renal disease', weight: 2 },
  { id: 'diabetes_end_organ_damage', label: 'Diabetes with end-organ damage', weight: 2 },
  { id: 'any_tumour', label: 'Any tumour (within 5 years)', weight: 2 },
  { id: 'leukaemia', label: 'Leukaemia', weight: 2 },
  { id: 'lymphoma', label: 'Lymphoma', weight: 2 },
  { id: 'moderate_severe_liver_disease', label: 'Moderate or severe liver disease', weight: 3 },
  { id: 'metastatic_solid_tumour', label: 'Metastatic solid tumour', weight: 6 },
  { id: 'aids', label: 'AIDS', weight: 6 },
] as const;

export type CharlsonCategoryId = (typeof CHARLSON_CATEGORIES)[number]['id'];

/**
 * The published mutual exclusions: the severe member of a pair REPLACES the mild one,
 * it does not add to it. Applied at BOTH bounds, so an unknown severe category cannot
 * inflate the upper bound by double-counting its own mild twin.
 */
const CHARLSON_SUPERSEDES: Partial<Record<CharlsonCategoryId, CharlsonCategoryId>> = {
  diabetes_end_organ_damage: 'diabetes_uncomplicated',
  moderate_severe_liver_disease: 'mild_liver_disease',
  metastatic_solid_tumour: 'any_tumour',
};

/** The published age adjustment. */
export function charlsonAgePoints(age: number): number {
  if (age < 50) return 0;
  if (age < 60) return 1;
  if (age < 70) return 2;
  if (age < 80) return 3;
  return 4;
}

/** The age band label the factor table prints ('Age band 60-69'). */
export function charlsonAgeBandLabel(age: number): string {
  if (age < 50) return 'Age band under 50';
  if (age < 60) return 'Age band 50–59';
  if (age < 70) return 'Age band 60–69';
  if (age < 80) return 'Age band 70–79';
  return 'Age band 80+';
}

export interface CharlsonInputs {
  /** null = unknown; the age factor then joins the missing list like any other input */
  age: number | null;
  /** EVERY category, explicitly. The assembler decides absent-vs-unknown, never this core. */
  categories: Record<CharlsonCategoryId, Tri>;
}

/**
 * Build a complete category record. `base` is the caller's closed-world decision:
 * 'absent' for a source that ENUMERATES a patient's comorbidities (the booking form
 * lists them all, so not-listed means not-present), 'unknown' for a source that
 * merely mentions some. Making the caller name the base is the point — a silent
 * default here would be the whole degradation story quietly guessed away.
 */
export function charlsonCategories(
  overrides: Partial<Record<CharlsonCategoryId, Tri>> = {},
  base: Tri = 'absent',
): Record<CharlsonCategoryId, Tri> {
  const out = {} as Record<CharlsonCategoryId, Tri>;
  for (const c of CHARLSON_CATEGORIES) out[c.id] = overrides[c.id] ?? base;
  return out;
}

export function computeCharlson(i: CharlsonInputs): InstrumentScore {
  const rows: FactorRow[] = [];
  for (const c of CHARLSON_CATEGORIES) {
    const status = i.categories[c.id];
    // A category superseded by a PRESENT severe twin scores nothing at either bound.
    const supersededBy = (Object.keys(CHARLSON_SUPERSEDES) as CharlsonCategoryId[])
      .find((sev) => CHARLSON_SUPERSEDES[sev] === c.id && i.categories[sev] === 'present');
    const weight = supersededBy ? 0 : c.weight;
    rows.push({
      id: c.id,
      label: c.label,
      status,
      points: status === 'present' ? weight : 0,
      maxPoints: weight,
    });
  }
  const ageStatus: Tri = i.age == null ? 'unknown' : 'present';
  const agePoints = i.age == null ? 0 : charlsonAgePoints(i.age);
  rows.push({
    id: 'age',
    label: i.age == null ? 'Age band' : charlsonAgeBandLabel(i.age),
    status: ageStatus,
    points: agePoints,
    // An unknown age is worth at most the top band; it can never be worth less than 0.
    maxPoints: i.age == null ? 4 : agePoints,
  });
  return fold('charlson', rows);
}

// ── presentation of a computed result (still pure — text, not DOM) ──────────────
//
// These live beside the arithmetic so the mockup's chip strings are pinned by the same
// tests that pin the numbers. B4 renders them; it does not re-derive them.

const EN = '–';   // en dash, as the mockup prints it: "1–2", "Class II–III"

/** 0.4 -> '0.4' · 11 -> '11' (no trailing '.0'). */
export function riskNumText(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

/** 0.4 -> '0.4%' · 11 -> '11%'. */
export function riskPctText(p: number): string {
  return `${riskNumText(p)}%`;
}

/**
 * RCRI's published output is a CLASS and a risk, not a factor count — so when both
 * bounds of a range land in the same Lee class the score text collapses to the
 * confirmed bound (the count is uncertain; the answer is not). mFI-5 and Charlson
 * print their range whenever the bounds differ, because for them the number IS the
 * output. Mockup: Manjunath renders "RCRI 3 · Class IV · 11%" with creatinine still
 * missing, and "mFI-5 3-4/5" in the same card.
 */
export function rcriScoreText(s: InstrumentScore): string {
  if (s.kind === 'not_computable' || s.lo == null || s.hi == null) return '—';
  if (s.lo === s.hi) return String(s.lo);
  const a = rcriClass(s.lo), b = rcriClass(s.hi);
  if (a.klass === b.klass) return String(s.lo);
  return `${s.lo}${EN}${s.hi}`;
}

/** 'Class III · 6.6%' | 'Class II–III · 0.9–6.6%' — the mockup's `.cls` span, verbatim. */
export function rcriClassText(s: InstrumentScore): string {
  if (s.kind === 'not_computable' || s.lo == null || s.hi == null) return 'not computable';
  const a = rcriClass(s.lo), b = rcriClass(s.hi);
  if (a.klass === b.klass) return `Class ${a.klass} · ${riskPctText(a.riskPct)}`;
  // One '%', at the end of the pair — 'Class II–III · 0.9–6.6%', as the mockup prints it.
  return `Class ${a.klass}${EN}${b.klass} · ${riskNumText(a.riskPct)}${EN}${riskNumText(b.riskPct)}%`;
}

/** '2/5' | '3–4/5' */
export function mfi5ScoreText(s: InstrumentScore): string {
  if (s.kind === 'not_computable' || s.lo == null || s.hi == null) return '—';
  return s.lo === s.hi ? `${s.lo}/5` : `${s.lo}${EN}${s.hi}/5`;
}

/** '4' | '3–5' */
export function charlsonScoreText(s: InstrumentScore): string {
  if (s.kind === 'not_computable' || s.lo == null || s.hi == null) return '—';
  return s.lo === s.hi ? String(s.lo) : `${s.lo}${EN}${s.hi}`;
}

/** The frailty word the case panel prints beside the score. */
export function frailtyLabel(score: number): string {
  if (score >= 3) return 'frail';
  if (score === 2) return 'intermediate frailty';
  return 'not frail';
}

/** The burden word the case panel prints beside the score ('CCI 4 — moderate burden'). */
export function charlsonBurdenLabel(score: number): string {
  if (score >= 5) return 'high burden';
  if (score >= 3) return 'moderate burden';
  return 'low burden';
}
