import { describe, it, expect } from "vitest";
import { decayWeight, daysBetween, WINDOW_DAYS } from "../decay";

describe("decayWeight", () => {
  it("returns 1.0 at 0 days old", () => {
    expect(decayWeight(0)).toBe(1);
  });

  it("returns 0.5 at half-window (90 days)", () => {
    expect(decayWeight(90)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 at the window boundary (180 days)", () => {
    expect(decayWeight(180)).toBe(0);
  });

  it("returns 0 beyond the window (200 days)", () => {
    expect(decayWeight(200)).toBe(0);
  });

  it("treats negative days_old as today (clamped to 1.0)", () => {
    expect(decayWeight(-5)).toBe(1);
  });

  it("decays linearly at 45 days", () => {
    expect(decayWeight(45)).toBeCloseTo(0.75, 5);
  });

  it("WINDOW_DAYS is 180", () => {
    expect(WINDOW_DAYS).toBe(180);
  });
});

describe("daysBetween", () => {
  it("returns positive difference for past → future", () => {
    expect(daysBetween("2026-04-01", "2026-04-30")).toBe(29);
  });

  it("returns negative for future → past", () => {
    expect(daysBetween("2026-04-30", "2026-04-01")).toBe(-29);
  });

  it("ignores time-of-day (UTC midnight anchor)", () => {
    expect(daysBetween("2026-04-01", "2026-04-02")).toBe(1);
  });

  it("handles month boundaries correctly", () => {
    expect(daysBetween("2026-03-30", "2026-04-02")).toBe(3);
  });

  it("accepts Date objects", () => {
    const a = new Date("2026-04-01T00:00:00Z");
    const b = new Date("2026-04-08T00:00:00Z");
    expect(daysBetween(a, b)).toBe(7);
  });
});
