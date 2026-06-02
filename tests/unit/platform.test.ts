import { describe, it, expect } from "vitest";
import { isIOSUserAgent } from "../../lib/platform";

describe("isIOSUserAgent", () => {
  it("detects iPhone / iPad / iPod", () => {
    expect(isIOSUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari")).toBe(true);
    expect(isIOSUserAgent("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)")).toBe(true);
    expect(isIOSUserAgent("Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)")).toBe(true);
  });
  it("detects iPadOS 13+ masquerading as desktop Mac with touch", () => {
    expect(isIOSUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "MacIntel", 5)).toBe(true);
  });
  it("does NOT flag desktop Mac without touch, Android, Windows", () => {
    expect(isIOSUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "MacIntel", 0)).toBe(false);
    expect(isIOSUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel)")).toBe(false);
    expect(isIOSUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
  });
});
