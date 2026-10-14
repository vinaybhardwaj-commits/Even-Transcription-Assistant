/**
 * lib/lab-v2/analysis-core.ts — the pure arithmetic behind `experiment_compare` and `run_diff`
 * (LAB-MCP-V2-PRD-v1.0 §17.4 items 4 and 5).
 *
 * Pure by construction: no database, no clock, no randomness that is not seeded. Everything a
 * comparison claims has to be reproducible from the stored rows alone, and a function that reads
 * the clock or an unseeded RNG cannot promise that.
 *
 * ⚠️ THE DENOMINATOR IS THE POINT. §9 says a report counts every item under all three statuses and
 * names the subset its metrics were computed on. So `countDenominators` returns every bucket
 * separately and asserts the identity `attempted = succeeded + failed + cancelled + expired`
 * rather than letting a caller infer it; `assessable_verified` is a SEPARATE, smaller number and
 * is the only one any metric is divided by. "10 failures out of 100" must show 100.
 */

// ── set comparison ───────────────────────────────────────────────────────────────────
/** Jaccard over two subject lists, order- and duplicate-insensitive. Empty ∩ empty = 1. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

export interface SubjectDiff { added: string[]; removed: string[]; kept: string[] }

/** What b has that a did not, and what a had that b lost. Sorted, so a diff is stable. */
export function diffSubjects(a: readonly string[], b: readonly string[]): SubjectDiff {
  const A = new Set(a);
  const B = new Set(b);
  return {
    added: [...B].filter((v) => !A.has(v)).sort(),
    removed: [...A].filter((v) => !B.has(v)).sort(),
    kept: [...A].filter((v) => B.has(v)).sort(),
  };
}

// ── denominators (§9) ────────────────────────────────────────────────────────────────
export interface DenominatorInput {
  execution_status: string | null;
  assessment_status: string | null;
  attribution_status: string | null;
}

export interface Denominators {
  attempted: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  expired: number;
  unassessable: number;
  attribution_invalid: number;
  /** THE METRIC DENOMINATOR. Succeeded AND assessed AND verified. Named in every output. */
  assessable_verified: number;
  /** The identity §17.4 requires: attempted = succeeded + failed + cancelled + expired. */
  sums: boolean;
}

export function countDenominators(items: readonly DenominatorInput[]): Denominators {
  const n = (p: (i: DenominatorInput) => boolean) => items.filter(p).length;
  const succeeded = n((i) => i.execution_status === 'succeeded');
  const failed = n((i) => i.execution_status === 'failed');
  const cancelled = n((i) => i.execution_status === 'cancelled');
  const expired = n((i) => i.execution_status === 'expired');
  // `partial` is a fifth execution status (§9). It is counted into neither side of the identity
  // below, so it is surfaced by making `sums` false rather than by being quietly folded in.
  const attempted = items.length;
  return {
    attempted,
    succeeded,
    failed,
    cancelled,
    expired,
    unassessable: n((i) => i.assessment_status === 'unassessable'),
    attribution_invalid: n((i) => i.attribution_status === 'invalid'),
    assessable_verified: n((i) =>
      i.execution_status === 'succeeded' && i.assessment_status === 'assessed' && i.attribution_status === 'verified'),
    sums: attempted === succeeded + failed + cancelled + expired,
  };
}

// ── seeded RNG ───────────────────────────────────────────────────────────────────────
/**
 * mulberry32 — small, fast, and fully determined by its seed. The bootstrap below must give the
 * same interval for the same rows on every machine and every run, or a comparison cannot be
 * checked by anyone but the person who ran it.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** §17.4 — fixed, so two people comparing the same run get the same interval. */
export const BOOTSTRAP_SEED = 19052026;
export const BOOTSTRAP_RESAMPLES = 1000;

export interface ClusteredValue { cluster: string; value: number }

export interface BootstrapResult {
  mean: number | null;
  lo: number | null;
  hi: number | null;
  n: number;
  clusters: number;
  resamples: number;
  seed: number;
}

/**
 * Member-cluster bootstrap over paired differences.
 *
 * ⚠️ IT RESAMPLES CLUSTERS, NOT ROWS, and that is the whole reason it exists. Two audits of the
 * same member are not independent observations: the same patient, the same history, often the same
 * doctor. Resampling rows would treat them as independent and report an interval narrower than the
 * evidence supports — a confident-looking number that is wrong in the direction that matters.
 * Clustering on `member_key` (decision 44) keeps a member's cases together in every resample.
 *
 * A cluster of one is still a cluster; a dataset with no member grouping degrades to one cluster
 * per case, which is the row bootstrap, and the output says how many clusters there were so a
 * reader can see which they got.
 */
export function bootstrapClustered(
  values: readonly ClusteredValue[],
  resamples: number = BOOTSTRAP_RESAMPLES,
  seed: number = BOOTSTRAP_SEED,
): BootstrapResult {
  const usable = values.filter((v) => Number.isFinite(v.value));
  const byCluster = new Map<string, number[]>();
  for (const v of usable) {
    const arr = byCluster.get(v.cluster);
    if (arr) arr.push(v.value); else byCluster.set(v.cluster, [v.value]);
  }
  const clusters = [...byCluster.values()];
  const base: BootstrapResult = {
    mean: null, lo: null, hi: null, n: usable.length, clusters: clusters.length, resamples, seed,
  };
  if (!usable.length || !clusters.length) return base;

  const mean = usable.reduce((s, v) => s + v.value, 0) / usable.length;
  // One cluster cannot produce an interval: every resample is that same cluster.
  if (clusters.length < 2) return { ...base, mean, lo: null, hi: null };

  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    let count = 0;
    for (let c = 0; c < clusters.length; c += 1) {
      const picked = clusters[Math.floor(rand() * clusters.length)];
      for (const v of picked) { sum += v; count += 1; }
    }
    if (count) means.push(sum / count);
  }
  means.sort((x, y) => x - y);
  const at = (q: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * (means.length - 1))))];
  return { ...base, mean, lo: at(0.025), hi: at(0.975) };
}

// ── paired case comparison ───────────────────────────────────────────────────────────
export interface CaseMetrics {
  case_key: string;
  member_key: string | null;
  n_findings: number | null;
  n_low_value: number | null;
  note_quality_index: number | null;
  band: string | null;
  subjects: string[];
  result_hash: string | null;
}

export interface PairedCase {
  case_key: string;
  member_key: string | null;
  delta_n_findings: number | null;
  delta_n_low_value: number | null;
  delta_note_quality_index: number | null;
  band_before: string | null;
  band_after: string | null;
  band_changed: boolean;
  subject_jaccard: number;
  subjects_added: string[];
  subjects_removed: string[];
  result_hash_equal: boolean;
}

const delta = (a: number | null, b: number | null): number | null =>
  (a == null || b == null ? null : b - a);

/** One case, baseline against arm. Only cases present on BOTH sides can be paired. */
export function pairCase(baseline: CaseMetrics, arm: CaseMetrics): PairedCase {
  const d = diffSubjects(baseline.subjects, arm.subjects);
  return {
    case_key: baseline.case_key,
    member_key: baseline.member_key ?? arm.member_key ?? null,
    delta_n_findings: delta(baseline.n_findings, arm.n_findings),
    delta_n_low_value: delta(baseline.n_low_value, arm.n_low_value),
    delta_note_quality_index: delta(baseline.note_quality_index, arm.note_quality_index),
    band_before: baseline.band,
    band_after: arm.band,
    band_changed: baseline.band !== arm.band,
    subject_jaccard: jaccard(baseline.subjects, arm.subjects),
    subjects_added: d.added,
    subjects_removed: d.removed,
    result_hash_equal: baseline.result_hash != null && baseline.result_hash === arm.result_hash,
  };
}

/** The bootstrap over one paired metric, clustered on member_key. */
export function bootstrapMetric(
  pairs: readonly PairedCase[],
  pick: (p: PairedCase) => number | null,
  resamples?: number,
  seed?: number,
): BootstrapResult {
  const values: ClusteredValue[] = [];
  for (const p of pairs) {
    const v = pick(p);
    if (v == null || !Number.isFinite(v)) continue;
    // A case with no member key is its own cluster — the honest degradation, not a shared bucket
    // that would pretend unrelated cases are correlated.
    values.push({ cluster: p.member_key ?? `case:${p.case_key}`, value: v });
  }
  return bootstrapClustered(values, resamples, seed);
}
