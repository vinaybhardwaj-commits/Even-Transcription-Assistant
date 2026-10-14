import type { InternalAudit, InternalFinding } from '../../../pipeline/types.js'
import { sortedCounts } from './serialize.js'

// The F7 governance serializer: InternalAudit -> body. The platform (assertGovernanceSafe) checks the result and refuses,
// never repairs. FLAG (template gaps this works around, see the S1 report):
//  1. InternalFinding.evidence is {quote, start, end}: no segment id, and a serializer sees the audit, not the input. The
//     rules therefore append a trailer to the finding summary, `[[g=<group>;e=<factid>:<segment>:<role>:<t0>:<t1>,...]]`,
//     and this serializer reads it back and strips it. The trailer also reaches the judges' claim text.
//  2. The audit keeps one probability per decision (the min of the two judges for a kept finding), not primary and second
//     separately, so judge.primary_p carries that combined value and judge.basis says so.
//  3. Rule-level abstentions and not_discussed counts never reach the audit; abstentions here are the run reason plus queue reasons.

export interface EvidenceTag {
  fact_id: string
  segment_id: string
  role: string
  t0: number
  t1: number
}

const TRAILER = /\s\[\[g=([a-z_A-Z]+);e=([^\]]*)\]\]$/

export function buildTrailer(group: string, tags: EvidenceTag[]): string {
  return ` [[g=${group};e=${tags.map((t) => `${t.fact_id}:${t.segment_id}:${t.role}:${t.t0}:${t.t1}`).join(',')}]]`
}

export function parseTrailer(summary: string): { claim: string; group: string; tags: Map<string, EvidenceTag> } | null {
  const m = TRAILER.exec(summary)
  if (!m) return null
  const tags = new Map<string, EvidenceTag>()
  for (const part of (m[2] ?? '').split(',').filter(Boolean)) {
    const [fact_id, segment_id, role, t0, t1] = part.split(':')
    if (!fact_id || !segment_id || !role || t0 === undefined || t1 === undefined) return null
    tags.set(fact_id, { fact_id, segment_id, role, t0: Number(t0), t1: Number(t1) })
  }
  return { claim: summary.slice(0, m.index), group: m[1] ?? 'other', tags }
}

const TYPE_BY_PREFIX: Array<[string, string]> = [
  ['consent.', 'consent_incomplete'],
  ['pressure.', 'pressure_signal'],
  ['svw.', 'said_vs_written'],
  ['concern.', 'patient_concern_unaddressed'],
  ['indication.', 'indication_gap'],
]
export const findingTypeOf = (ruleId: string): string => TYPE_BY_PREFIX.find(([p]) => ruleId.startsWith(p))?.[1] ?? 'unknown'

function governanceFinding(audit: InternalAudit, finding: InternalFinding): Record<string, unknown> | null {
  const parsed = parseTrailer(finding.summary)
  const decision = audit.decisions.find((d) => d.finding_id === finding.id)
  if (!parsed || !decision) return null
  const evidence = finding.evidence_fact_refs.map((ref, i) => {
    const tag = parsed.tags.get(ref)
    const quote = finding.evidence[i]?.quote
    if (!tag || quote === undefined) return null
    return { segment_id: tag.segment_id, role: tag.role, t0: tag.t0, t1: tag.t1, quote }
  })
  if (evidence.some((e) => e === null)) return null
  return {
    id: finding.id,
    finding_type: findingTypeOf(finding.rule_id),
    rule_id: finding.rule_id,
    rule_version: finding.rule_version,
    severity: finding.severity,
    procedure_group: parsed.group,
    summary: parsed.claim,
    evidence,
    judge: { primary_p: decision.top_probability, basis: 'min_of_primary_and_second', agree: true },
    doctor_visible: false,
    action: finding.action,
  }
}

export function governanceBody(audit: InternalAudit): Record<string, unknown> {
  const counts = new Map<string, number>()
  const bump = (reason: string) => counts.set(reason, (counts.get(reason) ?? 0) + 1)
  for (const item of audit.queue) bump(item.reason)
  // The run-level reason is counted only when no queue item already carries it, so one disagreeing finding is one count.
  if (audit.status === 'abstained' && audit.reason && !audit.queue.some((item) => item.reason === audit.reason)) bump(audit.reason)

  const findings: Record<string, unknown>[] = []
  for (const finding of audit.findings) {
    if (finding.action !== 'valid') continue // abstain and hold are counted through the queue, never listed
    const body = governanceFinding(audit, finding)
    // A kept finding the serializer cannot fully evidence is withheld and counted, never emitted half-formed.
    if (body) findings.push(body)
    else bump('evidence_unmapped')
  }
  const byType = new Map<string, number>()
  for (const f of findings) byType.set(String(f.finding_type), (byType.get(String(f.finding_type)) ?? 0) + 1)

  const reason = audit.reason ?? audit.error?.type
  return {
    trace_id: audit.trace_id,
    capability: audit.capability,
    capability_version: audit.capability_version,
    status: audit.status,
    ...(reason ? { reason } : {}),
    findings,
    abstentions: sortedCounts(counts),
    versions: audit.versions,
    summary: { findings: findings.length, by_type: sortedCounts(byType) },
  }
}
