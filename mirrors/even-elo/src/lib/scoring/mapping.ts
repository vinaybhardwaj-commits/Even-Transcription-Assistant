import { ObservationValue, Stream } from "./types";

/**
 * Map a raw observation value to a 0–100 sub-score given a stream's
 * direction + floor/target (PRD §6.3).
 *
 * Returns null if the value cannot be mapped (e.g., binary stream
 * received a numeric value, or numeric stream missing floor/target).
 */
export function mapToZeroHundred(value: ObservationValue, stream: Stream): number | null {
  if (stream.data_type === "binary") {
    if (value.kind !== "binary" || typeof value.val !== "boolean") return null;
    if (stream.direction === "higher_better") {
      return value.val ? 100 : 0;
    }
    return value.val ? 0 : 100;
  }

  if (stream.data_type === "numeric" || stream.data_type === "derived") {
    if (value.kind !== "numeric" || typeof value.val !== "number") return null;
    const f = stream.floor_value;
    const t = stream.target_value;
    if (f === null || t === null || f === t) return null;

    let raw: number;
    if (stream.direction === "higher_better") {
      raw = (100 * (value.val - f)) / (t - f);
    } else {
      raw = (100 * (f - value.val)) / (f - t);
    }
    return clamp(raw, 0, 100);
  }

  return null;
}

export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
