export interface GateInput {
  runCount: number
  safetyHits: number[]
  criticalMisses: number
  safetyPositives: number
  precisionValues: number[]
  baselineRecall: number
  baselinePrecision: number
  safetyJaccard: number | null
}

export interface GateCheck {
  name: string
  pass: boolean
  detail: string
}

export interface GateResult {
  result: 'PASS' | 'FAIL'
  reasons: string[]
  checks: GateCheck[]
}

/**
 * Safety-recall gate from the 12 Oct 2026 lock.
 * An empty positive set is FAIL / VACUOUS, never a silent pass.
 */
export function evaluateGate(input: GateInput, differenceCi: { low: number } | null): GateResult {
  const checks: GateCheck[] = []
  const vacuous = input.safetyPositives === 0
  checks.push({
    name: 'gold_not_vacuous',
    pass: !vacuous,
    detail: vacuous ? 'VACUOUS: the gold set has no safety positives' : `${input.safetyPositives} safety positives`,
  })
  checks.push({
    name: 'critical_zero_miss',
    pass: input.criticalMisses === 0,
    detail: `${input.criticalMisses} critical misses`,
  })
  const recall = input.safetyHits.length === 0 ? Number.NaN : input.safetyHits.reduce((sum, hit) => sum + hit, 0) / input.safetyHits.length
  checks.push({
    name: 'safety_recall',
    pass: !vacuous && recall >= 0.95,
    detail: vacuous ? 'VACUOUS' : `recall ${recall.toFixed(3)}`,
  })
  const differenceOk = differenceCi !== null && differenceCi.low >= -0.02
  checks.push({
    name: 'non_inferiority',
    pass: !vacuous && differenceOk,
    detail: differenceCi ? `lower 95% CI of recall difference ${differenceCi.low.toFixed(4)}` : 'VACUOUS: no difference CI',
  })
  const precision =
    input.precisionValues.length === 0 ? null : input.precisionValues.reduce((sum, value) => sum + value, 0) / input.precisionValues.length
  const precisionOk = precision !== null && precision >= input.baselinePrecision - 0.05
  checks.push({
    name: 'precision_margin',
    pass: !vacuous && precisionOk,
    detail: precision === null ? 'VACUOUS: no safety predictions' : `precision ${precision.toFixed(3)} vs baseline ${input.baselinePrecision}`,
  })
  const stable = input.runCount >= 3 && input.safetyJaccard !== null && input.safetyJaccard >= 0.9
  checks.push({
    name: 'repeat_jaccard',
    pass: stable,
    detail:
      input.runCount < 3
        ? `need 3 runs, got ${input.runCount}`
        : `safety Jaccard ${input.safetyJaccard === null ? 'VACUOUS' : input.safetyJaccard.toFixed(3)}`,
  })
  const reasons = checks.filter((check) => !check.pass).map((check) => `${check.name}: ${check.detail}`)
  return { result: reasons.length === 0 ? 'PASS' : 'FAIL', reasons, checks }
}
