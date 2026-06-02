/**
 * Pure, unit-testable platform detection. Kept free of `navigator` access so
 * the core logic can be tested directly; `detectIOS()` is the thin runtime
 * wrapper used by client components.
 *
 * iOS/WebKit matters because MediaRecorder + a WebAudio worklet can't share
 * one mic track there (B18), and Private Browsing disables IndexedDB.
 */
export function isIOSUserAgent(ua: string, platform = "", maxTouchPoints = 0): boolean {
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as desktop Mac but has a touchscreen.
  return platform === "MacIntel" && maxTouchPoints > 1;
}

export function detectIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return isIOSUserAgent(navigator.userAgent || "", navigator.platform || "", navigator.maxTouchPoints || 0);
}
