import type { EvidenceRef } from '../evidence/hits.js'
import type { Severity } from '../facts/schema.js'
import type { EvidenceQuote } from '../rules/pack.js'

/** Evidence item of an agent finding: the quote plus the segment the quote gate found it in. */
export type FindingEvidence = EvidenceQuote & {
  segment_id?: string | undefined
  role?: string | undefined
  t0?: number | undefined
  t1?: number | undefined
}

/** Flat, agent-owned finding metadata. Snake_case keys, scalar values. Never reaches a judge. */
export type FindingMeta = Record<string, string | number | boolean>

/** Per-judge probabilities for an agent finding. Absent on audit.note findings. */
export interface FindingJudge {
  primary_p: number | null
  second_p: number | null
  agree: boolean | null
  served_model_ids: string[]
}

export interface InternalFinding {
  id: string
  rule_id: string
  rule_version: string
  severity: Severity
  safety_class: boolean
  summary: string
  evidence_fact_refs: string[]
  evidence: FindingEvidence[]
  evidence_refs?: EvidenceRef[] | undefined
  doctor_visible: boolean
  /** Agent run path only. Never serialized for doctor, operator or internal. */
  judge?: FindingJudge | undefined
  /** Agent run path only. Copied from the candidate; governance bodies only. */
  meta?: FindingMeta | undefined
  action: 'valid' | 'route' | 'hold' | 'drop_informational' | 'suppressed_invalid' | 'abstain'
}

export interface InternalDecision {
  id: string
  finding_id: string
  question_id: string
  probabilities: Record<string, number>
  top_label: string
  top_probability: number
  outcome: 'resolve' | 'abstain'
  action: InternalFinding['action']
  policy_id: string
  rationale: string
  safety_class: boolean
}

export interface QueueItem {
  finding_id: string
  rule_id: string
  reason: string
}

export interface VersionStamp {
  engine: string
  rules: string
  extractor: string
  models: string[]
  question_set_sha: string
  /** Agent run path only: rule id -> `set id@sha` when per-rule question sets are used; absent for default-set-only runs. */
  question_sets?: Record<string, string> | undefined
}

export interface InternalAudit {
  trace_id: string
  capability: string
  capability_version: string
  status: 'ok' | 'empty' | 'abstained' | 'unavailable' | 'failed'
  reason?: string
  error?: { type: string; message: string }
  findings: InternalFinding[]
  decisions: InternalDecision[]
  queue: QueueItem[]
  versions: VersionStamp
  /** Agent run path only: opaque ids the agent derived from its input. Governance bodies only; never in doctor, operator or internal bodies. */
  doctor_uid?: string | undefined
  encounter_id?: string | undefined
  /** Agent run path only: sums of rule-reported counts, keyed by the agent's declared countReasons. Omitted when empty. */
  agent_counts?: Record<string, number> | undefined
  evidence_status?: 'ok' | 'empty' | 'unavailable' | undefined
  evidence_rerank?: 'off' | 'ok' | 'unavailable' | undefined
  evidence_hits?: EvidenceRef[] | undefined
}
