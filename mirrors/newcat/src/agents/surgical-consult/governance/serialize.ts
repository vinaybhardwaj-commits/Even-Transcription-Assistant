import type { EvidenceQuote } from '../rules/types.js'
import { OUTCOMES, RUN_STATUSES, type AgentRunSummary, type Audience, type JudgeProbs, type Outcome, type RunStatus } from './types.js'

export interface GovernanceFinding {
  finding_type: string
  procedure_group: string
  rule_id: string
  rule_version: string
  claim: string
  evidence: EvidenceQuote[]
  judge: JudgeProbs
  models: string[]
}

export interface GovernanceRun {
  encounter_id: string
  doctor_uid: string | null
  month: string
  status: RunStatus
  abstain_reason: string | null
  findings: GovernanceFinding[]
  // Counts only, never items about a doctor.
  dropped_counts: Partial<Record<Outcome, number>>
  abstention_counts: Record<string, number>
  not_discussed_counts: Record<string, number>
}

export type GovernanceInputErrorCode = 'bad_probability' | 'bad_count' | 'bad_status' | 'bad_month' | 'bad_outcome' | 'duplicate_encounter'

export class GovernanceInputError extends Error {
  constructor(readonly code: GovernanceInputErrorCode, message: string) {
    super(message)
    this.name = 'GovernanceInputError'
  }
}

// Keyed counts live in null-prototype objects so keys like 'constructor' or '__proto__' are plain data.
// Keys are sorted so equivalent runs serialise to the same bytes.
export function sortedCounts(counts: Iterable<[string, number]>): Record<string, number> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>
  for (const [k, n] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = n
  return out
}

const validProb = (p: number | null): boolean => p === null || (Number.isFinite(p) && p >= 0 && p <= 1)
const validCount = (n: number): boolean => Number.isFinite(n) && n >= 0

export function validateRun(run: AgentRunSummary): void {
  if (!(RUN_STATUSES as readonly string[]).includes(run.status)) throw new GovernanceInputError('bad_status', `unknown run status "${String(run.status)}"`)
  if (!/^\d{4}-\d{2}$/.test(run.month)) throw new GovernanceInputError('bad_month', `month must be YYYY-MM, got "${String(run.month)}"`)
  for (const f of run.findings) {
    if (!(OUTCOMES as readonly string[]).includes(f.outcome)) throw new GovernanceInputError('bad_outcome', `unknown outcome "${String(f.outcome)}" (${f.rule_id})`)
    if (!validProb(f.judge.jev_p) || !validProb(f.judge.gemini_p)) throw new GovernanceInputError('bad_probability', `judge probabilities must be null or in [0,1] (${f.rule_id})`)
  }
  for (const [rule, n] of Object.entries(run.not_discussed_counts)) {
    if (!validCount(n)) throw new GovernanceInputError('bad_count', `not_discussed count for ${rule} must be finite and >= 0`)
  }
}

const FORBIDDEN_KEYS = new Set(['text_native', 'patient_name'])

function assertNoForbiddenKeys(v: unknown, path = '$'): void {
  if (Array.isArray(v)) return v.forEach((x, i) => assertNoForbiddenKeys(x, `${path}[${i}]`))
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) throw new Error(`governance output must not carry ${k} (at ${path})`)
      assertNoForbiddenKeys(x, `${path}.${k}`)
    }
  }
}

// Spec section 13 (V1). Every field is copied by name, so nothing new on a finding can leak through.
export function toGovernance(run: AgentRunSummary): GovernanceRun {
  validateRun(run)
  const findings: GovernanceFinding[] = []
  const dropped = new Map<string, number>()
  for (const f of run.findings) {
    if ((f.doctor_visible as unknown) !== false) throw new Error(`doctor_visible must be false (${f.rule_id})`)
    if (f.outcome !== 'kept') {
      dropped.set(f.outcome, (dropped.get(f.outcome) ?? 0) + 1)
      continue
    }
    findings.push({
      finding_type: f.finding_type,
      procedure_group: f.procedure_group,
      rule_id: f.rule_id,
      rule_version: f.rule_version,
      claim: f.claim,
      evidence: f.evidence.map((e) => ({ segment_id: e.segment_id, role: e.role, t0: e.t0, t1: e.t1, quote: e.quote })),
      judge: { jev_p: f.judge.jev_p, gemini_p: f.judge.gemini_p, agree: f.judge.agree },
      models: [...f.models],
    })
  }
  const abstained = new Map<string, number>()
  for (const a of run.abstentions) abstained.set(a.reason, (abstained.get(a.reason) ?? 0) + 1)
  const out: GovernanceRun = {
    encounter_id: run.encounter_id,
    doctor_uid: run.doctor_uid,
    month: run.month,
    status: run.status,
    abstain_reason: run.abstain_reason,
    findings,
    dropped_counts: sortedCounts(dropped) as Partial<Record<Outcome, number>>,
    abstention_counts: sortedCounts(abstained),
    not_discussed_counts: sortedCounts(Object.entries(run.not_discussed_counts)),
  }
  assertNoForbiddenKeys(out)
  return out
}

// Allowed audiences (spec section 13 V1): internal, operator, governance. Never the doctor.
export function refuseAudience(aud: Audience): void {
  if (aud === 'doctor') throw new Error('audience "doctor" is refused: this agent has no doctor-facing view')
  if (aud !== 'internal' && aud !== 'operator' && aud !== 'governance') throw new Error(`unknown audience "${String(aud)}"`)
}
