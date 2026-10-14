import { beforeAll, describe, expect, it } from 'vitest'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { audienceAllowed } from '../../../src/auth/consumers.js'
import { assertGovernanceSafe, EmitRefusal, serialize } from '../../../src/audience/serialize.js'
import { AUDIENCES, type Audience } from '../../../src/facts/schema.js'
import type { InternalAudit } from '../../../src/pipeline/types.js'
import { toCapability, validateDefinition } from '../../../src/platform/agent/define.js'
import { postJson, testApp, testEnv, DEMO_KEYS } from '../../helpers.js'
import { GOOD_FACT, harness, reply } from '../agent/harness.js'

/** The test serializer an agent would own: projects the audit into a governance body. */
function echoGovernance(audit: InternalAudit): unknown {
  return {
    status: audit.status,
    findings: audit.findings.map((finding) => ({
      rule_id: finding.rule_id,
      action: finding.action,
      // InternalAudit evidence carries no segment id; a real agent maps it from its own sources. Fixed here.
      evidence: finding.evidence.map((item) => ({ segment_id: 's1', quote: item.quote })),
      judge: { primary_p: 0.9, second_p: null },
    })),
    abstentions: { no_segments: 0 },
  }
}

const GOOD_BODY = {
  findings: [{ action: 'valid', evidence: [{ segment_id: 's1', quote: 'q' }], judge: { primary_p: 0.8, second_p: 0.9 } }],
  abstentions: { judge_disagree: 2 },
}
const withFinding = (patch: Record<string, unknown>) => ({ ...GOOD_BODY, findings: [{ ...GOOD_BODY.findings[0], ...patch }] })

const governanceDef = { ...exampleEcho, audiences: ['internal', 'governance'] as Audience[], serializers: { governance: echoGovernance } }

let fixture: InternalAudit
beforeAll(async () => {
  fixture = await audit()
})

async function audit(): Promise<InternalAudit> {
  const h = await harness([reply([GOOD_FACT])])
  return h.run()
}

describe('allow matrix', () => {
  const EXPECTED: Record<Audience, Audience[]> = {
    internal: ['internal', 'operator', 'doctor', 'governance'],
    governance: ['governance'],
    operator: ['operator', 'doctor'],
    doctor: ['doctor'],
  }
  const pairs = AUDIENCES.flatMap((granted) => AUDIENCES.map((requested) => [granted, requested] as const))
  it('covers all 16 pairs', () => expect(pairs).toHaveLength(16))
  it.each(pairs)('granted %s requesting %s', (granted, requested) => {
    expect(audienceAllowed(granted, requested)).toBe(EXPECTED[granted].includes(requested))
  })
})

describe('governance serialize', () => {
  it('runs the agent serializer on example.echo and returns its body', async () => {
    const capability = toCapability(governanceDef)
    expect(capability.audiences).toContain('governance')
    const body = serialize(await audit(), 'governance', { governance: capability.serializers?.governance }) as { findings: unknown[] }
    expect(body.findings).toHaveLength(1)
  })

  it('refuses when no hook is supplied: governance never falls through to the internal body', () => {
    expect(() => serialize(fixture, 'governance')).toThrow(EmitRefusal)
  })

  it('refuses when the hook throws', () => {
    expect(() =>
      serialize(fixture, 'governance', {
        governance: () => {
          throw new Error('boom')
        },
      }),
    ).toThrow(EmitRefusal)
  })

  it('accepts a clean body and a body with no findings', () => {
    expect(() => assertGovernanceSafe(GOOD_BODY)).not.toThrow()
    expect(() => assertGovernanceSafe({ status: 'empty', findings: [], abstentions: {} })).not.toThrow()
  })

  it.each([
    ['not an object', 'text'],
    ['findings not an array', { findings: {} }],
    ['finding without evidence', withFinding({ evidence: [] })],
    ['evidence missing', withFinding({ evidence: undefined })],
    ['evidence item without quote', withFinding({ evidence: [{ segment_id: 's1' }] })],
    ['evidence item with empty quote', withFinding({ evidence: [{ segment_id: 's1', quote: '  ' }] })],
    ['evidence item without segment_id', withFinding({ evidence: [{ quote: 'q' }] })],
    ['finding without judge', withFinding({ judge: undefined })],
    ['judge probability out of range', withFinding({ judge: { primary_p: 1.5 } })],
    ['second probability not a number', withFinding({ judge: { primary_p: 0.5, second_p: 'x' } })],
    ['abstain finding', withFinding({ action: 'abstain' })],
    ['doctor_visible true', withFinding({ doctor_visible: true })],
    ['abstentions as a list', { ...GOOD_BODY, abstentions: [{ reason: 'x' }] }],
    ['abstentions with a non-count', { ...GOOD_BODY, abstentions: { judge_disagree: 'two' } }],
    ['banned key: prompt', { ...GOOD_BODY, prompt: 'x' }],
    ['banned key: rationale, nested', withFinding({ extra: { rationale: 'x' } })],
    ['banned key: raw model text', withFinding({ raw_model_text: 'x' })],
    ['banned key: wrong case', { ...GOOD_BODY, Prompt: 'x' }],
    ['empty object', {}],
    ['findings missing', { abstentions: {} }],
    ['abstentions missing', { findings: [] }],
    ['queue instead of findings', { queue: [{ finding_id: 'f1', reason: 'judge_disagree', action: 'abstain' }] }],
    ['items instead of findings', { items: [{ action: 'abstain', summary: 'x' }] }],
    ['decisions instead of findings', { decisions: [{ outcome: 'abstain', action: 'abstain' }] }],
    ['extra top-level key', { ...GOOD_BODY, models: ['m'] }],
    ['extra finding key', withFinding({ served_model_id: 'm' })],
    ['extra evidence key', withFinding({ evidence: [{ segment_id: 's1', quote: 'q', raw: 'x' }] })],
  ])('refuses: %s', (_name, body) => {
    expect(() => assertGovernanceSafe(body)).toThrow(EmitRefusal)
    expect(() => serialize(fixture, 'governance', { governance: () => body })).toThrow(EmitRefusal)
  })

  it('allows doctor_visible false', () => {
    expect(() => assertGovernanceSafe(withFinding({ doctor_visible: false }))).not.toThrow()
  })

  it('other audiences are unchanged for the same audit', async () => {
    const a = await audit()
    expect(() => serialize(a, 'internal')).not.toThrow()
    expect(() => serialize(a, 'operator')).not.toThrow()
  })
})

describe('governance definition', () => {
  it('validateDefinition rejects governance audiences without the serializer', () => {
    expect(() => validateDefinition({ ...exampleEcho, audiences: ['internal', 'governance'] })).toThrow(/governance/)
    expect(() => validateDefinition(governanceDef)).not.toThrow()
  })
})

describe('governance over HTTP', () => {
  const GOV_KEYS = [...DEMO_KEYS, { name: 'pulse-governance', token: 'pulse-governance-token-01', scopes: ['audit.note'], audience: 'governance' as const }]
  const envelope = (principal: string) => ({
    capability: 'audit.note',
    caller: { principal, purpose: 'opd-audit' },
    patient_ref: 'pt-synthetic-1',
    encounter_ref: 'enc-synthetic-1',
    audience: 'governance',
    idempotency_key: `idem-${Math.random().toString(16).slice(2)}abcd`,
    mode: 'sync',
    input: { source: 'opd', source_uid: 'syn-1', source_timestamp: '2026-01-01T00:00:00Z', body: 'Synthetic note.' },
  })

  it('audit.note refuses a governance request from a governance key and from an internal key (403)', async () => {
    const { app } = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(GOV_KEYS) }) })
    for (const [principal, token] of [
      ['pulse-governance', 'pulse-governance-token-01'],
      ['pulse', 'pulse-internal-token-01'],
    ] as const) {
      const response = await postJson(app, '/v1/invoke', token, envelope(principal))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { type: 'audience_not_permitted' } })
    }
  })

  it('a governance key may not request doctor or operator output', async () => {
    const { app } = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(GOV_KEYS) }) })
    const response = await postJson(app, '/v1/invoke', 'pulse-governance-token-01', { ...envelope('pulse-governance'), audience: 'doctor' })
    expect(response.status).toBe(403)
  })
})
