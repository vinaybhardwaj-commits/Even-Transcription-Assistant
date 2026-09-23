/**
 * lib/jev/bench.ts — J-CORE-3: labelled set in, recall/precision/ECE/cost/latency out.
 */
import { describe, it, expect } from "vitest";
import { calibrationBins, classMetrics, formatJevBenchReport, scoreJevBench, type BenchItem } from "@/lib/jev/bench";
import { JEV_INPUT_TOKEN_COST_USD } from "@/lib/jev/counters";

const item = (overrides: Partial<BenchItem>): BenchItem => ({
  subjectId: "s1",
  expected: "a",
  predicted: "a",
  confidence: 0.9,
  latencyMs: 100,
  inputTokens: 50,
  ...overrides,
});

describe("classMetrics — per-class recall/precision and their macro average", () => {
  it("perfect predictions: recall and precision are 1 for every class", () => {
    const items = [item({ expected: "a", predicted: "a" }), item({ expected: "b", predicted: "b" })];
    const m = classMetrics(items);
    expect(m.recall).toEqual({ a: 1, b: 1 });
    expect(m.precision).toEqual({ a: 1, b: 1 });
    expect(m.macroRecall).toBeCloseTo(1);
    expect(m.macroPrecision).toBeCloseTo(1);
  });

  it("a class that is never predicted has recall 0 but no precision entry (never punished for something it was never asked)", () => {
    const items = [item({ expected: "a", predicted: "b" })]; // a exists as truth, never predicted; b predicted, never truth
    const m = classMetrics(items);
    expect(m.recall.a).toBe(0); // a was the truth once, never correctly found
    expect(m.precision.a).toBeUndefined(); // a was never predicted at all
    expect(m.precision.b).toBe(0); // b was predicted once, and it was wrong
    expect(m.recall.b).toBeUndefined(); // b was never the ground truth
  });

  it("known worked example: 2 classes, one confusion", () => {
    // truth: a,a,b,b ; predicted: a,b,b,b
    const items = [
      item({ expected: "a", predicted: "a" }),
      item({ expected: "a", predicted: "b" }),
      item({ expected: "b", predicted: "b" }),
      item({ expected: "b", predicted: "b" }),
    ];
    const m = classMetrics(items);
    expect(m.recall.a).toBeCloseTo(0.5); // 1 of 2 "a" truths found
    expect(m.precision.a).toBeCloseTo(1); // every predicted "a" was correct (only 1, and it was right)
    expect(m.recall.b).toBeCloseTo(1); // both "b" truths found
    expect(m.precision.b).toBeCloseTo(2 / 3); // 3 predicted "b", 2 correct
  });

  it("empty input has no classes and 0 macro averages, not NaN", () => {
    const m = classMetrics([]);
    expect(m.recall).toEqual({});
    expect(m.macroRecall).toBe(0);
    expect(m.macroPrecision).toBe(0);
  });
});

describe("calibrationBins / ECE", () => {
  it("a known worked example: one bin, half right at 0.55 confidence -> ECE is exactly the gap", () => {
    // Both land in [0.5, 0.6): 1 of 2 correct -> accuracy 0.5, avgConfidence 0.55, gap 0.05, full
    // weight (100% of the items are in this one bin) -> ECE = 1 * |0.5 - 0.55| = 0.05.
    const items = [
      item({ confidence: 0.55, expected: "a", predicted: "a" }),
      item({ confidence: 0.55, expected: "a", predicted: "b" }),
    ];
    const { ece } = calibrationBins(items);
    expect(ece).toBeCloseTo(0.05);
  });

  it("ECE is WEIGHTED by bin population, not a plain average of the bins' gaps", () => {
    // A populous, mildly-miscalibrated bin (8 items, gap 0.35) must dominate a sparse, well-off
    // bin (2 items, gap 0.05) — a plain sum/average of gaps would treat them equally and get this
    // wrong. weighted = 0.8*0.35 + 0.2*0.05 = 0.29; an unweighted sum of the two gaps is 0.40.
    const lowBin = Array.from({ length: 8 }, (_, i) => item({ confidence: 0.15, expected: "a", predicted: i < 4 ? "a" : "b" }));
    const highBin = [item({ confidence: 0.95, expected: "a", predicted: "a" }), item({ confidence: 0.95, expected: "a", predicted: "a" })];
    const { ece } = calibrationBins([...lowBin, ...highBin]);
    expect(ece).toBeCloseTo(0.29);
  });

  it("badly miscalibrated: high confidence, all wrong -> large ECE", () => {
    const items = [item({ confidence: 0.95, expected: "a", predicted: "b" }), item({ confidence: 0.95, expected: "a", predicted: "b" })];
    const { ece } = calibrationBins(items);
    expect(ece).toBeCloseTo(0.95); // accuracy 0, confidence 0.95, gap 0.95, full weight (all items in one bin)
  });

  it("bins partition [0,1] into binCount equal-width ranges, and the LAST bin includes confidence 1.0", () => {
    const items = [item({ confidence: 1.0, expected: "a", predicted: "a" })];
    const { bins } = calibrationBins(items, 10);
    expect(bins).toHaveLength(10);
    expect(bins[9]!.range).toEqual([0.9, 1]);
    expect(bins[9]!.count).toBe(1); // confidence 1.0 lands in the last bin, not dropped as out-of-range
  });

  it("an empty bin reports count 0, accuracy 0, avgConfidence 0 — never NaN from a 0/0 division", () => {
    const { bins } = calibrationBins([item({ confidence: 0.95 })], 10);
    expect(bins[0]).toEqual({ range: [0, 0.1], count: 0, accuracy: 0, avgConfidence: 0 });
  });

  it("empty input is ECE 0, not NaN", () => {
    expect(calibrationBins([]).ece).toBe(0);
  });
});

describe("scoreJevBench — the whole shape, same for every use", () => {
  it("accuracy is the fraction of items where expected === predicted", () => {
    const items = [item({ expected: "a", predicted: "a" }), item({ expected: "a", predicted: "b" }), item({ expected: "b", predicted: "b" })];
    expect(scoreJevBench(items).accuracy).toBeCloseTo(2 / 3);
  });

  it("cost sums inputTokens across every item and prices them at the shared rate", () => {
    const items = [item({ inputTokens: 100 }), item({ inputTokens: 300 })];
    const m = scoreJevBench(items);
    expect(m.cost.totalInputTokens).toBe(400);
    expect(m.cost.estimatedCostUsd).toBeCloseTo(400 * JEV_INPUT_TOKEN_COST_USD);
  });

  it("latency reports avg, p50 and p95 over the item set", () => {
    const items = [10, 20, 30, 40, 50].map((ms) => item({ latencyMs: ms }));
    const m = scoreJevBench(items);
    expect(m.latency.avgMs).toBeCloseTo(30);
    expect(m.latency.p50Ms).toBe(30);
    expect(m.latency.p95Ms).toBe(50);
  });

  it("n is the item count, including 0 for an empty labelled set", () => {
    expect(scoreJevBench([]).n).toBe(0);
    expect(scoreJevBench([item({})]).n).toBe(1);
  });

  it("is pure — two calls over the same input are byte-identical", () => {
    const items = [item({}), item({ expected: "b", predicted: "b" })];
    expect(JSON.stringify(scoreJevBench(items))).toBe(JSON.stringify(scoreJevBench(items)));
  });
});

describe("formatJevBenchReport — the markdown block, same shape for every use", () => {
  it("names the use, the question, the prompt_version and the date, and carries every metric", () => {
    const metrics = scoreJevBench([item({ expected: "a", predicted: "a" }), item({ expected: "b", predicted: "a" })]);
    const report = formatJevBenchReport({ use: "U1 consult phase", questionId: "phase", promptVersion: "jev-arm-d-v1", metrics, date: "2026-09-23" });
    expect(report).toContain("U1 consult phase");
    expect(report).toContain("phase@jev-arm-d-v1");
    expect(report).toContain("2026-09-23");
    expect(report).toContain("n=2");
    expect(report).toMatch(/ECE=\d+\.\d{3}/);
    expect(report).toMatch(/input tokens/);
    expect(report).toMatch(/latency: avg/);
  });

  it("defaults the date to today when none is given", () => {
    const metrics = scoreJevBench([item({})]);
    const report = formatJevBenchReport({ use: "x", questionId: "q", promptVersion: "v1", metrics });
    const today = new Date().toISOString().slice(0, 10);
    expect(report).toContain(today);
  });
});
