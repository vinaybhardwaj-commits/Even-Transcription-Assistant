import type { InternalAudit, InternalFinding } from '../../../pipeline/types.js'
import { sortedCounts } from './serialize.js'

// The F7 governance serializer: InternalAudit -> body. The platform (assertGovernanceSafe) checks the result and refuses,
// never repairs. Since F7.3/F7.4 the audit carries everything this needs: evidence with segment id, role and times, the
// per-judge probabilities, the finding's meta (procedure_group), agent counts and the opaque ids. Summaries are claim
// constants (no trailer to strip).

const TYPE_BY_PREFIX: Array<[string, string]> = [
  ['consent.', 'consent_incomplete'],
  ['pressure.', 'pressure_signal'],
  ['svw.', 'said_vs_written'],
  ['concern.', 'concern_unaddressed'],
  ['indication.', 'indication_gap'],
]
export const findingTypeOf = (ruleId: string): string => TYPE_BY_PREFIX.find(([p]) => ruleId.startsWith(p))?.[1] ?? 'unknown'

function governanceFinding(finding: InternalFinding): Record<string, unknown> | null {
  const judge = finding.judge
  // A valid agent finding always has both. A finding without them is withheld and counted, never emitted half-formed.
  if (!judge || judge.primary_p === null || finding.evidence.length === 0) return null
  return {
    id: finding.id,
    finding_type: findingTypeOf(finding.rule_id),
    rule_id: finding.rule_id,
    rule_version: finding.rule_version,
    severity: finding.severity,
    procedure_group: String(finding.meta?.procedure_group ?? 'other'),
    summary: finding.summary,
    evidence: finding.evidence.map((e) => ({
      segment_id: e.segment_id ?? '',
      role: e.role ?? '',
      ...(e.t0 !== undefined ? { t0: e.t0 } : {}),
      ...(e.t1 !== undefined ? { t1: e.t1 } : {}),
      quote: e.quote,
    })),
    judge: { primary_p: judge.primary_p, second_p: judge.second_p, agree: judge.agree ?? false, served_model_ids: judge.served_model_ids },
    doctor_visible: false,
    action: finding.action,
  }
}

// versions.models is a list in the audit; the governance body wants strings. question_sets (platform-stamped) stays a record of strings.
const versionsOf = (versions: InternalAudit['versions']): Record<string, string | Record<string, string>> =>
  Object.fromEntries(
    Object.entries(versions as unknown as Record<string, unknown>).map(([k, v]) => [
      k,
      Array.isArray(v) ? v.join(',') : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([n, x]) => [n, String(x)])) : String(v),
    ]),
  )

export function governanceBody(audit: InternalAudit): Record<string, unknown> {
  const counts = new Map<string, number>()
  const bump = (reason: string) => counts.set(reason, (counts.get(reason) ?? 0) + 1)
  for (const item of audit.queue) bump(item.reason)
  // The run-level reason is counted only when no queue item already carries it, so one disagreeing finding is one count.
  if (audit.status === 'abstained' && audit.reason && !audit.queue.some((item) => item.reason === audit.reason)) bump(audit.reason)

  const findings: Record<string, unknown>[] = []
  for (const finding of audit.findings) {
    if (finding.action !== 'valid') continue // abstain and hold are counted through the queue, never listed
    const body = governanceFinding(finding)
    // A kept finding the serializer cannot fully evidence is withheld and counted, never emitted half-formed.
    if (body) findings.push(body)
    else bump('judge_missing')
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
    versions: versionsOf(audit.versions),
    ...(audit.doctor_uid !== undefined ? { doctor_uid: audit.doctor_uid } : {}),
    ...(audit.encounter_id !== undefined ? { encounter_id: audit.encounter_id } : {}),
    ...(audit.agent_counts !== undefined ? { agent_counts: audit.agent_counts } : {}),
    // The platform wants a string here: counts as `key=n` pairs built from code constants.
    summary: [`findings=${findings.length}`, ...Object.entries(sortedCounts(byType)).map(([type, n]) => `${type}=${n}`)].join('; '),
  }
}
