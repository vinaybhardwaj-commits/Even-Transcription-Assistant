/** Calibration acts on fitted precision, not on a raw confidence and not on 0.9. */
import { describe, expect, it } from "vitest";
import { calibratedP, emptyCalibration, fitCalibration, jevActs } from "@/lib/encounter-clock/timeline-calibration";

describe("fitCalibration", () => {
  it("a raw 0.95 that was usually wrong does not act: an inverted map is pooled and nothing clears the target", () => {
    const cal = fitCalibration([
      { raw: 0.1, correct: true }, { raw: 0.1, correct: true }, { raw: 0.1, correct: true }, { raw: 0.1, correct: true },
      { raw: 0.95, correct: false }, { raw: 0.95, correct: false }, { raw: 0.95, correct: false }, { raw: 0.95, correct: false },
    ]);
    expect(cal.method).toBe("isotonic");
    expect(cal.act_at).toBeNull();
    expect(jevActs(0.95, cal)).toBe(false);
    expect(jevActs(0.1, cal)).toBe(false);
    expect(calibratedP(0.95, cal)).toBeLessThan(0.8);
  });

  it("a lower raw acts when its bin is precise, and a raw in an imprecise bin does not", () => {
    const preciseLow = fitCalibration(Array.from({ length: 8 }, () => ({ raw: 0.4, correct: true })));
    expect(jevActs(0.4, preciseLow)).toBe(true);
    expect(jevActs(0.95, preciseLow)).toBe(true);
    const imprecise = fitCalibration([
      ...Array.from({ length: 8 }, () => ({ raw: 0.3, correct: false })),
      ...Array.from({ length: 8 }, () => ({ raw: 0.95, correct: true })),
    ]);
    expect(jevActs(0.3, imprecise)).toBe(false);
    expect(jevActs(0.95, imprecise)).toBe(true);
  });

  it("no fit, too few pairs, or a raw outside [0, 1] never acts", () => {
    expect(jevActs(0.95, emptyCalibration())).toBe(false);
    expect(jevActs(0.95, null)).toBe(false);
    expect(calibratedP(0.95, emptyCalibration())).toBeNull();
    const thin = fitCalibration(Array.from({ length: 7 }, () => ({ raw: 0.95, correct: true })));
    expect(thin.method).toBe("none");
    expect(jevActs(0.95, thin)).toBe(false);
    const dirty = fitCalibration([
      ...Array.from({ length: 8 }, () => ({ raw: 0.5, correct: true })),
      { raw: 2, correct: true }, { raw: -1, correct: false },
    ]);
    expect(dirty.method).toBe("isotonic");
  });

  it("a fit where every bin was right can act below 0.9", () => {
    const cal = fitCalibration(Array.from({ length: 8 }, (_, i) => ({ raw: (i + 1) / 10, correct: true })));
    expect(jevActs(0.2, cal)).toBe(true);
    expect(jevActs(0.95, cal)).toBe(true);
  });
});
