/**
 * lib/preop-tier-core.ts — tier rule v0, EXACTLY as the approved mockup's §3
 * (PREOP-RISK-AGENT-MOCKUP-v1, V-approved 26 Aug 2026 — the binding spec; deviations
 * need V). Plus the three derived card lines the board prints (why / missing /
 * situation), which are the SREWS derive.ts posture: deterministic text off a computed
 * result, never prose from a model.
 *
 * NO database, NO fetch, NO clock, NO model.
 *
 * ── the rule, restated from the mockup so a reader never has to open the HTML ──
 *
 *   instrument      GREEN            AMBER        RED
 *   RCRI (Lee)      Class I (0)      Class II (1) Class III–IV (>= 2)
 *   mFI-5           0–1              2            >= 3
 *   Charlson        <= 2             3–4          >= 5
 *
 *   composite = MAX severity across the three instruments, where a RANGE scores at its
 *   LOWER (confirmed) bound; if the UPPER bound would land a higher severity the
 *   composite FLOORS at AMBER and carries the unconfirmed tag.
 *   CRITICAL      = RED on >= 2 instruments, OR any RED with no finalized PAC <= 72 h
 *                   before surgery.
 *   needs review  = unreviewed RED/CRITICAL with surgery within 7 days (the SAME
 *                   predicate feeds the chooser badge, so they cannot disagree).
 *
 * Two consequences the mockup states in its own words and this file implements:
 *   · "missing data alone never mints RED" — the floor is AMBER, never higher. The
 *     SREWS 92-AMBER flood came from an opaque model minting tiers off absent data;
 *     creatinine is missing for ~83% of this cohort at booking, so a rule that let a
 *     missing input reach RED would flood the board on day one.
 *   · "a boundary-crossing range can never render GREEN either" — the floor is AMBER,
 *     never lower. Thin data is a finding, not a clean bill.
 *
 * Calibration review after 4 weeks of live data; thresholds move only by PRD amendment.
 */

import {
  charlsonBurdenLabel, charlsonScoreText, frailtyLabel, mfi5ScoreText,
  rcriClass, rcriClassText, rcriScoreText, riskPctText,
  type InstrumentId, type InstrumentScore,
} from './preop-instruments-core';

/** Bumped only by a PRD amendment to the thresholds or the escalation clauses. */
export const PREOP_TIER_RULE_VERSION = 'preop-tier/0';

export type Severity = 'GREEN' | 'AMBER' | 'RED';
export type Tier = 'GREEN' | 'AMBER' | 'RED' | 'CRITICAL';

const SEVERITY_RANK: Record<Severity, number> = { GREEN: 0, AMBER: 1, RED: 2 };

/** Board order: the dominant instrument on a tie is the earlier one in this list. */
export const INSTRUMENT_ORDER: InstrumentId[] = ['rcri', 'mfi5', 'charlson'];

export const INSTRUMENT_TITLES: Record<InstrumentId, string> = {
  rcri: 'RCRI',
  mfi5: 'mFI-5',
  charlson: 'Charlson',
};

// ── per-instrument bands (mockup §3 table) ──────────────────────────────────────

export function severityForScore(instrument: InstrumentId, score: number): Severity {
  if (instrument === 'rcri') {
    const k = rcriClass(score).klass;
    if (k === 'I') return 'GREEN';
    if (k === 'II') return 'AMBER';
    return 'RED';                       // Class III–IV
  }
  if (instrument === 'mfi5') {
    if (score <= 1) return 'GREEN';
    if (score === 2) return 'AMBER';
    return 'RED';
  }
  if (score <= 2) return 'GREEN';
  if (score <= 4) return 'AMBER';
  return 'RED';
}

/** The confirmed severity — what the LOWER bound scores. null when not computable. */
export function confirmedSeverity(s: InstrumentScore): Severity | null {
  if (s.kind === 'not_computable' || s.lo == null) return null;
  return severityForScore(s.instrument, s.lo);
}

/**
 * Does the unconfirmed upper bound land in a HIGHER band than the confirmed one? This
 * — not "is it a range" — is what floors the composite at AMBER and what dashes the
 * chip. Manjunath's mFI-5 3–4 is a range whose bounds are both RED: nothing is at
 * stake in the uncertainty, so nothing is flagged.
 */
export function crossesBoundary(s: InstrumentScore): boolean {
  if (s.kind !== 'range' || s.lo == null || s.hi == null) return false;
  return SEVERITY_RANK[severityForScore(s.instrument, s.hi)] > SEVERITY_RANK[severityForScore(s.instrument, s.lo)];
}

// ── the chip the board prints ───────────────────────────────────────────────────

export interface InstrumentChip {
  instrument: InstrumentId;
  /** 'RCRI' | 'mFI-5' | 'Charlson' */
  title: string;
  /** '2' | '1–2' | '3–4/5' | '—' */
  score: string;
  /** the muted `.cls` span: 'Class III · 6.6%' | 'frail' | '' */
  cls: string;
  /** dashed border ⇔ the upper bound crosses a severity boundary (mockup note 8) */
  dashed: boolean;
  severity: Severity | null;
}

/**
 * The mockup's twelve card chips, byte-for-byte. The `cls` span carries the class and
 * risk for RCRI always (they ARE the instrument's output), the frailty word for mFI-5
 * only in the RED band (where it changes what a reader does), and nothing for
 * Charlson, whose number is printed with its burden word on the case page instead.
 */
export function instrumentChip(s: InstrumentScore): InstrumentChip {
  const sev = confirmedSeverity(s);
  const dashed = crossesBoundary(s);
  if (s.instrument === 'rcri') {
    return { instrument: 'rcri', title: 'RCRI', score: rcriScoreText(s), cls: rcriClassText(s), dashed, severity: sev };
  }
  if (s.instrument === 'mfi5') {
    const cls = s.lo != null && severityForScore('mfi5', s.lo) === 'RED' ? frailtyLabel(s.lo) : '';
    return { instrument: 'mfi5', title: 'mFI-5', score: mfi5ScoreText(s), cls, dashed, severity: sev };
  }
  return { instrument: 'charlson', title: 'Charlson', score: charlsonScoreText(s), cls: '', dashed, severity: sev };
}

// ── the composite tier ──────────────────────────────────────────────────────────

export interface EpisodeContext {
  /** A PAC report exists for this patient AND its status is final. */
  pacFinalized: boolean;
  /**
   * Whole days from today to the surgery date, IST-day arithmetic done by the CALLER
   * (this core takes no clock). null = no surgery date on the episode.
   *
   * ⚠️ The mockup's escalation clause is written in hours ("<= 72 h") but surgery_cases
   * carries a DATE, not a timestamp — so 72 h is evaluated as <= 3 whole days, which is
   * the finest granularity the source data actually supports. Flagged for V: on a case
   * booked for the morning of day 3 this is marginally conservative (it escalates), and
   * being conservative is the right direction for an operational-danger clause.
   */
  daysToSurgery: number | null;
  /** A human has marked THIS snapshot version reviewed (a new version re-opens review). */
  reviewed: boolean;
}

/** The mockup's two escalation clauses, named so the card and the report can cite them. */
export type Escalation = 'red_on_two_instruments' | 'red_without_finalized_pac_72h';

export interface TierResult {
  tier: Tier;
  /** per-instrument confirmed severity + the unconfirmed flag, in board order */
  perInstrument: Array<{ instrument: InstrumentId; severity: Severity | null; unconfirmed: boolean }>;
  /** instruments whose CONFIRMED bound is RED (the >= 2 escalation counts these) */
  redCount: number;
  /** did a boundary-crossing range raise the composite to AMBER? */
  amberFloorApplied: boolean;
  /** any boundary-crossing range at all — the "unconfirmed" tag the card carries */
  unconfirmed: boolean;
  escalations: Escalation[];
  /** the instrument driving the composite — the why-line's subject */
  dominant: InstrumentId | null;
  needsReview: boolean;
  ruleVersion: string;
}

export interface TierInputs {
  rcri: InstrumentScore;
  mfi5: InstrumentScore;
  charlson: InstrumentScore;
  context: EpisodeContext;
}

/** Surgery is inside the 72-hour operational-danger window (and has not already passed). */
export function within72h(daysToSurgery: number | null): boolean {
  return daysToSurgery != null && daysToSurgery >= 0 && daysToSurgery <= 3;
}

/** Surgery is inside the needs-review window. */
export function within7d(daysToSurgery: number | null): boolean {
  return daysToSurgery != null && daysToSurgery >= 0 && daysToSurgery <= 7;
}

export function computeTier(inp: TierInputs): TierResult {
  const byId: Record<InstrumentId, InstrumentScore> = { rcri: inp.rcri, mfi5: inp.mfi5, charlson: inp.charlson };
  const perInstrument = INSTRUMENT_ORDER.map((id) => ({
    instrument: id,
    severity: confirmedSeverity(byId[id]),
    unconfirmed: crossesBoundary(byId[id]),
  }));

  const scored = perInstrument.filter((p) => p.severity !== null);
  const redCount = scored.filter((p) => p.severity === 'RED').length;
  const unconfirmed = perInstrument.some((p) => p.unconfirmed);

  // composite = max severity over the CONFIRMED bounds
  let composite: Severity = 'GREEN';
  for (const p of scored) {
    if (SEVERITY_RANK[p.severity as Severity] > SEVERITY_RANK[composite]) composite = p.severity as Severity;
  }
  // ...then the AMBER floor for a boundary-crossing range. Floor, not bump: it can
  // only ever raise GREEN to AMBER. Missing data never mints RED.
  const amberFloorApplied = unconfirmed && composite === 'GREEN';
  if (amberFloorApplied) composite = 'AMBER';

  // Everything unknown on all three instruments: no tier can be asserted. Rendered as
  // AMBER-with-nothing-confirmed rather than GREEN, because a blank patient days from
  // surgery is a finding, not a clean one.
  const nothingComputable = scored.length === 0;
  if (nothingComputable) composite = 'AMBER';

  const escalations: Escalation[] = [];
  if (redCount >= 2) escalations.push('red_on_two_instruments');
  if (composite === 'RED' && !inp.context.pacFinalized && within72h(inp.context.daysToSurgery)) {
    escalations.push('red_without_finalized_pac_72h');
  }
  const tier: Tier = escalations.length > 0 ? 'CRITICAL' : composite;

  // The dominant instrument: highest confirmed severity, ties broken by board order.
  let dominant: InstrumentId | null = null;
  for (const p of perInstrument) {
    if (p.severity === null) continue;
    if (dominant === null) { dominant = p.instrument; continue; }
    const cur = perInstrument.find((q) => q.instrument === dominant)!.severity as Severity;
    if (SEVERITY_RANK[p.severity] > SEVERITY_RANK[cur]) dominant = p.instrument;
  }

  const needsReview = !inp.context.reviewed && (tier === 'RED' || tier === 'CRITICAL') && within7d(inp.context.daysToSurgery);

  return {
    tier, perInstrument, redCount, amberFloorApplied, unconfirmed, escalations,
    dominant, needsReview, ruleVersion: PREOP_TIER_RULE_VERSION,
  };
}

// ── the derived card lines (SREWS derive.ts posture: deterministic text) ─────────

/** What the assembler knows about one input, for the why-line's evidence parenthetical. */
export interface FactorEvidence {
  /** short evidence text off the winning source, e.g. 'MI 2019' — null when there is none */
  detail?: string | null;
}

export interface CardLineInputs {
  rcri: InstrumentScore;
  mfi5: InstrumentScore;
  charlson: InstrumentScore;
  tier: TierResult;
  context: EpisodeContext;
  /** factor id -> evidence, so the why-line can print "ischaemic heart disease (MI 2019)" */
  evidence?: Record<string, FactorEvidence>;
  /** true when BOOKING is the only source that fed any input (mockup note 3) */
  bookingOnly?: boolean;
  /** the patient's age, for Charlson's age factor label in the why-line */
  age?: number | null;
}

const INSTRUMENT_UNITS: Record<InstrumentId, (n: number) => string> = {
  rcri: (n) => `RCRI, ${n} of 6 factors`,
  mfi5: (n) => `mFI-5, ${n} of 5 items`,
  charlson: (n) => `Charlson, ${n} points`,
};

const BOOKING_ONLY_CLAUSE = 'booking form is the only source on file — no OPD, labs or PAC yet';

/**
 * The why-line: the PRESENT factors of the dominant instrument, highest-points first,
 * with each factor's evidence in parentheses where the assembler has any.
 *
 * ⚠️ DEVIATION, flagged for V. The mockup prints four why-lines in three different
 * hand-written shapes (Shobha "… (RCRI)", Manjunath "… (RCRI, 3 of 6 factors)",
 * Farhan evidence-only "coronary angioplasty 2021 (RCRI) — upper bound unconfirmed").
 * No single deterministic generator emits all three, so this emits ONE shape — the
 * Manjunath shape, which is the most informative — for every case. The dominant
 * instrument and its factor set are reproduced exactly in all four cases; only the
 * punctuation of the suffix differs from the two shorter hand-written variants.
 */
export function whyLine(i: CardLineInputs): string {
  const dom = i.tier.dominant;
  if (!dom) return 'no instrument could be computed — no usable inputs on file';
  const score = dom === 'rcri' ? i.rcri : dom === 'mfi5' ? i.mfi5 : i.charlson;
  const present = score.factors
    .filter((f) => f.status === 'present' && f.points > 0)
    .sort((a, b) => b.points - a.points);

  const parts = present.map((f) => {
    const label = f.id === 'age' && i.age != null ? `age ${i.age}` : f.label.toLowerCase();
    const detail = i.evidence?.[f.id]?.detail;
    return detail ? `${label} (${detail})` : label;
  });

  // With nothing CONFIRMED anywhere, the honest why-line is about the absence itself —
  // and it must say which of the two absences this is. An AMBER that exists only because
  // the floor caught a boundary-crossing range is a different sentence from a GREEN with
  // nothing to report, and printing "nothing confirmed on RCRI yet" for both (as the
  // first production sweep did) tells a reader neither.
  const missingCount = new Set([...i.rcri.missing, ...i.mfi5.missing, ...i.charlson.missing]).size;
  const head = parts.length
    ? `${parts.join(' + ')} (${INSTRUMENT_UNITS[dom](score.lo ?? 0)})`
    : i.tier.amberFloorApplied
      ? `no risk factor is confirmed on any of the three instruments — the tier is AMBER only because ${missingCount} input${missingCount === 1 ? ' is' : 's are'} still unknown`
      : 'no risk factor on any of the three instruments';

  // The "upper bound unconfirmed" tail only adds something when the head named a
  // confirmed factor; the no-factor head above already says the whole story.
  const line = parts.length && crossesBoundary(score) ? `${head} — upper bound unconfirmed` : head;
  return i.bookingOnly ? `${line} · ${BOOKING_ONLY_CLAUSE}` : line;
}

/** The inputs a PAC visit can resolve — used to word the missing line's tail. */
export const PAC_COMPLETABLE = new Set(['creatinine_over_2', 'functional_status_dependent']);

/** Display names for the missing line, which speaks clinician, not factor-id. */
export const MISSING_LABELS: Record<string, string> = {
  creatinine_over_2: 'creatinine',
  functional_status_dependent: 'functional status',
  high_risk_surgery: 'procedure risk class',
  ischaemic_heart_disease: 'ischaemic heart disease',
  congestive_heart_failure: 'heart failure',
  cerebrovascular_disease: 'cerebrovascular disease',
  insulin_treated_diabetes: 'insulin-treated diabetes',
  diabetes_mellitus: 'diabetes',
  copd_or_pneumonia: 'COPD / pneumonia',
  hypertension_on_medication: 'hypertension',
  age: 'age',
};

export function missingLabel(id: string): string {
  return MISSING_LABELS[id] ?? id.replace(/_/g, ' ');
}

/**
 * "Missing: creatinine · functional status — both confirmable at PAC".
 *
 * The absent PAC is listed as a missing input ONLY when the situation line has not
 * already said so — the mockup prints "No PAC on file and surgery is in 3 days" in red
 * for Manjunath and then does NOT repeat PAC in his missing list, while Lakshmamma,
 * who gets no situation line, has PAC listed. One fact, one place on the card.
 * Returns '' when nothing is missing and no PAC is owed (Shobha at v3).
 */
export function missingLine(i: CardLineInputs, pacAlreadyCalledOut = false): string {
  const ids: string[] = [];
  for (const s of [i.rcri, i.mfi5, i.charlson]) {
    for (const id of s.missing) if (!ids.includes(id)) ids.push(id);
  }
  const labels = ids.map(missingLabel);
  const pacListed = !i.context.pacFinalized && !pacAlreadyCalledOut;
  if (pacListed) labels.push('PAC');
  if (!labels.length) return '';

  // The tail names what would tighten the score and where it comes from (mockup note 5).
  let tail = '';
  if (ids.length === 1 && ids[0] === 'creatinine_over_2') {
    tail = ' — a single lab collapses the range';
  } else if (ids.length > 0 && !pacListed && !i.context.pacFinalized && ids.every((id) => PAC_COMPLETABLE.has(id))) {
    // Only promise the PAC will settle these when there ISN'T one yet. A finalized PAC
    // that still leaves them unknown is the PRD §9.3 capture problem, not a pending
    // appointment, and telling a clinician to "confirm at PAC" about a PAC they already
    // have is the module wasting their time.
    tail = ids.length === 2 ? ' — both confirmable at PAC' : ' — confirmable at PAC';
  }
  return `Missing: ${labels.join(' · ')}${tail}`;
}

/**
 * The red situation line — operational danger only (mockup note 6): a RED or CRITICAL
 * case with no finalized PAC inside 72 h. Returns '' otherwise; this line is never used
 * for anything else, so a reader learns that red text here means "act today".
 */
export function situationLine(i: CardLineInputs): string {
  const t = i.tier.tier;
  if (t !== 'RED' && t !== 'CRITICAL') return '';
  if (i.context.pacFinalized) return '';
  if (!within72h(i.context.daysToSurgery)) return '';
  const d = i.context.daysToSurgery as number;
  const when = d === 0 ? 'surgery is today' : d === 1 ? 'surgery is tomorrow' : `surgery is in ${d} days`;
  return `No PAC on file and ${when}`;
}

/** The three card lines together — the ONLY composer the board should call, because the
 *  missing line's PAC entry depends on whether the situation line already carried it. */
export function cardLines(i: CardLineInputs): { why: string; missing: string; situation: string } {
  const situation = situationLine(i);
  return { why: whyLine(i), missing: missingLine(i, situation !== ''), situation };
}

/** The dense-row summary the collapsed GREEN rows print: 'RCRI 0 (0.4%) · mFI 0 · CCI 0'. */
export function denseSummary(rcri: InstrumentScore, mfi5: InstrumentScore, charlson: InstrumentScore): string {
  const r = rcriScoreText(rcri);
  const risk = rcri.lo != null && rcri.hi != null && rcriClass(rcri.lo).klass === rcriClass(rcri.hi).klass
    ? ` (${riskPctText(rcriClass(rcri.lo).riskPct)})`
    : '';
  const m = mfi5.lo == null ? '—' : mfi5.lo === mfi5.hi ? String(mfi5.lo) : `${mfi5.lo}–${mfi5.hi}`;
  const c = charlsonScoreText(charlson);
  return `RCRI ${r}${risk} · mFI ${m} · CCI ${c}`;
}

/** The case-panel one-liners ('mFI-5 2/5 — intermediate frailty', 'CCI 4 — moderate burden'). */
export function mfi5PanelLine(s: InstrumentScore): string {
  if (s.lo == null) return 'mFI-5 — not computable';
  return `mFI-5 ${mfi5ScoreText(s)} — ${frailtyLabel(s.lo)}`;
}

export function charlsonPanelLine(s: InstrumentScore): string {
  if (s.lo == null) return 'CCI — not computable';
  return `CCI ${charlsonScoreText(s)} — ${charlsonBurdenLabel(s.lo)}`;
}

export function rcriPanelLine(s: InstrumentScore): string {
  if (s.lo == null) return 'RCRI — not computable';
  const a = rcriClass(s.lo);
  return `RCRI Class ${a.klass} (Lee): ${a.riskPct}% major cardiac complication`;
}
