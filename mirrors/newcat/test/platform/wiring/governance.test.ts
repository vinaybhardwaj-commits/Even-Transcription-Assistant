import { z } from 'zod'
import { beforeAll, describe, expect, it } from 'vitest'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { audienceAllowed } from '../../../src/auth/consumers.js'
import { assertGovernanceSafe, EmitRefusal, serialize } from '../../../src/audience/serialize.js'
import { AUDIENCES, type Audience } from '../../../src/facts/schema.js'
import type { InternalAudit } from '../../../src/pipeline/types.js'
import { createApp } from '../../../src/api/http.js'
import type { Capability } from '../../../src/api/registry.js'
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
    ['judge with an extra key', withFinding({ judge: { primary_p: 0.5, reasoning: 'x' } })],
    ['judge agree not boolean', withFinding({ judge: { primary_p: 0.5, agree: 'yes' } })],
    ['judge served_model_ids not an array', withFinding({ judge: { primary_p: 0.5, served_model_ids: 'm' } })],
    ['judge served_model_ids with a non-string', withFinding({ judge: { primary_p: 0.5, served_model_ids: ['m', 1] } })],
    ['judge primary_p negative', withFinding({ judge: { primary_p: -0.1 } })],
    ['judge primary_p NaN', withFinding({ judge: { primary_p: Number.NaN } })],
    ['versions with an array value', { ...GOOD_BODY, versions: { queue: [] } }],
    ['versions not a record', { ...GOOD_BODY, versions: 'v1' }],
    ['top-level summary an object', { ...GOOD_BODY, summary: { text: 'x' } }],
    ['top-level reason a number', { ...GOOD_BODY, reason: 3 }],
    ['finding summary an object', withFinding({ summary: { text: 'x' } })],
    ['status outside the envelope set', { ...GOOD_BODY, status: 'done' }],
    ['evidence t0 negative', withFinding({ evidence: [{ segment_id: 's1', quote: 'q', t0: -1 }] })],
    ['evidence t1 a string', withFinding({ evidence: [{ segment_id: 's1', quote: 'q', t1: '4' }] })],
    ['evidence role a number', withFinding({ evidence: [{ segment_id: 's1', quote: 'q', role: 1 }] })],
    ['evidence segment_id a number', withFinding({ evidence: [{ segment_id: 7, quote: 'q' }] })],
    ['evidence quote a number', withFinding({ evidence: [{ segment_id: 's1', quote: 5 }] })],
    ['extra top-level key', { ...GOOD_BODY, models: ['m'] }],
    ['extra finding key', withFinding({ served_model_id: 'm' })],
    ['extra evidence key', withFinding({ evidence: [{ segment_id: 's1', quote: 'q', raw: 'x' }] })],
    ['trace_id an object', { ...GOOD_BODY, trace_id: { note: 'x' } }],
    ['capability a number', { ...GOOD_BODY, capability: 1 }],
    ['capability_version an array', { ...GOOD_BODY, capability_version: ['1'] }],
    ['finding id a number', withFinding({ id: 1 })],
    ['finding finding_type an object', withFinding({ finding_type: { a: 1 } })],
    ['finding rule_id an array', withFinding({ rule_id: ['x', 'y'] })],
    ['finding rule_version null', withFinding({ rule_version: null })],
    ['finding severity an object', withFinding({ severity: { note: 'x' } })],
    ['finding procedure_group a number', withFinding({ procedure_group: 3 })],
    ['abstention key free text', { ...GOOD_BODY, abstentions: { 'some free text': 1 } }],
    ['abstention key uppercase', { ...GOOD_BODY, abstentions: { Judge: 1 } }],
    ['abstention key leading digit', { ...GOOD_BODY, abstentions: { '1x': 1 } }],
    ['abstention key too long', { ...GOOD_BODY, abstentions: { ['a'.repeat(65)]: 1 } }],
  ])('refuses: %s', (_name, body) => {
    expect(() => assertGovernanceSafe(body)).toThrow(EmitRefusal)
    expect(() => serialize(fixture, 'governance', { governance: () => body })).toThrow(EmitRefusal)
  })

  describe('hook output is checked as the JSON the wire carries', () => {
    const leak = { prompt: 'leak', anything: 1 }
    class SneakyBody {
      findings: unknown[] = []
      abstentions = {}
      toJSON(): unknown {
        return leak
      }
    }
    class SneakyJudge {
      primary_p = 0.5
      toJSON(): unknown {
        return leak
      }
    }
    class SneakyEvidence {
      segment_id = 's1'
      quote = 'q'
      toJSON(): unknown {
        return leak
      }
    }
    class SneakyFinding {
      action = 'valid'
      evidence = [{ segment_id: 's1', quote: 'q' }]
      judge = { primary_p: 0.5 }
      toJSON(): unknown {
        return leak
      }
    }
    const cases: Array<[string, () => unknown]> = [
      ['toJSON at top level', () => new SneakyBody()],
      ['toJSON in judge', () => withFinding({ judge: new SneakyJudge() })],
      ['toJSON in an evidence item', () => withFinding({ evidence: [new SneakyEvidence()] })],
      ['toJSON in a finding', () => ({ ...GOOD_BODY, findings: [new SneakyFinding()] })],
      ['a getter whose value breaks the shape', () => ({ ...GOOD_BODY, get versions() { return { a: 1 } } })],
      ['a hook that returns nothing', () => undefined],
      ['a cycle', () => { const c: Record<string, unknown> = { ...GOOD_BODY }; c.self = c; return c }],
      ['a sparse served_model_ids (would go out as nulls)', () => withFinding({ judge: { primary_p: 0.5, served_model_ids: new Array(2) } })],
    ]
    it.each(cases)('refuses: %s', (_name, make) => {
      expect(() => serialize(fixture, 'governance', { governance: make })).toThrow(EmitRefusal)
    })

    it('a Map for versions is checked, and emitted, as the {} the wire carries', () => {
      const out = serialize(fixture, 'governance', { governance: () => ({ ...GOOD_BODY, versions: new Map([['a', 'b']]) }) })
      expect(out).toEqual({ ...GOOD_BODY, versions: {} })
    })

    it('returns the snapshot, not the live object', () => {
      const out = serialize(fixture, 'governance', { governance: () => GOOD_BODY })
      expect(out).toEqual(GOOD_BODY)
      expect(out).not.toBe(GOOD_BODY)
    })
  })

  it('accepts the full allowed value shapes', () => {
    const full = {
      status: 'ok',
      summary: 's',
      reason: 'r',
      versions: { engine: 'e1', rules: 'r1' },
      findings: [
        {
          action: 'valid',
          summary: 'f',
          evidence: [{ segment_id: 's1', quote: 'q', role: 'doctor', t0: 0, t1: 4.5 }],
          judge: { primary_p: 0.8, second_p: null, agree: true, served_model_ids: ['m1', 'm2'] },
        },
      ],
      abstentions: {},
    }
    expect(() => assertGovernanceSafe(full)).not.toThrow()
    for (const status of ['ok', 'empty', 'abstained', 'unavailable', 'failed']) {
      expect(() => assertGovernanceSafe({ ...full, status })).not.toThrow()
    }
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

describe('governance over HTTP, success path', () => {
  // Seam: AppDeps.capabilities overrides the registry list for the app under test; CAPABILITIES is never mutated.
  const GOV_KEYS = [
    ...DEMO_KEYS,
    { name: 'pulse-governance', token: 'pulse-governance-token-01', scopes: ['test.gov'], audience: 'governance' as const },
  ]
  const SAFE: unknown = {
    status: 'ok',
    summary: 'one finding',
    versions: { engine: 'e1' },
    findings: [
      {
        action: 'valid',
        evidence: [{ segment_id: 's1', quote: 'q', t0: 0, t1: 1 }],
        judge: { primary_p: 0.9, second_p: null, agree: true, served_model_ids: ['m1'] },
      },
    ],
    abstentions: { judge_disagree: 1 },
  }
  let body: unknown = SAFE
  const testCapability: Capability = {
    id: 'test.gov',
    version: '0.0.1',
    summary: 'test-only governance capability',
    modes: ['sync', 'async'],
    requiredScopes: ['test.gov'],
    audiences: ['internal', 'governance'],
    input: z.object({}).passthrough(),
    output: z.unknown(),
    run: async (ctx) => ({
      trace_id: ctx.traceId,
      capability: 'test.gov',
      capability_version: '0.0.1',
      status: 'ok',
      findings: [],
      decisions: [],
      queue: [],
      versions: { engine: 'e', rules: 'r', extractor: 'x', models: [], question_set_sha: 'q' },
    }),
    serializers: { governance: () => body },
  }

  const envelope = (mode: 'sync' | 'async') => ({
    capability: 'test.gov',
    caller: { principal: 'pulse-governance', purpose: 'opd-audit' },
    patient_ref: 'pt-synthetic-1',
    encounter_ref: 'enc-synthetic-1',
    audience: 'governance',
    idempotency_key: `idem-${Math.random().toString(16).slice(2)}abcd`,
    mode,
    input: {},
  })
  const TOKEN = 'pulse-governance-token-01'
  const newApp = async () => {
    const built = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(GOV_KEYS) }) })
    return { ...built, app: createApp({ ...built.deps, capabilities: [testCapability] }) }
  }
  const getJob = (app: Awaited<ReturnType<typeof newApp>>['app'], id: string) =>
    app.handle(new Request(`http://newcat.test/v1/jobs/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } }))

  it('sync: a governance key gets the agent body, unchanged', async () => {
    body = SAFE
    const { app } = await newApp()
    const response = await postJson(app, '/v1/invoke', TOKEN, envelope('sync'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(SAFE)
  })

  it('sync: an unsafe body becomes a 500 refuse_emit, not the body', async () => {
    body = { ...(SAFE as object), prompt: 'x' }
    const { app } = await newApp()
    const response = await postJson(app, '/v1/invoke', TOKEN, envelope('sync'))
    expect(response.status).toBe(500)
    const json = (await response.json()) as { error: { type: string } }
    expect(json.error.type).toBe('refuse_emit')
    expect(JSON.stringify(json)).not.toContain('prompt')
  })

  it('async: the job result is the agent body, via the job endpoint', async () => {
    body = SAFE
    const { app } = await newApp()
    const accepted = await postJson(app, '/v1/invoke', TOKEN, envelope('async'))
    expect(accepted.status).toBe(202)
    const pending = (await accepted.json()) as { job_id: string }
    await app.drain()
    const job = await getJob(app, pending.job_id)
    expect(job.status).toBe(200)
    expect(await job.json()).toEqual(SAFE)
  })

  it('async: an unsafe body is stored as a failed refuse_emit job', async () => {
    body = withFinding({ judge: { primary_p: 0.5, reasoning: 'x' } })
    const { app } = await newApp()
    const accepted = await postJson(app, '/v1/invoke', TOKEN, envelope('async'))
    const pending = (await accepted.json()) as { job_id: string }
    await app.drain()
    const job = await getJob(app, pending.job_id)
    const json = (await job.json()) as { status: string; error?: { type: string } }
    expect(json.status).toBe('failed')
    expect(json.error?.type).toBe('refuse_emit')
  })
})
