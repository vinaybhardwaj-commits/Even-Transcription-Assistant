import { beforeAll, describe, expect, it } from 'vitest'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { createApp } from '../../../src/api/http.js'
import type { Capability } from '../../../src/api/registry.js'
import { toCapability } from '../../../src/platform/agent/define.js'
import type { AgentDefinition } from '../../../src/platform/agent/types.js'
import { ABSENCE_QUESTION_SET, CONSULT_AGENT_ID, CONSULT_EXTRACTOR_VERSION, CONSULT_QUESTION_SET, surgicalConsult } from '../../../src/agents/surgical-consult/definition.js'
import { CONSENT_RULE_IDS } from '../../../src/agents/surgical-consult/rules/index.js'
import { RULES_VERSION } from '../../../src/agents/surgical-consult/versions.js'
import { sha256 } from '../../../src/hash.js'
import { ENGINE_VERSION } from '../../../src/version.js'
import { testApp, testEnv } from '../../helpers.js'

// F8-C C2: every key and string value the run read route returns passes the F7.5 wall. Synthetic marker rows only.
const AGENT = 'wall.agent'
const def = { ...exampleEcho, id: AGENT, audiences: ['internal', 'operator', 'governance'], serializers: { governance: () => ({}) } } as unknown as AgentDefinition<never, never>
const capabilities: Capability[] = [toCapability(def as never), toCapability(surgicalConsult as never)]
const KEYS = (['internal', 'operator', 'governance'] as const).map((audience) => ({ name: audience, token: `wall-key-${audience}-0001`, scopes: [AGENT, CONSULT_AGENT_ID], audience }))

interface Body {
  run: { versions: { question_sets: Record<string, string>; question_set_sha?: string; models?: string[] }; counts: unknown }
  findings: Finding[]
  abstentions: Record<string, number>
  dropped_fields: number
}
interface Finding {
  judge?: unknown
  evidence_refs?: unknown
  rule_version?: string
  severity?: string
  finding_id: string
  rule_id: string
  action: string
}

const REAL_RUN = sha256('wall-real-run').slice(0, 32)
const REAL_FID = sha256('wall-real-fid').slice(0, 16)
const DIGIT_RUN = '12345678901234567890123456789012'
const DIGIT_16 = '1234567890123456'
const DIGIT_64 = DIGIT_16.repeat(4)
let app: ReturnType<typeof createApp>
const QS = (id: string) => `${id}@${sha256(id)}`
const read = async (audience: string, runId = 'wall-run', agent = AGENT) => {
  const res = await app.handle(new Request(`http://newcat.test/v1/agents/${agent}/runs/${runId}`, { headers: { authorization: `Bearer wall-key-${audience}-0001` } }))
  return { res, text: await res.clone().text(), body: (await res.json()) as Body }
}

beforeAll(async () => {
  const built = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(KEYS) }) })
  app = createApp({ ...built.deps, capabilities })
  const run = (id: string, versions: unknown, counts: unknown, agent = AGENT) =>
    built.sql.query(
      `insert into agent_runs (run_id, agent_id, agent_version, trace_id, idempotency_key, input_sha, status, reason, versions, counts)
       values ($1,$2,'0.1.0','t','k-'||$1,'sha','ok',null,$3::jsonb,$4::jsonb)`,
      [id, agent, JSON.stringify(versions), JSON.stringify(counts)],
    )
  await run(
    'wall-run',
    {
      engine: 'MKENG the patient said',
      rules: 'MKRULES text here',
      extractor: 'MKEXT said hello',
      agent: 'MKAGENT words',
      question_set_id: 'MKQSID words',
      question_set_sha: 'MKQSSHA words',
      question_sets: { 'MK spaced key': QS('v1'), rule_ok: 'MKQSVAL a b', the_model_x: QS('v2'), patient_name: QS('v3'), ok_rule: QS('v4') },
      'MK spaced version': 'v1',
      patient_name: 'v1',
    },
    {
      llm_calls: 3,
      'MK spaced key': 4,
      patient_name: 5,
      uhid_no: 6,
      drops: { 'MK nested key': 2, phone_number: 1, fine: 7, deeper: { 'MK deep key': 1, ok: 2 } },
    },
  )
  await built.sql.query(
    `insert into agent_findings (run_id, finding_id, rule_id, rule_version, severity, safety_class, action, judge, evidence_refs) values
       ('wall-run','MK finding id','MK rule id','MK rule version','MK severity',false,'valid',$1::jsonb,$2::jsonb),
       ('wall-run','f-free','r1','1','high',false,'MK free action text',$1::jsonb,$2::jsonb),
       ('wall-run','f-hold','r1','1','high',false,'hold',$1::jsonb,$2::jsonb),
       ('wall-run','f-ok','rule.ok','v2','high',false,'valid',$3::jsonb,$4::jsonb)`,
    [
      JSON.stringify({ primary_p: 'MKJP the patient said', second_p: 'MKJS words', agree: 'MKAG words', served_model_ids: ['MKSM words'] }),
      JSON.stringify([{ source_id: 'MKSRC words', segment_id: 'MKSEG words', start: 'MKST words', end: 1 }]),
      JSON.stringify({ primary_p: 0.9, second_p: 0.8, agree: true, served_model_ids: ['model-a'] }),
      JSON.stringify([{ source_id: 'src-1', segment_id: 'seg-1', start: 1, end: 2 }]),
    ],
  )

  const fin = (run: string, fid: string, rule: string, rv: string, sev: string, action: string, judge: unknown, refs: unknown) =>
    built.sql.query(
      `insert into agent_findings (run_id, finding_id, rule_id, rule_version, severity, safety_class, action, judge, evidence_refs) values ($1,$2,$3,$4,$5,true,$6,$7::jsonb,$8::jsonb)`,
      [run, fid, rule, rv, sev, action, JSON.stringify(judge), JSON.stringify(refs)],
    )

  // Fable gate probe rows, verbatim (F8 Fable verdict condition 2).
  await run(
    'p-run',
    {
      engine: 'MKENG the patient said', rules: 'MKRULES spaced value', extractor: 'MKEXT spaced', agent: 'MKAGENT spaced', models: ['MKMODEL spaced'],
      question_set_id: 'MKQSID spaced', question_set_sha: 'MKQSSHA spaced', question_sets: { 'MK QS KEY': 'MK QS VAL spaced', 'ok.rule': 'sha', the_model_x: 'MKQSMODEL' },
      agentkey: 'tok-ok', 'MK AGENT KEY': 'x', agent_free: 'MKFREE spaced',
    },
    { 'MK SPACED COUNT KEY': 3, 'drops.MKDOT': 1, ok: 2, nested: { 'MK NESTED KEY': 1 } },
  )
  await fin('p-run', 'MK FID TEXT', 'MK RULE TEXT', 'MK RV TEXT', 'MK SEV TEXT', 'valid',
    { primary_p: 'MKJP text value', second_p: 0.5, agree: 'MKAGREE text', served_model_ids: ['MKSM text'] },
    [{ source_id: 'MKSRC text', segment_id: 'MKSEG text', start: 'MKSTART text', end: 2 }])
  await fin('p-run', 'f-act', 'r', '1', 'low', 'MK ACTION TEXT', { primary_p: 0.1 }, [])
  await fin('p-run', 'f-route', 'r', '1', 'low', 'route', { primary_p: 0.1 }, [])
  await fin('p-run', 'f-sup', 'r', '1', 'low', 'suppressed_invalid', { primary_p: 0.1 }, [])

  // Identifier-shaped values (digit runs) and wrong-typed judge/ref fields.
  await run('id-run', { patient_name: 'v1', mobile_no: 'v2', question_sets: { 'uhid.rule': QS('v'), 'rule.98765432': QS('v'), ok_rule: QS('v') }, rules: 'r1', engine: '9876543210', agent: 'uhid:98765:43210' }, { patient_name: 1, ward_no: 2, ipno: 3, x98765432: 4, fine: 5, nested: { uhid: 1, ok: 2 } })
  await fin('id-run', 'f-id', '9876543210', 'uhid:98765:43210', 'ph:98765-43210', 'valid',
    { primary_p: '9876543210', second_p: 0.4, agree: true, served_model_ids: ['98765432101'] },
    [{ source_id: '9876543210', segment_id: 'mrn:1234-5678', start: '98765.43210', end: 3 }])
  await fin('id-run', 'f-types', 'r1', '1', 'low', 'valid',
    { primary_p: 'MKtokjp', second_p: 7, agree: 'MK', served_model_ids: 'not-a-list', extra: 1 },
    [{ source_id: { a: 1 }, segment_id: ['seg'], start: -1, end: Number.NaN, extra: 'x' }, 'a string ref', ['nested']])
  await fin('id-run', 'f-nulls', 'r1', '1', 'low', 'valid', { primary_p: null, second_p: null, agree: null }, [])

  // All-digit platform hashes survive in their own fields; an all-digit value elsewhere still drops.
  await run(DIGIT_RUN, { question_set_sha: DIGIT_64, agent: DIGIT_16 }, {})
  await fin(DIGIT_RUN, DIGIT_16, 'r1', '1', 'low', 'valid', { primary_p: 0.5 }, [{ source_id: DIGIT_16, segment_id: 's1', start: 1, end: 2 }])

  // Exact persistRun shape for audit.consult, real rule ids and question set, a dated Bedrock model id.
  const consultQs = Object.fromEntries(CONSENT_RULE_IDS.map((id) => [id, `${ABSENCE_QUESTION_SET.id}@${ABSENCE_QUESTION_SET.sha}`]))
  await run(
    REAL_RUN,
    {
      extractor: CONSULT_EXTRACTOR_VERSION, rules: RULES_VERSION, agent: `${CONSULT_AGENT_ID}/${surgicalConsult.version}`, engine: ENGINE_VERSION,
      models: ['gemini-2.5-pro', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'], question_set_id: CONSULT_QUESTION_SET.id, question_set_sha: CONSULT_QUESTION_SET.sha, question_sets: consultQs,
    },
    { llm_calls: 2, judge_agree: 1, drops: { window_incomplete: 0 } },
    CONSULT_AGENT_ID,
  )
  await fin(REAL_RUN, REAL_FID, CONSENT_RULE_IDS[0]!, '0.1.0', 'high', 'valid',
    { primary_p: 0.93, second_p: 0.81, agree: true, served_model_ids: ['gemini-2.5-pro', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'] },
    [{ source_id: 's1', segment_id: 'seg-0003', start: 12, end: 48 }])
})

describe('run read route F7.5 wall', () => {
  for (const audience of ['internal', 'operator', 'governance']) {
    it(`${audience}: no MK marker anywhere in the body`, async () => {
      const { res, text } = await read(audience)
      expect(res.status).toBe(200)
      expect(text).not.toContain('MK')
      expect(text).not.toContain('patient_name')
      expect(text).not.toContain('uhid_no')
      expect(text).not.toContain('phone_number')
    })
  }

  it('drops only the failing key or value and counts it in dropped_fields', async () => {
    const { body } = await read('internal')
    expect(body.run.versions.question_sets).toEqual({ ok_rule: QS('v4'), the_model_x: QS('v2') })
    expect(body.run.counts).toEqual({ llm_calls: 3, drops: { fine: 7, deeper: { ok: 2 } } })
    expect(Number.isInteger(body.dropped_fields)).toBe(true)
    expect(body.dropped_fields).toBeGreaterThan(20)
    const ok = body.findings.find((f: Finding) => f.rule_id === 'rule.ok')
    expect(ok).toMatchObject({ finding_id: 'f-ok', rule_version: 'v2', severity: 'high', judge: { primary_p: 0.9, second_p: 0.8, agree: true, served_model_ids: ['model-a'] }, evidence_refs: [{ source_id: 'src-1', segment_id: 'seg-1', start: 1, end: 2 }] })
  })

  it('a clean run reports dropped_fields 0', async () => {
    const built = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(KEYS) }) })
    const clean = createApp({ ...built.deps, capabilities })
    await built.sql.query(
      `insert into agent_runs (run_id, agent_id, agent_version, trace_id, idempotency_key, input_sha, status, reason, versions, counts)
       values ('clean-run',$1,'0.1.0','t','k','sha','ok',null,'{"engine":"e1"}'::jsonb,'{"llm_calls":2}'::jsonb)`,
      [AGENT],
    )
    const res = await clean.handle(new Request(`http://newcat.test/v1/agents/${AGENT}/runs/clean-run`, { headers: { authorization: 'Bearer wall-key-internal-0001' } }))
    expect(((await res.json()) as { dropped_fields: number }).dropped_fields).toBe(0)
  })

  it('governance: question_sets inner keys naming a model are dropped; internal keeps them', async () => {
    expect((await read('governance')).body.run.versions.question_sets).toEqual({ ok_rule: QS('v4') })
    expect((await read('internal')).body.run.versions.question_sets.the_model_x).toBe(QS('v2'))
  })

  it('governance: an action outside the closed set becomes `other` in abstentions', async () => {
    const { body } = await read('governance')
    expect(body.abstentions).toEqual({ other: 1, hold: 1 })
    expect(body.findings.every((f: Finding) => f.action === 'valid')).toBe(true)
    expect((await read('internal')).body.findings.map((f: Finding) => f.action).sort()).toEqual(['hold', 'other', 'valid', 'valid'])
  })

  for (const audience of ['internal', 'operator', 'governance']) {
    it(`${audience}: Fable probe rows verbatim return no MK marker`, async () => {
      const { res, text, body } = await read(audience, 'p-run')
      expect(res.status).toBe(200)
      expect(text).not.toContain('MK')
      expect(body.run.versions.question_sets).toEqual({})
    })

    it(`${audience}: identifier-shaped values and wrong-typed fields are dropped and counted`, async () => {
      const { text, body } = await read(audience, 'id-run')
      for (const run of ['9876543210', '98765', '43210', '1234', '5678', '98765432101', 'patient_name', 'mobile_no', 'uhid', 'ward_no', 'ipno', 'MK']) expect(text).not.toContain(run)
      expect(body.dropped_fields).toBeGreaterThan(10)
      const typed = body.findings.find((f: Finding) => f.finding_id === 'f-types')
      expect(typed?.judge).toEqual({})
      expect(typed?.evidence_refs).toEqual([{}])
      const nulls = body.findings.find((f: Finding) => f.finding_id === 'f-nulls')
      expect(nulls?.judge).toEqual({ primary_p: null, second_p: null, agree: null })
    })

    it(`${audience}: real audit.consult persistRun shape survives whole, dropped_fields 0`, async () => {
      const { body } = await read(audience, REAL_RUN, CONSULT_AGENT_ID)
      const qs = `${ABSENCE_QUESTION_SET.id}@${ABSENCE_QUESTION_SET.sha}`
      expect(body.dropped_fields).toBe(0)
      expect(body.run.versions.question_set_sha).toBe(CONSULT_QUESTION_SET.sha)
      if (audience === 'governance') {
        expect(body.run.versions.question_sets).toEqual(Object.fromEntries(CONSENT_RULE_IDS.map((id) => [id, qs])))
        expect(body.run.versions.models).toBeUndefined()
      } else {
        expect(body.run.versions.question_sets).toEqual(Object.fromEntries(CONSENT_RULE_IDS.map((id) => [id, qs])))
        expect(body.run.versions.models).toEqual(['gemini-2.5-pro', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'])
      }
      expect(body.run).toMatchObject({ run_id: REAL_RUN, agent_id: CONSULT_AGENT_ID, reason: null })
      const judge = audience === 'governance' ? { primary_p: 0.93, second_p: 0.81, agree: true } : { primary_p: 0.93, second_p: 0.81, agree: true, served_model_ids: ['gemini-2.5-pro', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'] }
      expect(body.findings[0]).toMatchObject({ finding_id: REAL_FID, rule_id: CONSENT_RULE_IDS[0], judge, evidence_refs: [{ source_id: 's1', segment_id: 'seg-0003', start: 12, end: 48 }] })
    })
  }

  for (const audience of ['internal', 'operator', 'governance']) {
    it(`${audience}: all-digit run_id (32), finding_id (16) and question_set_sha (64) survive; all-digit agent and source_id drop`, async () => {
      const { body, text } = await read(audience, DIGIT_RUN)
      expect(body.run).toMatchObject({ run_id: DIGIT_RUN })
      expect(body.run.versions.question_set_sha).toBe(DIGIT_64)
      expect(body.findings[0]).toMatchObject({ finding_id: DIGIT_16 })
      expect((body.run.versions as Record<string, unknown>).agent).toBeUndefined()
      expect(body.findings[0]?.evidence_refs).toEqual([{ segment_id: 's1', start: 1, end: 2 }])
      expect(text).not.toContain(`"source_id":"${DIGIT_16}"`)
      expect(body.dropped_fields).toBe(2)
    })
  }

  it('dropped_fields counts a bad reason, a non-record question_sets, non-object refs and extra judge/ref keys', async () => {
    const built = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(KEYS) }) })
    const local = createApp({ ...built.deps, capabilities })
    await built.sql.query(
      `insert into agent_runs (run_id, agent_id, agent_version, trace_id, idempotency_key, input_sha, status, reason, versions, counts)
       values ('cnt-run',$1,'0.1.0','t','k','sha','ok','Bad Reason Text','{"question_sets":["x"]}'::jsonb,'{}'::jsonb)`,
      [AGENT],
    )
    await built.sql.query(
      `insert into agent_findings (run_id, finding_id, rule_id, rule_version, severity, safety_class, action, judge, evidence_refs)
       values ('cnt-run','f1','r1','1','low',false,'valid','{"extra_a":1,"extra_b":2}'::jsonb,'["str",{"extra_c":1}]'::jsonb)`,
    )
    const res = await local.handle(new Request(`http://newcat.test/v1/agents/${AGENT}/runs/cnt-run`, { headers: { authorization: 'Bearer wall-key-internal-0001' } }))
    const body = (await res.json()) as Body & { run: { reason: unknown } }
    expect(body.run.reason).toBeNull()
    // reason 1, question_sets 1, judge extras 2, string ref 1, ref extra 1.
    expect(body.dropped_fields).toBe(6)
  })
})
