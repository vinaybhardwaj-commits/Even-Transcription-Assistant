import { EmitRefusal, isOpaqueId } from '../../audience/serialize.js'
import { log } from '../../log.js'
import type { Sql } from '../../db/sql.js'
import { parseModelJson } from '../../extract/parse.js'
import type { Audience } from '../../facts/schema.js'
import { sha256, stableStringify } from '../../hash.js'
import type { ModelClient, ModelCompletion, ModelTier } from '../../llm/types.js'
import type { FindingJudge, FindingMeta, InternalAudit, InternalDecision, InternalFinding, QueueItem } from '../../pipeline/types.js'
import { ENGINE_VERSION } from '../../version.js'
import type { SecondJudge } from '../judge/second.js'
import { RunBudget, ledgerHasHeadroom } from './budget.js'
import { buildJudgeState, JudgeUnavailable, type JudgeContextSegment, type JudgePort } from './judge-port.js'
import { gateFacts, type GateResult } from './quote-gate.js'
import {
  PLATFORM_ABSTENTIONS,
  PLATFORM_EMPTY_REASONS,
  candidatesOf,
  type AgentDefinition,
  type ContextRange,
  type GatedFact,
  type PersistFact,
  type QuestionSetRef,
  type RawFact,
  type RuleSpec,
  type Source,
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
  /** Present only when a declared second judge answered with an empty servedModelIds; counted per answer. */
  served_unverified_second?: number
  rules_fired: number
  rules_disabled: number
  candidates: number
  judge_agree: number
  judge_disagree: number
  judge_dropped: number
  judge_unavailable: number
  llm_calls: number
  jev_calls: number
  /** Present (as 1) only when the agent's persist hook threw. */
  persist_failed?: number
  /** Sums of rule-reported counts, keyed by the agent's declared countReasons. Present only when a rule reported some. */
  agent_counts?: Record<string, number>
  /** Present only when the agent's identity() gave a malformed id or threw; by field. The id is left off the audit. */
  identity_invalid?: { doctor_uid?: number; encounter_id?: number; threw?: number }
}

const ERR = {
  budget: { type: 'budget_exhausted', message: 'The per-run call budget is exhausted.' },
  judge: { type: 'judge_unavailable', message: 'The judge could not answer.' },
  reason: { type: 'invalid_abstention_reason', message: 'The agent produced a reason outside its closed list.' },
  context: { type: 'invalid_rule_context', message: 'The agent rule context could not be built.' },
  meta: { type: 'invalid_meta_key', message: 'A rule used a meta key outside the agent declared metaKeys.' },
  count: { type: 'invalid_agent_count', message: 'A rule reported a count outside the agent declared reasons.' },
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
  judge: FindingJudge
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
  const allowedCounts = new Set<string>(def.countReasons ?? [])
  const allowedMeta = new Set<string>(def.metaKeys ?? [])
  const allowedEmpty = new Set<string>([...def.abstention.emptyReasons, ...PLATFORM_EMPTY_REASONS])

  const opaqueIds = buildOpaqueIds(def, input, counts)
  const questionSets = questionSetStamp(def)
  // The facts that survived the quote gate of the accepted extraction; stays empty when the run ended before or without one.
  let persistFacts: PersistFact[] = []

  const stamp = () => ({
    engine: ENGINE_VERSION,
    rules: def.versions.rules ?? `${def.id}/${def.version}`,
    extractor: def.versions.extractor ?? `${def.id}/${def.version}`,
    models: [...models],
    question_set_sha: def.judge.questionSet.sha,
    ...(questionSets ? { question_sets: questionSets } : {}),
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
      ...opaqueIds,
      ...partial,
    }
    counts.llm_calls = budget.snapshot().llm
    counts.jev_calls = budget.snapshot().jev
    const runId = await persistRun(deps.sql, def, deps, inputSha, audit, counts, trail)
    await runPersistHook(def, deps, runId, input, audit, counts, persistFacts)
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
    persistFacts = facts.map(toPersistFact)
    const agentCounts: Record<string, number> = Object.create(null) as Record<string, number>
    let agentEmptyReason: string | undefined
    const ruleContext = buildRuleContext(def, input)
    const candidates: Array<{ rule: RuleSpec<F, unknown>; summary: string; factRefs: string[]; key: string; meta?: FindingMeta; context: JudgeContextSegment[] }> = []
    for (const rule of def.rules) {
      if (!rule.enabled) {
        counts.rules_disabled += 1
        continue
      }
      const output = rule.evaluate(facts, structuredClone(ruleContext))
      const list = candidatesOf(output)
      if (!Array.isArray(output)) {
        for (const [reason, n] of Object.entries(output.counts ?? {})) {
          if (!allowedCounts.has(reason) || !Number.isInteger(n) || n < 0) throw new Stop({ status: 'failed', error: ERR.count })
          if (n > 0) agentCounts[reason] = (agentCounts[reason] ?? 0) + n
        }
        if (output.empty_reason !== undefined) {
          if (!def.abstention.emptyReasons.includes(output.empty_reason)) throw new Stop({ status: 'failed', error: ERR.reason })
          agentEmptyReason ??= output.empty_reason
        }
      }
      for (const candidate of list) {
        if (candidate.meta !== undefined && Object.keys(candidate.meta).some((key) => !allowedMeta.has(key))) throw new Stop({ status: 'failed', error: ERR.meta })
        const context = resolveContext(candidate.contextRanges, sources)
        if (context === null) {
          counts.drops.context_out_of_range = (counts.drops.context_out_of_range ?? 0) + 1
          continue
        }
        candidates.push({
          context,
          rule,
          summary: candidate.summary,
          factRefs: candidate.factRefs,
          key: candidate.key ?? '',
          ...(candidate.meta !== undefined ? { meta: candidate.meta } : {}),
        })
      }
      counts.rules_fired += 1
    }
    counts.candidates = candidates.length
    if (Object.keys(agentCounts).length > 0) counts.agent_counts = { ...agentCounts }
    const counted = Object.keys(agentCounts).length > 0 ? { agent_counts: { ...agentCounts } } : {}

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
        candidate.context,
      )
      const servedIds = new Set<string>()
      const set = def.judge.questionSets?.[rule.id] ?? def.judge.questionSet
      const verdict = await judgeOne(deps, def.judge.second, budget, state, threshold, servedIds, set, counts)
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
      const judge: FindingJudge = {
        primary_p: verdict.primary,
        second_p: verdict.second,
        agree: verdict.kind === 'valid' ? true : verdict.kind === 'disagree' ? false : null,
        served_model_ids: [...servedIds],
      }
      const doctorVisible = def.doctorVisible === 'policy' && action === 'valid' && rule.doctorSentence !== undefined
      findings.push({
        id,
        rule_id: rule.id,
        rule_version: rule.version,
        severity: rule.severity,
        safety_class: safety,
        summary: doctorVisible ? (rule.doctorSentence ?? candidate.summary) : candidate.summary,
        evidence_fact_refs: refs,
        evidence: evidenceFacts.map((fact) => ({
          quote: fact.quote,
          start: fact.start,
          end: fact.end,
          segment_id: fact.segment_id,
          role: fact.role,
          ...(fact.t0 !== null ? { t0: fact.t0 } : {}),
          ...(fact.t1 !== null ? { t1: fact.t1 } : {}),
        })),
        doctor_visible: doctorVisible,
        judge,
        ...(candidate.meta !== undefined ? { meta: { ...candidate.meta } } : {}),
        action,
      })
      decisions.push({
        id: sha256(`${id}|${set.id}`).slice(0, 16),
        finding_id: id,
        question_id: set.id,
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
        judge,
        evidenceRefs: evidenceFacts.map((fact) => ({ source_id: fact.source_id, segment_id: fact.segment_id, start: fact.start, end: fact.end })),
      })
      if (action === 'abstain') queue.push({ finding_id: id, rule_id: rule.id, reason: 'judge_disagree' })
      if (action === 'hold') queue.push({ finding_id: id, rule_id: rule.id, reason: 'judge_unavailable' })
    }

    // 8. abstention policy
    if (findings.some((finding) => finding.action === 'valid')) return await finish({ status: 'ok', findings, decisions, queue, ...counted })
    if (counts.judge_disagree > 0) return await finish({ status: 'abstained', reason: 'judge_disagree', findings, decisions, queue, ...counted })
    if (counts.judge_unavailable > 0) return await finish({ status: 'unavailable', error: ERR.judge, findings, decisions, queue, ...counted })
    const emptyReason = candidates.length === 0 ? (agentEmptyReason ?? 'no_candidate_findings') : 'judge_dropped_all'
    return await finish({ status: 'empty', reason: allowedEmpty.has(emptyReason) ? emptyReason : 'no_candidate_findings', ...counted })
  } catch (error) {
    if (error instanceof Stop) return finish({ ...error.audit, status: error.audit.status ?? 'failed' })
    throw error
  }
}

const PERSIST_STATUSES = new Set<InternalAudit['status']>(['ok', 'empty', 'abstained'])

const DEFAULT_PERSIST_TIMEOUT_MS = 10_000
const MAX_PERSIST_TIMEOUT_MS = 60_000

/**
 * Calls the agent's persist hook with a deep copy of the audit and the input, so nothing it does (mutate, throw, reject,
 * hang past `persistTimeoutMs`) reaches the caller or changes the audit.
 */
async function runPersistHook<I, F>(
  def: AgentDefinition<I, F>,
  deps: AgentDeps,
  runId: string,
  input: I,
  audit: InternalAudit,
  counts: AgentCounts,
  facts: PersistFact[],
): Promise<void> {
  if (!def.persist || !PERSIST_STATUSES.has(audit.status)) return
  const wanted = def.persistTimeoutMs
  const limit = typeof wanted === 'number' && Number.isFinite(wanted) ? Math.min(Math.max(wanted, 1), MAX_PERSIST_TIMEOUT_MS) : DEFAULT_PERSIST_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  try {
    // Promise.resolve: a hook that returns a plain value (not a promise) is awaited normally.
    const hook = Promise.resolve(def.persist({ sql: deps.sql, runId, traceId: deps.traceId, input: structuredClone(input), audit: structuredClone(audit), facts: structuredClone(facts), drops: structuredClone(counts.drops) }))
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('persist_timeout')), limit)
    })
    // A hook that settles late must not raise an unhandled rejection.
    hook.catch(() => undefined)
    await Promise.race([hook, deadline])
  } catch {
    counts.persist_failed = 1
    log('warn', 'agent.persist', { capability: def.id, trace_id: deps.traceId, error_type: 'persist_failed' })
    try {
      await deps.sql.query('update agent_runs set counts = $1::jsonb where run_id = $2 and trace_id = $3', [JSON.stringify(counts), runId, deps.traceId])
    } catch {
      // The count is best effort: the log line above is the record.
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** `rule id -> id@sha` for the per-rule sets; undefined (key absent) for a default-set-only agent. One value for audit.versions and agent_runs.versions. */
function questionSetStamp<I, F>(def: AgentDefinition<I, F>): Record<string, string> | undefined {
  const sets = def.judge.questionSets
  if (!sets || Object.keys(sets).length === 0) return undefined
  return Object.fromEntries(Object.entries(sets).map(([rule, set]) => [rule, `${set.id}@${set.sha}`]))
}

const PLATFORM_FACT_KEYS = new Set(['id', 'group', 'quote', 'source_id', 'segment_id', 'role', 't0', 't1', 'start', 'end'])

/** A gated fact as the persist hook sees it: platform-stamped location plus the agent's own fields. */
function toPersistFact<F>(fact: GatedFact<F>): PersistFact {
  const fields = Object.fromEntries(Object.entries(fact).filter(([key]) => !PLATFORM_FACT_KEYS.has(key)))
  return { group: fact.group, fields, segment_id: fact.segment_id, role: fact.role, t0: fact.t0, t1: fact.t1, quote: fact.quote }
}

function bumpIdentityInvalid(counts: AgentCounts, field: 'doctor_uid' | 'encounter_id' | 'threw'): void {
  const by = (counts.identity_invalid ??= {})
  by[field] = (by[field] ?? 0) + 1
}

/** Only the agent sets these, from its parsed input. A throw or a malformed value leaves the id off. */
function buildOpaqueIds<I, F>(def: AgentDefinition<I, F, unknown>, input: I, counts: AgentCounts): { doctor_uid?: string; encounter_id?: string } {
  if (!def.identity) return {}
  try {
    const raw = def.identity(structuredClone(input))
    const out: { doctor_uid?: string; encounter_id?: string } = {}
    for (const key of ['doctor_uid', 'encounter_id'] as const) {
      const value = raw[key]
      if (value === undefined) continue
      if (isOpaqueId(value)) out[key] = value as string
      else bumpIdentityInvalid(counts, key)
    }
    return out
  } catch {
    bumpIdentityInvalid(counts, 'threw')
    return {}
  }
}

/** The context is plain JSON by contract: anything else (a throw, a function, a cycle, undefined) fails the run with a fixed error. */
function buildRuleContext<I, F>(def: AgentDefinition<I, F, unknown>, input: I): unknown {
  if (!def.context) return undefined
  try {
    const built = def.context(structuredClone(input))
    return built === undefined ? undefined : JSON.parse(JSON.stringify(built))
  } catch {
    throw new Stop({ status: 'failed', error: ERR.context })
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

/** Resolves context ranges to whole segments of their source. Null when any range is outside the sources. */
function resolveContext(ranges: ContextRange[] | undefined, sources: Source[]): JudgeContextSegment[] | null {
  const out: JudgeContextSegment[] = []
  for (const range of ranges ?? []) {
    const source = sources.filter((candidate) => candidate.id === range.source_id)
    if (source.length !== 1) return null
    const segments = source[0]!.segments
    const from = segments.findIndex((segment) => segment.id === range.segment_from)
    const to = segments.findIndex((segment) => segment.id === range.segment_to)
    if (from < 0 || to < 0 || from > to) return null
    for (const segment of segments.slice(from, to + 1)) {
      if (!out.some((seen) => seen.source_id === range.source_id && seen.segment_id === segment.id)) {
        out.push({ source_id: range.source_id, segment_id: segment.id, role: segment.role, text: segment.text })
      }
    }
  }
  return out
}

async function judgeOne(
  deps: AgentDeps,
  secondDeclared: 'gemini' | null,
  budget: RunBudget,
  state: unknown,
  threshold: number,
  models: Set<string>,
  set: QuestionSetRef,
  counts: AgentCounts,
): Promise<Verdict> {
  const result = (kind: 'valid' | 'drop' | 'disagree' | 'unavailable', primary: number | null, second: number | null, p: number): Verdict => ({
    kind,
    primary,
    second,
    p,
  })
  const ask = async (call: () => Promise<{ p_yes: number; servedModelIds: string[] }>, isSecond = false): Promise<number | null> => {
    if (!budget.take('jev')) throw new Stop({ status: 'failed', error: ERR.budget })
    try {
      const answer = await call()
      for (const id of answer.servedModelIds) models.add(id)
      if (isSecond && answer.servedModelIds.length === 0) counts.served_unverified_second = (counts.served_unverified_second ?? 0) + 1
      return answer.p_yes
    } catch (error) {
      if (error instanceof JudgeUnavailable && error.kind === 'budget_exhausted') throw new Stop({ status: 'failed', error: ERR.budget })
      return null
    }
  }

  const primary = await ask(() => deps.judge.askValidity(state, set.question, set))
  if (primary === null) return result('unavailable', null, null, 0)
  if (secondDeclared === null) return result(primary >= threshold ? 'valid' : 'drop', primary, null, primary)

  const second = deps.second
  if (!second) return result('unavailable', primary, null, 0)
  const other = await ask(() => second.askValidity(state, set.question, set), true)
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
): Promise<string> {
  const versions = {
    ...def.versions,
    agent: `${def.id}/${def.version}`,
    engine: audit.versions.engine,
    models: audit.versions.models,
    question_set_id: def.judge.questionSet.id,
    question_set_sha: audit.versions.question_set_sha,
    ...(audit.versions.question_sets ? { question_sets: audit.versions.question_sets } : {}),
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
  return runId
}
