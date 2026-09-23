/**
 * lib/jev/counters.ts — J-CORE-1: cost and latency counters, aggregated across calls.
 *
 * The load-bearing invariant this file pins: the sum of every byQuestion[...].inputTokens must
 * equal overall.inputTokens (tokens are apportioned evenly across a fanned-out call's questions,
 * never credited whole to each), while byQuestion[...].latencyMsTotal is NOT constrained to sum
 * to overall.latencyMsTotal — every question in one call shares its full latency by design.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { _resetJevCountersForTests, jevCounterSnapshot, JEV_INPUT_TOKEN_COST_USD, recordJevBatchCall } from "@/lib/jev/counters";

beforeEach(() => {
  _resetJevCountersForTests();
});

describe("recordJevBatchCall — a single-question call", () => {
  it("credits the full call to both overall and the one question", () => {
    recordJevBatchCall({ questionIds: ["q1"], inputTokens: 100, outputTokens: 10, latencyMs: 50 });
    const snap = jevCounterSnapshot();
    expect(snap.calls).toBe(1);
    expect(snap.inputTokens).toBe(100);
    expect(snap.outputTokens).toBe(10);
    expect(snap.latencyMsTotal).toBe(50);
    expect(snap.latencyMsAvg).toBe(50);
    expect(snap.byQuestion.q1).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 10, latencyMsAvg: 50 });
  });

  it("estimatedCostUsd is inputTokens * JEV_INPUT_TOKEN_COST_USD, at both levels", () => {
    recordJevBatchCall({ questionIds: ["q1"], inputTokens: 1_000_000, outputTokens: 0, latencyMs: 1 });
    const snap = jevCounterSnapshot();
    expect(snap.estimatedCostUsd).toBeCloseTo(1_000_000 * JEV_INPUT_TOKEN_COST_USD);
    expect(snap.byQuestion.q1!.estimatedCostUsd).toBeCloseTo(1_000_000 * JEV_INPUT_TOKEN_COST_USD);
  });
});

describe("recordJevBatchCall — a fanned-out call with several questions", () => {
  it("apportions tokens EVENLY across questions — byQuestion sums to the true overall total, never a multiple of it", () => {
    recordJevBatchCall({ questionIds: ["q1", "q2", "q3", "q4"], inputTokens: 400, outputTokens: 40, latencyMs: 60 });
    const snap = jevCounterSnapshot();
    expect(snap.inputTokens).toBe(400); // the true total, counted once
    const summedByQuestion = Object.values(snap.byQuestion).reduce((sum, q) => sum + q.inputTokens, 0);
    expect(summedByQuestion).toBeCloseTo(400); // NOT 1600 (400 credited whole to all four)
    for (const q of Object.values(snap.byQuestion)) expect(q.inputTokens).toBeCloseTo(100);
  });

  it("does NOT split latency — every question in the call gets the FULL call latency, on purpose", () => {
    recordJevBatchCall({ questionIds: ["q1", "q2"], inputTokens: 200, outputTokens: 0, latencyMs: 90 });
    const snap = jevCounterSnapshot();
    expect(snap.byQuestion.q1!.latencyMsAvg).toBe(90);
    expect(snap.byQuestion.q2!.latencyMsAvg).toBe(90);
    // overall counts the call once; the two questions' full-latency credits are not summed into it
    expect(snap.latencyMsTotal).toBe(90);
  });

  it("a question appearing across MULTIPLE calls accumulates correctly, and its avg divides by ITS OWN call count", () => {
    recordJevBatchCall({ questionIds: ["q1", "q2"], inputTokens: 100, outputTokens: 0, latencyMs: 40 }); // q1 gets 50, 1 call
    recordJevBatchCall({ questionIds: ["q1"], inputTokens: 60, outputTokens: 0, latencyMs: 20 }); // q1 gets 60, 1 more call
    const snap = jevCounterSnapshot();
    expect(snap.byQuestion.q1!.calls).toBe(2);
    expect(snap.byQuestion.q1!.inputTokens).toBeCloseTo(50 + 60);
    expect(snap.byQuestion.q1!.latencyMsAvg).toBeCloseTo((40 + 20) / 2);
    expect(snap.byQuestion.q2!.calls).toBe(1);
  });

  it("an empty questionIds array still counts the call at the overall level, credits no question", () => {
    recordJevBatchCall({ questionIds: [], inputTokens: 10, outputTokens: 1, latencyMs: 5 });
    const snap = jevCounterSnapshot();
    expect(snap.calls).toBe(1);
    expect(snap.inputTokens).toBe(10);
    expect(Object.keys(snap.byQuestion)).toHaveLength(0);
  });
});

describe("_resetJevCountersForTests", () => {
  it("clears both overall and byQuestion", () => {
    recordJevBatchCall({ questionIds: ["q1"], inputTokens: 100, outputTokens: 10, latencyMs: 50 });
    _resetJevCountersForTests();
    const snap = jevCounterSnapshot();
    expect(snap.calls).toBe(0);
    expect(snap.inputTokens).toBe(0);
    expect(Object.keys(snap.byQuestion)).toHaveLength(0);
  });
});
