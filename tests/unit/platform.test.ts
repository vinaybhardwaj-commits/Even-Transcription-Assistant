import { describe, it, expect } from "vitest";
import { isIOSUserAgent, isDesktopSafariUserAgent } from "../../lib/platform";

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

const SAFARI_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const CHROME_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("isDesktopSafariUserAgent", () => {
  it("detects desktop Safari on macOS", () => {
    expect(isDesktopSafariUserAgent(SAFARI_DESKTOP)).toBe(true);
  });
  it("does NOT flag Chrome (which also carries 'Safari' in its UA)", () => {
    expect(isDesktopSafariUserAgent(CHROME_DESKTOP)).toBe(false);
  });
  it("does NOT flag iOS Safari (handled by isIOSUserAgent instead)", () => {
    expect(isDesktopSafariUserAgent(IPHONE_SAFARI)).toBe(false);
  });
  it("does NOT flag iPadOS-as-desktop with touch", () => {
    expect(isDesktopSafariUserAgent(SAFARI_DESKTOP, "MacIntel", 5)).toBe(false);
  });
});
