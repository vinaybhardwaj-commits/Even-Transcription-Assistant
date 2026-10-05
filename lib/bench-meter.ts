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
