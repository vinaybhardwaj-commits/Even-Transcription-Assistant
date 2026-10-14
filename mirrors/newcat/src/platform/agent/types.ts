import type { ZodType } from 'zod'
import type { GovernanceSerializer } from '../../audience/serialize.js'
import type { Sql } from '../../db/sql.js'
import type { FindingMeta, InternalAudit } from '../../pipeline/types.js'
import type { Audience, Severity } from '../../facts/schema.js'
import type { ModelTier } from '../../llm/types.js'

/** One piece of source text. Offsets the gate computes are relative to `text`. */
export interface Segment {
  id: string
  role: string
  t0?: number
  t1?: number
  text: string
}

export interface Source {
  id: string
  segments: Segment[]
}

/** What the model returns per fact. It never supplies offsets, roles or judgements. */
export interface RawFact {
  group: string
  quote: string
  segment_id: string
  [field: string]: unknown
}

/** A fact that passed the gate. Code stamped everything below `fields`. */
export type GatedFact<F> = F & {
  id: string
  group: string
  quote: string
  source_id: string
  segment_id: string
  role: string
  t0: number | null
  t1: number | null
  start: number
  end: number
}

export interface ExtractSpec<I, F> {
  tier: ModelTier
  /** Tier for the one escalation re-run. Defaults to 'sonnet'. */
  escalationTier?: ModelTier
  toolName: string
  toolDescription: string
  /** JSON schema of the forced tool input: `{ facts: [...] }`. */
  toolInputSchema: Record<string, unknown>
  maxOutputTokens: number
  buildPrompt(input: I, sources: Source[]): { system: string; user: string }
  /** Validates the agent's own fields on each raw fact. Group, quote and segment_id are checked by the gate. */
  factSchema: ZodType<F>
  /** group -> roles allowed to carry that group. A group not in the table is rejected. */
  roleTable: Record<string, string[]>
  /** Default 0.30. */
  maxDropRate?: number
}

/** Whole segments of one source, inclusive, in source order. Used to show the judge context (an absence claim). */
export interface ContextRange {
  source_id: string
  segment_from: string
  segment_to: string
}

export interface Candidate {
  /** Fact ids the candidate rests on. */
  factRefs: string[]
  summary: string
  /** Distinguishes several candidates of one rule. */
  key?: string
  /** Flat agent metadata (snake_case keys, scalar values). Copied to the finding; never sent to a judge or put in the claim. */
  meta?: FindingMeta
  /** Whole segments the judge also sees, under `context_segments` in the judge state (never in `quotes`). Out-of-source ranges drop the candidate. */
  contextRanges?: ContextRange[]
}

/**
 * What a rule may return besides a bare candidate list. `counts` is keyed only by the agent's declared `countReasons`
 * (non-negative integers, summed over rules). `empty_reason` must be one of the agent's declared `emptyReasons`; when the
 * run ends empty with no candidates, the first rule's `empty_reason` (in rule order) replaces `no_candidate_findings`.
 */
export interface RuleOutput {
  candidates: Candidate[]
  counts?: Record<string, number>
  empty_reason?: string
}

export type RuleResult = Candidate[] | RuleOutput

export function candidatesOf(result: RuleResult): Candidate[] {
  return Array.isArray(result) ? result : result.candidates
}

export interface RuleSpec<F, C = unknown> {
  id: string
  version: string
  severity: Severity
  safety_class?: boolean
  citation?: string
  enabled: boolean
  /** Template sentence for the doctor audience. Used only when the agent's doctorVisible is 'policy'. */
  doctorSentence?: string
  /**
   * Pure function of the gated facts and, when the agent defines `context`, its input-derived context. Models never score.
   * The context is for rule logic only: it never reaches a judge, the claim text, logs, `agent_runs`, `agent_findings` or any audience body.
   */
  evaluate(facts: GatedFact<F>[], ctx?: C): RuleResult
}

export interface QuestionSetRef {
  id: string
  sha: string
  question: string
}

export interface JudgeSpec {
  /** The default question set. */
  questionSet: QuestionSetRef
  /** Per-rule sets, keyed by rule id. A rule without an entry uses `questionSet`. */
  questionSets?: Record<string, QuestionSetRef>
  /** Declaring a second judge makes it mandatory: no one-judge verdict. */
  second: 'gemini' | null
  thresholds: { safety: number; nonSafety: number }
}

export interface AbstentionSpec {
  /** Closed enum, snake_case, no PHI. */
  reasons: readonly string[]
  emptyReasons: readonly string[]
}

export interface EvalGateSpec {
  fixtures: string[]
  metamorphic: string[]
  planted: string[]
  regression: string[]
}

/**
 * `jevCalls` counts asks (run.ts takes one per ask (two per candidate when a second judge is declared; the second judge's ask is not a Jev wire call)). Each ask is two wire calls, each charged on the global jev ledger
 * before the request (transport.ts). A per-run cap of N allows up to 2N ledger calls.
 */
export interface AgentBudget {
  llmCalls: number
  jevCalls: number
  clefCalls?: number
}

export type CompletenessResult = { ok: true } | { ok: false; reason: string }

/** A fact that survived the quote gate, as given to the persist hook. `fields` is the agent's own validated fields. */
export interface PersistFact {
  group: string
  fields: Record<string, unknown>
  segment_id: string
  role: string
  t0: number | null
  t1: number | null
  quote: string
}

/** What the agent's post-run persist hook receives. */
export interface PersistContext<I> {
  sql: Sql
  runId: string
  traceId: string
  /** A copy of the parsed (strict) input. */
  input: I
  /** A deep copy: changing it changes neither the returned audit nor `agent_findings`. */
  audit: InternalAudit
  /** Deep copy of the gated facts of the accepted extraction (empty when the run ended before the gate or on `extraction_unverified`). Contains quotes. */
  facts: PersistFact[]
  /** Deep copy of the gate's drop counts by reason (`counts.drops`, includes `context_out_of_range`). Counts only. */
  drops: Record<string, number>
}

export interface AgentDefinition<I, F, C = unknown> {
  id: string
  version: string
  summary: string
  modes: Array<'sync' | 'async'>
  audiences: Audience[]
  doctorVisible: 'never' | 'policy'
  input: ZodType<I>
  output: ZodType
  sources(input: I): Source[]
  completeness?(input: I): CompletenessResult
  extract: ExtractSpec<I, F>
  rules: RuleSpec<F, C>[]
  /**
   * Optional rule context: a pure function of the parsed input, plain JSON (no functions, classes or undefined). Called once per run
   * before the rules; each rule gets its own deep copy as the second argument of `evaluate`. A throw or a non-JSON value fails the run.
   */
  context?(input: I): C
  judge: JudgeSpec
  /**
   * Optional opaque ids for governance reporting, derived from the parsed input (never from model output). Each must match
   * `^[A-Za-z0-9._:-]{1,128}$` and contain no run of 8 or more digits; a value that does not is left off the audit and counted in `counts.identity_invalid`. They reach governance bodies only.
   */
  identity?(input: I): { doctor_uid?: string; encounter_id?: string }
  abstention: AbstentionSpec
  /** Closed set of reasons a rule may count without a candidate (snake_case). Sums go to audit `agent_counts`. */
  countReasons?: readonly string[]
  /** Closed set of keys a candidate's `meta` may use (slug-shaped, not identifier-like). A rule using another key fails the run (`invalid_meta_key`). Default: none. */
  metaKeys?: readonly string[]
  evalGate: EvalGateSpec
  budget: AgentBudget
  versions: Record<string, string>
  /**
   * Optional post-run hook for the agent's own tables. Runs after the platform's run rows are written, in the same job,
   * only when the status is ok, empty or abstained. A throw is caught and counted (`counts.persist_failed`), logged as a
   * code only, and never changes the returned audit (it gets copies). A hook that outlives `persistTimeoutMs` is counted the same way. May run again for a retry of the same idempotency key: keep it idempotent.
   */
  persist?(ctx: PersistContext<I>): Promise<void>
  /** Deadline for `persist` in ms (default 10000, capped at 60000). On timeout the run counts `persist_failed` and continues. */
  persistTimeoutMs?: number
  /**
   * Optional daily retention pass for the agent's own tables. The worker calls it at most once per UTC day (and once at start). Returns a count only.
   * A throw is caught by the worker and logged as a code; it never stops the worker. A hook that outlives the worker's deadline (default 30 s) is counted as a timeout. `swept` is coerced to a non-negative integer. Keep it idempotent.
   */
  retention?(ctx: { sql: Sql; now: Date }): Promise<{ swept: number }>
  /**
   * Optional projection of the parsed input that may stay at rest in `jobs.request`. For an async job the worker replaces
   * `jobs.request` with this value at completion (same UPDATE as the result); until then the full input stays, so a crash retry sees it. The run itself uses the full input. Absent: `jobs.request` is unchanged (until the 90-day sweep).
   */
  storedInput?(input: I): unknown
  /** Required when `audiences` lists governance (validateDefinition). Agent-owned code. */
  serializers?: { governance?: GovernanceSerializer }
}

/** Platform reasons every agent can emit without declaring them. */
export const PLATFORM_ABSTENTIONS = ['extraction_unverified', 'judge_disagree'] as const
export const PLATFORM_EMPTY_REASONS = ['no_candidate_findings', 'judge_dropped_all'] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentDefinition = AgentDefinition<any, any, any>
