/**
 * lib/value-score-core.ts — Care-Value Scorecard CORE (VS.1).
 *
 * PURE, dependency-free (no db/llm/json). Importable by the server (lib/doc-audit.ts)
 * AND the client renderer (components/CaseAuditReport.tsx); unit-testable with
 * `node --experimental-strip-types`.
 *
 * WHAT THIS IS — AND ISN'T.
 * The canonical definition of value (Porter) is health OUTCOMES achieved per unit COST
 * over the full care cycle. The outcomes that define value (healing, complications,
 * readmission, PROMs) live DOWNSTREAM of a single document, so a per-document number
 * cannot be a Porter value score. This is a deliberately-scoped **process + cost value
 * PROXY**: how well the documented episode aligns with high-value-care principles
 * (right care, right intensity, safe, cost-stewarded, well-documented, patient-centred),
 * scored as deviation from the case-specific idealised pathway CAT already generates.
 *
 * DETERMINISM. The LLM only *tags* each finding with a domain; ALL arithmetic here is
 * pure, bounded and auditable — never an LLM-produced number. Frameworks mapped:
 *   appropriateness → RAND/UCLA appropriateness + Choosing Wisely / low-value indices
 *   efficiency      → IOM "Efficient" + Berwick "overtreatment" waste
 *   safety          → IOM "Safe" + antimicrobial stewardship
 *   cost            → Porter/Kaplan TDABC (tariff-approximated)
 *   documentation   → PDQI-9 + NABH completeness
 *   patient_centred → IOM "Patient-centred" + care-coordination
 *
 * POSTURE: episode-level, advisory, NOT a clinician scorecard. See CDMSS-CARE-VALUE-PRD.
 */

import type { NetValue } from './doc-audit-core';
import type { AdminFacts } from './doc-audit-core';
export type { NetValue, AdminFacts } from './doc-audit-core';

export type ValueDomain =
  | 'appropriateness' | 'efficiency' | 'safety' | 'cost' | 'documentation' | 'patient_centred';

export const VALUE_DOMAINS: ValueDomain[] =
  ['appropriateness', 'efficiency', 'safety', 'cost', 'documentation', 'patient_centred'];

export const DOMAIN_LABEL: Record<ValueDomain, string> = {
  appropriateness: 'Appropriateness',
  efficiency: 'Care-intensity efficiency',
  safety: 'Safety & stewardship',
  cost: 'Cost stewardship',
  documentation: 'Documentation',
  patient_centred: 'Patient-centredness',
};

// Short axis labels for the radar.
export const DOMAIN_SHORT: Record<ValueDomain, string> = {
  appropriateness: 'Appropriate', efficiency: 'Efficient', safety: 'Safe',
  cost: 'Cost', documentation: 'Documented', patient_centred: 'Patient-centred',
};

// Balanced default weights (sum = 1). Documentation is deliberately light so a well-written
// low-value episode can't score as "good value"; it is also surfaced as its own axis.
export const DEFAULT_WEIGHTS: Record<ValueDomain, number> = {
  appropriateness: 0.30, efficiency: 0.20, safety: 0.20, cost: 0.15, documentation: 0.10, patient_centred: 0.05,
};

// Which finding-domains are "clinical findings" scored by the verdict×confidence penalty model.
const FINDING_DOMAINS: ValueDomain[] = ['appropriateness', 'efficiency', 'safety'];

// Max points a single full-confidence low-value finding removes from a domain.
const PENALTY_BASE = 45;
// Severity weight by verdict.
const SEVERITY: Record<NetValue, number> = {
  'low-value': 1.0, 'context-dependent': 0.5, uncertain: 0.2, 'high-value': 0,
};
// Default ₹ of identified avoidable spend (tariffed low-value + estimated bed-days) that
// drives the cost score to 0. Sized for an inpatient episode; configurable.
export const DEFAULT_COST_CAP = 100_000;

export type Band = 'A' | 'B' | 'C' | 'D' | 'E';
export interface DomainScore {
  domain: ValueDomain;
  label: string;
  score: number;        // 0..100, higher = better value
  weight: number;       // its weight in the headline (normalised)
  n: number;            // # of inputs/signals informing it
  basis: string;        // short human explanation
}
export interface ValueScorecard {
  headline: number;     // 0..100 weighted Care-Value Index
  band: Band;
  domains: DomainScore[];
  lowValueSpend: number | null;     // ₹ of TARIFF-cited low-value care (charge-master)
  excessBedDayCost: number | null;  // ₹ of avoidable bed-days (tariff rate × audit-judged excess days)
  costNote?: string;                // e.g. "7 excess bed-days × ₹8,500 private ward"
  roomCategoryInflation: number | null;  // ₹ the episode's orders cost above General-ward rates (informational)
  roomTier?: string;                // the patient's room tier (for the inflation note)
  confidence: 'low' | 'moderate' | 'high';
  caveat: string;
}

export interface ScoreFinding { verdict: NetValue; confidence: number; domain?: ValueDomain; tariff?: number | null }
export interface ScoreInput {
  findings: ScoreFinding[];
  completenessCoverage: number;          // 0..1 (NABH coverage)
  patientCentred: { present: number; total: number };  // continuity completeness subset
  adminFacts?: AdminFacts;
  bedDayCost?: number | null;            // estimated avoidable bed-day ₹ (room-rent-core), adds to cost burden
  bedDayDetail?: string;                 // human note for the bed-day estimate
  roomCategoryInflation?: number | null; // ₹ episode orders cost above General-ward (informational, NOT in burden)
  roomTier?: string;                     // patient's room tier label
  weights?: Partial<Record<ValueDomain, number>>;
  costCap?: number;
}

export const CARE_VALUE_CAVEAT =
  'Process- and cost-based value proxy, case-adjusted against the idealised pathway. Not an outcomes-based (Porter) value score, and not a clinician scorecard — read it at the episode/service-line level, never as a physician rating.';

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function round(n: number): number { return Math.round(n); }

function netSeverity(v: NetValue): number { return SEVERITY[v] ?? 0.2; }

/** Penalty (points removed) for one finding. */
export function findingPenalty(f: ScoreFinding): number {
  return PENALTY_BASE * netSeverity(f.verdict) * clamp(Number(f.confidence) || 0, 0, 1);
}

/** Domain score from a set of findings: start at 100, subtract bounded penalties. */
function scoreFromFindings(fs: ScoreFinding[]): { score: number; n: number } {
  let pen = 0;
  for (const f of fs) pen += findingPenalty(f);
  return { score: clamp(100 - pen, 0, 100), n: fs.length };
}

export function bandFor(headline: number): Band {
  if (headline >= 85) return 'A';
  if (headline >= 70) return 'B';
  if (headline >= 55) return 'C';
  if (headline >= 40) return 'D';
  return 'E';
}

/**
 * Compute the full scorecard. Pure + deterministic.
 * Findings tagged efficiency/safety score those axes; everything else (incl. untagged)
 * counts toward appropriateness. Cost is driven by the ₹ of low-value tariff spend.
 */
export function computeScorecard(input: ScoreInput): ValueScorecard {
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights || {}) };
  const costCap = input.costCap && input.costCap > 0 ? input.costCap : DEFAULT_COST_CAP;
  const findings = Array.isArray(input.findings) ? input.findings : [];

  // Bucket findings by domain (untagged / 'cost' / 'patient_centred' fall to appropriateness
  // for the clinical penalty so a real low-value flag always dents *something*).
  const bucket: Record<ValueDomain, ScoreFinding[]> = {
    appropriateness: [], efficiency: [], safety: [], cost: [], documentation: [], patient_centred: [],
  };
  for (const f of findings) {
    const d = f.domain && FINDING_DOMAINS.includes(f.domain) ? f.domain : 'appropriateness';
    bucket[d].push(f);
  }

  // Low-value spend = Σ tariff of findings that are genuinely low-value / context-dependent.
  let lowValueSpend = 0; let haveTariff = false;
  for (const f of findings) {
    if ((f.verdict === 'low-value' || f.verdict === 'context-dependent') && f.tariff != null && f.tariff > 0) {
      lowValueSpend += f.tariff; haveTariff = true;
    }
  }

  const appr = scoreFromFindings(bucket.appropriateness);
  const eff = scoreFromFindings(bucket.efficiency);
  const saf = scoreFromFindings(bucket.safety);

  const coverage = clamp(Number(input.completenessCoverage) || 0, 0, 1);
  const docScore = round(coverage * 100);

  const pc = input.patientCentred || { present: 0, total: 0 };
  const pcScore = pc.total > 0 ? round((clamp(pc.present, 0, pc.total) / pc.total) * 100) : 100;

  // Cost burden = tariff-cited low-value spend + estimated avoidable bed-days of any
  // flagged over-stay. The bed-day part is a labelled estimate (kept separate in the card).
  const bedDay = Math.max(0, Number(input.bedDayCost) || 0);
  // Room-category inflation is SURFACED, not added to the burden (a higher room may be a
  // legitimate patient choice) — so it informs without auto-penalising the score.
  const inflation = Math.max(0, Number(input.roomCategoryInflation) || 0);
  const costBurden = lowValueSpend + bedDay;
  const haveCost = haveTariff || bedDay > 0;
  const costScore = haveCost ? clamp(round(100 - (costBurden / costCap) * 100), 0, 100) : 100;
  const costParts = [
    haveTariff ? `₹${Math.round(lowValueSpend).toLocaleString('en-IN')} tariffed low-value` : '',
    bedDay > 0 ? (input.bedDayDetail || `₹${Math.round(bedDay).toLocaleString('en-IN')} est. bed-days`) : '',
    inflation > 0 ? `+₹${Math.round(inflation).toLocaleString('en-IN')} vs general ward (room category)` : '',
  ].filter(Boolean);

  const domains: DomainScore[] = [
    { domain: 'appropriateness', label: DOMAIN_LABEL.appropriateness, score: appr.score, weight: weights.appropriateness, n: appr.n,
      basis: appr.n ? `${appr.n} appropriateness finding${appr.n === 1 ? '' : 's'}` : 'no over-use/low-value flagged' },
    { domain: 'efficiency', label: DOMAIN_LABEL.efficiency, score: eff.score, weight: weights.efficiency, n: eff.n,
      basis: eff.n ? `${eff.n} intensity finding${eff.n === 1 ? '' : 's'}${input.adminFacts?.lengthOfStayDays != null ? ` · LOS ${input.adminFacts.lengthOfStayDays}d` : ''}` : (input.adminFacts?.lengthOfStayDays != null ? `LOS ${input.adminFacts.lengthOfStayDays}d, none flagged` : 'no intensity issues flagged') },
    { domain: 'safety', label: DOMAIN_LABEL.safety, score: saf.score, weight: weights.safety, n: saf.n,
      basis: saf.n ? `${saf.n} safety/stewardship finding${saf.n === 1 ? '' : 's'}` : 'no safety issues flagged' },
    { domain: 'cost', label: DOMAIN_LABEL.cost, score: costScore, weight: weights.cost, n: costParts.length ? 1 : 0,
      basis: costParts.length ? costParts.join(' + ') : 'no avoidable spend identified' },
    { domain: 'documentation', label: DOMAIN_LABEL.documentation, score: docScore, weight: weights.documentation, n: 1,
      basis: `NABH completeness ${docScore}%` },
    { domain: 'patient_centred', label: DOMAIN_LABEL.patient_centred, score: pcScore, weight: weights.patient_centred, n: pc.total,
      basis: pc.total ? `${pc.present}/${pc.total} continuity fields present` : 'no continuity fields assessed' },
  ];

  // Normalise weights actually present, then weighted mean.
  const wsum = domains.reduce((s, d) => s + (d.weight > 0 ? d.weight : 0), 0) || 1;
  const headline = round(domains.reduce((s, d) => s + d.score * (d.weight > 0 ? d.weight : 0), 0) / wsum);

  // Confidence: how much real signal fed the score.
  const nFindings = findings.length;
  const confidence: ValueScorecard['confidence'] = nFindings >= 3 ? 'high' : nFindings >= 1 ? 'moderate' : 'low';

  return {
    headline,
    band: bandFor(headline),
    domains,
    lowValueSpend: haveTariff ? Math.round(lowValueSpend) : null,
    excessBedDayCost: bedDay > 0 ? Math.round(bedDay) : null,
    costNote: bedDay > 0 ? (input.bedDayDetail || undefined) : undefined,
    roomCategoryInflation: inflation > 0 ? Math.round(inflation) : null,
    roomTier: input.roomTier || undefined,
    confidence,
    caveat: CARE_VALUE_CAVEAT,
  };
}
