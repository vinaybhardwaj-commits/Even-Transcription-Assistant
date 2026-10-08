/**
 * lib/rubrics/bench.ts — S7-0: score a rubric against its labelled bench set. The bench set is a JSON file of units and the values a correct run must give:
 *   { "unit": "room_hour", "items": [ { "unit_key": "...", "expected": { "<score field>": <value>, ... }, "tolerance": 0.02 } ] }
 * It holds identifiers and expected numbers / codes only (no transcript text), and lives in the lab store (rubric/<id>/<version>/bench.json) or, once a rubric is benched, in
 * the repo (rubrics/<id>/bench.json). Scoring goes through lib/jev/bench.ts (scoreJevBench): every expected field is one item whose label is the expected value and whose
 * prediction is the engine's value (a number within `tolerance` of the expected one counts as equal), so per-class recall / precision come with the accuracy.
 */
import { scoreJevBench, type BenchItem, type BenchMetrics } from "@/lib/jev/bench";
import type { RubricUnit } from "./types";

export type BenchSetItem = { unit_key: string; expected: Record<string, unknown>; tolerance?: number };
export type BenchSet = { unit: RubricUnit; items: BenchSetItem[] };
export const BENCH_MAX_ITEMS = 500;
export const DEFAULT_TOLERANCE = 0.01;

export function parseBenchSet(raw: unknown): BenchSet | null {
  const o = raw as { unit?: unknown; items?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.items) || typeof o.unit !== "string") return null;
  if (!["window", "consult", "room_hour", "stay"].includes(o.unit)) return null;
  if (o.items.length === 0 || o.items.length > BENCH_MAX_ITEMS) return null;
  const items: BenchSetItem[] = [];
  for (const it of o.items as Array<Record<string, unknown>>) {
    if (!it || typeof it.unit_key !== "string" || !it.unit_key || typeof it.expected !== "object" || it.expected === null || Array.isArray(it.expected)) return null;
    if (Object.keys(it.expected as object).length === 0) return null;
    items.push({ unit_key: it.unit_key, expected: it.expected as Record<string, unknown>, ...(typeof it.tolerance === "number" ? { tolerance: it.tolerance } : {}) });
  }
  return { unit: o.unit as RubricUnit, items };
}

const label = (v: unknown): string => (Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : v === null || v === undefined ? "null" : String(v));

/** One unit's comparison: per expected field, equal or not. A unit the engine did not score (skipped / failed) fails every field. */
export function compareItem(item: BenchSetItem, score: Record<string, unknown> | null): Array<{ field: string; expected: string; got: string; equal: boolean }> {
  const tol = item.tolerance ?? DEFAULT_TOLERANCE;
  return Object.entries(item.expected).map(([field, exp]) => {
    const got = score ? score[field] : undefined;
    const equal = typeof exp === "number" && typeof got === "number" ? Math.abs(got - exp) <= tol : label(exp) === label(got);
    return { field, expected: label(exp), got: equal ? label(exp) : score ? label(got) : "unscored", equal };
  });
}

export type BenchReport = {
  metric: string; value: number; threshold: number; passed: boolean; items: number; fields: number; items_all_equal: number; metrics: BenchMetrics;
  per_field: Record<string, { n: number; equal: number }>; unscored: number;
};

export function scoreBench(metric: string, threshold: number, compared: Array<ReturnType<typeof compareItem>>): BenchReport | { error: "metric_not_supported" } {
  if (metric !== "field_accuracy" && metric !== "accuracy") return { error: "metric_not_supported" };
  const flat: BenchItem[] = [];
  const perField: Record<string, { n: number; equal: number }> = {};
  let allEqual = 0, unscored = 0;
  compared.forEach((cmp, i) => {
    if (cmp.every((c) => c.equal)) allEqual += 1;
    if (cmp.every((c) => c.got === "unscored")) unscored += 1;
    for (const c of cmp) {
      flat.push({ subjectId: String(i), expected: c.expected, predicted: c.got, confidence: 1, latencyMs: 0, inputTokens: 0 });
      const f = (perField[c.field] ??= { n: 0, equal: 0 });
      f.n += 1;
      if (c.equal) f.equal += 1;
    }
  });
  const metrics = scoreJevBench(flat);
  const items = compared.length;
  let value: number;
  if (metric === "field_accuracy") value = metrics.accuracy;
  else value = items === 0 ? 0 : allEqual / items;
  const passed = value >= threshold;
  return { metric, value: Math.round(value * 1000) / 1000, threshold, passed, items, fields: flat.length, items_all_equal: allEqual, metrics, per_field: perField, unscored };
}

/**
 * S71-AB/C: what a report calls itself. A GrokBot-label set is model-vs-model AGREEMENT, never "accuracy", and has no pass line; V's own labels are accuracy_vs_V with n stated. The
 * `accuracy` key of the scorer's metrics is renamed for the agreement set so the word cannot be read off the report.
 */
export function labelReport(set: "gold" | "grokbot_agreement" | "human_v", r: BenchReport): Record<string, unknown> {
  if (set === "gold") return { ...r, set };
  const { accuracy, ...restMetrics } = r.metrics as BenchMetrics & { accuracy: number };
  if (set === "grokbot_agreement") {
    return { ...r, set, metric: "agreement_with_grokbot", metrics: { ...restMetrics, agreement: accuracy }, threshold: null, passed: null, human_gold: false, provenance: "model_grokbot", n: r.items,
      note: "labels are the GrokBot Sentiment Analyzer's model scores, not a human verdict; agreement is not accuracy" };
  }
  return { ...r, set, metric: "accuracy_vs_V", metrics: { ...restMetrics, accuracy_vs_V: accuracy }, threshold: null, passed: null, human_gold: true, rater: "V", n: r.items, population: "in-room consults, room tape (not Meet)" };
}
