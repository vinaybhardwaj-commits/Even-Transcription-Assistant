/**
 * lib/preop-harvest-core.ts — B8a, THE DETERMINISTIC HARVEST. No DB, no fetch, no clock,
 * NO MODEL. Everything here reads a record and returns an observation; nothing here infers.
 *
 * WHY IT EXISTS. B7 measured the extraction rail and found two defects (validation pack
 * §5): it disagreed with itself on 40% of identical texts, and its single tier-moving
 * reading was `"TAB RABEPRAZOLE 20 MG"` read as peptic ulcer disease — a proton-pump
 * inhibitor read as a Charlson diagnosis, moving a 75-year-old into RED. The same run also
 * showed the rail getting things RIGHT that no regex could: `"TAB TELMA 40 MG"` →
 * hypertension on medication, four spellings of "no known comorbidities", one misspelt.
 *
 * B8's ruling separates those two populations rather than judging the rail as a whole.
 * What a model was doing that a TABLE can do, a table now does — deterministically,
 * reproducibly, at ₹0, and inside the score. What only a model can do moves to the
 * suggestion rail (lib/preop-suggest-core.ts) where it cannot touch a score at all.
 *
 * ── THE ONE RULE THAT MATTERS ────────────────────────────────────────────────────
 *
 * A MEDICATION MAY ESTABLISH AN INPUT WHOSE DEFINITION *IS* THE MEDICATION.
 * A MEDICATION MAY NEVER ESTABLISH A DIAGNOSIS IT MERELY SUGGESTS.
 *
 * The mFI-5 item is literally "hypertension REQUIRING MEDICATION", so telmisartan
 * establishes it — the drug is not evidence for the item, the drug is the item. RCRI's
 * factor is "INSULIN-TREATED diabetes", so insulin establishes it. But no drug establishes
 * peptic ulcer disease, or ischaemic heart disease, or COPD: a PPI is prescribed for
 * reflux and for gastroprotection far more often than for an ulcer, aspirin is taken for
 * primary prevention, and a bronchodilator is given for asthma. Those are DIAGNOSES, and a
 * diagnosis must be named by a record, not deduced from a pharmacy line.
 *
 * The ban is enforced as a CATEGORY, not as a blocklist of drugs: RX_RULES may only name
 * inputs in RX_DEFINITIONAL_INPUTS, and a test asserts it. Adding rabeprazole to this file
 * cannot reintroduce the B7 defect, because there is no input it would be allowed to map
 * to. See BANNED_DRUG_INFERENCE for the reasoning as a constant the report can quote.
 */

import type { Observation, PreopInputId } from './preop-assemble-core';

/** Bumped when the dictionaries, the negation guard, or the definitional set change. */
export const PREOP_HARVEST_RULE_VERSION = 'preop-harvest/1';

// ── the drug dictionary ─────────────────────────────────────────────────────────

/**
 * The ONLY inputs a medication may establish. Every one is an input whose published
 * definition names a treatment rather than a disease. This set is the category ban.
 */
export const RX_DEFINITIONAL_INPUTS: ReadonlySet<PreopInputId> = new Set<PreopInputId>([
  'hypertension_on_medication',   // mFI-5: "hypertension requiring medication"
  'insulin_treated_diabetes',     // RCRI: "insulin-treated diabetes"
  'diabetes_mellitus',            // implied by any glucose-lowering agent — the drug class IS diabetes treatment
  'diabetes_uncomplicated',       // the Charlson twin of the above, when nothing says end-organ damage
]);

/**
 * Why the ban is a category. Quoted verbatim in the B8 report and pinned by test, so the
 * reasoning survives the next person who wants to add "just one more" mapping.
 */
export const BANNED_DRUG_INFERENCE =
  'A medication may establish an input whose definition IS the medication, and may never '
  + 'establish a diagnosis it merely suggests. Measured 27 Aug 2026: "TAB RABEPRAZOLE 20 MG" '
  + 'read as peptic ulcer disease moved a 75-year-old from AMBER to RED. A proton-pump '
  + 'inhibitor is prescribed for reflux and for gastroprotection far more often than for an '
  + 'ulcer. The ban is enforced by RX_DEFINITIONAL_INPUTS rather than by a blocklist, so no '
  + 'new drug entry can reintroduce the defect.';

export interface RxRule {
  /** what the class is called on the card */
  label: string;
  /** the drug class, for the report and the chip title */
  klass: string;
  /** generic and Indian brand stems, lowercased; matched on word boundaries */
  names: readonly string[];
  present: readonly PreopInputId[];
  /**
   * Inputs this class RESOLVES AS ABSENT. Only ever used where the class is definitionally
   * exclusive of the other treatment — an oral hypoglycaemic does not tell us the patient
   * is not ALSO on insulin, so it resolves nothing (see the note).
   */
  absent?: readonly PreopInputId[];
  note?: string;
}

/**
 * Reviewed constant. Brand stems are the ones this cohort's PAC medication lines actually
 * carry (measured over the 98 live reports); generics are included so the table survives a
 * change of pharmacy.
 *
 * ⚠️ ORAL HYPOGLYCAEMICS RESOLVE NOTHING ABOUT INSULIN. The B7 rail read "TAB VOGLIBOSE
 * 0.3 MG" as insulin-treated diabetes ABSENT, and that reading is *usually* right — but a
 * type-2 diabetic on metformin plus basal insulin is an ordinary patient, and calling their
 * RCRI factor absent would collapse a range onto a wrong point. Absence of a drug from a
 * list is not evidence: the list may be incomplete. Insulin status stays UNKNOWN unless
 * INSULIN itself appears. This is the kickoff's rule and it is stricter than what B7 did.
 */
export const RX_RULES: RxRule[] = [
  {
    label: 'Antihypertensive', klass: 'antihypertensive',
    names: [
      'telmisartan', 'telma', 'telsartan', 'losartan', 'losar', 'olmesartan', 'olmy', 'olmat',
      'valsartan', 'irbesartan', 'candesartan',
      'amlodipine', 'amlong', 'amlokind', 'amlopres', 'cilnidipine', 'cilacar', 'nifedipine',
      'enalapril', 'ramipril', 'lisinopril', 'perindopril',
      'atenolol', 'metoprolol', 'metolar', 'bisoprolol', 'nebivolol', 'nebicard', 'carvedilol',
      'hydrochlorothiazide', 'chlorthalidone', 'indapamide', 'prazosin', 'clonidine',
    ],
    present: ['hypertension_on_medication'],
    note: 'the mFI-5 item is "hypertension requiring medication" — the drug IS the item',
  },
  {
    label: 'Insulin', klass: 'insulin',
    names: [
      'insulin', 'humalog', 'lantus', 'glargine', 'huminsulin', 'actrapid', 'mixtard',
      'novomix', 'novorapid', 'ryzodeg', 'tresiba', 'degludec', 'aspart', 'lispro', 'basalog',
    ],
    present: ['insulin_treated_diabetes', 'diabetes_mellitus', 'diabetes_uncomplicated'],
    note: 'RCRI scores INSULIN-treated diabetes — the drug IS the factor',
  },
  {
    label: 'Oral hypoglycaemic', klass: 'oral hypoglycaemic',
    names: [
      'metformin', 'glycomet', 'glyciphage', 'gluconorm',
      'glimepiride', 'glimy', 'amaryl', 'gliclazide', 'glibenclamide', 'glipizide',
      'sitagliptin', 'januvia', 'istamet', 'vildagliptin', 'galvus', 'linagliptin',
      'teneligliptin', 'tenepride', 'dapagliflozin', 'empagliflozin', 'voglibose', 'acarbose',
      'pioglitazone',
    ],
    present: ['diabetes_mellitus', 'diabetes_uncomplicated'],
    // NO `absent` — see the header note. An oral agent proves diabetes, not the absence of insulin.
    note: 'proves diabetes; says NOTHING about insulin, because a list may be incomplete',
  },
];

/** Word-boundary match on a lowercased haystack, so "insulin" does not fire on "insulinoma". */
function mentions(haystack: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z])${needle}([^a-z]|$)`, 'i').test(haystack);
}

export interface RxHit { rule: RxRule; matched: string }

export function rxHits(text: string | null | undefined): RxHit[] {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return [];
  const out: RxHit[] = [];
  for (const rule of RX_RULES) {
    const matched = rule.names.find((n) => mentions(t, n));
    if (matched) out.push({ rule, matched });
  }
  return out;
}

/**
 * Medication text → observations, source RX. Deterministic and reproducible: the same
 * string yields the same observations forever, which is exactly what the B7 rail could not
 * promise about the same facts.
 */
export function rxObservations(
  text: string | null | undefined,
  fieldLabel: string,
  observedAt: string | null = null,
  ref: string | null = null,
): Observation[] {
  const out: Observation[] = [];
  for (const { rule, matched } of rxHits(text)) {
    for (const inputId of rule.present) {
      out.push({
        inputId, status: 'present', source: 'RX',
        detail: `${rule.label} on the medication list (${matched}) — ${fieldLabel}`,
        provenanceRef: ref, observedAt,
      });
    }
    for (const inputId of rule.absent ?? []) {
      out.push({
        inputId, status: 'absent', source: 'RX',
        detail: `${rule.label} (${matched}) — ${fieldLabel}`,
        provenanceRef: ref, observedAt,
      });
    }
  }
  return out;
}

// ── the explicit disease-name matcher ───────────────────────────────────────────

export interface DiseaseRule {
  label: string;
  /** exact names and aliases, lowercased. Matched on word boundaries, never as substrings. */
  names: readonly string[];
  inputs: readonly PreopInputId[];
  note?: string;
}

/**
 * A curated name list, NOT a classifier. The rule is "the name appears", full stop: no
 * inference, no synonym expansion at read time, no severity reasoning.
 *
 * ⚠️ ARF IS DELIBERATELY ABSENT — the B3 ruling, kept. Acute renal failure is not chronic
 * renal disease, and Charlson scores the chronic one. Anything that would need a judgement
 * about chronicity, staging or severity is not in this table; it is a suggestion (B8b).
 */
export const DISEASE_RULES: DiseaseRule[] = [
  { label: 'Ischaemic heart disease', names: ['ihd', 'cad', 'coronary artery disease', 'ischemic heart disease', 'ischaemic heart disease', 'angina', 'cabg', 'ptca', 'coronary angioplasty'], inputs: ['ischaemic_heart_disease'] },
  { label: 'Myocardial infarction', names: ['mi', 'myocardial infarction', 'heart attack', 'nstemi', 'stemi'], inputs: ['ischaemic_heart_disease', 'myocardial_infarction'] },
  { label: 'Congestive heart failure', names: ['ccf', 'chf', 'congestive cardiac failure', 'congestive heart failure', 'heart failure', 'cardiac failure'], inputs: ['congestive_heart_failure'] },
  { label: 'Cerebrovascular disease', names: ['cva', 'stroke', 'tia', 'transient ischemic attack', 'transient ischaemic attack', 'cerebrovascular accident'], inputs: ['cerebrovascular_disease'] },
  { label: 'Hemiplegia', names: ['hemiplegia', 'hemiparesis', 'paraplegia', 'quadriplegia'], inputs: ['hemiplegia'] },
  { label: 'COPD', names: ['copd', 'chronic obstructive pulmonary disease', 'emphysema', 'chronic bronchitis'], inputs: ['copd_or_pneumonia', 'chronic_pulmonary_disease'] },
  { label: 'Asthma', names: ['asthma', 'bronchial asthma'], inputs: ['chronic_pulmonary_disease'] },
  { label: 'Chronic kidney disease', names: ['ckd', 'chronic kidney disease', 'chronic renal failure', 'crf', 'dialysis', 'haemodialysis', 'hemodialysis', 'esrd'], inputs: ['moderate_severe_renal_disease'] },
  { label: 'Peripheral vascular disease', names: ['pvd', 'peripheral vascular disease', 'peripheral arterial disease', 'claudication'], inputs: ['peripheral_vascular_disease'] },
  { label: 'Peptic ulcer disease', names: ['peptic ulcer', 'duodenal ulcer', 'gastric ulcer', 'pud'], inputs: ['peptic_ulcer_disease'], note: 'the NAME, never the drug — see BANNED_DRUG_INFERENCE' },
  { label: 'Chronic liver disease', names: ['chronic liver disease', 'cld', 'cirrhosis', 'hepatitis b', 'hepatitis c'], inputs: ['mild_liver_disease'] },
  { label: 'Dementia', names: ['dementia', 'alzheimer', "alzheimer's"], inputs: ['dementia'] },
  { label: 'Connective tissue disease', names: ['rheumatoid arthritis', 'systemic lupus', 'sle', 'scleroderma', 'polymyositis'], inputs: ['connective_tissue_disease'] },
  { label: 'Hypothyroidism', names: ['hypothyroid', 'hypothyroidism'], inputs: [], note: 'no instrument scores it — carried so the coverage report can count it' },
];

/**
 * THE NEGATION GUARD. Deliberately simple and deliberately biased: when in doubt, DO NOT
 * MATCH. A miss degrades to a suggestion in B8b, where a human can confirm it; a false hit
 * corrupts a score silently. The guard looks left of the match for a negation cue and
 * right for a "no h/o X" style construction, and it also refuses a match sitting inside a
 * blanket denial ("no known comorbidities") anywhere in the same clause.
 */
const NEG_LEFT = /\b(?:no|not|nil|denies|denied|without|negative for|neg for|free of|ruled out|r\/o|h\/o\s+no|absent)\s+(?:known\s+|significant\s+|h\/o\s+|history\s+of\s+|past\s+|any\s+|previous\s+){0,3}$/i;
/**
 * ⚠️ AND THE OTHER SIDE OF THE NAME. Clinicians write the negation AFTER the term at least
 * as often as before it — "CKD not present", "IHD - nil", "COPD: no". A left-only guard
 * matched "NIL COMORBIDITIES; CKD not present" and scored a renal diagnosis off a denial,
 * which is the precise class of error the guard exists to prevent. Caught by the B8a test
 * table before this shipped.
 */
const NEG_RIGHT = /^[\s:,\-–—]*(?:not\s+present|not\s+known|absent|nil|none|no|negative|denied|ruled\s+out|excluded)\b/i;
const BLANKET_DENIAL = /\b(?:no|nil|denies|not)\b[^.;]{0,24}\b(?:known\s+)?(?:comorbid\w*|comorbs?|co-?morbidit\w*|medical\s+history|significant\s+history|h\/o)\b/i;

/** True when the match at `offset` is governed by a negation. */
export function negated(haystack: string, offset: number, length: number): boolean {
  const left = haystack.slice(Math.max(0, offset - 60), offset);
  if (NEG_LEFT.test(left)) return true;
  if (NEG_RIGHT.test(haystack.slice(offset + length, offset + length + 30))) return true;
  // The clause the match sits in — a blanket denial anywhere in it disqualifies everything.
  const start = Math.max(0, haystack.lastIndexOf('.', offset), haystack.lastIndexOf(';', offset), haystack.lastIndexOf('\n', offset));
  const endRel = haystack.slice(offset + length).search(/[.;\n]/);
  const end = endRel < 0 ? haystack.length : offset + length + endRel;
  return BLANKET_DENIAL.test(haystack.slice(start, end));
}

export interface DiseaseHit { rule: DiseaseRule; matched: string; offset: number; negated: boolean }

export function diseaseHits(text: string | null | undefined): DiseaseHit[] {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const hay = raw.toLowerCase();
  const out: DiseaseHit[] = [];
  for (const rule of DISEASE_RULES) {
    for (const name of rule.names) {
      const re = new RegExp(`(^|[^a-z])(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})([^a-z]|$)`, 'gi');
      let m: RegExpExecArray | null;
      let found = false;
      while ((m = re.exec(hay)) !== null) {
        const offset = m.index + m[1].length;
        out.push({ rule, matched: name, offset, negated: negated(raw, offset, name.length) });
        found = true;
        break;                                 // one hit per name is enough to decide
      }
      if (found) break;                        // one alias per rule
    }
  }
  return out;
}

/**
 * Disease NAMES in the anaesthetist's own prose → observations. Only positive, unnegated
 * matches produce anything: a negated mention observes NOTHING rather than asserting
 * absence, because "no h/o IHD" in a free-text box is a note, not an enumeration, and this
 * module reserves absence-from-silence for forms that actually enumerate (the closed-world
 * rule in preop-assemble-core).
 */
export function diseaseObservations(
  text: string | null | undefined,
  fieldLabel: string,
  observedAt: string | null = null,
  ref: string | null = null,
): { observations: Observation[]; suppressedByNegation: string[]; unmapped: string[] } {
  const observations: Observation[] = [];
  const suppressedByNegation: string[] = [];
  const unmapped: string[] = [];
  for (const hit of diseaseHits(text)) {
    if (hit.negated) { suppressedByNegation.push(hit.rule.label); continue; }
    if (!hit.rule.inputs.length) { unmapped.push(hit.rule.label); continue; }
    for (const inputId of hit.rule.inputs) {
      observations.push({
        inputId, status: 'present', source: 'PAC',
        detail: `${hit.rule.label} named in ${fieldLabel} ("${hit.matched}")`,
        provenanceRef: ref, observedAt,
      });
    }
  }
  return { observations, suppressedByNegation, unmapped };
}

// ── the sixth deterministic source ──────────────────────────────────────────────

/**
 * `individuals-prescriptions.comorbidities` — flagged unmapped in the B7 report and mapped
 * here. It is NOT free text: it is a structured array of `{ comorbidity: { uid, name } }`
 * whose names are a small controlled vocabulary ("High BP", "Thyroid Disorder", "Diabetes").
 * Same table as the ICD codes, same rank, same source label.
 *
 * ⚠️ "High BP" gives hypertension WITHOUT saying it is medicated, and mFI-5 scores the
 * medicated one. It therefore does NOT assert the mFI item — the RX dictionary above and
 * the booking form settle that. Carried as an unmapped term instead, so the coverage report
 * counts what the field says rather than what we wish it said.
 */
const OPD_COMORBIDITY_RULES: Array<{ names: readonly string[]; inputs: readonly PreopInputId[]; label: string }> = [
  { names: ['diabetes', 'diabetes mellitus', 'sugar'], inputs: ['diabetes_mellitus', 'diabetes_uncomplicated'], label: 'diabetes' },
  { names: ['heart disease', 'cardiac disease', 'ihd', 'coronary artery disease'], inputs: ['ischaemic_heart_disease'], label: 'ischaemic heart disease' },
  { names: ['asthma', 'copd'], inputs: ['chronic_pulmonary_disease'], label: 'chronic pulmonary disease' },
  { names: ['kidney disease', 'chronic kidney disease', 'ckd'], inputs: ['moderate_severe_renal_disease'], label: 'chronic kidney disease' },
  { names: ['stroke', 'paralysis'], inputs: ['cerebrovascular_disease'], label: 'cerebrovascular disease' },
];

export function opdComorbidityObservations(
  names: readonly string[] | null | undefined,
  observedAt: string | null = null,
  ref: string | null = null,
): { observations: Observation[]; matched: string[]; unmapped: string[] } {
  const observations: Observation[] = [];
  const matched: string[] = [];
  const unmapped: string[] = [];
  for (const raw of names ?? []) {
    const n = String(raw).trim().toLowerCase();
    if (!n) continue;
    const rule = OPD_COMORBIDITY_RULES.find((r) => r.names.includes(n));
    if (!rule) { unmapped.push(String(raw).trim()); continue; }
    matched.push(String(raw).trim());
    for (const inputId of rule.inputs) {
      observations.push({
        inputId, status: 'present', source: 'OPD',
        detail: `${rule.label} on the OPD comorbidity list ("${String(raw).trim()}")`,
        provenanceRef: ref, observedAt,
      });
    }
  }
  return { observations, matched, unmapped };
}
