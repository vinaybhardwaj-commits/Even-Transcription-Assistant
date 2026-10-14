/**
 * lib/opd-note-score-core.ts — OPD Note-Quality Score CORE.
 *
 * Sibling of value-score-core.ts, tuned for a SINGLE OUTPATIENT ENCOUNTER NOTE
 * (not an admitted episode). PURE, dependency-light, unit-testable with
 * `node --experimental-strip-types`. Reuses the shared penalty + band model.
 *
 * WHY A SEPARATE SCORE. The Care-Value Scorecard is an episode value proxy whose
 * Care-intensity-efficiency (LOS) and Cost-stewardship (bed-days, room tariff) axes
 * do not exist for an OPD consult. This score drops those and adds the two things that
 * define a good outpatient note: documentation/NOTE QUALITY (PDQI-9) and PRESCRIBING
 * QUALITY (rational prescribing + interactions). It answers: "is this a well-documented,
 * appropriate, safely-prescribed encounter, as demonstrated in the note?"
 *
 * DETERMINISM. The LLM only RATES (PDQI-9 1–5) and TAGS findings (verdict/domain); ALL
 * arithmetic here is pure, bounded and auditable — never an LLM-produced index number.
 * Frameworks: PDQI-9 (note quality) · NABH OPD documentation · RAND/Choosing Wisely
 * (appropriateness) · WHO rational prescribing + stewardship (prescribing-safety) ·
 * IOM patient-centred / continuity.
 *
 * POSTURE: encounter-level, advisory, NOT a clinician scorecard.
 */

// Type-only imports (erased at runtime → keeps the pure-core unit-testable under
// `node --experimental-strip-types`, which can't resolve runtime cross-core imports).
// The two tiny scoring helpers (findingPenalty, bandFor) are INLINED below to match
// the repo convention (cf. validateCitationIds inlined in pathway-core/doc-audit-core);
// keep them in sync with value-score-core.
import type { Band, NetValue } from './value-score-core';
export type { Band, NetValue };

export type OpdDomain =
  | 'documentation' | 'note_quality' | 'appropriateness' | 'prescribing_safety' | 'patient_centred';

export const OPD_DOMAINS: OpdDomain[] =
  ['documentation', 'note_quality', 'appropriateness', 'prescribing_safety', 'patient_centred'];

export const OPD_DOMAIN_LABEL: Record<OpdDomain, string> = {
  documentation: 'Documentation completeness',
  note_quality: 'Note quality (PDQI-9)',
  appropriateness: 'Diagnostic & test appropriateness',
  prescribing_safety: 'Prescribing quality & safety',
  patient_centred: 'Continuity & patient-centredness',
};

export const OPD_DOMAIN_SHORT: Record<OpdDomain, string> = {
  documentation: 'Documented', note_quality: 'Note quality', appropriateness: 'Appropriate',
  prescribing_safety: 'Prescribing', patient_centred: 'Patient-centred',
};

// OPD-tuned weights (sum = 1). Documentation + note-quality lead because the brief is
// "quality of the encounter AS DEMONSTRATED IN THE NOTE"; appropriateness + prescribing
// safety are the clinical core; continuity is lighter.
export const OPD_DEFAULT_WEIGHTS: Record<OpdDomain, number> = {
  documentation: 0.25, note_quality: 0.25, appropriateness: 0.20, prescribing_safety: 0.20, patient_centred: 0.10,
};

// PDQI-9 — Physician Documentation Quality Instrument (validated 9 attributes, 1–5 Likert).
export type Pdqi9Attr =
  | 'up_to_date' | 'accurate' | 'thorough' | 'useful' | 'organized'
  | 'comprehensible' | 'succinct' | 'synthesized' | 'internally_consistent';

export const PDQI9_ATTRS: Pdqi9Attr[] = [
  'up_to_date', 'accurate', 'thorough', 'useful', 'organized',
  'comprehensible', 'succinct', 'synthesized', 'internally_consistent',
];
export const PDQI9_LABEL: Record<Pdqi9Attr, string> = {
  up_to_date: 'Up-to-date', accurate: 'Accurate', thorough: 'Thorough', useful: 'Useful',
  organized: 'Organized', comprehensible: 'Comprehensible', succinct: 'Succinct',
  synthesized: 'Synthesized', internally_consistent: 'Internally consistent',
};

// Findings (LLM appropriateness + LLM/deterministic prescribing-safety) flow through the
// shared verdict×confidence penalty model. domain restricted to the two clinical axes.
export type OpdFindingDomain = 'appropriateness' | 'prescribing_safety';
// Phase 3a: `direction` is carried so findingPenalty can zero an UNDERUSE finding. Optional —
// every stored row and every existing caller omits it, and absent means 'undetermined'.
export interface OpdScoreFinding { verdict: NetValue; confidence: number; domain?: OpdFindingDomain; direction?: 'overuse' | 'underuse' }

export interface OpdScoreInput {
  findings: OpdScoreFinding[];
  completenessCoverage: number;                 // 0..1 — type-aware NABH OPD completeness
  pdqi9: Partial<Record<Pdqi9Attr, number>> | null;  // each attribute 1..5; null = not assessed
  patientCentred: { present: number; total: number }; // continuity fields (advice, follow-up) — exactly the two; nothing else feeds this
  weights?: Partial<Record<OpdDomain, number>>;
}

export interface OpdDomainScore {
  domain: OpdDomain; label: string; score: number; weight: number; n: number; basis: string;
}
export interface OpdFlag { key: string; label: string; detail: string; severity: 'info' | 'warn' }
export interface OpdScorecard {
  headline: number;     // 0..100 weighted OPD Note-Quality Index
  band: Band;
  domains: OpdDomainScore[];
  pdqi9: { attr: Pdqi9Attr; label: string; value: number }[]; // per-attribute (provided only)
  confidence: 'low' | 'moderate' | 'high';
  flags: OpdFlag[];     // advisory annotations (e.g. "fields present but content thin") — B3
  caveat: string;
}

/**
 * B3 — the "documentation completeness ≠ clinical adequacy" flag. Fires when the NABH fields are
 * (near-)complete but the note's PDQI thoroughness/synthesis is poor — the exact contradiction
 * clinicians flagged (Documentation 100 while Thoroughness ≤ 2). Pure derivation from the stored
 * doc score + PDQI rows, so the DISPLAY can compute it for existing audits with no re-audit.
 */
export function documentationAdequacyFlag(
  docScore: number, pdqi9: { attr: string; value: number }[],
): OpdFlag | null {
  if (!(docScore >= 90)) return null;                 // only when fields are (near-)complete
  const v = (a: string): number | null => { const r = pdqi9.find((x) => x.attr === a); return r && Number.isFinite(r.value) ? r.value : null; };
  const thorough = v('thorough'); const synth = v('synthesized');
  const weakest = Math.min(thorough ?? 5, synth ?? 5);
  if (weakest > 2) return null;
  return {
    key: 'thin_documentation',
    label: 'Fields present · content thin',
    detail: 'All required NABH fields are filled, but the clinical content is sparse (low thoroughness/synthesis). A high completeness score means "nothing left blank", not "well-documented" — read it alongside Note quality.',
    severity: 'warn',
  };
}

export const OPD_NOTE_CAVEAT =
  'Note-level quality proxy from the documented encounter — documentation, note quality (PDQI-9), appropriateness and prescribing safety AS DEMONSTRATED IN THE NOTE. Not an outcomes measure and not a clinician scorecard; read at the encounter / service-line level.';

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function round(n: number): number { return Math.round(n); }

// Inlined from value-score-core (keep in sync) — see import note above.
// Exported so the "How the audit works" reference page renders the REAL constants (no drift).
export const PENALTY_BASE = 45;
export const SEVERITY: Record<NetValue, number> = { 'low-value': 1.0, 'context-dependent': 0.5, uncertain: 0.2, 'high-value': 0 };

/**
 * 0.81.16 (audit-integrity batch, phase 0) — confidence quantization REVERTED per the 28 Jul
 * S0/S1 ruling. MEASURED on production: 17.0% of 36,502 scoring findings carry confidence exactly
 * 0.80 — the quantization boundary — and quantization raised the mean penalty by 3.10 points per
 * finding. A cliff sitting on the modal confidence value is a worse instrument than the raw float
 * it replaced. The ruling withdrew quantization ONLY; hysteresis (displayed_band) stays endorsed.
 * The input clamp is the one behaviour kept: junk (<0, >1, NaN→0) lands on the scale, not outside it.
 */
function findingPenalty(f: { verdict: NetValue; confidence: number; direction?: string }): number {
  // Phase 3a (R-5): an UNDERUSE finding contributes ZERO penalty. Implemented as an early return
  // rather than a new SEVERITY member — SEVERITY must stay a pure function of NetValue, and
  // NetValue must stay closed (it feeds scoring). Underuse is the opposite failure to low-value
  // care; penalising it under the low-value weight is what put 78 "prescribe more antibiotics"
  // findings inside antibiotic OVERUSE.
  if (f.direction === 'underuse') return 0;
  return PENALTY_BASE * (SEVERITY[f.verdict] ?? 0.2) * clamp(Number(f.confidence) || 0, 0, 1);
}
export function bandFor(headline: number): Band {
  if (headline >= 85) return 'A';
  if (headline >= 70) return 'B';
  if (headline >= 55) return 'C';
  if (headline >= 40) return 'D';
  return 'E';
}

/**
 * S1 — the hysteresis guard width. MEASURED: σ per run 3.866 on the 50-pair A/A at 0.81.14 (paired
 * SD 5.4669). g tracks the instrument it guards (D2): when an engine version has its own
 * interleaved A/A σ, source g from that; 3.87 is the fallback. Simulated on the empirical
 * distribution: re-score band-flip rate 0.223 → 0.079 at zero inference cost.
 */
export const HYSTERESIS_G = 3.87;

/** Band lower bounds (inclusive) — DERIVED from bandFor's thresholds, which stay the one truth. */
const BAND_LO: Record<Band, number> = { A: 85, B: 70, C: 55, D: 40, E: Number.NEGATIVE_INFINITY };
const BAND_HI: Record<Band, number> = { A: Number.POSITIVE_INFINITY, B: 85, C: 70, D: 55, E: 40 };

/**
 * S1 — the hysteresis rule (design-final §2, adopted verbatim; PRD §3). A DISPLAY rule on the
 * canonical row, anchored WITHIN an engine version only:
 *   · no prior displayed band (NULL — first score at this version) ⇒ band normally, set the anchor;
 *   · otherwise the displayed band HOLDS unless the new index leaves the held band's range by ≥ g;
 *   · on a decisive crossing ⇒ `bandFor(index)` — the band the raw index actually implies, NOT one
 *     step. An engine-version bump resets the anchor by construction (fresh row ⇒ NULL prior).
 * The raw index is always displayed beside the band; a contest conversation is about the number,
 * not the label. bandFor and its thresholds are UNTOUCHED — this wraps, never replaces.
 * Pure and total: an unknown prior string behaves as no prior.
 */
export function hysteresisBand(index: number, priorDisplayedBand: string | null | undefined, g: number = HYSTERESIS_G): Band {
  const prior = priorDisplayedBand as Band;
  if (prior !== 'A' && prior !== 'B' && prior !== 'C' && prior !== 'D' && prior !== 'E') return bandFor(index);
  const leavesDown = index < BAND_LO[prior] - g;
  const leavesUp = index >= BAND_HI[prior] + g;
  return leavesDown || leavesUp ? bandFor(index) : prior;
}

function scoreFromFindings(fs: OpdScoreFinding[]): { score: number; n: number } {
  // v0.81 (BUG-0.8-05/07): combine penalties with DIMINISHING RETURNS instead of a flat additive
  // sum — each finding removes a fraction of the REMAINING score, so a stack degrades gracefully
  // (one low-value ≈55, two ≈30, three ≈17) rather than collapsing a domain to an unfair 0.
  // A single finding is unchanged vs the old additive model (preserves calibration for the common case).
  let remaining = 100;
  for (const f of fs) {
    // `direction` MUST be forwarded — rebuilding the object without it silently re-penalised
    // every underuse finding and made the phase-3a early return dead code.
    const p = findingPenalty({ verdict: f.verdict, confidence: f.confidence, direction: f.direction });
    remaining *= 1 - clamp(p, 0, 100) / 100;
  }
  return { score: round(clamp(remaining, 0, 100)), n: fs.length };
}

/** PDQI-9 → 0..100 (mean of provided 1–5 ratings, rescaled). Returns null if none provided. */
function pdqi9Score(p: Partial<Record<Pdqi9Attr, number>> | null): { score: number | null; rows: { attr: Pdqi9Attr; label: string; value: number }[]; n: number } {
  const rows: { attr: Pdqi9Attr; label: string; value: number }[] = [];
  if (p) {
    for (const a of PDQI9_ATTRS) {
      const v = p[a];
      if (typeof v === 'number' && Number.isFinite(v)) rows.push({ attr: a, label: PDQI9_LABEL[a], value: clamp(v, 1, 5) });
    }
  }
  if (rows.length === 0) return { score: null, rows: [], n: 0 };
  const mean = rows.reduce((s, r) => s + r.value, 0) / rows.length;
  return { score: round(((mean - 1) / 4) * 100), rows, n: rows.length };
}

/** Compute the OPD Note-Quality scorecard. Pure + deterministic. */
export function computeOpdScore(input: OpdScoreInput): OpdScorecard {
  const weights = { ...OPD_DEFAULT_WEIGHTS, ...(input.weights || {}) };
  const findings = Array.isArray(input.findings) ? input.findings : [];

  const appr: OpdScoreFinding[] = [];
  const presc: OpdScoreFinding[] = [];
  for (const f of findings) (f.domain === 'prescribing_safety' ? presc : appr).push(f);

  const apprS = scoreFromFindings(appr);
  const prescS = scoreFromFindings(presc);

  const coverage = clamp(Number(input.completenessCoverage) || 0, 0, 1);
  const docScore = round(coverage * 100);

  const pq = pdqi9Score(input.pdqi9);

  const pc = input.patientCentred || { present: 0, total: 0 };
  const pcScore = pc.total > 0 ? round((clamp(pc.present, 0, pc.total) / pc.total) * 100) : 100;

  // note_quality weight collapses to 0 when PDQI-9 wasn't assessed (so it never drags the index).
  const nqWeight = pq.score == null ? 0 : weights.note_quality;

  const domains: OpdDomainScore[] = [
    { domain: 'documentation', label: OPD_DOMAIN_LABEL.documentation, score: docScore, weight: weights.documentation, n: 1,
      basis: `NABH OPD completeness ${docScore}%` },
    { domain: 'note_quality', label: OPD_DOMAIN_LABEL.note_quality, score: pq.score ?? 0, weight: nqWeight, n: pq.n,
      basis: pq.score == null ? 'PDQI-9 not assessed' : `PDQI-9 ${pq.n}/9 attributes rated` },
    { domain: 'appropriateness', label: OPD_DOMAIN_LABEL.appropriateness, score: apprS.score, weight: weights.appropriateness, n: apprS.n,
      basis: apprS.n ? `${apprS.n} appropriateness finding${apprS.n === 1 ? '' : 's'}` : 'no low-value/inappropriate orders flagged' },
    { domain: 'prescribing_safety', label: OPD_DOMAIN_LABEL.prescribing_safety, score: prescS.score, weight: weights.prescribing_safety, n: prescS.n,
      basis: prescS.n ? `${prescS.n} prescribing/safety finding${prescS.n === 1 ? '' : 's'}` : 'no prescribing or interaction issues flagged' },
    { domain: 'patient_centred', label: OPD_DOMAIN_LABEL.patient_centred, score: pcScore, weight: weights.patient_centred, n: pc.total,
      basis: pc.total ? `${pc.present}/${pc.total} continuity fields present` : 'no continuity fields assessed' },
  ];

  const wsum = domains.reduce((s, d) => s + (d.weight > 0 ? d.weight : 0), 0) || 1;
  const headline = round(domains.reduce((s, d) => s + d.score * (d.weight > 0 ? d.weight : 0), 0) / wsum);

  // Confidence: more real signal (findings + a PDQI-9 read) → higher.
  const signal = findings.length + (pq.score == null ? 0 : 2);
  const confidence: OpdScorecard['confidence'] = signal >= 4 ? 'high' : signal >= 2 ? 'moderate' : 'low';

  // B3 — advisory flags (completeness ≠ adequacy). Scores are unchanged; this reframes the reading.
  const flags = [documentationAdequacyFlag(docScore, pq.rows)].filter((f): f is OpdFlag => f != null);

  return {
    headline,
    band: bandFor(headline),
    domains,
    pdqi9: pq.rows,
    confidence,
    flags,
    caveat: OPD_NOTE_CAVEAT,
  };
}
