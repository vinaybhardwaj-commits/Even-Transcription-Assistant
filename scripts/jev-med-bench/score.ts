/**
 * scripts/jev-med-bench/score.ts — pre-registered scoring for the medication-note bench.
 *
 * PRE-REGISTERED RULE (BENCH-DESIGN.md, ruled W30.3; fixed before any live run):
 *   flag(sentence) := P(supported) < T.
 *   T is chosen ON DEV ONLY: the largest grid value (0.05 steps, 0.05..0.95) whose dev false-flag
 *   rate is <= DEV_FF_CAP (0.08). If none qualifies, T = 0.05.
 *   TEST is then scored ONCE at that frozen T.
 *   PASS := test false-flag observed <= 0.10 AND its one-sided 95% Clopper-Pearson upper bound < 0.25.
 *   (At n=200 the observed cap already implies an upper bound of ~14%, so in practice PASS = observed <= 10%;
 *   the bound binds only if n is smaller. Both are kept because the ruling names both.)
 * false-flag = P(flag | label = supported). catch = P(flag | label = unsupported), by perturbation type.
 */
import { scoreJevBench, type BenchItem } from "../../lib/jev/bench";
import type { Excerpt, Sentence } from "./generate";

export const DEV_FF_CAP = 0.08;
export const PASS_OBSERVED_MAX = 0.10;
export const PASS_UPPER_MAX = 0.25;
export const THRESHOLD_GRID = Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 5) / 100);

export type Scored = { case_id: string; split: "dev" | "test"; label: "supported" | "unsupported"; perturbation: string | null; detail: string; tags: string[]; p: number };

export function joinResults(excerpts: Excerpt[], results: Record<string, number>): Scored[] {
  const out: Scored[] = [];
  for (const e of excerpts) {
    for (const s of e.sentences) {
      const p = results[s.case_id];
      if (typeof p !== "number" || Number.isNaN(p)) continue; // unanswered stays out, and is counted by the caller
      out.push({ case_id: s.case_id, split: e.split, label: s.label, perturbation: s.perturbation, detail: s.detail, tags: s.tags, p });
    }
  }
  return out;
}

export const flagged = (p: number, T: number): boolean => p < T;

export function rate(rows: Scored[], pred: (r: Scored) => boolean, T: number): { k: number; n: number; rate: number } {
  const sel = rows.filter(pred);
  const k = sel.filter((r) => flagged(r.p, T)).length;
  return { k, n: sel.length, rate: sel.length ? k / sel.length : NaN };
}

export function chooseThreshold(dev: Scored[]): { T: number; devFalseFlag: number } {
  let best = { T: 0.05, devFalseFlag: rate(dev, (r) => r.label === "supported", 0.05).rate };
  for (const T of THRESHOLD_GRID) {
    const ff = rate(dev, (r) => r.label === "supported", T).rate;
    if (ff <= DEV_FF_CAP) best = { T, devFalseFlag: ff };
  }
  return best;
}

// ---- exact binomial bound
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}
function binomCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, sum);
}
/** One-sided upper Clopper-Pearson limit: the p with P(X <= k | n, p) = alpha. */
export function cpUpper(k: number, n: number, alpha = 0.05): number {
  if (n === 0) return 1;
  if (k >= n) return 1;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type Report = {
  T: number;
  devFalseFlag: number;
  n: { dev: number; test: number; unanswered: number };
  test: {
    falseFlag: { k: number; n: number; rate: number; upper95: number };
    catchOverall: { k: number; n: number; rate: number };
    catchByType: Record<string, { k: number; n: number; rate: number }>;
    falseFlagBySubset: Record<string, { k: number; n: number; rate: number }>;
    ece: number;
    accuracy: number;
  };
  verdict: "PASS" | "FAIL";
  reason: string;
};

export function buildReport(all: Scored[], unanswered = 0): Report {
  const dev = all.filter((r) => r.split === "dev");
  const test = all.filter((r) => r.split === "test");
  const { T, devFalseFlag } = chooseThreshold(dev);
  const ff = rate(test, (r) => r.label === "supported", T);
  const upper95 = cpUpper(ff.k, ff.n);
  const catchByType: Report["test"]["catchByType"] = {};
  for (const t of ["dose", "number", "drug"]) catchByType[t] = rate(test, (r) => r.perturbation === t, T);
  const falseFlagBySubset: Report["test"]["falseFlagBySubset"] = {};
  for (const tag of ["codemixed", "brand_generic", "abbrev"]) falseFlagBySubset[tag] = rate(test, (r) => r.label === "supported" && r.tags.includes(tag), T);
  const items: BenchItem[] = test.map((r) => ({
    subjectId: r.case_id,
    expected: r.label,
    predicted: flagged(r.p, T) ? "unsupported" : "supported",
    // confidence in the PREDICTED class (the prediction is made at T, not 0.5)
    confidence: flagged(r.p, T) ? 1 - r.p : r.p,
    latencyMs: 0,
    inputTokens: 0,
  }));
  const m = items.length ? scoreJevBench(items) : null;
  const okObs = ff.n > 0 && ff.rate <= PASS_OBSERVED_MAX;
  const okUp = ff.n > 0 && upper95 < PASS_UPPER_MAX;
  const verdict = okObs && okUp && unanswered === 0 ? "PASS" : "FAIL";
  const reason = ff.n === 0
    ? "no supported test sentences answered"
    : unanswered > 0
      ? `${unanswered} sentences unanswered (absent means unanswered, not supported) — verdict withheld as FAIL`
      : `test false-flag ${ff.k}/${ff.n} = ${(ff.rate * 100).toFixed(1)}% (cap ${PASS_OBSERVED_MAX * 100}%), upper95 ${(upper95 * 100).toFixed(1)}% (cap <${PASS_UPPER_MAX * 100}%)`;
  return {
    T,
    devFalseFlag,
    n: { dev: dev.length, test: test.length, unanswered },
    test: { falseFlag: { ...ff, upper95 }, catchOverall: rate(test, (r) => r.label === "unsupported", T), catchByType, falseFlagBySubset, ece: m?.ece ?? NaN, accuracy: m?.accuracy ?? NaN },
    verdict,
    reason,
  };
}

const pct = (x: { k: number; n: number; rate: number }) => `${x.k}/${x.n} = ${Number.isNaN(x.rate) ? "n/a" : (x.rate * 100).toFixed(1) + "%"}`;

export function formatReport(r: Report): string {
  const lines = [
    `# Medication-note bench — ${r.verdict}`,
    ``,
    `- ${r.reason}`,
    `- Frozen threshold T = ${r.T} (chosen on dev only; dev false-flag ${(r.devFalseFlag * 100).toFixed(1)}%, cap ${DEV_FF_CAP * 100}%). n: dev ${r.n.dev}, test ${r.n.test}, unanswered ${r.n.unanswered}.`,
    `- Test false-flag (primary): ${pct(r.test.falseFlag)}, one-sided 95% upper bound ${(r.test.falseFlag.upper95 * 100).toFixed(1)}%.`,
    `- Test catch overall: ${pct(r.test.catchOverall)}. By type: ${Object.entries(r.test.catchByType).map(([k, v]) => `${k} ${pct(v)}`).join("; ")}.`,
    `- Test false-flag by subset (supported only): ${Object.entries(r.test.falseFlagBySubset).map(([k, v]) => `${k} ${pct(v)}`).join("; ")}.`,
    `- Test accuracy ${(r.test.accuracy * 100).toFixed(1)}%, ECE ${r.test.ece.toFixed(3)}.`,
    ``,
    `Floor only: invented transcripts are cleaner than real room audio. Real-data false-flag needs the shadow-week jev_decision sample or D1b.`,
  ];
  return lines.join("\n");
}

export type { Sentence };
