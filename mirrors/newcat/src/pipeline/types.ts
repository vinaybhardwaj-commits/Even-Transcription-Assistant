import type { EvidenceRef } from '../evidence/hits.js'
import type { Severity } from '../facts/schema.js'
import type { EvidenceQuote } from '../rules/pack.js'

export interface InternalFinding {
  id: string
  rule_id: string
  rule_version: string
  severity: Severity
  safety_class: boolean
  summary: string
  evidence_fact_refs: string[]
  evidence: EvidenceQuote[]
  evidence_refs?: EvidenceRef[] | undefined
  doctor_visible: boolean
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
  evidence_status?: 'ok' | 'empty' | 'unavailable' | undefined
  evidence_rerank?: 'off' | 'ok' | 'unavailable' | undefined
  evidence_hits?: EvidenceRef[] | undefined
}
