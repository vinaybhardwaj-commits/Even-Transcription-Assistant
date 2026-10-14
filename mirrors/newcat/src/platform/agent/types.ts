import type { ZodType } from 'zod'
import type { GovernanceSerializer } from '../../audience/serialize.js'
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

export interface Candidate {
  /** Fact ids the candidate rests on. */
  factRefs: string[]
  summary: string
  /** Distinguishes several candidates of one rule. */
  key?: string
}

export interface RuleSpec<F> {
  id: string
  version: string
  severity: Severity
  safety_class?: boolean
  citation?: string
  enabled: boolean
  /** Template sentence for the doctor audience. Used only when the agent's doctorVisible is 'policy'. */
  doctorSentence?: string
  /** Pure function of the gated facts. Models never score. */
  evaluate(facts: GatedFact<F>[]): Candidate[]
}

export interface QuestionSetRef {
  id: string
  sha: string
  question: string
}

export interface JudgeSpec {
  questionSet: QuestionSetRef
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

export interface AgentBudget {
  llmCalls: number
  jevCalls: number
  clefCalls?: number
}

export type CompletenessResult = { ok: true } | { ok: false; reason: string }

export interface AgentDefinition<I, F> {
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
  rules: RuleSpec<F>[]
  judge: JudgeSpec
  abstention: AbstentionSpec
  evalGate: EvalGateSpec
  budget: AgentBudget
  versions: Record<string, string>
  /** Required when `audiences` lists governance (validateDefinition). Agent-owned code. */
  serializers?: { governance?: GovernanceSerializer }
}

/** Platform reasons every agent can emit without declaring them. */
export const PLATFORM_ABSTENTIONS = ['extraction_unverified', 'judge_disagree'] as const
export const PLATFORM_EMPTY_REASONS = ['no_candidate_findings', 'judge_dropped_all'] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentDefinition = AgentDefinition<any, any>
