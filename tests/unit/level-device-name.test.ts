/**
 * levelDeviceName (migration 0120, Fable ruling 346, eta-refuter #2016): macOS names Continuity and Bluetooth inputs after their owner,
 * so the device name stored on every level row drops everything up to and including a LEADING possessive. Pure; the db module is
 * mocked only because lib/bench-levels imports it.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));

import { levelDeviceName } from "@/lib/bench-levels";

describe("levelDeviceName", () => {
  it("leaves a hardware name alone", () => {
    expect(levelDeviceName("C270 HD WEBCAM")).toBe("C270 HD WEBCAM");
    expect(levelDeviceName("TONOR TM20 Audio Device")).toBe("TONOR TM20 Audio Device");
    expect(levelDeviceName("Microsoft Teams Audio")).toBe("Microsoft Teams Audio");
  });

  it("drops an owner's name before a straight possessive", () => {
    expect(levelDeviceName("Priya's AirPods Pro")).toBe("AirPods Pro");
    expect(levelDeviceName("Dr. O'Brien's iPhone Microphone")).toBe("iPhone Microphone");
  });

  it("drops an owner's name before a typographic possessive (macOS writes ’)", () => {
    expect(levelDeviceName("Priya’s AirPods Pro")).toBe("AirPods Pro");
  });

  it("is null for nothing, for a non-string, and for a name that was only a possessive", () => {
    expect(levelDeviceName(null)).toBeNull();
    expect(levelDeviceName(undefined)).toBeNull();
    expect(levelDeviceName("")).toBeNull();
    expect(levelDeviceName("   ")).toBeNull();
    expect(levelDeviceName("Priya's ")).toBeNull();
    expect(levelDeviceName(42 as unknown as string)).toBeNull();
  });
});
