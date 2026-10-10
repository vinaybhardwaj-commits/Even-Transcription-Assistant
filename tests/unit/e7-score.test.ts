/** E-7 scoring core (epic #23 h): the match rule at its edges, every metric, per room, control, coverage. Intervals synthetic. */
import { describe, it, expect } from "vitest";
import { matches, percentile, scoreArm, scoreByRoom, shiftedAnchorControl, coverageReport, overlapMs } from "@/lib/encounter-clock/e7-score";

const M = 60_000;
const iv = (a: number, b: number, room?: string) => ({ start_ms: a * M, end_ms: b * M, ...(room ? { room_id: room } : {}) });

describe("match rule", () => {
  it("half of the SHORTER interval, inclusive", () => {
    expect(matches(iv(0, 10), iv(5, 15))).toBe(true);       // overlap 5 = 50 % of 10
    expect(matches(iv(0, 10), { start_ms: 5 * M + 1, end_ms: 15 * M })).toBe(false);
    expect(matches(iv(0, 60), iv(10, 14))).toBe(true);      // the short one lies inside
  });
  it("empty and disjoint intervals never match", () => {
    expect(matches(iv(0, 0), iv(0, 10))).toBe(false);
    expect(matches(iv(0, 5), iv(5, 10))).toBe(false);
    expect(overlapMs(iv(0, 5), iv(5, 10))).toBe(0);
  });
});

describe("scoreArm", () => {
  it("recall, precision, splits, merges and errors", () => {
    const truth = [iv(0, 10), iv(20, 30), iv(40, 50)];
    const hyp = [iv(1, 9), iv(21, 24), iv(25, 31), iv(60, 70)];
    const s = scoreArm(truth, hyp);
    expect(s).toMatchObject({ truth: 3, hypotheses: 4, recalled: 2, precise: 3, splits: 1, merges: 0 });
    expect(s.recall).toBeCloseTo(2 / 3);
    expect(s.precision).toBeCloseTo(3 / 4);
    expect(s.start_error.n).toBe(2);
    expect(s.start_error.median_ms).toBe(M);   // errors 1 min and 1 min
  });
  it("a merge: one hypothesis spanning two truths", () => {
    expect(scoreArm([iv(0, 10), iv(11, 21)], [iv(0, 21)]).merges).toBe(1);
  });
  it("no truth or no hypotheses gives null rates, never a divide by zero", () => {
    expect(scoreArm([], [iv(0, 1)])).toMatchObject({ recall: null, precision: 0 });
    expect(scoreArm([iv(0, 1)], [])).toMatchObject({ recall: 0, precision: null });
  });
  it("end error is broken out for consults with a missing End click only", () => {
    const truth = [{ ...iv(0, 10), end_clicked: false }, { ...iv(20, 30), end_clicked: true }, iv(40, 50)];
    const s = scoreArm(truth, [iv(0, 14), iv(20, 31), iv(40, 52)]);
    expect(s.end_error.n).toBe(3);
    expect(s.end_error_missing_end).toEqual({ n: 1, median_ms: 4 * M, p90_ms: 4 * M });
  });
  it("the best match is the largest overlap", () => {
    const s = scoreArm([iv(0, 10)], [iv(0, 3), iv(2, 11)]);
    expect(s.end_error.median_ms).toBe(M);
  });
});

describe("percentile", () => {
  it("nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.5)).toBe(5);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("per room and the shifted-anchor control", () => {
  it("scores each room separately", () => {
    const { pooled, rooms } = scoreByRoom([iv(0, 10, "a"), iv(0, 10, "b")], [iv(0, 10, "a"), iv(50, 60, "b")]);
    expect(rooms.a!.recall).toBe(1);
    expect(rooms.b!.recall).toBe(0);
    expect(pooled.recall).toBe(0.5);
  });
  it("an arm that uses the anchors collapses when they are shifted 10 minutes; one that ignores them does not", () => {
    const truth = [iv(0, 10), iv(30, 40)];
    const anchored = (shift: number) => truth.map((t) => ({ start_ms: t.start_ms + shift, end_ms: t.end_ms + shift }));
    const c = shiftedAnchorControl(truth, anchored);
    expect(c.base.recall).toBe(1);
    expect(c.plus.recall).toBe(0);
    expect(c.minus.recall).toBe(0);
    const blind = shiftedAnchorControl(truth, () => truth);
    expect([blind.base.recall, blind.plus.recall, blind.minus.recall]).toEqual([1, 1, 1]);
  });
});

describe("coverageReport", () => {
  it("counts close kinds, clicks, and PQM consults with no Pulse window", () => {
    const anchors = [
      { ...iv(0, 10, "a"), close_kind: "clicked_end", end_clicked: true },
      { ...iv(20, 30, "a"), close_kind: "url_clear", end_clicked: false },
      { ...iv(40, 50, "b"), close_kind: "url_clear", end_clicked: false },
    ];
    const c = coverageReport(anchors, [iv(1, 9, "a"), iv(21, 29, "a"), iv(100, 110, "a"), iv(41, 49, "a")]);
    expect(c.by_close_kind).toEqual({ clicked_end: 1, url_clear: 2 });
    expect(c.by_end_clicked).toEqual({ clicked: 1, not_clicked: 2 });
    expect(c.pqm_without_start).toBe(2);              // 100–110 has none; 41–49 is room "a" but the window is room "b"
    expect(c.pqm_with_pulse_window_share).toBe(0.5);
  });
});
