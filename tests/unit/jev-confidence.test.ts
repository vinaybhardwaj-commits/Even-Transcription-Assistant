/**
 * lib/jev/confidence.ts — J-CORE-1: the confidence-band helper (PLAN-v3.md §1 principle 4).
 */
import { describe, it, expect } from "vitest";
import { confidenceBand, DEFAULT_CONFIDENCE_THRESHOLDS, noulConfidence } from "@/lib/jev/confidence";

describe("confidenceBand — the plan's own thresholds (principle 4)", () => {
  it(">= 0.9 acts", () => {
    expect(confidenceBand(0.9)).toBe("act");
    expect(confidenceBand(1)).toBe("act");
  });

  it("[0.5, 0.9) is caution", () => {
    expect(confidenceBand(0.5)).toBe("caution");
    expect(confidenceBand(0.89)).toBe("caution");
  });

  it("< 0.5 is review", () => {
    expect(confidenceBand(0.49)).toBe("review");
    expect(confidenceBand(0)).toBe("review");
  });

  it("boundaries are inclusive on the lower edge of each band, not the upper", () => {
    // 0.9 exactly is "act" (>=), not "caution" — the plan's own wording is ">= 0.9 act".
    expect(confidenceBand(0.9)).toBe("act");
    expect(confidenceBand(0.8999999)).toBe("caution");
    expect(confidenceBand(0.5)).toBe("caution");
    expect(confidenceBand(0.4999999)).toBe("review");
  });

  it("a non-finite confidence is 'review', never 'act' — a caller that never validated the number fails toward caution", () => {
    expect(confidenceBand(NaN)).toBe("review");
    expect(confidenceBand(Infinity)).toBe("review"); // Infinity is not finite, even though Infinity >= act numerically
  });

  it("thresholds are tunable per use (plan: 'tuned per use'), overriding the defaults", () => {
    expect(confidenceBand(0.7, { act: 0.95, caution: 0.7 })).toBe("caution");
    expect(confidenceBand(0.96, { act: 0.95, caution: 0.7 })).toBe("act");
    expect(confidenceBand(0.6, { act: 0.95, caution: 0.7 })).toBe("review");
  });

  it("DEFAULT_CONFIDENCE_THRESHOLDS is exactly the plan's numbers", () => {
    expect(DEFAULT_CONFIDENCE_THRESHOLDS).toEqual({ act: 0.9, caution: 0.5 });
  });
});

describe("noulConfidence — the probability of whichever side a noul answer favours", () => {
  it("a high noul (favouring true) is its own value", () => {
    expect(noulConfidence(0.85)).toBeCloseTo(0.85);
  });

  it("a low noul (favouring false) is 1 minus it — equally decisive, opposite direction", () => {
    expect(noulConfidence(0.15)).toBeCloseTo(0.85);
  });

  it("exactly 0.5 is maximally undecided: confidence 0.5 either way", () => {
    expect(noulConfidence(0.5)).toBeCloseTo(0.5);
  });

  it("0 and 1 are both fully confident", () => {
    expect(noulConfidence(0)).toBeCloseTo(1);
    expect(noulConfidence(1)).toBeCloseTo(1);
  });

  it("a non-finite noul is 0 confidence, not NaN propagating silently", () => {
    expect(noulConfidence(NaN)).toBe(0);
  });
});
