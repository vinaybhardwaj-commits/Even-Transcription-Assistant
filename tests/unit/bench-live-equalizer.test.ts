import { describe, expect, it } from "vitest";
import { isDigitalSilence } from "@/components/admin/bench-live/BenchLevelMeter";
import { isIsoDate } from "@/lib/bench-levels";

describe("Bench Live Equalizer", () => {
  it("uses reported zero ratio or the existing room fact for digital silence", () => {
    expect(isDigitalSilence({ peak: 0.2, avg: 0.1, zero_ratio: 0.99 })).toBe(true);
    expect(isDigitalSilence({ peak: 0.2, avg: 0.1, zero_ratio: 0.2 })).toBe(false);
    expect(isDigitalSilence({ peak: 0.2, avg: 0.1 }, true)).toBe(true);
    expect(isDigitalSilence(null)).toBe(false);
  });

  it("validates timeline day parameters", () => {
    expect(isIsoDate("2026-09-22")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("22-09-2026")).toBe(false);
  });
});
