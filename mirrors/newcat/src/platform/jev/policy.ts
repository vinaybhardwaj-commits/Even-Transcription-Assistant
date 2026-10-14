import type { RegisteredQuestionSet } from './registry.js'

/** Isotonic table: x ascending raw probabilities, y calibrated values at each x. INFERRED shape. */
export interface IsotonicTable {
  x: number[]
  y: number[]
}

export interface JevPolicy {
  questionSet: Pick<RegisteredQuestionSet, 'id' | 'sha'>
  thresholds: { safety: number; nonSafety: number }
  calibration?: { method: 'none' | 'isotonic'; table?: IsotonicTable }
}

/** Applies the calibration of a policy to a probability. 'none' or no calibration is the identity. */
export function calibrate(policy: JevPolicy, p: number): number {
  const calibration = policy.calibration
  if (!calibration || calibration.method === 'none' || !calibration.table) return p
  const { x, y } = calibration.table
  if (x.length === 0 || x.length !== y.length) return p
  const first = y[0]
  const last = y[y.length - 1]
  if (first === undefined || last === undefined) return p
  if (p <= (x[0] ?? p)) return first
  for (let i = 1; i < x.length; i++) {
    const x1 = x[i] ?? 0
    if (p <= x1) {
      const x0 = x[i - 1] ?? 0
      const y0 = y[i - 1] ?? 0
      const y1 = y[i] ?? 0
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (p - x0)) / (x1 - x0)
    }
  }
  return last
}

export function thresholdFor(policy: JevPolicy, safetyClass: boolean): number {
  return safetyClass ? policy.thresholds.safety : policy.thresholds.nonSafety
}
