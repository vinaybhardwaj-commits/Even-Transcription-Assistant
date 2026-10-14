import { describe, it, expect } from "vitest";
import {
  composeScore,
  classifyTier,
  lowConfidenceFlag,
  LOW_CONFIDENCE_OBS_THRESHOLD,
} from "../compose";
import { ComponentResult, Weights } from "../types";

const w333: Weights = { caseload_pct: 33, outcomes_pct: 34, adherence_pct: 33 };

function mkComp(score: number | null): ComponentResult {
  return { score, streams: [], scoreable_stream_count: 0 };
}

describe("composeScore — all three components scoreable", () => {
  it("equal weights, equal scores → that score", () => {
    const c = mkComp(80);
    const o = mkComp(80);
    const a = mkComp(80);
    expect(composeScore(c, o, a, w333)).toBeCloseTo(80, 5);
  });

  it("weighted sum at 33/34/33", () => {
    const c = mkComp(60);
    const o = mkComp(80);
    const a = mkComp(40);
    // (60*33 + 80*34 + 40*33) / 100 = (1980 + 2720 + 1320) / 100 = 60.2
    expect(composeScore(c, o, a, w333)).toBeCloseTo(60.2, 5);
  });
});

describe("composeScore — renormalization with insufficient-data components", () => {
  it("drops one null component and renormalizes weights", () => {
    const c = mkComp(60);
    const o = mkComp(null); // dropped
    const a = mkComp(40);
    // Effective: (60*33 + 40*33) / (33 + 33) = 50
    expect(composeScore(c, o, a, w333)).toBeCloseTo(50, 5);
  });

  it("composite from caseload alone", () => {
    const c = mkComp(72);
    const o = mkComp(null);
    const a = mkComp(null);
    expect(composeScore(c, o, a, w333)).toBe(72);
  });

  it("returns 0 when all three components are null", () => {
    expect(composeScore(mkComp(null), mkComp(null), mkComp(null), w333)).toBe(0);
  });
});

describe("classifyTier — boundary values (PRD §6.3)", () => {
  it("composite ≥ 75 → distinguished", () => {
    expect(classifyTier(75, true)).toBe("distinguished");
    expect(classifyTier(99.9, true)).toBe("distinguished");
  });
  it("60 ≤ composite < 75 → standard", () => {
    expect(classifyTier(60, true)).toBe("standard");
    expect(classifyTier(74.99, true)).toBe("standard");
  });
  it("45 ≤ composite < 60 → watch", () => {
    expect(classifyTier(45, true)).toBe("watch");
    expect(classifyTier(59.99, true)).toBe("watch");
  });
  it("30 ≤ composite < 45 → pip", () => {
    expect(classifyTier(30, true)).toBe("pip");
    expect(classifyTier(44.99, true)).toBe("pip");
  });
  it("composite < 30 → suspension_review", () => {
    expect(classifyTier(0, true)).toBe("suspension_review");
    expect(classifyTier(29.99, true)).toBe("suspension_review");
  });
  it("zero cases in window → no_recent_activity regardless of composite", () => {
    expect(classifyTier(85, false)).toBe("no_recent_activity");
    expect(classifyTier(0, false)).toBe("no_recent_activity");
  });
});

describe("lowConfidenceFlag", () => {
  it("threshold is 30", () => {
    expect(LOW_CONFIDENCE_OBS_THRESHOLD).toBe(30);
  });
  it("returns true when below threshold", () => {
    expect(lowConfidenceFlag(0)).toBe(true);
    expect(lowConfidenceFlag(29)).toBe(true);
  });
  it("returns false at or above threshold", () => {
    expect(lowConfidenceFlag(30)).toBe(false);
    expect(lowConfidenceFlag(100)).toBe(false);
  });
});
