/**
 * lib/scoring-policy/recompute.ts — rebuild a headline index from STORED domain scores after the
 * documentation domain has been re-weighted. PRD §2.6.
 *
 * PURE, dependency-free, strip-types testable.
 *
 * ⚠️ THE SCORING CORES ARE NEVER RE-ENTERED. This module deliberately RE-STATES the two weight
 * vectors rather than importing lib/opd-note-score-core.ts / lib/value-score-core.ts, because both
 * are on the PRD's hard UNTOUCHED list and because importing them would drag `lib/doc-audit-core`
 * (and its types) into a module that must stay strip-types-pure. The constants below are copied
 * VERBATIM from those files and asserted against them by a test that reads them as source text, so
 * the duplication cannot drift silently.
 *
 *   OPD  (lib/opd-note-score-core.ts OPD_DEFAULT_WEIGHTS):
 *        documentation .25 · note_quality .25 · appropriateness .20
 *        · prescribing_safety .20 · patient_centred .10
 *   IPD  (lib/value-score-core.ts DEFAULT_WEIGHTS):
 *        appropriateness .30 · efficiency .20 · safety .20
 *        · cost .15 · documentation .10 · patient_centred .05
 */

export type Band = 'A' | 'B' | 'C' | 'D' | 'E';

/** PRD §2.7 / companion spec §5.4. Unchanged by this build; re-stated for the same reason as the
 *  weights above (both cores define an identical `bandFor`). */
export function bandFor(score: number): Band {
  if (!Number.isFinite(score)) return 'E';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

export const BANDS: Band[] = ['A', 'B', 'C', 'D', 'E'];

export type OpdDomain = 'documentation' | 'note_quality' | 'appropriateness' | 'prescribing_safety' | 'patient_centred';
export type IpdDomain = 'appropriateness' | 'efficiency' | 'safety' | 'cost' | 'documentation' | 'patient_centred';

export const OPD_WEIGHTS: Record<OpdDomain, number> = {
  documentation: 0.25, note_quality: 0.25, appropriateness: 0.20, prescribing_safety: 0.20, patient_centred: 0.10,
};

export const IPD_WEIGHTS: Record<IpdDomain, number> = {
  appropriateness: 0.30, efficiency: 0.20, safety: 0.20, cost: 0.15, documentation: 0.10, patient_centred: 0.05,
};

/** A domain score that is null/absent is NOT APPLICABLE: its weight leaves the denominator, exactly
 *  as the cores do (`const nqWeight = pq.score == null ? 0 : weights.note_quality`). This is what
 *  makes the PDQI-9-absent case divide by 0.75 rather than 1.00 (PRD §2.6). */
function weightedIndex(pairs: { score: number | null | undefined; weight: number }[]): number {
  let num = 0, den = 0;
  for (const p of pairs) {
    if (p.score == null || !Number.isFinite(Number(p.score))) continue;
    if (!(p.weight > 0)) continue;
    num += Number(p.score) * p.weight;
    den += p.weight;
  }
  if (den <= 0) return 0;
  return Math.round(num / den);
}

export interface OpdDomainScores {
  documentation?: number | null;
  note_quality?: number | null;
  appropriateness?: number | null;
  prescribing_safety?: number | null;
  patient_centred?: number | null;
}

export interface IpdDomainScores {
  appropriateness?: number | null;
  efficiency?: number | null;
  safety?: number | null;
  cost?: number | null;
  documentation?: number | null;
  patient_centred?: number | null;
}

export interface RecomputeResult { index: number; band: Band }

/**
 * PRD §2.6 procedure: take stored domain scores → substitute the newly weighted documentation
 * score → recompute the index → re-band. `newDocumentation` is the weighted completeness (which
 * IS the documentation domain score — companion spec §4.4 establishes that identity across
 * 25,112 of 25,112 rows).
 */
export function recomputeOpdIndex(stored: OpdDomainScores, newDocumentation: number | null | undefined): RecomputeResult {
  const doc = newDocumentation == null ? stored.documentation : newDocumentation;
  const index = weightedIndex([
    { score: doc, weight: OPD_WEIGHTS.documentation },
    { score: stored.note_quality, weight: OPD_WEIGHTS.note_quality },
    { score: stored.appropriateness, weight: OPD_WEIGHTS.appropriateness },
    { score: stored.prescribing_safety, weight: OPD_WEIGHTS.prescribing_safety },
    { score: stored.patient_centred, weight: OPD_WEIGHTS.patient_centred },
  ]);
  return { index, band: bandFor(index) };
}

export function recomputeIpdIndex(stored: IpdDomainScores, newDocumentation: number | null | undefined): RecomputeResult {
  const doc = newDocumentation == null ? stored.documentation : newDocumentation;
  const index = weightedIndex([
    { score: stored.appropriateness, weight: IPD_WEIGHTS.appropriateness },
    { score: stored.efficiency, weight: IPD_WEIGHTS.efficiency },
    { score: stored.safety, weight: IPD_WEIGHTS.safety },
    { score: stored.cost, weight: IPD_WEIGHTS.cost },
    { score: doc, weight: IPD_WEIGHTS.documentation },
    { score: stored.patient_centred, weight: IPD_WEIGHTS.patient_centred },
  ]);
  return { index, band: bandFor(index) };
}

/** PRD §8.3 — every surface showing a band or index must also show the weights version that
 *  produced it. This is the label those surfaces render. */
export function scoredUnderLabel(weightsVersion: string | null | undefined): string | null {
  return weightsVersion ? `Scored under ${weightsVersion}` : null;
}
