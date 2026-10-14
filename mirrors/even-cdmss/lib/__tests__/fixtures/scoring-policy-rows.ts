/**
 * lib/__tests__/fixtures/scoring-policy-rows.ts — discharge_summary completeness fixtures + an
 * INDEPENDENT reference implementation of the legacy arithmetic.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ PROVENANCE — READ THIS. THESE ARE SHAPE-REAL, NOT ROW-REAL.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * The kickoff asks for "a fixture of real report.completeness.items arrays". The build sandbox has
 * NO LIVE DATABASE, so the 345 stored rows could not be exported. What is real here:
 *
 *   · the 21 keys, labels and sections — read VERBATIM from data/nabh-rubric.json;
 *   · the item SHAPE — {key, label, section, ref, status, mandatory, note?}, matching
 *     lib/doc-audit-core.ts `CompletenessItem` exactly;
 *   · `ref: "AAC.14"` and `mandatory: true` on every item, per PRD §2.2;
 *   · the status DISTRIBUTIONS — driven by the measured missing counts in PRD §2.9
 *     (date_discharge 269/345, signed_datetime 261/345, cause_of_death `na` in 342/345, …).
 *
 * What is NOT real: the specific per-row combinations. They are constructed to span the arithmetic
 * — including the rounding ties and the non-conditional `na` case — not sampled from production.
 *
 * WHY THE TEST IS STILL WORTH SOMETHING: `legacyPctReference` below is written from
 * lib/doc-audit-core.ts's `assembleCompleteness` + lib/ipd-audit/assemble.ts's `×100` AS A SEPARATE
 * IMPLEMENTATION — it does not call the module under test. So the invariant test compares two
 * independent computations of the same quantity, which catches an arithmetic or rounding error
 * regardless of where the rows came from.
 *
 * WHAT THIS TEST CANNOT DO: prove the 313/345 agreement figure in PRD §2.5. That is a live-data
 * check and stays with the orchestrator (verification plan §11 step 4). See the build report.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

export type FixtureStatus = 'present' | 'partial' | 'missing' | 'na';

export interface FixtureItem {
  key: string;
  label: string;
  section: string;
  ref: string;
  status: FixtureStatus;
  mandatory: boolean;
  note?: string;
}

/** key → [label, section], VERBATIM from data/nabh-rubric.json, in rubric order. */
const FIELD_META: [string, string, string][] = [
  ['patient_name', 'Patient name', 'identifiers'],
  ['uhid', 'UHID', 'identifiers'],
  ['treating_doctor', 'Treating doctor', 'identifiers'],
  ['date_admission', 'Date of admission', 'identifiers'],
  ['date_discharge', 'Date of discharge', 'identifiers'],
  ['reason_admission', 'Reason for admission', 'clinical'],
  ['significant_findings', 'Significant findings', 'clinical'],
  ['diagnosis', 'Diagnosis', 'clinical'],
  ['condition_at_discharge', 'Condition at discharge', 'clinical'],
  ['investigations', 'Investigation results', 'course'],
  ['procedures_performed', 'Procedures performed', 'course'],
  ['medications_administered', 'Medications administered', 'course'],
  ['treatment_given', 'Other treatment given', 'course'],
  ['followup_advice', 'Follow-up advice', 'followup'],
  ['discharge_medication', 'Discharge medication (with dose/route/duration)', 'followup'],
  ['patient_instructions', 'Patient instructions (understandable language)', 'followup'],
  ['urgent_care_instructions', 'When & how to obtain urgent care', 'followup'],
  ['outcome', 'Discharge outcome (Discharged/LAMA/Referred/Death)', 'outcome'],
  ['cause_of_death', 'Cause of death', 'outcome'],
  ['doctor_signature', 'Doctor name & signature', 'signoff'],
  ['signed_datetime', 'Date & time of signature', 'signoff'],
];

/** The one conditional field (rubric `"cond":"outcome=Death"`). `na` on it is the normal case. */
const COND_KEY = 'cause_of_death';

/**
 * Build a full 21-item array. Any key not named in `overrides` is `present`; `cause_of_death`
 * defaults to `na` (342 of 345 audits, PRD §2.9).
 */
export function buildItems(overrides: Record<string, FixtureStatus>): FixtureItem[] {
  return FIELD_META.map(([key, label, section]) => {
    const status: FixtureStatus = overrides[key] ?? (key === COND_KEY ? 'na' : 'present');
    const item: FixtureItem = { key, label, section, ref: 'AAC.14', status, mandatory: true };
    if (status === 'partial' || status === 'missing') item.note = 'documented but incomplete';
    return item;
  });
}

export interface Fixture { id: string; why: string; items: FixtureItem[] }

/**
 * ═══ THE REFERENCE IMPLEMENTATION ═══
 * A second, independent transcription of the legacy chain:
 *
 *   lib/doc-audit-core.ts assembleCompleteness()
 *     counted        = mandatory && !cond          ⇒ always in the denominator
 *     mandatoryMet  += 1     when status is 'present' OR 'na'      ← note the `|| 'na'`
 *     mandatoryMet  += 0.5   when status is 'partial'
 *     cond fields    = counted ONLY when status ∈ {present, partial, missing}
 *     coverage       = Math.round((met / total) * 100) / 100
 *
 *   lib/ipd-audit/assemble.ts:59
 *     completenessPct = Math.round(coverage * 100)
 *
 * Written deliberately in a different style from lib/scoring-policy/completeness.ts (imperative
 * counters, no weights, no options object) so a shared mistake is unlikely.
 */
export function legacyPctReference(items: FixtureItem[]): number {
  let met = 0;
  let total = 0;
  for (const it of items) {
    const isCond = it.key === COND_KEY;
    if (isCond) {
      if (it.status === 'na') continue;              // condition did not hold ⇒ out of both sides
      total += 1;
      if (it.status === 'present') met += 1;
      else if (it.status === 'partial') met += 0.5;
      continue;
    }
    total += 1;
    if (it.status === 'present' || it.status === 'na') met += 1;   // ← THE DIVERGENCE FROM THE PRD PROSE
    else if (it.status === 'partial') met += 0.5;
  }
  if (total === 0) return 100;
  const coverage = Math.round((met / total) * 100) / 100;
  return Math.round(coverage * 100);
}

/**
 * The fixtures. `why` documents what each one is for; the invariant test asserts the set covers
 * the rounding ties, the `na` divergence, partials, and the applicable-conditional case.
 *
 * Rounding ties arise at total = 20 with an ODD number of `partial` fields: met is then a
 * half-integer and met/20 × 100 lands exactly on .5, which is where a half-up vs half-even
 * tie-break would diverge. Five such rows are included, as PRD §10 requires.
 */
export const DS_FIXTURES: Fixture[] = [
  {
    id: 'ds-01-perfect',
    why: 'everything present, cause_of_death na — the 20/20 ceiling',
    items: buildItems({}),
  },
  {
    id: 'ds-02-the-common-pair',
    why: 'the two systemic gaps: date_discharge (269/345) + signed_datetime (261/345)',
    items: buildItems({ date_discharge: 'missing', signed_datetime: 'missing' }),
  },
  {
    id: 'ds-03-rounding-tie-17.5',
    why: 'rounding tie: 17.5/20 = 87.5 exactly (5 partials → odd half)',
    items: buildItems({
      date_discharge: 'missing', signed_datetime: 'missing',
      diagnosis: 'partial', investigations: 'partial', treatment_given: 'partial',
      followup_advice: 'partial', patient_instructions: 'partial',
    }),
  },
  {
    id: 'ds-04-rounding-tie-16.5',
    why: 'rounding tie: 16.5/20 = 82.5 exactly',
    items: buildItems({
      date_discharge: 'missing', signed_datetime: 'missing', procedures_performed: 'missing',
      diagnosis: 'partial', investigations: 'partial', treatment_given: 'partial',
    }),
  },
  {
    id: 'ds-05-rounding-tie-15.5',
    why: 'rounding tie: 15.5/20 = 77.5 exactly',
    items: buildItems({
      date_discharge: 'missing', signed_datetime: 'missing',
      medications_administered: 'missing', urgent_care_instructions: 'missing',
      diagnosis: 'partial', investigations: 'partial', treatment_given: 'partial',
    }),
  },
  {
    id: 'ds-06-rounding-tie-13.5',
    why: 'rounding tie: 13.5/20 = 67.5 exactly — a C/D boundary neighbourhood',
    items: buildItems({
      date_discharge: 'missing', signed_datetime: 'missing', procedures_performed: 'missing',
      medications_administered: 'missing', urgent_care_instructions: 'missing',
      patient_instructions: 'missing',
      diagnosis: 'partial', investigations: 'partial', treatment_given: 'partial',
    }),
  },
  {
    id: 'ds-07-rounding-tie-9.5',
    why: 'rounding tie: 9.5/20 = 47.5 exactly — deep in band D',
    items: buildItems({
      date_discharge: 'missing', signed_datetime: 'missing', doctor_signature: 'missing',
      procedures_performed: 'missing', medications_administered: 'missing',
      urgent_care_instructions: 'missing', patient_instructions: 'missing',
      discharge_medication: 'missing', followup_advice: 'missing',
      diagnosis: 'partial', significant_findings: 'partial', condition_at_discharge: 'partial',
    }),
  },
  {
    id: 'ds-08-na-on-a-non-conditional-field',
    why: 'procedures_performed na (rubric allows it) — THE na-policy divergence case',
    items: buildItems({ procedures_performed: 'na', date_discharge: 'missing', signed_datetime: 'missing' }),
  },
  {
    id: 'ds-09-na-plus-heavy-missing',
    why: 'na + 9 missing — where legacy (55) and the kickoff prose (53) visibly disagree',
    items: buildItems({
      procedures_performed: 'na',
      date_discharge: 'missing', signed_datetime: 'missing', doctor_signature: 'missing',
      medications_administered: 'missing', urgent_care_instructions: 'missing',
      patient_instructions: 'missing', discharge_medication: 'missing',
      followup_advice: 'missing', investigations: 'missing',
    }),
  },
  {
    id: 'ds-10-death-case',
    why: 'outcome=Death ⇒ cause_of_death APPLIES: mandatoryTotal 21, not 20 (the 3 of 345)',
    items: buildItems({ cause_of_death: 'present', date_discharge: 'missing' }),
  },
  {
    id: 'ds-11-death-case-missing-cod',
    why: 'the condition holds but the field is missing ⇒ 20/21',
    items: buildItems({ cause_of_death: 'missing' }),
  },
  {
    id: 'ds-12-everything-missing',
    why: 'the 0% floor — 0/20, must not produce NaN or a negative',
    items: buildItems(Object.fromEntries(
      FIELD_META.filter(([k]) => k !== COND_KEY).map(([k]) => [k, 'missing' as FixtureStatus]),
    )),
  },
  {
    id: 'ds-13-all-partial',
    why: 'every applicable field partial ⇒ exactly 50%',
    items: buildItems(Object.fromEntries(
      FIELD_META.filter(([k]) => k !== COND_KEY).map(([k]) => [k, 'partial' as FixtureStatus]),
    )),
  },
  {
    id: 'ds-14-single-partial',
    why: '19.5/20 = 97.5 — a tie at the top of the range',
    items: buildItems({ discharge_medication: 'partial' }),
  },
  {
    id: 'ds-15-realistic-mid',
    why: 'a plausible production row: the two systemic gaps + a partial med list',
    items: buildItems({
      date_discharge: 'missing', signed_datetime: 'missing',
      discharge_medication: 'partial', urgent_care_instructions: 'missing',
      significant_findings: 'missing',
    }),
  },
  {
    id: 'ds-16-all-na',
    why: 'pathological: every field na ⇒ 100 with applicable 0, never a divide-by-zero (PRD §8.5)',
    items: buildItems(Object.fromEntries(FIELD_META.map(([k]) => [k, 'na' as FixtureStatus]))),
  },
];
