import { describe, it, expect } from "vitest";
import { boundedWindowStart, MAX_WINDOW_BYTES } from "../../lib/live-window";

// Bytes actually sent for a chosen window: header (only when effStart > 0) plus
// every included chunk. Mirrors what the hook builds: [header?] + chunks[eff..end].
function windowBytes(chunkSizes: number[], effStart: number, base: number, headerSize: number) {
  const header = effStart > 0 ? headerSize : 0;
  let sum = header;
  for (let i = effStart; i < base + chunkSizes.length; i++) sum += chunkSizes[i - base] ?? 0;
  return sum;
}

describe("boundedWindowStart — Sarvam live window byte cap (B22 http_413 regression)", () => {
  it("keeps the window under MAX_WINDOW_BYTES no matter how many chunks accumulate", () => {
    // 2000 chunks × 50KB = 100MB buffered, watermark never advanced (the wedge
    // scenario): the window must still be capped, not the whole 100MB.
    const sizes = Array(2000).fill(50_000);
    const eff = boundedWindowStart(sizes, 0, 0, 0, MAX_WINDOW_BYTES);
    const bytes = windowBytes(sizes, eff, 0, 0);
    expect(bytes).toBeLessThanOrEqual(MAX_WINDOW_BYTES);
    expect(eff).toBeGreaterThan(0);          // it slid the start forward
    expect(eff).toBeLessThan(2000);          // but kept the recent tail
  });

  it("does not slide when the whole span already fits", () => {
    const sizes = Array(40).fill(20_000); // 800KB < 3.5MB
    const eff = boundedWindowStart(sizes, 0, 0, 0, MAX_WINDOW_BYTES);
    expect(eff).toBe(0); // no forced advance
    expect(windowBytes(sizes, eff, 0, 0)).toBeLessThanOrEqual(MAX_WINDOW_BYTES);
  });

  it("counts the prepended header against the budget when start > 0", () => {
    // start=10 (10 committed chunks), header is large; only the newest chunks
    // that fit alongside the header are kept.
    const sizes = Array(100).fill(50_000); // base 0, indices 0..99
    const headerSize = 1_000_000;
    const eff = boundedWindowStart(sizes, 10, 0, headerSize, MAX_WINDOW_BYTES);
    expect(eff).toBeGreaterThanOrEqual(10);
    expect(windowBytes(sizes, eff, 0, headerSize)).toBeLessThanOrEqual(MAX_WINDOW_BYTES);
  });

  it("always keeps at least the newest chunk even if it alone exceeds the cap", () => {
    const sizes = [6_000_000]; // a single 6MB chunk, over the 3.5MB cap
    const eff = boundedWindowStart(sizes, 0, 0, 0, MAX_WINDOW_BYTES);
    expect(eff).toBe(0); // can't drop the only chunk; send it and let the server 413 once, not forever
  });

  it("respects a front-trim offset (base > 0, TRIM_LIVE_BUFFERS path)", () => {
    // chunks 500..1499 live in the buffer (base=500); watermark at 500.
    const sizes = Array(1000).fill(50_000);
    const base = 500;
    const eff = boundedWindowStart(sizes, base, base, 0, MAX_WINDOW_BYTES);
    expect(eff).toBeGreaterThanOrEqual(base);
    expect(eff).toBeLessThan(base + 1000);
    expect(windowBytes(sizes, eff, base, 0)).toBeLessThanOrEqual(MAX_WINDOW_BYTES);
  });
});
