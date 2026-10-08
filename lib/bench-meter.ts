import { SILENT_ZERO_RATIO } from "@/lib/bench-bus-constants";

export type BenchMeterLevels = {
  peak: number;
  avg: number;
  zero_ratio?: number;
};

/**
 * The EQ paints digital silence from the ratio alone, on this slice. The Room Watchdog uses the
 * same ratio (`SILENT_ZERO_RATIO`) and, unlike this meter, also requires the peak to stay under
 * the alive floor before it pages. See `pollIsSilent`.
 */
const DIGITAL_SILENCE_ZERO_RATIO = SILENT_ZERO_RATIO;

export function isDigitalSilence(
  levels: BenchMeterLevels | null | undefined,
  reportedSilence = false,
): boolean {
  return reportedSilence
    || Boolean(
      levels
      && typeof levels.zero_ratio === "number"
      && levels.zero_ratio >= DIGITAL_SILENCE_ZERO_RATIO,
    );
}

/**
 * FROZEN / STALE LEVELS (Arch #19). When a capture device drops, the recorder keeps resending the last meter value, so a flat non-zero floor
 * (live, 7 Oct: peak 0.0125, 0.0164) looks alive to any levels-only reader. There is no capture-side sequence number yet, so the test is
 * derived at READ time from the samples themselves: the same (peak, avg, zero_ratio) triple for longer than LEVELS_FROZEN_MS, or no sample
 * newer than LEVELS_FRESH_MS. Digital silence is exempt from the repeat test (a muted mic legitimately repeats 0 / 1.0) because it is
 * already named by `isDigitalSilence`. Mark, never delete: the stored rows are untouched.
 */
/** At least 2x POLL_HIDDEN_MS (5 s): a hidden-tab kiosk polls every 5 s, and one late poll must not grey a live meter. */
export const LEVELS_FRESH_MS = 12_000;
export const LEVELS_FROZEN_MS = 6_000;

export type LevelStamp = { t_ms: number; peak: number; avg: number | null; zero_ratio: number | null };

/** PURE. `samples` in any order. No samples is stale; null only when the newest sample has no zero_ratio (cannot judge). */
export function levelsStale(samples: readonly LevelStamp[], nowMs: number): boolean | null {
  // Nothing newer than LEVELS_FRESH_MS exists: stale. (A caller that could not READ samples must not call this; it has nothing to judge.)
  if (samples.length === 0) return true;
  const sorted = [...samples].sort((a, b) => a.t_ms - b.t_ms);
  const newest = sorted[sorted.length - 1]!;
  if (nowMs - newest.t_ms > LEVELS_FRESH_MS) return true;
  if (isDigitalSilence({ peak: newest.peak, avg: newest.avg ?? 0, ...(newest.zero_ratio !== null ? { zero_ratio: newest.zero_ratio } : {}) })) return false;
  // The repeat test cannot tell a frozen meter from a silent one without the zero ratio (digital silence legitimately repeats). No ratio: CANNOT JUDGE,
  // which is null, never stale. "We could not look" is not "we looked and it is frozen".
  if (newest.zero_ratio === null) return null;
  let first = newest.t_ms;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const r = sorted[i]!;
    if (r.peak === newest.peak && r.avg === newest.avg && r.zero_ratio === newest.zero_ratio) first = r.t_ms;
    else break;
  }
  return newest.t_ms - first > LEVELS_FROZEN_MS;
}
