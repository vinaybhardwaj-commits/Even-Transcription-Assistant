/**
 * lib/jev/bench.ts — J-CORE-3: the bench harness. "Labelled set in, recall / precision / ECE /
 * cost / latency out, same shape for every use" (PLAN-v3.md §2) — plan principle 3, "bench before
 * wiring": every USE of Jev measures itself with this, on real labelled data, before it runs in
 * shadow and before its own flag goes on.
 *
 * PURE scoring (scoreJevBench, classMetrics, calibrationBins) — no I/O, no Jev call of its own.
 * A caller collects BenchItem rows by running lib/jev/ask.ts with persist:false against a
 * labelled set (so a bench run does not leave rows in jev_decision) and scores the result here.
 *
 * formatJevBenchReport produces the markdown block the kickoff asks for; it does not write to
 * docs/handoff/ETA-JEV-PROGRAMME-*.md itself — that file is append-only by hand (`cat >>`), the
 * same convention as docs/handoff/ETA-FINDINGS-LEDGER.md, not something library code should do.
 */
import { JEV_INPUT_TOKEN_COST_USD } from "./counters";

export type BenchItem = {
  subjectId: string;
  /** Ground truth and Jev's answer, as comparable labels — a "score" question's numeric answer
   * is stringified by the caller before it becomes a BenchItem, so this harness stays agnostic
   * to noul/choice/score and works identically for all three. */
  expected: string;
  predicted: string;
  confidence: number;
  latencyMs: number;
  inputTokens: number;
};

export type ClassMetrics = {
  recall: Record<string, number>;
  precision: Record<string, number>;
  macroRecall: number;
  macroPrecision: number;
};

export type CalibrationBin = { range: [number, number]; count: number; accuracy: number; avgConfidence: number };

export type BenchMetrics = {
  n: number;
  accuracy: number;
  recall: Record<string, number>;
  precision: Record<string, number>;
  macroRecall: number;
  macroPrecision: number;
  ece: number;
  bins: CalibrationBin[];
  cost: { totalInputTokens: number; estimatedCostUsd: number };
  latency: { avgMs: number; p50Ms: number; p95Ms: number };
};

/** PURE. Per-class recall/precision plus their macro average, over whatever labels actually
 * appear (as ground truth, as a prediction, or both) — never a fixed class list, so a use with
 * three criteria and a use with six both work unmodified. A class with no ground-truth items
 * (recall undefined) or no predicted items (precision undefined) is excluded from that macro
 * average rather than counted as 0, which would understate a harness run early in labelling. */
export function classMetrics(items: readonly BenchItem[]): ClassMetrics {
  const classes = new Set<string>();
  for (const it of items) {
    classes.add(it.expected);
    classes.add(it.predicted);
  }
  const recall: Record<string, number> = {};
  const precision: Record<string, number> = {};
  for (const c of classes) {
    const truePositives = items.filter((it) => it.expected === c && it.predicted === c).length;
    const expectedCount = items.filter((it) => it.expected === c).length;
    const predictedCount = items.filter((it) => it.predicted === c).length;
    if (expectedCount > 0) recall[c] = truePositives / expectedCount;
    if (predictedCount > 0) precision[c] = truePositives / predictedCount;
  }
  const recallValues = Object.values(recall);
  const precisionValues = Object.values(precision);
  return {
    recall,
    precision,
    macroRecall: recallValues.length ? recallValues.reduce((a, b) => a + b, 0) / recallValues.length : 0,
    macroPrecision: precisionValues.length ? precisionValues.reduce((a, b) => a + b, 0) / precisionValues.length : 0,
  };
}

/** PURE. Expected Calibration Error over `binCount` equal-width confidence bins (standard ECE):
 * a well-calibrated 0.9-confidence bin should be right about 90% of the time — ECE is the
 * count-weighted average gap between a bin's confidence and its actual accuracy. The final bin
 * includes confidence == 1.0 (every other bin's upper edge is exclusive). */
export function calibrationBins(items: readonly BenchItem[], binCount = 10): { ece: number; bins: CalibrationBin[] } {
  const width = 1 / binCount;
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = i * width;
    const hi = (i + 1) * width;
    const inBin = items.filter((it) => it.confidence >= lo && (i === binCount - 1 ? it.confidence <= hi : it.confidence < hi));
    if (inBin.length === 0) {
      bins.push({ range: [lo, hi], count: 0, accuracy: 0, avgConfidence: 0 });
      continue;
    }
    const correct = inBin.filter((it) => it.expected === it.predicted).length;
    bins.push({
      range: [lo, hi],
      count: inBin.length,
      accuracy: correct / inBin.length,
      avgConfidence: inBin.reduce((sum, it) => sum + it.confidence, 0) / inBin.length,
    });
  }
  const n = items.length;
  const ece = n === 0 ? 0 : bins.reduce((sum, b) => sum + (b.count / n) * Math.abs(b.accuracy - b.avgConfidence), 0);
  return { ece, bins };
}

/** PURE. Nearest-rank percentile over `field`, ascending. */
function percentileOf(items: readonly BenchItem[], field: "latencyMs", p: number): number {
  if (items.length === 0) return 0;
  const sorted = [...items].map((it) => it[field]).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

/** PURE. The one entry point every use's bench script calls — same shape out regardless of what
 * question type or subject_type went in. */
export function scoreJevBench(items: readonly BenchItem[]): BenchMetrics {
  const n = items.length;
  const accuracy = n === 0 ? 0 : items.filter((it) => it.expected === it.predicted).length / n;
  const { recall, precision, macroRecall, macroPrecision } = classMetrics(items);
  const { ece, bins } = calibrationBins(items);
  const totalInputTokens = items.reduce((sum, it) => sum + it.inputTokens, 0);
  const latencies = items.map((it) => it.latencyMs);
  return {
    n,
    accuracy,
    recall,
    precision,
    macroRecall,
    macroPrecision,
    ece,
    bins,
    cost: { totalInputTokens, estimatedCostUsd: totalInputTokens * JEV_INPUT_TOKEN_COST_USD },
    latency: {
      avgMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      p50Ms: percentileOf(items, "latencyMs", 0.5),
      p95Ms: percentileOf(items, "latencyMs", 0.95),
    },
  };
}

/** The markdown block for docs/handoff/ETA-JEV-PROGRAMME-*.md — same shape for every use, per
 * the kickoff. Not written to disk here; a bench run's own script appends it by hand. */
export function formatJevBenchReport(opts: { use: string; questionId: string; promptVersion: string; metrics: BenchMetrics; date?: string }): string {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const m = opts.metrics;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const perClass = Object.keys({ ...m.recall, ...m.precision })
    .sort()
    .map((c) => `  - ${c}: recall ${m.recall[c] !== undefined ? pct(m.recall[c]!) : "n/a"}, precision ${m.precision[c] !== undefined ? pct(m.precision[c]!) : "n/a"}`)
    .join("\n");
  return [
    `## ${opts.use} — ${opts.questionId}@${opts.promptVersion} (${date})`,
    "",
    `n=${m.n}, accuracy=${pct(m.accuracy)}, macro recall=${pct(m.macroRecall)}, macro precision=${pct(m.macroPrecision)}, ECE=${m.ece.toFixed(3)}`,
    perClass,
    `cost: ${m.cost.totalInputTokens} input tokens (~$${m.cost.estimatedCostUsd.toFixed(4)}); latency: avg ${m.latency.avgMs.toFixed(0)}ms, p50 ${m.latency.p50Ms.toFixed(0)}ms, p95 ${m.latency.p95Ms.toFixed(0)}ms`,
    "",
  ].join("\n");
}
