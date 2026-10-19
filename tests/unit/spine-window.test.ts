import { describe, it, expect } from "vitest";
import { kLaneBlockedNow, istSecondOfHour } from "@/lib/spine/window";

const ist = (hhmmss: string) => { const [h, m, s] = hhmmss.split(":").map(Number); return new Date(Date.UTC(2026, 9, 20, h! - 5, m! - 30, s!)); };

describe("lib/spine/window", () => {
  it("IST second of the hour", () => { expect(istSecondOfHour(ist("11:25:30"))).toBe(25 * 60 + 30); expect(istSecondOfHour(new Date(Date.UTC(2026, 9, 20, 0, 0, 0)))).toBe(30 * 60); });
  it.each([["11:19:59", false], ["11:20:00", true], ["11:24:59", true], ["11:25:00", true], ["11:44:59", true], ["11:45:00", false], ["11:59:59", false], ["12:00:00", false]] as const)("%s blocked=%s", (t, b) => { expect(kLaneBlockedNow(ist(t))).toBe(b); });
});
