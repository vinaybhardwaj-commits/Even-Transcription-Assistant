import { beforeAll, describe, expect, it } from 'vitest'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { createApp } from '../../../src/api/http.js'
import type { Capability } from '../../../src/api/registry.js'
import { FakeModelClient } from '../../../src/llm/fake.js'
import { toCapability } from '../../../src/platform/agent/define.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { runAgent } from '../../../src/platform/agent/run.js'
import type { AgentDefinition } from '../../../src/platform/agent/types.js'
import { testApp, testEnv } from '../../helpers.js'

const AGENT = exampleEcho.id
const QUOTE_MARKER = 'zqxmarkerquote'
const INPUT_MARKER = 'zqxmarkerinput'
const INPUT = {
  segments: [
    { id: 's1', role: 'clinician' as const, text: `The sample ${QUOTE_MARKER} is blue and sealed.` },
    { id: 's2', role: 'patient' as const, text: `Unrelated ${INPUT_MARKER} remark.` },
  ],
}
const FACT = { group: 'widget_claim', quote: `${QUOTE_MARKER} is blue`, segment_id: 's1', claim: 'blue' }

const govDef = {
  ...exampleEcho,
  audiences: ['internal', 'operator', 'governance'],
  serializers: { governance: () => ({ status: 'ok', findings: [], abstentions: {} }) },
} as unknown as AgentDefinition<never, never>
const capabilities: Capability[] = [toCapability(govDef as never)]

// Direct-row marker fixtures: inserted straight into the tables so the projection, not persistRun, is under test.
const MK_AGENT = 'marker.agent'
const mkDef = { ...exampleEcho, id: MK_AGENT, audiences: ['internal', 'operator', 'governance'] } as unknown as AgentDefinition<never, never>
const mkGovDef = { ...mkDef, serializers: { governance: () => ({}) } } as unknown as AgentDefinition<never, never>
// toCapability refuses doctor, so widen the built capability the way a core capability (audit.note) lists ALL audiences.
capabilities.push({ ...toCapability(mkGovDef as never), audiences: ['internal', 'operator', 'governance', 'doctor'] })

const KEYS = [
  { name: 'k-internal', token: 'agent-run-internal-0001', scopes: [AGENT], audience: 'internal' as const },
  { name: 'k-operator', token: 'agent-run-operator-0001', scopes: [AGENT], audience: 'operator' as const },
  { name: 'k-doctor', token: 'agent-run-doctor-00001', scopes: [AGENT], audience: 'doctor' as const },
  { name: 'k-governance', token: 'agent-run-governance-01', scopes: [AGENT], audience: 'governance' as const },
  { name: 'k-noscope', token: 'agent-run-noscope-00001', scopes: ['audit.note'], audience: 'internal' as const },
  { name: 'k-other', token: 'agent-run-other-0000001', scopes: ['other.agent'], audience: 'internal' as const },
  { name: 'k-mk-internal', token: 'agent-run-mk-internal-1', scopes: [MK_AGENT], audience: 'internal' as const },
  { name: 'k-mk-governance', token: 'agent-run-mk-govern-001', scopes: [MK_AGENT], audience: 'governance' as const },
  { name: 'k-mk-doctor', token: 'agent-run-mk-doctor-001', scopes: [MK_AGENT], audience: 'doctor' as const },
{ name: 'k-ghost', token: 'agent-run-ghost-0000001', scopes: ['ghost.agent'], audience: 'internal' as const },
]
const tokenOf = (name: string) => KEYS.find((key) => key.name === name)!.token

let app: ReturnType<typeof createApp>
let runId = ''
let runStatus = ''

beforeAll(async () => {
  const built = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(KEYS) }) })
  app = createApp({ ...built.deps, capabilities })
  const models = new FakeModelClient(built.sql, () => ({ kind: 'text', text: '', toolInput: { facts: [FACT] } }))
  const audit = await runAgent(
    exampleEcho as never,
    { sql: built.sql, models, traceId: 'trace-agent-run-1', purpose: 'test', audience: 'internal', judge: new FakeJudgePort(), second: null, idempotencyKey: 'idem-agent-run-1' },
    INPUT,
  )
  runStatus = audit.status
  const row = (await built.sql.query<{ run_id: string }>('select run_id from agent_runs where agent_id = $1', [AGENT])).rows[0]!
  runId = row.run_id
  // A run that belongs to a different agent.
  await built.sql.query(
    `insert into agent_runs (run_id, agent_id, agent_version, trace_id, idempotency_key, input_sha, status, reason, versions, counts)
     values ('other-run-1','other.agent','1.0.0','t','k','sha','ok',null,'{}'::jsonb,'{}'::jsonb)`,
  )
  await built.sql.query(
    `insert into agent_runs (run_id, agent_id, agent_version, trace_id, idempotency_key, input_sha, status, reason, versions, counts)
     values ('mk-run',$1,'0.1.0','MKTRACE','MKIDEM','MKINPUTSHA','abstained','MK REASON TEXT',$2::jsonb,$3::jsonb)`,
    [
      MK_AGENT,
      JSON.stringify({ engine: 'e1', rules: 'r1', models: ['MKMODELA'], input: 'free text MKVINPUT here', nested: { quote: 'MKVQUOTE' }, judge_model: 'MKJMODEL', extractor_model: 'MKEXTMODEL', custom_version: 'v9', bad: { quote: 'MKBADOBJ' } }),
      JSON.stringify({ llm_calls: 3, drops: { a: 2, b: 'MKDROPTEXT' }, text: 'MKCOUNTTEXT', neg: -4, frac: 1.5 }),
    ],
  )
  await built.sql.query(
    `insert into agent_findings (run_id, finding_id, rule_id, rule_version, severity, safety_class, action, judge, evidence_refs)
     values ('mk-run','f-abstain','rule','1','high',true,'abstain',$1::jsonb,$2::jsonb),
            ('mk-run','f-hold','rule','1','high',true,'hold',$1::jsonb,$2::jsonb),
            ('mk-run','f-hold2','rule','1','high',true,'hold',$1::jsonb,$2::jsonb),
            ('mk-run','f-valid','rule','1','high',true,'valid',$3::jsonb,$4::jsonb)`,
    [
      JSON.stringify({ primary_p: 0.9, quote: 'MKJQUOTE', rationale: 'MKRAT' }),
      JSON.stringify([{ source_id: 's', segment_id: 'g', start: 1, end: 2, quote: 'MKEQUOTE', text: 'MKETEXT' }]),
      JSON.stringify({ primary_p: { text: 'MKNESTEDP' }, second_p: 0.8, agree: true, served_model_ids: ['MKJUDGEMODEL'], quote: 'MKJQUOTE' }),
      JSON.stringify([{ source_id: 's', segment_id: { text: 'MKREFOBJ' }, start: 1, end: 2, quote: 'MKEQUOTE' }]),
    ],
  )
})

const get = (path: string, token: string | null) =>
  app.handle(new Request(`http://newcat.test${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }))
const runPath = (agent = AGENT, id = runId) => `/v1/agents/${agent}/runs/${id}`
const errorType = async (res: Response) => ((await res.json()) as { error: { type: string } }).error.type

describe('GET /v1/agents/:agentId/runs/:runId', () => {
  it('the fixture run produced a finding', () => {
    expect(runStatus).toBe('ok')
  })

  it('requires a key', async () => {
    expect((await get(runPath(), null)).status).toBe(401)
  })

  it('returns run metadata and finding rows for an internal key', async () => {
    const res = await get(runPath(), tokenOf('k-internal'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { run: Record<string, unknown>; findings: Array<Record<string, unknown>> }
    expect(Object.keys(body.run).sort()).toEqual(
      ['agent_id', 'agent_version', 'counts', 'created_at', 'reason', 'run_id', 'status', 'versions'].sort(),
    )
    expect(body.run).toMatchObject({ run_id: runId, agent_id: AGENT, status: 'ok' })
    expect(body.findings.length).toBeGreaterThan(0)
    for (const finding of body.findings) {
      expect(Object.keys(finding).sort()).toEqual(
        ['action', 'evidence_refs', 'finding_id', 'judge', 'rule_id', 'rule_version', 'safety_class', 'severity'].sort(),
      )
      for (const ref of finding.evidence_refs as Array<Record<string, unknown>>) {
        expect(Object.keys(ref).sort()).toEqual(['end', 'segment_id', 'source_id', 'start'])
      }
    }
  })

  it('an operator key reads it too', async () => {
    expect((await get(runPath(), tokenOf('k-operator'))).status).toBe(200)
  })

  it('refuses a key whose scope lacks the agent id', async () => {
    const res = await get(runPath(), tokenOf('k-noscope'))
    expect(res.status).toBe(403)
    expect(await errorType(res)).toBe('forbidden')
  })

  it('refuses a key scoped to a different agent for this agent, and 404s that agent\'s run under it', async () => {
    expect((await get(runPath(AGENT, 'other-run-1'), tokenOf('k-other'))).status).toBe(403)
    expect((await get(runPath('other.agent', 'other-run-1'), tokenOf('k-other'))).status).toBe(404)
  })

  it('refuses the doctor audience even with the scope', async () => {
    const res = await get(runPath(), tokenOf('k-doctor'))
    expect(res.status).toBe(403)
    expect(await errorType(res)).toBe('audience_not_permitted')
  })

  it('404 for an unknown run', async () => {
    expect((await get(runPath(AGENT, 'no-such-run'), tokenOf('k-internal'))).status).toBe(404)
  })

  it('404 for another agent\'s run id under this agent', async () => {
    expect((await get(runPath(AGENT, 'other-run-1'), tokenOf('k-internal'))).status).toBe(404)
  })

  it('404 for an agent id that is not registered', async () => {
    expect((await get('/v1/agents/ghost.agent/runs/x', tokenOf('k-ghost'))).status).toBe(404)
  })

  it('refuses non-GET methods', async () => {
    const res = await app.handle(new Request(`http://newcat.test${runPath()}`, { method: 'POST', headers: { authorization: `Bearer ${tokenOf('k-internal')}` } }))
    expect(res.status).toBe(405)
  })

  it('the body never contains quote or input text (marker test)', async () => {
    for (const name of ['k-internal', 'k-operator', 'k-governance']) {
      const text = await (await get(runPath(), tokenOf(name))).text()
      expect(text.length).toBeGreaterThan(50)
      expect(text.toLowerCase()).not.toContain(QUOTE_MARKER)
      expect(text.toLowerCase()).not.toContain(INPUT_MARKER)
      expect(text).not.toContain('"quote"')
    }
  })

  it('a governance key gets no served model ids; internal and operator keep them', async () => {
    type Body = { run: { versions: Record<string, unknown> }; findings: Array<{ judge: Record<string, unknown> }> }
    const read = async (name: string) => (await (await get(runPath(), tokenOf(name))).json()) as Body
    const internal = await read('k-internal')
    const operator = await read('k-operator')
    const governance = await read('k-governance')
    expect(internal.run.versions).toHaveProperty('models')
    expect(operator.run.versions).toHaveProperty('models')
    expect(internal.findings.some((f) => 'served_model_ids' in f.judge)).toBe(true)
    expect(operator.findings.some((f) => 'served_model_ids' in f.judge)).toBe(true)
    expect(governance.run.versions).not.toHaveProperty('models')
    expect(governance.findings.length).toBe(internal.findings.length)
    for (const f of governance.findings) expect(f.judge).not.toHaveProperty('served_model_ids')
    const { models: _models, ...rest } = internal.run.versions
    expect(governance.run.versions).toEqual(rest)
    const text = await (await get(runPath(), tokenOf('k-governance'))).text()
    expect(text).not.toContain('served_model_ids')
    expect(text).not.toContain('"models"')
  })

  describe('direct-row marker projection', () => {
    const MARKERS = ['MKTRACE', 'MKIDEM', 'MKINPUTSHA', 'MK REASON', 'MKVINPUT', 'MKVQUOTE', 'MKBADOBJ', 'MKDROPTEXT', 'MKCOUNTTEXT', 'MKJQUOTE', 'MKRAT', 'MKEQUOTE', 'MKETEXT', 'MKNESTEDP', 'MKREFOBJ']
    const mk = (name: string) => get(runPath(MK_AGENT, 'mk-run'), tokenOf(name))
    type Body = {
      run: { reason: unknown; versions: Record<string, unknown>; counts: Record<string, unknown> }
      findings: Array<{ finding_id: string; action: string; judge: Record<string, unknown>; evidence_refs: Array<Record<string, unknown>> }>
      abstentions?: Record<string, number>
    }

    it('drops every marker for internal and governance keys', async () => {
      for (const name of ['k-mk-internal', 'k-mk-governance']) {
        const text = await (await mk(name)).text()
        for (const marker of MARKERS) expect(text).not.toContain(marker)
      }
    })

    it('versions keep only allowlisted keys and identifier-shaped agent keys', async () => {
      const body = (await (await mk('k-mk-internal')).json()) as Body
      expect(body.run.versions).toEqual({ engine: 'e1', rules: 'r1', models: ['MKMODELA'], judge_model: 'MKJMODEL', extractor_model: 'MKEXTMODEL', custom_version: 'v9' })
    })

    it('governance gets no model-bearing version key, whatever the agent named it', async () => {
      const text = await (await mk('k-mk-governance')).text()
      for (const marker of ['MKMODELA', 'MKJMODEL', 'MKEXTMODEL', 'MKJUDGEMODEL', 'served_model_ids', 'judge_model', 'extractor_model']) expect(text).not.toContain(marker)
      const body = JSON.parse(text) as Body
      expect(body.run.versions).toEqual({ engine: 'e1', rules: 'r1', custom_version: 'v9' })
    })

    it('counts keep non-negative integers only', async () => {
      const body = (await (await mk('k-mk-internal')).json()) as Body
      expect(body.run.counts).toEqual({ llm_calls: 3, drops: { a: 2 } })
      expect(body.run.reason).toBeNull()
    })

    it('judge and evidence ref values are type-checked', async () => {
      const body = (await (await mk('k-mk-internal')).json()) as Body
      const valid = body.findings.find((f) => f.finding_id === 'f-valid')!
      expect(valid.judge).toEqual({ second_p: 0.8, agree: true, served_model_ids: ['MKJUDGEMODEL'] })
      expect(valid.evidence_refs).toEqual([{ source_id: 's', start: 1, end: 2 }])
    })

    it('internal sees every row; governance sees valid rows and abstentions as counts by reason', async () => {
      const internal = (await (await mk('k-mk-internal')).json()) as Body
      expect(internal.findings.map((f) => f.action).sort()).toEqual(['abstain', 'hold', 'hold', 'valid'])
      expect(internal.abstentions).toBeUndefined()
      const governance = (await (await mk('k-mk-governance')).json()) as Body
      expect(governance.findings.map((f) => f.finding_id)).toEqual(['f-valid'])
      expect(governance.abstentions).toEqual({ abstain: 1, hold: 2 })
    })

    it('governance body from a fully valid run carries an empty abstentions object', async () => {
      const body = (await (await get(runPath(), tokenOf('k-governance'))).json()) as Body
      expect(body.abstentions).toEqual({})
    })

    it('doctor is refused for a capability that lists doctor', async () => {
      const res = await mk('k-mk-doctor')
      expect(res.status).toBe(403)
      expect(await errorType(res)).toBe('audience_not_permitted')
    })
  })
})
