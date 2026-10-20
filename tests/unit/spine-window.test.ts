import { describe, it, expect } from "vitest";
import { kLaneBlockedNow, istSecondOfHour, hourlyWindowMin } from "@/lib/spine/window";

const ist = (hhmmss: string) => { const [h, m, s] = hhmmss.split(":").map(Number); return new Date(Date.UTC(2026, 9, 20, h! - 5, m! - 30, s!)); };

describe("lib/spine/window", () => {
  it("IST second of the hour", () => { expect(istSecondOfHour(ist("11:25:30"))).toBe(25 * 60 + 30); expect(istSecondOfHour(new Date(Date.UTC(2026, 9, 20, 0, 0, 0)))).toBe(30 * 60); });
  it.each([["11:19:59", false], ["11:20:00", true], ["11:24:59", true], ["11:25:00", true], ["11:44:59", true], ["11:45:00", false], ["11:59:59", false], ["12:00:00", false]] as const)("%s blocked=%s", (t, b) => { expect(kLaneBlockedNow(ist(t), {})).toBe(b); });
  it("R4: the server window reads the box's env (SPINE_HOURLY_FROM_MIN / _TO_MIN), with the box's fallbacks", () => {
    expect(hourlyWindowMin({})).toEqual([25, 45]);
    expect(hourlyWindowMin({ SPINE_HOURLY_FROM_MIN: "10", SPINE_HOURLY_TO_MIN: "30" })).toEqual([10, 30]);
    expect(hourlyWindowMin({ SPINE_HOURLY_FROM_MIN: "30", SPINE_HOURLY_TO_MIN: "30" })).toEqual([25, 45]);
    expect(hourlyWindowMin({ SPINE_HOURLY_FROM_MIN: "45", SPINE_HOURLY_TO_MIN: "25" })).toEqual([25, 45]);
    expect(hourlyWindowMin({ SPINE_HOURLY_FROM_MIN: "x", SPINE_HOURLY_TO_MIN: "99" })).toEqual([25, 45]);
    expect(hourlyWindowMin({ SPINE_HOURLY_FROM_MIN: "10", SPINE_HOURLY_TO_MIN: "99" })).toEqual([10, 45]);
    const env = { SPINE_HOURLY_FROM_MIN: "10", SPINE_HOURLY_TO_MIN: "30" };
    expect(kLaneBlockedNow(ist("11:04:59"), env)).toBe(false);
    expect(kLaneBlockedNow(ist("11:05:00"), env)).toBe(true);
    expect(kLaneBlockedNow(ist("11:29:59"), env)).toBe(true);
    expect(kLaneBlockedNow(ist("11:30:00"), env)).toBe(false);
  });
});
