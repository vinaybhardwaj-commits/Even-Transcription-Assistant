/**
 * lib/readmission-rates-core.ts — PURE definitions for the readmission RATES module
 * (CDMSS-READMISSIONS-R7-PRD v1.0, 19 Aug 2026; R7-2 / R7-4 / R7-5 / R7-6 / R7-8) — the method of
 * CDMSS-EHRC-READMISSION-RATE-REPORT-19-AUG-2026 codified ONCE, so the module and every future report
 * compute the same numbers from the same definitions. No DB, no React, no clock: `ceilingDay` is an
 * input.
 *
 *   · Surveillance window: index discharges from SURVEILLANCE_START (22 Sep 2025, left truncation per
 *     the report) to the ascertainment ceiling.
 *   · Three denominators (R7-2): ELIGIBLE = discharges with complete 30-day follow-up (discharge day
 *     ≤ ceiling − 30; the default); TRUE IPD = eligible minus the patient-chose-to-leave class (DAMA /
 *     LAMA / Discharge On Request / Absconded) and in-hospital deaths;
 *     ALL IN WINDOW = every discharge to the ceiling (rendered, tagged `understates` — recent discharges
 *     lack 30-day follow-up). The 90-day rate uses ceiling − 90 likewise.
 *   · Numerators: detected Even→Even pairs (one pair = one index encounter, LEAD pairing) whose index
 *     discharge day is inside the window and whose gap ≤ 30 (or ≤ 90); split reviewable vs held-out by
 *     the index department against the detector's EXCLUDED_DEPARTMENTS (reused, never redeclared);
 *     immediate return = gap ≤ 1 (R7-5); proposed-avoidable = stored avoidable = 'avoidable' (R7-3).
 *   · Monthly cohort method: index-discharge month (IST); a month is COMPLETE for 30-day follow-up when
 *     its last day + 30 ≤ ceiling — incomplete months are rendered as censored ghosts, never as rates.
 *   · Wilson 95% CI (z = 1.96) — the report's worked example 65 / 1,185 → 4.33 – 6.93 %.
 *   · EHBR gate (R7-4): a facility earns rates when its FIRST FULL calendar month of discharges has
 *     completed 30-day follow-up; before that the module shows counts only. Computed, never hardcoded.
 *   · Staged-return marker (R7-6) + immediate-return predicate (R7-5): deterministic, no model verdict
 *     touched, no engine bump.
 *
 * R9 (CDMSS-READMISSIONS-R9-DUAL-CONTRACT PRD, GO 27 Aug 2026) — the SECOND published contract.
 * The same detection spine now feeds two aggregators (D1):
 *   · INCIDENCE (the LEAD, D2/D3/D4/D5): unique PEOPLE, clock hours from the stored
 *     `index_discharge_at` / `readmit_admit_at` (never floor-days — T1), <24h collapsed as the same
 *     event, index department not in INCIDENCE_EXCLUDED_DEPARTMENTS. Denominator = distinct people
 *     among Even completed IP discharges in the same window, read by its own query. People are not
 *     stays: when the distinct-person count cannot be read the card says so and shows NOTHING (T5).
 *   · ELIGIBLE EPISODES (the SECONDARY): today's `rates/1` math, BYTE-STABLE. Everything below the
 *     incidence block is unchanged arithmetic; only the card strip's presentation moved.
 * RATES_VERSION is 'rates/2' because the card strip's semantics changed (the reviewable peer card is
 * gone, the lead is a different measure) — not because any Eligible number moved.
 */
import { EXCLUDED_DEPARTMENTS } from './readmission-detect-core';

// ── constants ────────────────────────────────────────────────────────────────────────────

export const RATES_VERSION = 'rates/2';
/** Left truncation (report caveat 4): surveillance starts 22 Sep 2025 IST. */
export const SURVEILLANCE_START = '2025-09-22';
export const FOLLOW_UP_30 = 30;
export const FOLLOW_UP_90 = 90;
/** db13 kx_discharged_completed_patients.discharge_type_value — values GROUNDED LIVE 19 Aug 2026 on
 *  2,025 ip_admission rows: 'Normal Discharge' 1,973 · 'DAMA' 22 · 'Discharge On Request' 11 ·
 *  'Expired' 7 · 'Mortuary' 5 · 'Admitted Dead' 3 · 'Refer External Hospital' 1 · 'Early Neonatal' 1 ·
 *  'LAMA' 1 · 'Absconded' 1. TRUE IPD removes the patient-chose-to-leave class (DAMA / LAMA /
 *  Discharge On Request / Absconded — R7.1, V ruled 19 Aug; Absconded bundled by the orchestrator) and
 *  in-hospital death (Expired / Mortuary / Admitted Dead). 'Refer External Hospital' and 'Early
 *  Neonatal' are NOT removed. */
export const TRUE_IPD_EXCLUDED_DISPOSITIONS: readonly string[] = ['DAMA', 'LAMA', 'Discharge On Request', 'Absconded', 'Expired', 'Mortuary', 'Admitted Dead'];
/** db13 facility_name values (R6, measured): the two hospitals. Encounter-prefix fallback for findings. */
export const FACILITY_EHRC = 'Even';
export const FACILITY_EHBR = 'Even-EHBR';
export const FACILITIES: readonly string[] = [FACILITY_EHRC, FACILITY_EHBR];

export type DenominatorKey = 'eligible' | 'true_ipd' | 'all_in_window';
export const DENOMINATORS: readonly DenominatorKey[] = ['eligible', 'true_ipd', 'all_in_window'];
export const DENOMINATOR_LABEL: Readonly<Record<DenominatorKey, string>> = {
  eligible: 'Eligible — complete 30-day follow-up',
  true_ipd: 'True IPD — also excluding left-against-advice / on-request / absconded and deaths',
  all_in_window: 'All in window',
};
export const DENOMINATOR_WARNING: Readonly<Record<DenominatorKey, string | null>> = {
  eligible: null,
  true_ipd: null,
  all_in_window: 'understates — recent discharges lack 30d follow-up',
};
export const DEFAULT_DENOMINATOR: DenominatorKey = 'eligible';

/** The footnote (report caveat 1): an Even-return rate, not a true readmission rate. */
export const THIS_HOSPITAL_ONLY_FOOTNOTE = 'These are returns to THIS hospital only — returns to other hospitals are invisible except by patient report, so the true all-hospital rate is higher by an unknown margin. Definitions: CDMSS-EHRC-READMISSION-RATE-REPORT-19-AUG-2026 (codified in readmission-rates-core).';
export const RATES_UNAVAILABLE_COPY = 'rates unavailable right now';
export const EHBR_GATE_COPY = 'counts only — rates are shown once the first full month of discharges has completed its 30-day follow-up';
/** R7-7 — condition-pass-only audits are labelled, never "no judgement". */
export const CONDITION_PASS_ONLY_LABEL = 'condition-pass only';

// ── R9 — the incidence contract (D2 … D6, L1, O4, T1, T3, T4, T5) ─────────────────────────

/**
 * R9 / D5 (O4) — the departments dropped from the INCIDENCE numerator, matched on the INDEX stay's
 * `treating_sub_department_name`, exact strings: the four oncology strings plus all Obstetrics and
 * Gynecology (maternity is not splittable into delivery vs other gynae on this spine — D6).
 *
 * ⚠️ THIS DELIBERATELY AMENDS THE R7 INVARIANT "EXCLUDED_DEPARTMENTS is reused, never redeclared".
 * Two lists now exist and they are not the same list, on purpose:
 *   · the DETECTOR's six-string `EXCLUDED_DEPARTMENTS` (readmission-detect-core) still drives
 *     detection hold-out and the board's held-out list filter, and it still contains 'Nephrology';
 *   · this five-string list drives the INCIDENCE numerator only, and Nephrology is NOT in it —
 *     Mohsin named oncology and maternity, never CKD (D5, refuse list).
 * Neither list may be derived from the other; a change to one is not a change to the other.
 */
export const INCIDENCE_EXCLUDED_DEPARTMENTS: readonly string[] = [
  'Oncology',
  'Medical Oncology',
  'Radiation Oncology',
  'Surgical Oncology & Oncoplastic Breast Surgery',
  'Obstetrics and Gynecology',
];

/** D5 — exact string match on the trimmed index department. Null / unknown department → NOT excluded. */
export function isIncidenceExcludedDepartment(department: string | null | undefined): boolean {
  return department != null && INCIDENCE_EXCLUDED_DEPARTMENTS.includes(department.trim());
}

/** D4 — the incidence clock window, in HOURS: <24h is the same event; >30 days is out of window. */
export const INCIDENCE_MIN_HOURS = 24;
export const INCIDENCE_MAX_HOURS = FOLLOW_UP_30 * 24;

/**
 * T1 — CLOCK hours between two stored instants, NEVER floor-days. Either side missing or
 * unparseable → null, and a null is NOT countable: the pair simply cannot be judged for incidence
 * and is reported as such (never silently re-judged with `gap_days`).
 */
export function clockHoursBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  const parse = (v: string | null | undefined): number | null => {
    if (v == null || v === '') return null;
    const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(String(v)) ? String(v).replace(' ', 'T') : String(v));
    return Number.isFinite(t) ? t : null;
  };
  const a = parse(fromIso), b = parse(toIso);
  if (a == null || b == null) return null;
  return (b - a) / 3_600_000;
}

/** D4 — the pair's clock gap is inside the incidence window: ≥ 24 h and ≤ 30 days. */
export function isIncidenceClockGap(hours: number | null | undefined): boolean {
  return typeof hours === 'number' && Number.isFinite(hours) && hours >= INCIDENCE_MIN_HOURS && hours <= INCIDENCE_MAX_HOURS;
}

// ── R9 card copy (§12.2; L1 for the Immediate card) ───────────────────────────────────────

export const INCIDENCE_LEAD_LABEL = '30-day incidence · unique patients';
export const INCIDENCE_LEAD_NOTE = 'clock ≥24h and ≤30d · onco and ObGyn excluded';
/** D6 — the two exclusions that cannot be tagged on this spine. Required on the incidence card. */
export const INCIDENCE_FOOTNOTE = 'Neonate and ophthal/cataract cannot be tagged on completed IP discharges. This is CAT incidence on the CAT spine, not the insurer calendar.';
/** T5 — people are NEVER approximated as stays: the card says it cannot count people. */
export const INCIDENCE_UNAVAILABLE_COPY = 'incidence unavailable — the unique-patient count could not be read; people are not stays, so nothing is shown';
export const EPISODES_SECONDARY_LABEL = '30-day episodes · warranty / clinical';
export const EPISODES_SECONDARY_NOTE = '0–30 including next-morning · stays, not people';
export const EPISODES_90_LABEL = '90-day episodes';
/** L1 — the Immediate card's label and copy. The union test itself is UNCHANGED (see isImmediateReturn). */
export const IMMEDIATE_CARD_LABEL = 'Immediate / next-morning returns';
export const IMMEDIATE_CARD_COPY = 'count, not a rate · includes next-morning returns · <24h same-event returns are out of incidence';
/** §12.2 — the advisory card's sub-line under the dual contract. */
export const PROPOSED_AVOIDABLE_ADVISORY = 'agent proposal, not the human overlay';

// ── small pure helpers ───────────────────────────────────────────────────────────────────

/** YYYY-MM-DD of an instant in IST (UTC+05:30, no DST). */
export function istDay(v: string | Date | number | null | undefined): string | null {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(/^\d{4}-\d{2}-\d{2} /.test(String(v)) ? String(v).replace(' ', 'T') : String(v));
  if (!Number.isFinite(t)) return null;
  return new Date(t + 5.5 * 3_600_000).toISOString().slice(0, 10);
}
export const monthOf = (day: string): string => day.slice(0, 7);
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export function addDays(day: string, n: number): string { return new Date(dayMs(day) + n * 86_400_000).toISOString().slice(0, 10); }
export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);   // day 0 of next month
}
export function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

/** Facility of a finding: the R6 name when the route carries it, else the encounter-prefix fallback
 *  (measured: 'IP-' = Even / EHRC; 'IPNO-' and 'ADM' = Even-EHBR). Unknown prefix → null. */
export function facilityOfEncounter(encounterId: string | null | undefined, facilityName?: string | null): string | null {
  if (facilityName && (FACILITIES as readonly string[]).includes(facilityName)) return facilityName;
  const id = (encounterId ?? '').trim().toUpperCase();
  if (id.startsWith('IPNO') || id.startsWith('ADM')) return FACILITY_EHBR;
  if (id.startsWith('IP-')) return FACILITY_EHRC;
  return null;
}

/** The held-out set — the detector's EXCLUDED_DEPARTMENTS (reused), exact strings, trimmed. */
export function isHeldOutDepartment(department: string | null | undefined): boolean {
  return department != null && (EXCLUDED_DEPARTMENTS as readonly string[]).includes(department.trim());
}

/**
 * R7-5 — immediate return: a pair with gap ≤ 1 day (same / next-day). Null gap → false.
 *
 * L1 / acceptance #9 keep the UNION test "clock < 24 h OR gap_days ≤ 1", and this single predicate
 * already IS that union, exactly: gap_days is floor((admit − discharge) / 24 h), so a clock gap under
 * 24 h floors to 0 and is therefore always inside `gap_days ≤ 1`. {clock < 24h} ⊂ {gap_days ≤ 1}, so
 * the union equals {gap_days ≤ 1}. The card's LABEL and COPY change under R9; this arithmetic does
 * not, and the Immediate count is byte-stable.
 */
export function isImmediateReturn(gapDays: number | null | undefined): boolean {
  return typeof gapDays === 'number' && Number.isFinite(gapDays) && gapDays <= 1;
}
export const IMMEDIATE_RETURN_COPY = 'Immediate return — possible transfer or deferred surgery';
export const STAGED_RETURN_COPY = 'possible planned staged return — the index follow-up mentions this procedure';

/** Wilson score interval (z = 1.96), in PERCENT with 2 dp, as the report prints it. n = 0 → null. */
export function wilsonCi(k: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const r2 = (x: number) => Math.round(x * 10_000) / 100;
  return { lo: r2(Math.max(0, centre - half)), hi: r2(Math.min(1, centre + half)) };
}
export const pct = (k: number, n: number): number | null => (n > 0 ? Math.round((k / n) * 10_000) / 100 : null);

// ── inputs (aggregates / per-pair facts only — no identifiers beyond the encounter id used for facility) ──

/** One detected Even→Even pair as the rates read needs it. */
export interface RatePair {
  index_encounter_id: string;
  /** IST calendar day of the index discharge. */
  index_day: string | null;
  gap_days: number | null;
  index_department: string | null;
  lane: string | null;
  audit_status: string | null;
  avoidable: string | null;
  planned: string | null;
  preventable_injury?: string | null;
  facility?: string | null;
}
/** One db13 discharge bucket: facility × IST day × department × disposition → count. */
export interface DischargeBucket {
  facility: string | null;
  day: string | null;
  department: string | null;
  disposition: string | null;
  n: number;
}

/**
 * R9 — one detected Even→Even pair as the INCIDENCE aggregator needs it (D3/D4/D5).
 *
 * `person` is the stored `uhid`. It is the ONLY identifier this core ever receives, it is used for
 * exactly one thing — counting a repeater once (D3) — and it is NEVER emitted: `Incidence` carries
 * counts only. This is the same posture as `index_encounter_id`, which the R7 core already reads
 * server-side solely to resolve a facility and never puts in the payload.
 */
export interface IncidencePair {
  person: string | null;
  index_encounter_id: string;
  /** IST calendar day of the index discharge. */
  index_day: string | null;
  index_department: string | null;
  /** The stored instants — the ONLY source of the incidence clock (T1). */
  index_discharge_at: string | null;
  readmit_admit_at: string | null;
  facility?: string | null;
}

// ── outputs ───────────────────────────────────────────────────────────────────────────────

export interface Measure { numerator: number; denominator: number; rate: number | null; ci: { lo: number; hi: number } | null }

/**
 * R9 — the incidence contract's result. AGGREGATES ONLY.
 *
 * `available` is the T5 fail-closed switch: false means the distinct-PEOPLE denominator could not be
 * read, and the card must show INCIDENCE_UNAVAILABLE_COPY. It must never fall back to the stays
 * denominator — a people rate printed off a stays denominator is a number neither board publishes.
 * The three drop counters exist so the recipe can be audited from the payload without any identifier.
 */
export interface Incidence {
  available: boolean;
  /** Distinct people with a qualifying return. 0 is a real answer; unavailable is not 0. */
  numerator: number;
  /** Distinct people discharged in the window, or null when the read failed (T5). */
  denominator: number | null;
  rate: number | null;
  ci: { lo: number; hi: number } | null;
  windowStart: string;
  windowEnd: string;
  /** Pairs in the window dropped because the index department is in INCIDENCE_EXCLUDED_DEPARTMENTS. */
  excludedByDepartment: number;
  /** Pairs in the window whose clock gap is outside [24 h, 30 d] — the <24h same-event collapse (D4). */
  outOfClockWindow: number;
  /** Pairs in the window that cannot be judged at all: a missing timestamp or a missing person key (T1). */
  notCountable: number;
}
export interface DenominatorSet {
  key: DenominatorKey;
  label: string;
  warning: string | null;
  /** Denominators: 30-day window (all / reviewable / held-out) and the 90-day window. */
  d30: number; d30_reviewable: number; d30_held_out: number; d90: number; d90_reviewable: number;
  /** The five cards. */
  all30: Measure; reviewable30: Measure; heldOut30: Measure; all90: Measure; reviewable90: Measure;
  immediate: Measure; proposedAvoidable: Measure;
}
export interface MonthCohort {
  month: string;
  complete: boolean;          // month end + 30 ≤ ceiling
  discharges: number; discharges_reviewable: number; discharges_held_out: number;
  returns30: number; returns30_reviewable: number; returns30_held_out: number;
  rate30: number | null; rate30_reviewable: number | null; rate30_held_out: number | null;
}
export interface JudgementStats {
  audited: number; justified: number; needs_adjudication: number; avoidable: number;
  /** R7-7: lane 'other', unpromoted — null avoidable BY DESIGN; labelled, never "no judgement". */
  condition_pass_only: number;
  /** Any other audited row with a null avoidable (not condition-pass): the true "no judgement" count. */
  no_judgement: number;
  held_out_detected: number; not_auditable: number; pending: number;
  preventable_injury_suspected: number;
}
export interface FacilityRates {
  facility: string;
  pairs: number;
  /** R7-4: rates are shown only when the facility has earned them. */
  ratesAllowed: boolean;
  gate: { firstDischargeDay: string | null; firstFullMonth: string | null; opensOn: string | null; reason: string | null };
  denominators: Record<DenominatorKey, DenominatorSet>;
  months: MonthCohort[];
  judgements: JudgementStats;
  gapDistribution: { d0_1: number; d2_7: number; d8_30: number; d31_90: number };
  /** R9 — the incidence LEAD. Non-null only where an incidence read was supplied for this facility
   *  (today: Even / EHRC only — EHBR stays its own tab and its own gate). */
  incidence: Incidence | null;
}
export interface RatesResult {
  version: typeof RATES_VERSION;
  ceilingDay: string;
  surveillanceStart: string;
  facilities: FacilityRates[];
}

// ── the computation ───────────────────────────────────────────────────────────────────────

const measure = (k: number, n: number): Measure => ({ numerator: k, denominator: n, rate: pct(k, n), ci: wilsonCi(k, n) });
const inWindow = (day: string | null, start: string, endInclusive: string): boolean => !!day && day >= start && day <= endInclusive;

/**
 * R9 — the INCIDENCE aggregator (D2 … D5, T1, T5). PURE, and deliberately its own function so the
 * recipe can be read in one place:
 *
 *   denominator  distinct PEOPLE discharged from this facility with complete 30-day follow-up
 *                (index day in [start, ceiling − 30]); supplied by the caller because a distinct
 *                count cannot be recovered from the day × department × disposition buckets, and
 *                NULL when that read failed — which fails the whole card closed (T5).
 *   numerator    distinct PEOPLE among this facility's even_even pairs whose index day is in the
 *                same window, whose index department is not in INCIDENCE_EXCLUDED_DEPARTMENTS, and
 *                whose CLOCK gap is in [24 h, 30 d]. A person with two qualifying returns counts once.
 *
 * A pair with a missing timestamp, an unparseable timestamp, or no person key is NOT countable and is
 * reported in `notCountable` — never re-judged with `gap_days` (T1), never quietly dropped.
 */
export function computeIncidence(input: {
  pairs: readonly IncidencePair[];
  denominator: number | null | undefined;
  ceilingDay: string;
  start?: string;
  facility?: string;
}): Incidence {
  const start = input.start ?? SURVEILLANCE_START;
  const end30 = addDays(input.ceilingDay, -FOLLOW_UP_30);
  const fac = input.facility ?? FACILITY_EHRC;
  const people = new Set<string>();
  let excludedByDepartment = 0, outOfClockWindow = 0, notCountable = 0;
  for (const p of input.pairs) {
    if ((p.facility ?? facilityOfEncounter(p.index_encounter_id)) !== fac) continue;
    if (!inWindow(p.index_day, start, end30)) continue;
    if (isIncidenceExcludedDepartment(p.index_department)) { excludedByDepartment++; continue; }
    const hours = clockHoursBetween(p.index_discharge_at, p.readmit_admit_at);
    if (hours == null) { notCountable++; continue; }
    if (!isIncidenceClockGap(hours)) { outOfClockWindow++; continue; }
    const person = typeof p.person === 'string' ? p.person.trim() : '';
    if (!person) { notCountable++; continue; }
    people.add(person);
  }
  const denom = typeof input.denominator === 'number' && Number.isFinite(input.denominator) && input.denominator >= 0 ? Math.floor(input.denominator) : null;
  const numerator = people.size;
  const available = denom != null && denom > 0;
  return {
    available,
    numerator,
    denominator: denom,
    rate: available ? pct(numerator, denom) : null,
    ci: available ? wilsonCi(Math.min(numerator, denom), denom) : null,
    windowStart: start,
    windowEnd: end30,
    excludedByDepartment,
    outOfClockWindow,
    notCountable,
  };
}

/**
 * `incidencePairs` / `incidenceDenominator` are OPTIONAL and additive: omit them and every facility
 * gets `incidence: null` and every Eligible / 90-day / immediate / proposed-avoidable number below is
 * bit-for-bit what `rates/1` produced for the same input.
 */
export function computeRates(input: {
  pairs: readonly RatePair[];
  discharges: readonly DischargeBucket[];
  ceilingDay: string;
  start?: string;
  incidencePairs?: readonly IncidencePair[] | null;
  incidenceDenominator?: number | null;
}): RatesResult {
  const start = input.start ?? SURVEILLANCE_START;
  const ceiling = input.ceilingDay;
  const end30 = addDays(ceiling, -FOLLOW_UP_30);
  const end90 = addDays(ceiling, -FOLLOW_UP_90);
  const facilities: FacilityRates[] = [];
  for (const fac of FACILITIES) {
    const pairs = input.pairs.filter((p) => (p.facility ?? facilityOfEncounter(p.index_encounter_id)) === fac);
    const disch = input.discharges.filter((d) => d.facility === fac && d.day != null);
    const heldOutD = (d: DischargeBucket) => isHeldOutDepartment(d.department);
    const heldOutP = (p: RatePair) => isHeldOutDepartment(p.index_department);
    const excludedDisp = (d: DischargeBucket) => d.disposition != null && TRUE_IPD_EXCLUDED_DISPOSITIONS.includes(d.disposition.trim());
    const sum = (rows: readonly DischargeBucket[], pred: (d: DischargeBucket) => boolean) => rows.reduce((n, d) => n + (pred(d) ? Number(d.n) || 0 : 0), 0);
    const count = (rows: readonly RatePair[], pred: (p: RatePair) => boolean) => rows.reduce((n, p) => n + (pred(p) ? 1 : 0), 0);

    const denomSet = (key: DenominatorKey): DenominatorSet => {
      const e30 = key === 'all_in_window' ? ceiling : end30;
      const e90 = key === 'all_in_window' ? ceiling : end90;
      const keep = (d: DischargeBucket) => key === 'true_ipd' ? !excludedDisp(d) : true;
      const d30 = sum(disch, (d) => inWindow(d.day, start, e30) && keep(d));
      const d30h = sum(disch, (d) => inWindow(d.day, start, e30) && keep(d) && heldOutD(d));
      const d90 = sum(disch, (d) => inWindow(d.day, start, e90) && keep(d));
      const d90h = sum(disch, (d) => inWindow(d.day, start, e90) && keep(d) && heldOutD(d));
      const n30 = count(pairs, (p) => inWindow(p.index_day, start, e30) && (p.gap_days ?? Infinity) <= 30);
      const n30h = count(pairs, (p) => inWindow(p.index_day, start, e30) && (p.gap_days ?? Infinity) <= 30 && heldOutP(p));
      const n90 = count(pairs, (p) => inWindow(p.index_day, start, e90) && (p.gap_days ?? Infinity) <= 90);
      const n90h = count(pairs, (p) => inWindow(p.index_day, start, e90) && (p.gap_days ?? Infinity) <= 90 && heldOutP(p));
      const nImm = count(pairs, (p) => inWindow(p.index_day, start, e30) && isImmediateReturn(p.gap_days));
      const nAvoid = count(pairs, (p) => inWindow(p.index_day, start, e30) && (p.gap_days ?? Infinity) <= 30 && p.avoidable === 'avoidable');
      return {
        key, label: DENOMINATOR_LABEL[key], warning: DENOMINATOR_WARNING[key],
        d30, d30_reviewable: d30 - d30h, d30_held_out: d30h, d90, d90_reviewable: d90 - d90h,
        all30: measure(n30, d30), reviewable30: measure(n30 - n30h, d30 - d30h), heldOut30: measure(n30h, d30h),
        all90: measure(n90, d90), reviewable90: measure(n90 - n90h, d90 - d90h),
        immediate: measure(nImm, d30), proposedAvoidable: measure(nAvoid, d30),
      };
    };
    const denominators = { eligible: denomSet('eligible'), true_ipd: denomSet('true_ipd'), all_in_window: denomSet('all_in_window') };

    // Monthly cohorts (IST index-discharge month), complete when month end + 30 ≤ ceiling.
    const firstDay = disch.map((d) => d.day as string).filter((d) => d >= start).sort()[0] ?? null;
    const fromMonth = monthOf(firstDay && firstDay > start ? firstDay : start);
    const months: MonthCohort[] = monthsBetween(fromMonth, monthOf(ceiling)).map((month) => {
      const complete = addDays(lastDayOfMonth(month), FOLLOW_UP_30) <= ceiling;
      const dAll = sum(disch, (d) => inWindow(d.day, start, ceiling) && monthOf(d.day as string) === month);
      const dH = sum(disch, (d) => inWindow(d.day, start, ceiling) && monthOf(d.day as string) === month && heldOutD(d));
      const rAll = count(pairs, (p) => !!p.index_day && monthOf(p.index_day) === month && p.index_day >= start && (p.gap_days ?? Infinity) <= 30);
      const rH = count(pairs, (p) => !!p.index_day && monthOf(p.index_day) === month && p.index_day >= start && (p.gap_days ?? Infinity) <= 30 && heldOutP(p));
      return {
        month, complete, discharges: dAll, discharges_reviewable: dAll - dH, discharges_held_out: dH,
        returns30: rAll, returns30_reviewable: rAll - rH, returns30_held_out: rH,
        rate30: complete ? pct(rAll, dAll) : null, rate30_reviewable: complete ? pct(rAll - rH, dAll - dH) : null, rate30_held_out: complete ? pct(rH, dH) : null,
      };
    });

    // R7-4 gate: the first FULL calendar month of discharges must have completed 30-day follow-up.
    const firstFullMonth = firstDay ? (firstDay.slice(8) === '01' ? monthOf(firstDay) : nextMonth(monthOf(firstDay))) : null;
    const opensOn = firstFullMonth ? addDays(lastDayOfMonth(firstFullMonth), FOLLOW_UP_30) : null;
    const ratesAllowed = !!opensOn && opensOn <= ceiling;

    const audited = pairs.filter((p) => p.audit_status === 'audited');
    const judgements: JudgementStats = {
      audited: audited.length,
      justified: count(audited, (p) => p.avoidable === 'justified'),
      needs_adjudication: count(audited, (p) => p.avoidable === 'needs_adjudication'),
      avoidable: count(audited, (p) => p.avoidable === 'avoidable'),
      condition_pass_only: count(audited, (p) => (p.avoidable == null || p.avoidable === '') && p.lane === 'other'),
      no_judgement: count(audited, (p) => (p.avoidable == null || p.avoidable === '') && p.lane !== 'other'),
      held_out_detected: count(pairs, (p) => p.audit_status === 'excluded'),
      not_auditable: count(pairs, (p) => p.audit_status === 'not_auditable'),
      pending: count(pairs, (p) => p.audit_status === 'detected'),
      preventable_injury_suspected: count(audited, (p) => p.preventable_injury === 'suspected'),
    };
    const gapDistribution = {
      d0_1: count(pairs, (p) => p.gap_days != null && p.gap_days <= 1),
      d2_7: count(pairs, (p) => p.gap_days != null && p.gap_days > 1 && p.gap_days <= 7),
      d8_30: count(pairs, (p) => p.gap_days != null && p.gap_days > 7 && p.gap_days <= 30),
      d31_90: count(pairs, (p) => p.gap_days != null && p.gap_days > 30 && p.gap_days <= 90),
    };
    // R9 — the incidence lead. Only the facility the incidence denominator was read FOR (Even) can
    // have one: a people-denominator read for one hospital is not a denominator for another.
    const incidence = input.incidencePairs && fac === FACILITY_EHRC
      ? computeIncidence({ pairs: input.incidencePairs, denominator: input.incidenceDenominator, ceilingDay: ceiling, start, facility: fac })
      : null;
    facilities.push({
      facility: fac, pairs: pairs.length, ratesAllowed,
      gate: { firstDischargeDay: firstDay, firstFullMonth, opensOn, reason: ratesAllowed ? null : EHBR_GATE_COPY },
      denominators, months, judgements, gapDistribution, incidence,
    });
  }
  return { version: RATES_VERSION, ceilingDay: ceiling, surveillanceStart: start, facilities };
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// ── R7-6: the staged-return matcher (deterministic, pure) ─────────────────────────────────
//
// A return is a POSSIBLE planned staged return when the index stay's text (extracted followUp /
// procedure / aftercare follow-up detail) and the return stay's procedure evidence (extracted procedure,
// OT surgery_name) share a staged-procedure match:
//   (a) DEVICE STAGE — the return procedure names a device-stage act (stent removal / exchange, implant /
//       wire / k-wire / fixator / plate removal, tube removal) AND the index text mentions that device
//       (the stent / implant / wire / fixator was placed, or its removal was scheduled);
//   (b) DEFERRED / STAGED — the index text carries a staging or deferral cue (staged, second-stage,
//       planned re-, rescheduled, deferred, postponed, to be performed / taken up, will be planned) AND
//       the return procedure shares a substantive procedure term with the index text.
// Mohsin's fixtures (PRD R7-6): IPNO-31|IPNO-196 (DJ stenting → DJ stent removal) gains the marker via
// (a); IP-713|IP-740 (TKR planned-not-performed, "surgery to be rescheduled" → TKR) via (b);
// IP-740|IP-827 (TKR → OGD for an LRTI) must NOT be marked — no device, no shared procedure term.
// No model verdict is overridden; the situation line stays; queue membership and badge unchanged.

const DEVICE_STAGE_PATTERNS: ReadonlyArray<{ device: RegExp; act: RegExp; anchor: string }> = [
  { device: /\bstent(?:s|ing|ed)?\b/i, act: /\b(?:stent(?:s)?\s+(?:removal|exchange|extraction|change)|(?:removal|exchange|extraction|change)\s+of\s+(?:the\s+)?(?:dj\s+|ureteric\s+|double[-\s]j\s+)?stent)/i, anchor: 'stent' },
  { device: /\b(?:implant|k[-\s]?wire|wire|fixator|ex[-\s]?fix|plate|screw|nail|rod)s?\b/i, act: /\b(?:implant|k[-\s]?wire|wire|fixator|ex[-\s]?fix|plate|screw|nail|rod)s?\s+removal\b|\bremoval\s+of\s+(?:the\s+)?(?:implant|k[-\s]?wire|wire|fixator|ex[-\s]?fix|plate|screw|nail|rod)s?\b|\bhardware\s+removal\b/i, anchor: 'implant / wire / fixator' },
  { device: /\b(?:drain|catheter|tube|peg|tracheostomy|nephrostomy|pcn)\b/i, act: /\b(?:drain|catheter|tube|peg|tracheostomy|nephrostomy|pcn)\s+(?:removal|exchange|change)\b|\bremoval\s+of\s+(?:the\s+)?(?:drain|catheter|tube|peg|nephrostomy|pcn)\b/i, anchor: 'tube / catheter' },
];
const STAGING_CUE = /\b(?:staged|second[-\s]stage|stage\s*(?:2|ii|two)|planned\s+re-?\w*|re-?(?:look|exploration|do)\b|rescheduled?|re-?plan(?:ned|ning)?|deferred|postponed|to\s+be\s+(?:performed|done|taken\s+up|rescheduled|planned|scheduled)|will\s+be\s+(?:rescheduled|planned|scheduled|taken\s+up|done)|plan(?:ned)?\s+for\s+(?:\w+\s+){0,3}(?:surgery|procedure|removal|exchange|revision|closure|arthroplasty|replacement)|for\s+(?:removal|exchange)\s+after|surgery\s+(?:was\s+)?(?:not\s+performed|cancelled|abandoned))/i;
const PROCEDURE_STOP = new Set(['with', 'under', 'left', 'right', 'bilateral', 'side', 'local', 'general', 'spinal', 'anaesthesia', 'anesthesia', 'done', 'performed', 'procedure', 'surgery', 'operation', 'status', 'post', 'planned', 'review', 'after', 'days', 'weeks', 'follow', 'followup', 'opd', 'appointment', 'prior', 'with', 'plus', 'and', 'the', 'for', 'was', 'not', 'due', 'size', 'component', 'insert', 'baseplate', 'titanium', 'screws', 'screw', 'fixation', 'implants', 'implant', 'mm', 'total', 'cemented', 'medial', 'lateral', 'plateau', 'tibial', 'femoral', 'this', 'that', 'been', 'were', 'have', 'will', 'from', 'into', 'through']);
const tokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9+\s/-]/g, ' ').split(/[\s/+-]+/).filter((w) => w.length >= 4 && !PROCEDURE_STOP.has(w));

export interface StagedMatch { matched: boolean; kind: 'device' | 'deferred' | null; anchor: string | null }

export function stagedReturnMatch(indexTexts: ReadonlyArray<string | null | undefined>, returnTexts: ReadonlyArray<string | null | undefined>): StagedMatch {
  const idx = indexTexts.filter((t): t is string => typeof t === 'string' && t.trim() !== '').join(' \n ');
  const ret = returnTexts.filter((t): t is string => typeof t === 'string' && t.trim() !== '').join(' \n ');
  if (!idx.trim() || !ret.trim()) return { matched: false, kind: null, anchor: null };
  // (a) device stage
  for (const p of DEVICE_STAGE_PATTERNS) {
    if (p.act.test(ret) && p.device.test(idx)) return { matched: true, kind: 'device', anchor: p.anchor };
  }
  // (b) deferred / staged with a shared substantive procedure term
  if (STAGING_CUE.test(idx)) {
    const it = new Set(tokens(idx));
    const shared = tokens(ret).filter((w) => it.has(w));
    if (shared.length) return { matched: true, kind: 'deferred', anchor: Array.from(new Set(shared)).slice(0, 3).join(' ') };
  }
  return { matched: false, kind: null, anchor: null };
}

/** The per-card return context (R7-5 / R7-6), derived by the route from the extracts + ledger. */
export interface ReturnContext { immediate: boolean; staged: StagedMatch }
export function returnContext(args: { gapDays: number | null | undefined; indexTexts: ReadonlyArray<string | null | undefined>; returnTexts: ReadonlyArray<string | null | undefined> }): ReturnContext {
  return { immediate: isImmediateReturn(args.gapDays), staged: stagedReturnMatch(args.indexTexts, args.returnTexts) };
}

// ── the module's view model (pure, R7-1 / R7-2 / R7-3 / R7-4) ───────────────────────────────

export const fmtPct = (v: number | null): string => (v == null ? '—' : `${v.toFixed(2)}%`);
export const fmtCi = (ci: { lo: number; hi: number } | null): string => (ci == null ? '' : `${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)}%`);
export const fmtCount = (n: number): string => n.toLocaleString('en-IN');

export interface RateCard {
  key: string;
  title: string;
  big: string;
  sub: string;
  ci: string;
  /** The static method line under the sub (the recipe, not the numbers). */
  note: string | null;
  advisory: string | null;
  tone: 'lead' | 'plain' | 'count' | 'advisory' | 'unavailable';
}

/**
 * R9 §12.2 — the Even-tab card strip. The reviewable card is GONE from the strip (D8 / §3.3): the
 * hold-out is a list filter, not a peer rate, because CAT's 45 and revenue's 45 are two different 45s.
 *
 *   [LEAD]      30-day incidence · unique patients      people, clock ≥24h and ≤30d, onco + ObGyn out
 *   [SECONDARY] 30-day episodes · warranty / clinical   today's Eligible stay rate, 0–30 inclusive
 *   [PLAIN]     90-day episodes                         demoted, kept (§3.2 "may remain, demoted")
 *   [COUNT]     Immediate / next-morning returns        L1 label + copy; a COUNT, never a rate
 *   [ADVISORY]  Proposed avoidable                      agent proposal, not the human overlay (D14)
 *
 * The lead card renders ONLY from `f.incidence`. No incidence read, or a read that could not produce a
 * distinct-people denominator, gives the unavailable card (T5) — never the stays number wearing a
 * people label. Rates stay NUMBERS only when the facility has earned them (R7-4); otherwise counts.
 */
export function rateCards(f: FacilityRates, key: DenominatorKey): RateCard[] {
  const d = f.denominators[key];
  const ok = f.ratesAllowed;
  const big = (m: Measure) => (ok ? fmtPct(m.rate) : `${fmtCount(m.numerator)} / ${fmtCount(m.denominator)}`);
  const sub = (m: Measure, what: string) => (ok ? `${fmtCount(m.numerator)} of ${fmtCount(m.denominator)} ${what}` : `counts only · ${what}`);
  const ci = (m: Measure) => (ok ? fmtCi(m.ci) : '');
  const inc = f.incidence;
  const lead: RateCard = inc && inc.available && inc.denominator != null
    ? {
        key: 'incidence', title: INCIDENCE_LEAD_LABEL,
        big: ok ? fmtPct(inc.rate) : `${fmtCount(inc.numerator)} / ${fmtCount(inc.denominator)}`,
        sub: ok ? `${fmtCount(inc.numerator)} of ${fmtCount(inc.denominator)} people` : `counts only · ${fmtCount(inc.numerator)} of ${fmtCount(inc.denominator)} people`,
        ci: ok ? fmtCi(inc.ci) : '', note: INCIDENCE_LEAD_NOTE, advisory: null, tone: 'lead',
      }
    : { key: 'incidence', title: INCIDENCE_LEAD_LABEL, big: '—', sub: INCIDENCE_UNAVAILABLE_COPY, ci: '', note: null, advisory: null, tone: 'unavailable' };
  return [
    lead,
    { key: 'episodes30', title: EPISODES_SECONDARY_LABEL, big: big(d.all30), sub: sub(d.all30, 'discharges'), ci: ci(d.all30), note: EPISODES_SECONDARY_NOTE, advisory: null, tone: 'plain' },
    { key: 'all90', title: EPISODES_90_LABEL, big: big(d.all90), sub: sub(d.all90, 'discharges with 90-day follow-up'), ci: ci(d.all90), note: 'stays, not people', advisory: null, tone: 'plain' },
    { key: 'immediate', title: IMMEDIATE_CARD_LABEL, big: fmtCount(d.immediate.numerator), sub: `of ${fmtCount(d.immediate.denominator)} discharges`, ci: '', note: IMMEDIATE_CARD_COPY, advisory: null, tone: 'count' },
    { key: 'proposedAvoidable', title: 'Proposed avoidable', big: fmtCount(d.proposedAvoidable.numerator), sub: ok ? `${fmtPct(d.proposedAvoidable.rate)} of ${fmtCount(d.proposedAvoidable.denominator)} eligible discharges` : `of ${fmtCount(d.proposedAvoidable.denominator)} eligible discharges`, ci: '', note: null, advisory: PROPOSED_AVOIDABLE_ADVISORY, tone: 'advisory' },
  ];
}

export interface TrendBar { month: string; label: string; complete: boolean; reviewablePct: number | null; heldOutPct: number | null; discharges: number; returns30: number; returns30_reviewable: number; returns30_held_out: number; title: string }
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (month: string): string => { const [y, m] = month.split('-').map(Number); return `${MONTH_ABBR[(m || 1) - 1]} ${String(y).slice(2)}`; };

/** The split trend bars: reviewable vs held-out share of each complete month's discharges (as % of
 *  ALL that month's discharges, so the two stack to the month's all-cause rate); incomplete months are
 *  ghosts (dashed, no rate) — censored, never a rate. `ratesAllowed` false → every bar a ghost. */
export function trendBars(f: FacilityRates): TrendBar[] {
  return f.months.map((m) => {
    const live = f.ratesAllowed && m.complete && m.discharges > 0;
    const rPct = live ? Math.round((m.returns30_reviewable / m.discharges) * 10_000) / 100 : null;
    const hPct = live ? Math.round((m.returns30_held_out / m.discharges) * 10_000) / 100 : null;
    const title = live
      ? `${monthLabel(m.month)}: ${m.returns30} of ${m.discharges} (${fmtPct(m.rate30)}) — reviewable ${m.returns30_reviewable} (${fmtPct(rPct)}), held-out ${m.returns30_held_out} (${fmtPct(hPct)})`
      : `${monthLabel(m.month)}: ${m.returns30} of ${m.discharges} so far — 30-day follow-up not complete, no rate`;
    return { month: m.month, label: monthLabel(m.month), complete: m.complete, reviewablePct: rPct, heldOutPct: hPct, discharges: m.discharges, returns30: m.returns30, returns30_reviewable: m.returns30_reviewable, returns30_held_out: m.returns30_held_out, title };
  });
}

/** The facility the module shows: the R6 filter's hospital when it names one the rates know, else the
 *  module's own tab, else the first facility with any discharges (EHRC). */
export function moduleFacility(rates: RatesResult, r6Facility: string | null | undefined, tab: string | null | undefined): FacilityRates | null {
  const byName = (n: string | null | undefined) => (n ? rates.facilities.find((f) => f.facility === n) ?? null : null);
  return byName(r6Facility) ?? byName(tab) ?? rates.facilities.find((f) => f.gate.firstDischargeDay != null) ?? rates.facilities[0] ?? null;
}

/** "computed at" stamp — IST wall clock, as the rest of the surface prints times. */
export function computedAtLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 5.5 * 3_600_000);
  return `computed ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} IST`;
}

/** The card / case-page marker lines (R7-5 / R7-6) — exact copy; nothing else changes on the card. */
export function returnContextLines(ctx: ReturnContext | null | undefined): Array<{ key: 'immediate' | 'staged'; text: string }> {
  const out: Array<{ key: 'immediate' | 'staged'; text: string }> = [];
  if (!ctx) return out;
  if (ctx.immediate) out.push({ key: 'immediate', text: IMMEDIATE_RETURN_COPY });
  if (ctx.staged?.matched) out.push({ key: 'staged', text: STAGED_RETURN_COPY });
  return out;
}

/** R7-7 — the judgement-stats line: every audited row accounted for, condition-pass-only audits
 *  LABELLED (lane 'other', unpromoted — null avoidable by design), never "no judgement". The true
 *  no-judgement count (null avoidable outside lane 'other') is printed only when non-zero. */
export function judgementStatsParts(j: JudgementStats): Array<{ key: string; label: string; n: number }> {
  const parts = [
    { key: 'justified', label: 'justified', n: j.justified },
    { key: 'needs_adjudication', label: 'needs adjudication', n: j.needs_adjudication },
    { key: 'avoidable', label: 'proposed avoidable', n: j.avoidable },
    { key: 'condition_pass_only', label: CONDITION_PASS_ONLY_LABEL, n: j.condition_pass_only },
  ];
  if (j.no_judgement > 0) parts.push({ key: 'no_judgement', label: 'no judgement', n: j.no_judgement });
  return parts;
}
export function judgementStatsLine(j: JudgementStats): string {
  return `${fmtCount(j.audited)} audited: ${judgementStatsParts(j).map((p) => `${p.label} ${fmtCount(p.n)}`).join(' · ')}`;
}
