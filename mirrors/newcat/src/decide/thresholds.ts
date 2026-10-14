import { ABSTENTION_POLICY_ID } from '../version.js'

export interface Thresholds {
  policyId: string
  safetyAbstainBelow: number
  nonSafetyAbstainBelow: number
  safetySlots: number
  nonSafetySlots: number
}

export interface BudgetInput {
  dailyBudget: number
  safetyShare: number
  backlogDays: number
  expectedSafetyDecisions: number
  expectedNonSafetyDecisions: number
  fallbackSafety: number
  fallbackNonSafety: number
}

/** Placeholder distribution until human labels exist. Not clinical calibration data. */
export const SYNTHETIC_SAFETY_SCORES: number[] = [...Array(15).fill(0.82), ...Array(25).fill(0.97)]
export const SYNTHETIC_NON_SAFETY_SCORES: number[] = [...Array(10).fill(0.5), ...Array(70).fill(0.88)]

export const DEFAULT_BUDGET: BudgetInput = {
  dailyBudget: 25,
  safetyShare: 0.6,
  backlogDays: 0,
  expectedSafetyDecisions: 40,
  expectedNonSafetyDecisions: 80,
  fallbackSafety: 0.9,
  fallbackNonSafety: 0.75,
}

export function quantile(sortedAscending: number[], rate: number): number {
  if (sortedAscending.length === 0) return 1
  if (rate <= 0) return 0
  if (rate >= 1) return 1.01
  const index = Math.min(sortedAscending.length - 1, Math.floor(rate * sortedAscending.length))
  return sortedAscending[index] ?? 1
}

/**
 * Safety receives at least 60% of abstention slots.
 * A decision abstains when its top probability is below `abstainBelow`.
 * When the human backlog exceeds 2 days, non-safety slots shrink first.
 * That lowers the non-safety bar so only the least confident non-safety items still abstain.
 * Safety items below threshold abstain and are never dropped.
 * Critical findings at or above the safety bar are routed by policy and do not ask the route question.
 */
export function thresholdsFromBudget(
  policy: BudgetInput,
  safetyScores: number[],
  nonSafetyScores: number[],
): Thresholds {
  const share = Math.max(policy.safetyShare, 0.6)
  const safetySlots = Math.ceil(policy.dailyBudget * share)
  let nonSafetySlots = Math.max(0, policy.dailyBudget - safetySlots)
  if (policy.backlogDays > 2) nonSafetySlots = Math.floor(nonSafetySlots / 4)
  const safetyRate = policy.expectedSafetyDecisions === 0 ? 1 : Math.min(1, safetySlots / policy.expectedSafetyDecisions)
  const nonSafetyRate =
    policy.expectedNonSafetyDecisions === 0 ? 1 : Math.min(1, nonSafetySlots / policy.expectedNonSafetyDecisions)
  const safetySorted = [...safetyScores].sort((left, right) => left - right)
  const nonSorted = [...nonSafetyScores].sort((left, right) => left - right)
  return {
    policyId: ABSTENTION_POLICY_ID,
    safetyAbstainBelow: safetySorted.length > 0 ? quantile(safetySorted, safetyRate) : policy.fallbackSafety,
    nonSafetyAbstainBelow: nonSorted.length > 0 ? quantile(nonSorted, nonSafetyRate) : policy.fallbackNonSafety,
    safetySlots,
    nonSafetySlots,
  }
}

export function activeThresholds(backlogDays: number): Thresholds {
  return thresholdsFromBudget({ ...DEFAULT_BUDGET, backlogDays }, SYNTHETIC_SAFETY_SCORES, SYNTHETIC_NON_SAFETY_SCORES)
}
