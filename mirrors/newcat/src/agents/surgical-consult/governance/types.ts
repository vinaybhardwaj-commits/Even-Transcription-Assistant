import type { CandidateFinding } from '../rules/types.js'

export const OUTCOMES = ['kept', 'abstain_disagree', 'below_threshold'] as const
export type Outcome = (typeof OUTCOMES)[number]

export interface JudgeProbs {
  jev_p: number | null
  gemini_p: number | null
  agree: boolean | null
}

// A rule candidate after both judges have run. Only outcome 'kept' ever leaves this agent as an item.
export interface JudgedFinding extends CandidateFinding {
  judge: JudgeProbs
  models: string[]
  outcome: Outcome
}

export const RUN_STATUSES = ['ok', 'empty', 'abstained', 'unavailable', 'failed'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export interface AgentRunSummary {
  encounter_id: string
  doctor_uid: string | null
  month: string // YYYY-MM
  status: RunStatus
  abstain_reason: string | null
  findings: JudgedFinding[]
  abstentions: { rule_id: string; reason: string }[]
  not_discussed_counts: Record<string, number>
}

export const AUDIENCES = ['internal', 'operator', 'governance', 'doctor'] as const
export type Audience = (typeof AUDIENCES)[number]
