/**
 * lib/encounter-clock/timeline-calibration.ts — confidence for the timeline lane (epic #23 f).
 *
 * The Jev wire has no temperature knob (a temperature field is a 400). Reproducibility is the model pin,
 * the question-set hash and the answer cache. A raw confidence is not a decision: this fits a monotone
 * map from (raw confidence, was-it-right) pairs and acts only when the calibrated probability clears a
 * precision target. There is no fixed 0.9 cutoff. With no fit, nothing acts.
 */
export const CAL_TARGET_PRECISION = 0.8;
export const CAL_MIN_PAIRS = 8;

export type CalPair = { raw: number; correct: boolean };

export type CalBin = { lo: number; hi: number; n: number; p: number };

export type Calibration =
  | { method: "none"; bins: []; act_at: null; target_precision: number }
  | { method: "isotonic"; bins: CalBin[]; act_at: number | null; target_precision: number };

export function emptyCalibration(target = CAL_TARGET_PRECISION): Calibration {
  return { method: "none", bins: [], act_at: null, target_precision: target };
}

function pav(bins: CalBin[]): CalBin[] {
  const out = bins.map((b) => ({ ...b }));
  let i = 0;
  while (i < out.length) {
    if (i > 0 && out[i]!.p < out[i - 1]!.p - 1e-12) {
      const a = out[i - 1]!, b = out[i]!;
      const n = a.n + b.n;
      out.splice(i - 1, 2, { lo: a.lo, hi: b.hi, n, p: n ? (a.p * a.n + b.p * b.n) / n : 0 });
      i = Math.max(0, i - 1);
    } else i++;
  }
  return out;
}

/** PURE — isotonic bins. Fewer than CAL_MIN_PAIRS pairs, or pairs outside [0, 1], yield method "none". */
export function fitCalibration(pairs: readonly CalPair[], target = CAL_TARGET_PRECISION): Calibration {
  const usable = pairs.filter((p) => Number.isFinite(p.raw) && p.raw >= 0 && p.raw <= 1);
  if (usable.length < CAL_MIN_PAIRS) return emptyCalibration(target);
  const sorted = [...usable].sort((a, b) => a.raw - b.raw);
  const nBins = Math.min(5, Math.max(2, Math.floor(sorted.length / 2)));
  const size = Math.ceil(sorted.length / nBins);
  const rawBins: CalBin[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    const slice = sorted.slice(i, i + size);
    const correct = slice.filter((p) => p.correct).length;
    const lo = i === 0 ? 0 : slice[0]!.raw;
    const hi = i + size >= sorted.length ? 1.000001 : sorted[Math.min(sorted.length - 1, i + size)]!.raw;
    rawBins.push({ lo, hi, n: slice.length, p: correct / slice.length });
  }
  const bins = pav(rawBins);
  const binOf = (raw: number): CalBin => bins.find((b) => raw >= b.lo && raw < b.hi) ?? bins[bins.length - 1]!;
  const thresholds = [...new Set(bins.map((b) => b.p))].sort((a, b) => a - b);
  let act: number | null = null;
  for (const th of thresholds) {
    const pred = usable.filter((p) => binOf(p.raw).p >= th - 1e-12);
    if (!pred.length) continue;
    const precision = pred.filter((p) => p.correct).length / pred.length;
    if (precision + 1e-9 >= target) { act = th; break; }
  }
  return { method: "isotonic", bins, act_at: act, target_precision: target };
}

/** PURE — calibrated probability of the raw value, or null when there is no fit. */
export function calibratedP(raw: number | null, cal: Calibration | null): number | null {
  if (raw == null || !Number.isFinite(raw) || !cal || cal.method !== "isotonic" || !cal.bins.length) return null;
  const b = cal.bins.find((x) => raw >= x.lo && raw < x.hi) ?? cal.bins[cal.bins.length - 1]!;
  return b.p;
}

/**
 * PURE — act only when a fit exists and the calibrated probability is at or above the precision target's
 * threshold. A raw 0.95 in a bin that was usually wrong does not act. No fit does not act.
 */
export function jevActs(raw: number | null, cal: Calibration | null): boolean {
  if (!cal || cal.method !== "isotonic" || cal.act_at == null) return false;
  const p = calibratedP(raw, cal);
  return p != null && p + 1e-12 >= cal.act_at;
}
