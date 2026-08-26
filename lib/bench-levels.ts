/**
 * Pure parsing for microphone measurements. Absence must stay absent: JavaScript's
 * Number(null) and Number("") both produce zero, which would turn an unmeasured microphone
 * into measured silence on the room screen and the operator door.
 */

export type MicLevels = { peak: number; avg: number };

/** A finite number from a number or non-empty numeric string; everything else is absent. */
export function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A complete normalised level pair, or null. A partial pair is no measurement because filling
 * either side with zero would invent a value that no microphone reported.
 */
export function parseMicLevelPair(peakValue: unknown, avgValue: unknown): MicLevels | null {
  const peak = finiteNumberOrNull(peakValue);
  const avg = finiteNumberOrNull(avgValue);
  if (peak === null || avg === null || peak < 0 || peak > 1 || avg < 0 || avg > peak) return null;
  return { peak, avg };
}

/** The object form used by the command poll and its existing callers. */
export function parseMicLevels(value: unknown): MicLevels | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const pair = value as Record<string, unknown>;
  return parseMicLevelPair(pair.peak, pair.avg);
}
