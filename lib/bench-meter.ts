export type BenchMeterLevels = {
  peak: number;
  avg: number;
  zero_ratio?: number;
};

const DIGITAL_SILENCE_ZERO_RATIO = 0.98;

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
