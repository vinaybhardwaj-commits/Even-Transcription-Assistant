import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fitCalibration, jevActs, type CalPair } from "@/lib/encounter-clock/timeline-calibration";
import { LEAVE_CALIBRATION, LEAVE_CALIBRATION_META } from "@/lib/encounter-clock/timeline-calibration-fit";

const pairs = JSON.parse(readFileSync("tests/fixtures/timeline-leave-calibration-pairs.json", "utf8")) as CalPair[];

describe("LEAVE_CALIBRATION (stored fit)", () => {
  it("is exactly fitCalibration of its stored pairs", () => {
    expect(fitCalibration(pairs)).toEqual(LEAVE_CALIBRATION);
  });

  it("the pairs file holds only raw + correct, and matches the recorded counts", () => {
    expect(pairs).toHaveLength(LEAVE_CALIBRATION_META.pairs);
    expect(pairs.filter((p) => p.correct)).toHaveLength(LEAVE_CALIBRATION_META.correct);
    for (const p of pairs) expect(Object.keys(p).sort()).toEqual(["correct", "raw"]);
  });

  it("is isotonic with monotone bins and lets Jev act", () => {
    expect(LEAVE_CALIBRATION.method).toBe("isotonic");
    const ps = LEAVE_CALIBRATION.bins.map((b) => b.p);
    expect([...ps].sort((a, b) => a - b)).toEqual(ps);
    expect(LEAVE_CALIBRATION.act_at).not.toBeNull();
    expect(jevActs(0.9, LEAVE_CALIBRATION)).toBe(true);
    expect(jevActs(null, LEAVE_CALIBRATION)).toBe(false);
  });
});
