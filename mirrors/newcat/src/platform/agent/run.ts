import { EmitRefusal } from '../../audience/serialize.js'
import type { Sql } from '../../db/sql.js'
import { parseModelJson } from '../../extract/parse.js'
import type { Audience } from '../../facts/schema.js'
import { sha256, stableStringify } from '../../hash.js'
import type { ModelClient, ModelCompletion, ModelTier } from '../../llm/types.js'
import type { InternalAudit, InternalDecision, InternalFinding, QueueItem } from '../../pipeline/types.js'
import { ENGINE_VERSION } from '../../version.js'
import type { SecondJudge } from '../judge/second.js'
import { RunBudget, ledgerHasHeadroom } from './budget.js'
import { buildJudgeState, JudgeUnavailable, type JudgePort } from './judge-port.js'
import { gateFacts, type GateResult } from './quote-gate.js'
import {
  PLATFORM_ABSTENTIONS,
  PLATFORM_EMPTY_REASONS,
  type AgentDefinition,
  type GatedFact,
  type RawFact,
  type RuleSpec,
} from './types.js'

export interface AgentDeps {
  sql: Sql
  models: ModelClient
  traceId: string
  purpose: string
  audience: Audience
  judge: JudgePort
  /** Required when the definition declares a second judge. A missing one means unavailable. */
  second?: SecondJudge | null
  /** Defaults to the trace id. */
  idempotencyKey?: string
}

export interface AgentCounts {
  facts_total: number
  facts_kept: number
  facts_dropped: number
  drops: Record<string, number>
  extract_attempts: number
  served_unverified: number
  rules_fired: number
  rules_disabled: number
  candidates: number
  judge_agree: number
  judge_disagree: number
  judge_dropped: number
  judge_unavailable: number
  llm_calls: number
  jev_calls: number
}

const ERR = {
  budget: { type: 'budget_exhausted', message: 'The per-run call budget is exhausted.' },
  judge: { type: 'judge_unavailable', message: 'The judge could not answer.' },
  reason: { type: 'invalid_abstention_reason', message: 'The agent produced a reason outside its closed list.' },
} as const

function newCounts(): AgentCounts {
  return {
    facts_total: 0,
    facts_kept: 0,
    facts_dropped: 0,
    drops: {},
    extract_attempts: 0,
    served_unverified: 0,
    rules_fired: 0,
    rules_disabled: 0,
    candidates: 0,
    judge_agree: 0,
    judge_disagree: 0,
    judge_dropped: 0,
    judge_unavailable: 0,
    llm_calls: 0,
    jev_calls: 0,
  }
}

interface TrailRow {
  findingId: string
  judge: { primary_p: number | null; second_p: number | null; agree: boolean | null; served_model_ids: string[] }
  evidenceRefs: Array<{ source_id: string; segment_id: string; start: number; end: number }>
}

class Stop extends Error {
  constructor(readonly audit: Partial<InternalAudit>) {
    super('run stopped')
  }
}

function readRawFacts(completion: ModelCompletion): unknown[] | null {
  let raw: unknown = completion.toolInput
  if (raw === null) {
    try {
      raw = parseModelJson(completion.text)
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const facts = (raw as { facts?: unknown }).facts
  return Array.isArray(facts) ? facts : null
}

export async function runAgent<I, F>(def: AgentDefinition<I, F>, deps: AgentDeps, rawInput: unknown): Promise<InternalAudit> {
  if (deps.audience === 'doctor' && def.doctorVisible === 'never') throw new EmitRefusal()
  if (!def.audiences.includes(deps.audience)) throw new EmitRefusal()

  // 1. strict input
  const input = def.input.parse(rawInput)
  const inputSha = sha256(stableStringify(rawInput))
  const counts = newCounts()
  const models = new Set<string>()
  const budget = new RunBudget(def.budget)
  const trail: TrailRow[] = []
  const allowedReasons = new Set<string>([...def.abstention.reasons, ...PLATFORM_ABSTENTIONS])
  const allowedEmpty = new Set<string>([...def.abstention.emptyReasons, ...PLATFORM_EMPTY_REASONS])

  const stamp = () => ({
    engine: ENGINE_VERSION,
    rules: def.versions.rules ?? `${def.id}/${def.version}`,
    extractor: def.versions.extractor ?? `${def.id}/${def.version}`,
    models: [...models],
    question_set_sha: def.judge.questionSet.sha,
  })

  const finish = async (partial: Partial<InternalAudit> & { status: InternalAudit['status'] }): Promise<InternalAudit> => {
    const audit: InternalAudit = {
      trace_id: deps.traceId,
      capability: def.id,
      capability_version: def.version,
      findings: [],
      decisions: [],
      queue: [],
      versions: stamp(),
      ...partial,
    }
    counts.llm_calls = budget.snapshot().llm
    counts.jev_calls = budget.snapshot().jev
    await persistRun(deps.sql, def, deps, inputSha, audit, counts, trail)
    return audit
  }

  const abstain = (reason: string) =>
    allowedReasons.has(reason)
      ? finish({ status: 'abstained', reason })
      : finish({ status: 'failed', error: ERR.reason })

  try {
    // 2. completeness, before any model call
    const completeness = def.completeness?.(input) ?? { ok: true as const }
    if (!completeness.ok) return await abstain(completeness.reason)

    // 3. whole-run budget check
    if (!(await ledgerHasHeadroom(deps.sql, ['llm', 'jev']))) return await finish({ status: 'failed', error: ERR.budget })

    // 4 + 5. extract and gate (one escalation re-run)
    const sources = def.sources(input)
    const maxDrop = def.extract.maxDropRate ?? 0.3
    const prompt = def.extract.buildPrompt(input, sources)
    const tool = {
      name: def.extract.toolName,
      description: def.extract.toolDescription,
      inputSchema: def.extract.toolInputSchema,
    }
    const tiers: ModelTier[] = [def.extract.tier, def.extract.escalationTier ?? 'sonnet']
    let gate: GateResult<F> | null = null
    for (const [attempt, tier] of tiers.entries()) {
      if (!budget.take('llm')) throw new Stop({ status: 'failed', error: ERR.budget })
      counts.extract_attempts += 1
      const outcome = await deps.models.complete({
        tier,
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: def.extract.maxOutputTokens,
        traceId: deps.traceId,
        purpose: attempt === 0 ? `${def.id}:extract` : `${def.id}:extract_escalation`,
        tool,
      })
      if (outcome.status !== 'ok') {
        if (outcome.status === 'refused' && outcome.error.type === 'budget_exhausted') throw new Stop({ status: 'failed', error: ERR.budget })
        if (outcome.status === 'unavailable') throw new Stop({ status: 'unavailable', error: outcome.error })
        const error = 'error' in outcome ? outcome.error : { type: 'model_failed', message: 'The model call failed.' }
        throw new Stop({ status: 'failed', error })
      }
      // A null served id is stamped as absent: never the intended id, never a placeholder.
      if (outcome.data.servedModelId === null) counts.served_unverified += 1
      else models.add(outcome.data.servedModelId)
      const rawFacts = readRawFacts(outcome.data)
      const result: GateResult<F> =
        rawFacts === null
          ? { kept: [], dropped: { schema: 1 } as GateResult<F>['dropped'], total: 1, droppedTotal: 1, dropRate: 1 }
          : gateFacts<F>(rawFacts, sources, def.extract.roleTable, (raw) => parseFields(def, raw))
      gate = result
      counts.facts_total = result.total
      counts.facts_kept = result.kept.length
      counts.facts_dropped = result.droppedTotal
      counts.drops = Object.fromEntries(Object.entries(result.dropped).filter(([, n]) => n > 0))
      if (result.dropRate <= maxDrop) break
      gate = null
    }
    if (!gate) return await abstain('extraction_unverified')

    // 6. rules
    const facts = gate.kept
    const candidates: Array<{ rule: RuleSpec<F>; summary: string; factRefs: string[]; key: string }> = []
    for (const rule of def.rules) {
      if (!rule.enabled) {
        counts.rules_disabled += 1
        continue
      }
      for (const candidate of rule.evaluate(facts)) {
        candidates.push({ rule, summary: candidate.summary, factRefs: candidate.factRefs, key: candidate.key ?? '' })
      }
      counts.rules_fired += 1
    }
    counts.candidates = candidates.length

    // 7. judge
    const findings: InternalFinding[] = []
    const decisions: InternalDecision[] = []
    const queue: QueueItem[] = []
    const byId = new Map(facts.map((fact) => [fact.id, fact] as const))
    const seen = new Set<string>()
    for (const candidate of candidates) {
      const { rule } = candidate
      const refs = [...candidate.factRefs].sort()
      const id = sha256(`${def.id}|${rule.id}|${candidate.key}|${refs.join(',')}`).slice(0, 16)
      if (seen.has(id)) continue
      seen.add(id)
      const evidenceFacts = refs.map((ref) => byId.get(ref)).filter((fact): fact is GatedFact<F> => fact !== undefined)
      const safety = rule.safety_class === true
      const threshold = safety ? def.judge.thresholds.safety : def.judge.thresholds.nonSafety
      const state = buildJudgeState(
        rule.id,
        candidate.summary,
        evidenceFacts.map((fact) => ({ role: fact.role, group: fact.group, quote: fact.quote })),
      )
      const servedIds = new Set<string>()
      const verdict = await judgeOne(def, deps, budget, state, threshold, servedIds)
      for (const served of servedIds) models.add(served)
      if (verdict.kind === 'drop') {
        counts.judge_dropped += 1
        continue
      }
      const action: InternalFinding['action'] =
        verdict.kind === 'valid' ? 'valid' : verdict.kind === 'disagree' ? 'abstain' : 'hold'
      if (verdict.kind === 'valid') counts.judge_agree += 1
      else if (verdict.kind === 'disagree') counts.judge_disagree += 1
      else counts.judge_unavailable += 1
      const doctorVisible = def.doctorVisible === 'policy' && action === 'valid' && rule.doctorSentence !== undefined
      findings.push({
        id,
        rule_id: rule.id,
        rule_version: rule.version,
        severity: rule.severity,
        safety_class: safety,
        summary: doctorVisible ? (rule.doctorSentence ?? candidate.summary) : candidate.summary,
        evidence_fact_refs: refs,
        evidence: evidenceFacts.map((fact) => ({ quote: fact.quote, start: fact.start, end: fact.end })),
        doctor_visible: doctorVisible,
        action,
      })
      decisions.push({
        id: sha256(`${id}|${def.judge.questionSet.id}`).slice(0, 16),
        finding_id: id,
        question_id: def.judge.questionSet.id,
        probabilities: verdict.kind === 'unavailable' ? {} : { yes: verdict.p },
        top_label: verdict.kind === 'unavailable' ? 'unavailable' : verdict.kind === 'valid' ? 'yes' : 'unresolved',
        top_probability: verdict.kind === 'unavailable' ? 0 : verdict.p,
        outcome: action === 'valid' ? 'resolve' : 'abstain',
        action,
        policy_id: `${def.id}/${def.version}`,
        rationale: action === 'valid' ? 'judges_agree' : action === 'abstain' ? 'judge_disagree' : 'judge_unavailable',
        safety_class: safety,
      })
      trail.push({
        findingId: id,
        judge: {
          primary_p: verdict.primary,
          second_p: verdict.second,
          agree: verdict.kind === 'valid' ? true : verdict.kind === 'disagree' ? false : null,
          served_model_ids: [...servedIds],
        },
        evidenceRefs: evidenceFacts.map((fact) => ({ source_id: fact.source_id, segment_id: fact.segment_id, start: fact.start, end: fact.end })),
      })
      if (action === 'abstain') queue.push({ finding_id: id, rule_id: rule.id, reason: 'judge_disagree' })
      if (action === 'hold') queue.push({ finding_id: id, rule_id: rule.id, reason: 'judge_unavailable' })
    }

    // 8. abstention policy
    if (findings.some((finding) => finding.action === 'valid')) return await finish({ status: 'ok', findings, decisions, queue })
    if (counts.judge_disagree > 0) return await finish({ status: 'abstained', reason: 'judge_disagree', findings, decisions, queue })
    if (counts.judge_unavailable > 0) return await finish({ status: 'unavailable', error: ERR.judge, findings, decisions, queue })
    const emptyReason = candidates.length === 0 ? 'no_candidate_findings' : 'judge_dropped_all'
    return await finish({ status: 'empty', reason: allowedEmpty.has(emptyReason) ? emptyReason : 'no_candidate_findings' })
  } catch (error) {
    if (error instanceof Stop) return finish({ ...error.audit, status: error.audit.status ?? 'failed' })
    throw error
  }
}

function parseFields<I, F>(def: AgentDefinition<I, F>, raw: RawFact): { ok: true; value: F } | { ok: false } {
  const parsed = def.extract.factSchema.safeParse(raw)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}

type Verdict = { primary: number | null; second: number | null; p: number } & (
  | { kind: 'valid' }
  | { kind: 'drop' }
  | { kind: 'disagree' }
  | { kind: 'unavailable' }
)

async function judgeOne<I, F>(
  def: AgentDefinition<I, F>,
  deps: AgentDeps,
  budget: RunBudget,
  state: unknown,
  threshold: number,
  models: Set<string>,
): Promise<Verdict> {
  const result = (kind: 'valid' | 'drop' | 'disagree' | 'unavailable', primary: number | null, second: number | null, p: number): Verdict => ({
    kind,
    primary,
    second,
    p,
  })
  const set = def.judge.questionSet
  const ask = async (call: () => Promise<{ p_yes: number; servedModelIds: string[] }>): Promise<number | null> => {
    if (!budget.take('jev')) throw new Stop({ status: 'failed', error: ERR.budget })
    try {
      const answer = await call()
      for (const id of answer.servedModelIds) models.add(id)
      return answer.p_yes
    } catch (error) {
      if (error instanceof JudgeUnavailable && error.kind === 'budget_exhausted') throw new Stop({ status: 'failed', error: ERR.budget })
      return null
    }
  }

  const primary = await ask(() => deps.judge.askValidity(state, set.question, set))
  if (primary === null) return result('unavailable', null, null, 0)
  if (def.judge.second === null) return result(primary >= threshold ? 'valid' : 'drop', primary, null, primary)

  const second = deps.second
  if (!second) return result('unavailable', primary, null, 0)
  const other = await ask(() => second.askValidity(state, set.question, set))
  if (other === null) return result('unavailable', primary, null, 0)
  const yes = [primary >= threshold, other >= threshold]
  if (yes[0] && yes[1]) return result('valid', primary, other, Math.min(primary, other))
  if (!yes[0] && !yes[1]) return result('drop', primary, other, Math.max(primary, other))
  return result('disagree', primary, other, Math.min(primary, other))
}

/** Writes the run row and one row per finding in one transaction. No input text, quote or reason text goes in. */
async function persistRun<I, F>(
  sql: Sql,
  def: AgentDefinition<I, F>,
  deps: AgentDeps,
  inputSha: string,
  audit: InternalAudit,
  counts: AgentCounts,
  trail: TrailRow[],
): Promise<void> {
  const versions = {
    ...def.versions,
    agent: `${def.id}/${def.version}`,
    engine: audit.versions.engine,
    models: audit.versions.models,
    question_set_id: def.judge.questionSet.id,
    question_set_sha: audit.versions.question_set_sha,
  }
  const key = deps.idempotencyKey ?? deps.traceId
  const runId = sha256(`${def.id}|${key}`).slice(0, 32)
  const byId = new Map(trail.map((row) => [row.findingId, row] as const))
  await sql.withTx(async (tx) => {
    const inserted = await tx.query(
      `insert into agent_runs (run_id, agent_id, agent_version, trace_id, idempotency_key, input_sha, status, reason, versions, counts)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
       on conflict (agent_id, idempotency_key) do nothing
       returning run_id`,
      [
        runId,
        def.id,
        def.version,
        deps.traceId,
        key,
        inputSha,
        audit.status,
        audit.reason ?? audit.error?.type ?? null,
        JSON.stringify(versions),
        JSON.stringify(counts),
      ],
    )
    // A retry that lost the race wrote no run row: the first run's trail stands, so write no finding rows.
    if (inserted.rows.length === 0) return
    for (const finding of audit.findings) {
      const row = byId.get(finding.id)
      await tx.query(
        `insert into agent_findings (run_id, finding_id, rule_id, rule_version, severity, safety_class, action, judge, evidence_refs)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
         on conflict (run_id, finding_id) do nothing`,
        [
          runId,
          finding.id,
          finding.rule_id,
          finding.rule_version,
          finding.severity,
          finding.safety_class,
          finding.action,
          JSON.stringify(row?.judge ?? { primary_p: null, second_p: null, agree: null, served_model_ids: [] }),
          JSON.stringify(row?.evidenceRefs ?? []),
        ],
      )
    }
  })
}
