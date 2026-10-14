import { z } from 'zod'
import type { Capability } from '../../api/registry.js'
import { sha256 } from '../../hash.js'
import { defineAgent } from '../../platform/agent/define.js'
import type { AgentDefinition, Source } from '../../platform/agent/types.js'
import { ALLOWED_ROLES, ExtractedFact } from './facts.js'
import { governanceBody } from './governance/f7.js'
import { ConsultAuditInput } from './input.js'
import { prepass } from './prepass.js'
import { MAX_CANDIDATES, RULE_SPECS } from './rules/index.js'
import { TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA, TOOL_NAME, buildPrompt } from './extract/prompt.js'
import { RULES_VERSION } from './versions.js'

/**
 * audit.consult: the surgical consult audit on the F7 template (spec sections 2 to 4, 12, 13).
 * Segment ids are opaque (`seg-NNNN`, by position in the pre-pass output), never derived from record text.
 * Judges: Jev primary (default wiring) and a Gemini second judge. No Gemini client exists yet, so `second` is null in the
 * wiring and every finding is held (judge_unavailable) until S3: correct, not a bug.
 */

export const CONSULT_AGENT_ID = 'audit.consult'
export const CONSULT_EXTRACTOR_VERSION = 'consult-extract/0.1.0'

// Neutral and closed: no assertion before the question (a leading statement biases both judges toward yes).
export const CONSULT_QUESTION = 'Do the quoted words, read as they stand, support the claim? Answer yes or no.'
export const CONSULT_QUESTION_SET = {
  id: 'consult-finding-validity',
  sha: sha256(`consult-finding-validity|${CONSULT_QUESTION}`),
  question: CONSULT_QUESTION,
} as const

// jevCalls = 2 x MAX_CANDIDATES (primary + second per candidate). MAX_CANDIDATES is derived from RULE_SPECS (every spec
// that can be enabled, indication and svw included); see rules/index.ts for the caps.
export const JEV_CALLS = 2 * MAX_CANDIDATES

export const segmentId = (index: number): string => `seg-${String(index + 1).padStart(4, '0')}`

export function consultSources(input: ConsultAuditInput): Source[] {
  const { turns } = prepass(input)
  return [
    {
      id: 's1',
      segments: turns.map((turn, i) => ({ id: segmentId(i), role: turn.role, t0: turn.t0, t1: turn.t1, text: turn.text_en })),
    },
  ]
}

export const ConsultOutput = z.object({}).passthrough()

export const surgicalConsult: AgentDefinition<ConsultAuditInput, ExtractedFact> = {
  id: CONSULT_AGENT_ID,
  version: '0.1.0',
  summary: 'Audits one surgical consult for consent gaps, pressure, patient concerns and said-vs-written mismatches. Governance review only.',
  modes: ['async'],
  audiences: ['internal', 'operator', 'governance'],
  doctorVisible: 'never',
  input: ConsultAuditInput,
  output: ConsultOutput,
  sources: consultSources,
  // I1 prepass rule: window.complete AND doctor and patient both present AND no gap > 120 s between kept turns.
  completeness(input) {
    return prepass(input).complete ? { ok: true } : { ok: false, reason: 'window_incomplete' }
  },
  extract: {
    tier: 'sonnet',
    escalationTier: 'sonnet',
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    toolInputSchema: TOOL_INPUT_SCHEMA,
    maxOutputTokens: 8192,
    buildPrompt: (_input, sources) => buildPrompt(sources),
    factSchema: ExtractedFact,
    roleTable: ALLOWED_ROLES,
    maxDropRate: 0.3,
  },
  rules: RULE_SPECS,
  judge: {
    questionSet: CONSULT_QUESTION_SET,
    second: 'gemini',
    thresholds: { safety: 0.9, nonSafety: 0.75 },
  },
  abstention: { reasons: ['window_incomplete'], emptyReasons: ['no_surgical_recommendation'] },
  evalGate: {
    fixtures: ['fixtures/surgical-consult/hernia-full-consent.json'],
    metamorphic: ['delete-consent-quote', 'role-swap'],
    planted: ['consent.risks'],
    regression: ['hernia-full-consent', 'knee-replacement-missing-consent'],
  },
  budget: { llmCalls: 2, jevCalls: JEV_CALLS, clefCalls: 0 },
  versions: { extractor: CONSULT_EXTRACTOR_VERSION, rules: RULES_VERSION },
  serializers: { governance: governanceBody },
}

export const surgicalConsultCapability: Capability = defineAgent(surgicalConsult)
