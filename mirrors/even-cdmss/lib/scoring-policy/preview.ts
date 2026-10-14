/**
 * lib/scoring-policy/preview.ts — apply a CANDIDATE weight vector across a cohort and describe
 * what it would do. PRD §5.3 (impact preview) and §5.3 (systemic-defect warning).
 *
 * PURE, dependency-free, strip-types testable. The cohort rows are fetched by the caller; nothing
 * here touches a database, so the screen can recompute on every tier change with no round-trip.
 */

import { weightedCompleteness, type StoredItem, type WeightedCompletenessOptions } from './completeness';
import { bandFor, recomputeIpdIndex, recomputeOpdIndex, BANDS, type Band, type IpdDomainScores, type OpdDomainScores } from './recompute';
import type { WeightVector } from './weights';

/** One cohort row: the stored per-field statuses plus the stored domain scores the index rebuilds
 *  from. `kind` selects which index formula applies. */
export interface CohortRow {
  id: string;
  items: StoredItem[];
  kind: 'ipd' | 'opd';
  domains: IpdDomainScores & OpdDomainScores;
  /** The value on the row today — used only for the "Now" side of the comparison. */
  storedCompleteness?: number | null;
  storedIndex?: number | null;
  storedBand?: string | null;
}

export interface CohortStats {
  n: number;
  meanCompleteness: number;
  sdCompleteness: number;
  bandHistogram: Record<Band, number>;
}

export interface Mover {
  id: string;
  fromPct: number;
  toPct: number;
  delta: number;
  fromBand: Band;
  toBand: Band;
}

export interface PreviewResult {
  now: CohortStats;
  after: CohortStats;
  /** How many rows change BAND (on the headline index, not on completeness). */
  changingBand: number;
  /** The three largest absolute completeness movers (PRD §5.3). */
  movers: Mover[];
  /** after − now, for the three metric cards. */
  deltaMeanCompleteness: number;
  deltaSd: number;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** POPULATION standard deviation (÷N). The cohort IS the population — it is every audit in the
 *  window, not a sample drawn from one — so N is correct and N−1 would understate nothing real. */
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

function emptyHistogram(): Record<Band, number> {
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

/** Score one row under a vector: weighted completeness + the index it rebuilds. */
export function scoreRow(row: CohortRow, vector: WeightVector | null, opts: WeightedCompletenessOptions = {}): { pct: number; index: number; band: Band } {
  const c = weightedCompleteness(row.items, vector, opts);
  const r = row.kind === 'ipd'
    ? recomputeIpdIndex(row.domains, c.pct)
    : recomputeOpdIndex(row.domains, c.pct);
  return { pct: c.pct, index: r.index, band: r.band };
}

function statsFor(rows: CohortRow[], vector: WeightVector | null, opts: WeightedCompletenessOptions): { stats: CohortStats; per: { id: string; pct: number; band: Band }[] } {
  const per = rows.map((r) => {
    const s = scoreRow(r, vector, opts);
    return { id: r.id, pct: s.pct, band: s.band };
  });
  const pcts = per.map((p) => p.pct);
  const hist = emptyHistogram();
  for (const p of per) hist[p.band] += 1;
  return {
    stats: { n: rows.length, meanCompleteness: round1(mean(pcts)), sdCompleteness: round1(sd(pcts)), bandHistogram: hist },
    per,
  };
}

/**
 * Compare a candidate vector against the active one over a cohort.
 *
 * `activeVector` null ⇒ equal weights (legacy), which is also the correct "Now" side on the very
 * first visit, before anything has been published beyond the seeded v1.
 *
 * Never throws: an empty cohort yields zeroed stats and no movers, which is what the OPD empty
 * state (decision §1.5) renders against.
 */
export function previewImpact(
  rows: CohortRow[],
  activeVector: WeightVector | null,
  candidateVector: WeightVector | null,
  opts: WeightedCompletenessOptions = {},
): PreviewResult {
  const list = Array.isArray(rows) ? rows : [];
  const nowSide = statsFor(list, activeVector, opts);
  const afterSide = statsFor(list, candidateVector, opts);

  const byId = new Map(nowSide.per.map((p) => [p.id, p]));
  let changingBand = 0;
  const movers: Mover[] = [];
  for (const a of afterSide.per) {
    const b = byId.get(a.id);
    if (!b) continue;
    if (a.band !== b.band) changingBand += 1;
    if (a.pct !== b.pct) {
      movers.push({ id: a.id, fromPct: b.pct, toPct: a.pct, delta: a.pct - b.pct, fromBand: b.band, toBand: a.band });
    }
  }
  movers.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.id.localeCompare(y.id));

  return {
    now: nowSide.stats,
    after: afterSide.stats,
    changingBand,
    movers: movers.slice(0, 3),
    deltaMeanCompleteness: round1(afterSide.stats.meanCompleteness - nowSide.stats.meanCompleteness),
    deltaSd: round1(afterSide.stats.sdCompleteness - nowSide.stats.sdCompleteness),
  };
}

/** Per-field prevalence: how often each key is missing across the cohort. Drives the load-bearing
 *  "missing in 78% of summaries" line and the field ordering within a section (PRD §5.3). */
export function missingPrevalence(rows: CohortRow[]): Record<string, { missing: number; applicable: number; pct: number }> {
  const out: Record<string, { missing: number; applicable: number; pct: number }> = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const it of Array.isArray(r.items) ? r.items : []) {
      if (!it || typeof it.key !== 'string' || !it.key) continue;
      const status = String(it.status ?? '');
      if (status === 'na') continue;                       // not applicable ⇒ not in the prevalence base
      const e = out[it.key] ?? (out[it.key] = { missing: 0, applicable: 0, pct: 0 });
      e.applicable += 1;
      if (status === 'missing') e.missing += 1;
    }
  }
  for (const k of Object.keys(out)) {
    const e = out[k];
    e.pct = e.applicable > 0 ? Math.round((100 * e.missing) / e.applicable) : 0;
  }
  return out;
}

/**
 * PRD §5.3 systemic-defect warning. Fires when a field that is ALREADY missing from most documents
 * is set to Critical: weighting it heavily fails almost every doctor at once instead of telling
 * them apart. It WARNS; it never blocks.
 */
export const SYSTEMIC_DEFECT_THRESHOLD = 50;

export function systemicDefectWarnings(
  candidate: WeightVector | null | undefined,
  prevalence: Record<string, { pct: number }>,
  labelFor: (key: string) => string,
): { key: string; label: string; missingPct: number }[] {
  const out: { key: string; label: string; missingPct: number }[] = [];
  if (!candidate) return out;
  for (const [key, tier] of Object.entries(candidate)) {
    if (tier !== 'critical') continue;
    const p = prevalence[key]?.pct ?? 0;
    if (p > SYSTEMIC_DEFECT_THRESHOLD) out.push({ key, label: labelFor(key), missingPct: p });
  }
  return out.sort((a, b) => b.missingPct - a.missingPct);
}

/** The warning copy, verbatim per PRD §5.3. Exported so the UI cannot drift from the spec. */
export function systemicDefectMessage(fieldName: string, sdAfter: number): string {
  return `${fieldName} is missing from most summaries already. Weighting it heavily fails almost every doctor at once instead of telling them apart — this is a discharge template problem, not a scoring one. Spread is now ${sdAfter}.`;
}

export { BANDS };
