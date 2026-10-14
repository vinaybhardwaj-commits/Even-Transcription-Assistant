import { z } from 'zod'
import type { Capability } from '../../api/registry.js'
import { defineAgent } from '../../platform/agent/define.js'
import type { AgentDefinition, Source } from '../../platform/agent/types.js'

/**
 * example.echo: the toy agent. It "audits" a synthetic two-role conversation for sentences
 * a clinician said about a widget. Fixtures and fake judges only; it is NOT in src/agents/index.ts.
 */

export const EchoInput = z
  .object({
    segments: z
      .array(z.object({ id: z.string().min(1), role: z.enum(['clinician', 'patient']), text: z.string() }).strict())
      .max(50),
  })
  .strict()
export type EchoInput = z.infer<typeof EchoInput>

const EchoFact = z.object({ claim: z.string().min(1) })
type EchoFact = z.infer<typeof EchoFact>

export const EchoOutput = z.object({}).passthrough()

export const exampleEcho: AgentDefinition<EchoInput, EchoFact> = {
  id: 'example.echo',
  version: '0.1.0',
  summary: 'Toy agent: flags widget claims the clinician made. Template tests only.',
  modes: ['sync'],
  audiences: ['internal', 'operator'],
  doctorVisible: 'never',
  input: EchoInput,
  output: EchoOutput,
  sources(input): Source[] {
    return [{ id: 'conversation', segments: input.segments.map((segment) => ({ ...segment })) }]
  },
  completeness(input) {
    const spoken = input.segments.some((segment) => segment.text.trim().length > 0)
    return spoken ? { ok: true } : { ok: false, reason: 'no_segments' }
  },
  extract: {
    tier: 'haiku',
    toolName: 'record_facts',
    toolDescription: 'Record the widget claims, each with a verbatim quote and its segment id.',
    toolInputSchema: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: { group: { type: 'string' }, quote: { type: 'string' }, segment_id: { type: 'string' }, claim: { type: 'string' } },
            required: ['group', 'quote', 'segment_id', 'claim'],
          },
        },
      },
      required: ['facts'],
    },
    maxOutputTokens: 512,
    buildPrompt(_input, sources) {
      const lines = sources.flatMap((source) => source.segments.map((segment) => `[${segment.id}|${segment.role}] ${segment.text}`))
      return { system: 'Extract widget claims. Quote verbatim.', user: lines.join('\n') }
    },
    factSchema: EchoFact,
    roleTable: { widget_claim: ['clinician'] },
  },
  rules: [
    {
      id: 'echo.widget_claim',
      version: '1',
      severity: 'quality',
      enabled: true,
      evaluate: (facts) =>
        facts.filter((fact) => fact.group === 'widget_claim').map((fact) => ({ factRefs: [fact.id], summary: `Clinician stated: ${fact.claim}` })),
    },
    {
      id: 'echo.widget_safety',
      version: '1',
      severity: 'safety',
      safety_class: true,
      enabled: false,
      evaluate: () => [],
    },
  ],
  judge: {
    questionSet: { id: 'example-echo/0.1.0', sha: 'example-echo-sha-0001', question: 'Does the evidence support the claim?' },
    second: null,
    thresholds: { safety: 0.9, nonSafety: 0.75 },
  },
  abstention: { reasons: ['no_segments'], emptyReasons: ['no_widget_claims'] },
  evalGate: {
    fixtures: ['fixtures/example-echo/basic.json'],
    metamorphic: ['delete', 'role-swap'],
    planted: ['widget_claim'],
    regression: ['basic'],
  },
  budget: { llmCalls: 2, jevCalls: 4 },
  versions: { extractor: 'example-echo-extract/0.1.0', rules: 'example-echo-rules/0.1.0' },
}

export const exampleEchoCapability: Capability = defineAgent(exampleEcho)
