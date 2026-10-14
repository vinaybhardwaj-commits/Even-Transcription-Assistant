import { z } from 'zod'
import type { EvidenceRef } from '../evidence/hits.js'
import type { Audience, Severity } from '../facts/schema.js'
import { SEVERITIES } from '../facts/schema.js'
import type { InternalAudit } from '../pipeline/types.js'

const ACTIONS = ['valid', 'route', 'hold', 'drop_informational', 'suppressed_invalid', 'abstain'] as const

const ErrorInfo = z.object({ type: z.string(), message: z.string() }).strict()

const DoctorCitation = z
  .object({
    source_name: z.string(),
    section: z.string(),
    quote: z.string(),
    url: z.string().nullable(),
  })
  .strict()

const DoctorFinding = z
  .object({
    id: z.string(),
    summary: z.string(),
    severity: z.enum(SEVERITIES),
    evidence: z.array(z.object({ quote: z.string() }).strict()),
    citations: z.array(DoctorCitation).optional(),
  })
  .strict()

const DoctorDecision = z.object({ finding_id: z.string(), recommendation: z.string() }).strict()

const base = {
  trace_id: z.string(),
  capability: z.string(),
  capability_version: z.string(),
}

export const DoctorBody = z.discriminatedUnion('status', [
  z.object({ ...base, status: z.literal('ok'), findings: z.array(DoctorFinding).min(1), decisions: z.array(DoctorDecision) }).strict(),
  z
    .object({
      ...base,
      status: z.literal('empty'),
      reason: z.string().min(1),
      findings: z.array(DoctorFinding).length(0),
      decisions: z.array(DoctorDecision).length(0),
    })
    .strict(),
  z.object({ ...base, status: z.literal('failed'), error: ErrorInfo }).strict(),
  z.object({ ...base, status: z.literal('unavailable'), error: ErrorInfo }).strict(),
])

const OperatorEvidence = z.object({ quote: z.string(), start: z.number(), end: z.number() }).strict()
const CorpusRef = z
  .object({
    chunk_id: z.string(),
    source_id: z.string(),
    source_name: z.string(),
    section_path: z.string(),
    licence_class: z.enum(['open', 'licensed_internal', 'india_regulatory', 'commercial_db']),
    url: z.string().nullable(),
    quote: z.string().optional(),
  })
  .strict()
const OperatorFinding = z
  .object({
    id: z.string(),
    rule_id: z.string(),
    rule_version: z.string(),
    severity: z.enum(SEVERITIES),
    summary: z.string(),
    action: z.enum(ACTIONS),
    evidence: z.array(OperatorEvidence),
    evidence_refs: z.array(CorpusRef).optional(),
  })
  .strict()
const OperatorDecision = z
  .object({
    finding_id: z.string(),
    question_id: z.string(),
    action: z.enum(ACTIONS),
    outcome: z.enum(['resolve', 'abstain']),
  })
  .strict()
const QueueItem = z.object({ finding_id: z.string(), rule_id: z.string(), reason: z.string() }).strict()
const OperatorVersions = z.object({ engine: z.string(), rules: z.string() }).strict()

const evidenceMetaSchema = {
  evidence_status: z.enum(['ok', 'empty', 'unavailable']).optional(),
  evidence_rerank: z.enum(['off', 'ok', 'unavailable']).optional(),
}

const operatorTerminal = {
  findings: z.array(OperatorFinding),
  decisions: z.array(OperatorDecision),
  queue: z.array(QueueItem),
  versions: OperatorVersions,
  ...evidenceMetaSchema,
}

export const OperatorBody = z.discriminatedUnion('status', [
  z.object({ ...base, status: z.literal('ok'), ...operatorTerminal }).strict(),
  z.object({ ...base, status: z.literal('empty'), reason: z.string().min(1), ...operatorTerminal }).strict(),
  z.object({ ...base, status: z.literal('abstained'), reason: z.string().min(1), ...operatorTerminal }).strict(),
  z.object({ ...base, status: z.literal('failed'), error: ErrorInfo }).strict(),
  z.object({ ...base, status: z.literal('unavailable'), error: ErrorInfo }).strict(),
])

const InternalVersions = z
  .object({
    engine: z.string(),
    rules: z.string(),
    extractor: z.string(),
    models: z.array(z.string()),
    question_set_sha: z.string(),
  })
  .strict()

const InternalFinding = OperatorFinding.extend({
  safety_class: z.boolean(),
  evidence_fact_refs: z.array(z.string()),
}).strict()

const InternalDecision = OperatorDecision.extend({
  id: z.string(),
  probabilities: z.record(z.string(), z.number()),
  top_label: z.string(),
  top_probability: z.number(),
  policy_id: z.string(),
  rationale: z.string(),
  safety_class: z.boolean(),
}).strict()

const internalTerminal = {
  findings: z.array(InternalFinding),
  decisions: z.array(InternalDecision),
  queue: z.array(QueueItem),
  versions: InternalVersions,
  evidence_hits: z.array(CorpusRef).optional(),
  ...evidenceMetaSchema,
}

export const InternalBody = z.discriminatedUnion('status', [
  z.object({ ...base, status: z.literal('ok'), ...internalTerminal }).strict(),
  z.object({ ...base, status: z.literal('empty'), reason: z.string().min(1), ...internalTerminal }).strict(),
  z.object({ ...base, status: z.literal('abstained'), reason: z.string().min(1), ...internalTerminal }).strict(),
  z.object({ ...base, status: z.literal('failed'), error: ErrorInfo, versions: InternalVersions }).strict(),
  z.object({ ...base, status: z.literal('unavailable'), error: ErrorInfo, versions: InternalVersions }).strict(),
])

export const PendingBody = z
  .object({
    ...base,
    status: z.literal('ok'),
    pending: z.literal(true),
    job_id: z.string(),
    job_status: z.enum(['queued', 'running']),
  })
  .strict()

const BANNED_DOCTOR_KEYS = new Set([
  'rationale',
  'policy_id',
  'probabilities',
  'question_set_sha',
  'served_model_id',
  'intended_model_id',
  'models',
  'extractor',
  'extractor_version',
  'top_probability',
  'rule_id',
  'rule_version',
  'queue',
  'versions',
  'chunk_id',
  'source_id',
  'licence_class',
  'evidence_refs',
  'evidence_hits',
  'evidence_status',
  'evidence_rerank',
  'section_path',
])

export class EmitRefusal extends Error {
  constructor() {
    super('refusing to emit internal fields')
    this.name = 'EmitRefusal'
  }
}

export type GovernanceSerializer = (audit: InternalAudit) => unknown

export interface SerializerHooks {
  /** Agent-owned governance body. The platform has no generic one. */
  governance?: GovernanceSerializer | undefined
}

export function serialize(audit: InternalAudit, audience: Audience, hooks: SerializerHooks = {}): unknown {
  switch (audience) {
    case 'doctor': {
      const parsed = DoctorBody.safeParse(toDoctor(audit))
      if (!parsed.success) throw new EmitRefusal()
      assertDoctorSafe(parsed.data)
      return parsed.data
    }
    case 'operator': {
      const parsed = OperatorBody.safeParse(toOperator(audit))
      if (!parsed.success) throw new EmitRefusal()
      return parsed.data
    }
    case 'internal': {
      const parsed = InternalBody.safeParse(toInternal(audit))
      if (!parsed.success) throw new EmitRefusal()
      return parsed.data
    }
    case 'governance':
      return toGovernance(audit, hooks.governance)
    default:
      return assertNever(audience)
  }
}

function assertNever(_audience: never): never {
  throw new EmitRefusal()
}

/** Keys that must never appear anywhere in a governance body. */
const BANNED_GOVERNANCE_KEYS = new Set([
  'prompt',
  'system_prompt',
  'user_prompt',
  'rationale',
  'raw_text',
  'raw_model_text',
  'model_text',
  'completion',
  'tool_input',
])

/** Platform allowlists for a governance body. An agent serializer may emit only these keys. */
const GOVERNANCE_TOP_KEYS: ReadonlySet<string> = new Set([
  'trace_id',
  'capability',
  'capability_version',
  'status',
  'reason',
  'findings',
  'abstentions',
  'versions',
  'summary',
])
const GOVERNANCE_FINDING_KEYS: ReadonlySet<string> = new Set([
  'id',
  'finding_type',
  'rule_id',
  'rule_version',
  'severity',
  'procedure_group',
  'summary',
  'evidence',
  'judge',
  'doctor_visible',
  'action',
])
const GOVERNANCE_EVIDENCE_KEYS: ReadonlySet<string> = new Set(['segment_id', 'role', 't0', 't1', 'quote'])

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''
const probability = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** Runs the agent's serializer, then checks the platform invariants. Anything off is a refusal. */
function toGovernance(audit: InternalAudit, hook: GovernanceSerializer | undefined): unknown {
  if (!hook) throw new EmitRefusal()
  let body: unknown
  try {
    body = hook(audit)
  } catch {
    throw new EmitRefusal()
  }
  assertGovernanceSafe(body)
  return body
}

/**
 * Required: `findings` (array) and `abstentions` (record of counts). Top-level, finding and evidence keys must be on the allowlists above.
 * Every finding carries non-empty evidence (each item with segment_id and quote) and judge probabilities
 * (`judge.primary_p`, and `judge.second_p` when present and not null). No `abstain` findings: abstentions
 * are counts only (`abstentions` is a record of non-negative integers). doctor_visible is false or absent.
 * No banned-internal key at any depth.
 */
export function assertGovernanceSafe(body: unknown): void {
  if (!isRecord(body)) throw new EmitRefusal()
  if (bannedKeys(body, [], BANNED_GOVERNANCE_KEYS, true).length > 0) throw new EmitRefusal()
  if (Object.keys(body).some((key) => !GOVERNANCE_TOP_KEYS.has(key))) throw new EmitRefusal()
  const counts = body.abstentions
  if (!isRecord(counts) || !Object.values(counts).every((n) => Number.isInteger(n) && (n as number) >= 0)) throw new EmitRefusal()
  if (!Array.isArray(body.findings)) throw new EmitRefusal()
  for (const finding of body.findings) {
    if (!isRecord(finding)) throw new EmitRefusal()
    if (Object.keys(finding).some((key) => !GOVERNANCE_FINDING_KEYS.has(key))) throw new EmitRefusal()
    if (finding.action === 'abstain') throw new EmitRefusal()
    if (finding.doctor_visible !== undefined && finding.doctor_visible !== false) throw new EmitRefusal()
    const evidence = finding.evidence
    if (!Array.isArray(evidence) || evidence.length === 0) throw new EmitRefusal()
    for (const item of evidence) {
      if (!isRecord(item) || !nonEmptyString(item.segment_id) || !nonEmptyString(item.quote)) throw new EmitRefusal()
      if (Object.keys(item).some((key) => !GOVERNANCE_EVIDENCE_KEYS.has(key))) throw new EmitRefusal()
    }
    const judge = finding.judge
    if (!isRecord(judge) || !probability(judge.primary_p)) throw new EmitRefusal()
    if (judge.second_p !== undefined && judge.second_p !== null && !probability(judge.second_p)) throw new EmitRefusal()
  }
}

export function assertDoctorSafe(value: unknown): void {
  const leaks = bannedKeys(value)
  if (leaks.length > 0) throw new EmitRefusal()
}

function bannedKeys(value: unknown, found: string[] = [], banned: ReadonlySet<string> = BANNED_DOCTOR_KEYS, lower = false): string[] {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) bannedKeys(item, found, banned, lower)
    return found
  }
  for (const [key, child] of Object.entries(value)) {
    if (banned.has(lower ? key.toLowerCase() : key)) found.push(key)
    bannedKeys(child, found, banned, lower)
  }
  return found
}

function shell(audit: InternalAudit) {
  return {
    trace_id: audit.trace_id,
    capability: audit.capability,
    capability_version: audit.capability_version,
  }
}

function errorOf(audit: InternalAudit): { type: string; message: string } {
  return audit.error ?? { type: audit.status, message: audit.status }
}

function toDoctor(audit: InternalAudit): unknown {
  if (audit.status === 'failed' || audit.status === 'unavailable') {
    return { ...shell(audit), status: audit.status, error: errorOf(audit) }
  }
  const findings = audit.findings
    .filter((finding) => finding.doctor_visible)
    .map((finding) => {
      const citations = doctorCitations(finding.evidence_refs)
      return {
        id: finding.id,
        summary: finding.summary,
        severity: finding.severity as Severity,
        evidence: finding.evidence.map((item) => ({ quote: item.quote })),
        ...(citations.length > 0 ? { citations } : {}),
      }
    })
  if (findings.length === 0) {
    const reason = audit.status === 'empty' ? (audit.reason ?? 'no_candidate_findings') : 'nothing_routed'
    return { ...shell(audit), status: 'empty', reason, findings: [], decisions: [] }
  }
  return {
    ...shell(audit),
    status: 'ok',
    findings,
    decisions: findings.map((finding) => ({ finding_id: finding.id, recommendation: finding.summary })),
  }
}

function toOperator(audit: InternalAudit): unknown {
  if (audit.status === 'failed' || audit.status === 'unavailable') {
    return { ...shell(audit), status: audit.status, error: errorOf(audit) }
  }
  return {
    ...shell(audit),
    status: audit.status,
    ...(audit.reason ? { reason: audit.reason } : {}),
    findings: audit.findings.map((finding) => operatorFinding(finding, 'operator')),
    ...meta(audit),
    decisions: audit.decisions.map((decision) => ({
      finding_id: decision.finding_id,
      question_id: decision.question_id,
      action: decision.action,
      outcome: decision.outcome,
    })),
    queue: audit.queue,
    versions: { engine: audit.versions.engine, rules: audit.versions.rules },
  }
}

function toInternal(audit: InternalAudit): unknown {
  if (audit.status === 'failed' || audit.status === 'unavailable') {
    return { ...shell(audit), status: audit.status, error: errorOf(audit), versions: audit.versions }
  }
  return {
    ...shell(audit),
    status: audit.status,
    ...(audit.reason ? { reason: audit.reason } : {}),
    findings: audit.findings.map((finding) => ({
      ...operatorFinding(finding, 'internal'),
      safety_class: finding.safety_class,
      evidence_fact_refs: finding.evidence_fact_refs,
    })),
    decisions: audit.decisions,
    queue: audit.queue,
    versions: audit.versions,
    ...meta(audit),
    ...(audit.evidence_hits ? { evidence_hits: audit.evidence_hits.map((hit) => projectRef(hit, 'internal')) } : {}),
  }
}

function operatorFinding(finding: InternalAudit['findings'][number], audience: 'operator' | 'internal') {
  const refs = finding.evidence_refs && finding.evidence_refs.length > 0 ? finding.evidence_refs.map((ref) => projectRef(ref, audience)) : undefined
  return {
    id: finding.id,
    rule_id: finding.rule_id,
    rule_version: finding.rule_version,
    severity: finding.severity,
    summary: finding.summary,
    action: finding.action,
    evidence: finding.evidence.map((item) => ({ quote: item.quote, start: item.start, end: item.end })),
    ...(refs ? { evidence_refs: refs } : {}),
  }
}

function meta(audit: InternalAudit): Record<string, unknown> {
  return {
    ...(audit.evidence_status ? { evidence_status: audit.evidence_status } : {}),
    ...(audit.evidence_rerank ? { evidence_rerank: audit.evidence_rerank } : {}),
  }
}

function doctorCitations(refs: EvidenceRef[] | undefined): { source_name: string; section: string; quote: string; url: string | null }[] {
  if (!refs) return []
  return refs
    .filter((ref) => ref.doctor_visible && ref.licence_class !== 'licensed_internal' && ref.licence_class !== 'commercial_db' && ref.quote !== '')
    .map((ref) => ({
      source_name: ref.source_name,
      section: ref.section_path,
      quote: ref.quote,
      url: ref.url,
    }))
}

function projectRef(ref: EvidenceRef, audience: 'operator' | 'internal') {
  const base = {
    chunk_id: ref.chunk_id,
    source_id: ref.source_id,
    source_name: ref.source_name,
    section_path: ref.section_path,
    licence_class: ref.licence_class,
    url: ref.url,
  }
  const showQuote = audience === 'internal' || (ref.doctor_visible && ref.licence_class !== 'licensed_internal' && ref.licence_class !== 'commercial_db')
  return showQuote && ref.quote !== '' ? { ...base, quote: ref.quote } : base
}

export function pendingBody(audit: { trace_id: string; capability: string; capability_version: string }, jobId: string, jobStatus: 'queued' | 'running') {
  return {
    trace_id: audit.trace_id,
    capability: audit.capability,
    capability_version: audit.capability_version,
    status: 'ok' as const,
    pending: true as const,
    job_id: jobId,
    job_status: jobStatus,
  }
}
