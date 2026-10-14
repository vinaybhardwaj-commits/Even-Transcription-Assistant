import { GovernanceInputError, sortedCounts, toGovernance, type GovernanceFinding } from './serialize.js'
import { RUN_STATUSES, type AgentRunSummary, type RunStatus } from './types.js'

// Binary cut for the kappa: jev_p >= t vs gemini_p >= t.
export const AGREEMENT_THRESHOLD = 0.75
export const SMALL_N = 3
const EXAMPLES_PER_TYPE = 3

export interface DoctorProcedureRow {
  doctor_uid: string | null
  procedure_group: string
  finding_type: string
  month: string
  n: number
  small_n: boolean
}

export interface ExampleFinding extends GovernanceFinding {
  encounter_id: string
  doctor_uid: string | null
  score: number
}

export interface Aggregate {
  by_doctor_procedure_type: DoctorProcedureRow[]
  by_type: { finding_type: string; n: number }[]
  runs_by_status: Record<RunStatus, number>
  abstention: { n_runs: number; n_abstained: number; rate: number; by_reason: Record<string, number> }
  judge_agreement: { n_both: number; n_agree: number; threshold: number; kappa: number | null }
  not_discussed_totals: Record<string, number>
  example_findings: Record<string, ExampleFinding[]>
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Cohen's kappa for two binary raters. null when undefined (no pairs, or both raters constant and equal).
export function cohenKappa(pairs: [boolean, boolean][]): number | null {
  const n = pairs.length
  if (n === 0) return null
  let aYes = 0, bYes = 0, agree = 0
  for (const [a, b] of pairs) {
    if (a) aYes++
    if (b) bYes++
    if (a === b) agree++
  }
  const po = agree / n
  const pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n)
  if (pe === 1) return null
  return (po - pe) / (1 - pe)
}

export function aggregate(runs: AgentRunSummary[]): Aggregate {
  const rows = new Map<string, DoctorProcedureRow>()
  const types = new Map<string, number>()
  const runs_by_status = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>
  const byReason = new Map<string, number>()
  const notDiscussed = new Map<string, number>()
  const seen = new Set<string>()
  const pairs: [boolean, boolean][] = []
  const candidates = new Map<string, ExampleFinding[]>()
  let nAbstained = 0

  for (const run of runs) {
    const g = toGovernance(run) // same guards as the per-run output (validation, doctor_visible, forbidden keys)
    if (seen.has(run.encounter_id)) throw new GovernanceInputError('duplicate_encounter', `duplicate encounter_id ${run.encounter_id}`)
    seen.add(run.encounter_id)
    runs_by_status[run.status]++
    // Agreement is measured over every judged finding with both probabilities, whatever its outcome: kept ones
    // are all (yes, yes) by construction, so the dropped ones are what make kappa computable. Counts only.
    for (const f of run.findings) {
      if (f.judge.jev_p !== null && f.judge.gemini_p !== null) pairs.push([f.judge.jev_p >= AGREEMENT_THRESHOLD, f.judge.gemini_p >= AGREEMENT_THRESHOLD])
    }
    if (run.status === 'abstained') {
      nAbstained++
      const reason = run.abstain_reason ?? 'unspecified'
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
    }
    for (const [rule, n] of Object.entries(g.not_discussed_counts)) notDiscussed.set(rule, (notDiscussed.get(rule) ?? 0) + n)
    for (const f of g.findings) {
      const key = JSON.stringify([run.doctor_uid, f.procedure_group, f.finding_type, run.month])
      const row = rows.get(key) ?? { doctor_uid: run.doctor_uid, procedure_group: f.procedure_group, finding_type: f.finding_type, month: run.month, n: 0, small_n: true }
      row.n++
      rows.set(key, row)
      types.set(f.finding_type, (types.get(f.finding_type) ?? 0) + 1)
      const { jev_p, gemini_p } = f.judge
      if (jev_p !== null && gemini_p !== null) {
        const list = candidates.get(f.finding_type) ?? []
        list.push({ ...f, encounter_id: run.encounter_id, doctor_uid: run.doctor_uid, score: Math.min(jev_p, gemini_p) })
        candidates.set(f.finding_type, list)
      }
    }
  }

  const doctorRows = [...rows.values()].map((r) => ({ ...r, small_n: r.n < SMALL_N }))
  doctorRows.sort(
    (a, b) =>
      (a.doctor_uid === b.doctor_uid ? 0 : a.doctor_uid === null ? 1 : b.doctor_uid === null ? -1 : cmp(a.doctor_uid, b.doctor_uid)) ||
      cmp(a.procedure_group, b.procedure_group) ||
      cmp(a.finding_type, b.finding_type) ||
      cmp(a.month, b.month),
  )

  const example_findings: Record<string, ExampleFinding[]> = {}
  for (const [type, list] of [...candidates.entries()].sort(([a], [b]) => cmp(a, b))) {
    list.sort((a, b) => b.score - a.score || cmp(a.encounter_id, b.encounter_id) || cmp(a.rule_id, b.rule_id))
    example_findings[type] = list.slice(0, EXAMPLES_PER_TYPE)
  }

  return {
    by_doctor_procedure_type: doctorRows,
    by_type: [...types.entries()].sort(([a], [b]) => cmp(a, b)).map(([finding_type, n]) => ({ finding_type, n })),
    runs_by_status,
    abstention: { n_runs: runs.length, n_abstained: nAbstained, rate: runs.length === 0 ? 0 : nAbstained / runs.length, by_reason: sortedCounts(byReason) },
    judge_agreement: {
      n_both: pairs.length,
      n_agree: pairs.filter(([a, b]) => a === b).length,
      threshold: AGREEMENT_THRESHOLD,
      kappa: cohenKappa(pairs),
    },
    not_discussed_totals: sortedCounts(notDiscussed),
    example_findings,
  }
}
