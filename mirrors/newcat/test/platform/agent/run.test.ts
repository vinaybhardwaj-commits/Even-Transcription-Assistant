import { describe, expect, it } from 'vitest'
import { httpStatusFor } from '../../../src/api/schema.js'
import { EmitRefusal, serialize } from '../../../src/audience/serialize.js'
import { FakeModelClient } from '../../../src/llm/fake.js'
import type { ModelClient } from '../../../src/llm/types.js'
import { setBudgetMax } from '../../../src/llm/ledger.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { FakeSecondJudge } from '../../../src/platform/judge/second.js'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { asJson } from '../../../src/db/sql.js'
import { CONVERSATION, GOOD_FACT, harness, reply, withJudge } from './harness.js'

const BAD_FACT = { group: 'widget_claim', quote: 'never said this', segment_id: 's1', claim: 'x' }
const WRONG_ROLE = { group: 'widget_claim', quote: 'widget is red', segment_id: 's2', claim: 'red' }

async function modelCalls(h: Awaited<ReturnType<typeof harness>>): Promise<number> {
  const rows = await h.sql.query<{ n: number }>('select count(*)::int as n from model_calls')
  return Number(rows.rows[0]?.n)
}

describe('run order', () => {
  it('complete input: extract, gate, rule, judge, ok', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run()
    expect(audit.status).toBe('ok')
    expect(audit.capability).toBe('example.echo')
    expect(audit.findings).toHaveLength(1)
    expect(audit.findings[0]).toMatchObject({ rule_id: 'echo.widget_claim', action: 'valid', doctor_visible: false })
    expect(audit.findings[0]!.evidence[0]).toMatchObject({ quote: 'widget is blue', start: 11, end: 25 })
    expect(audit.versions.models).toEqual(expect.arrayContaining(['fake.judge-1']))
    expect(h.judge.calls).toHaveLength(1)
  })

  it('incomplete input abstains with the agent reason and makes no model call', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run({ segments: [{ id: 's1', role: 'clinician', text: '   ' }] })
    expect(audit).toMatchObject({ status: 'abstained', reason: 'no_segments' })
    expect(await modelCalls(h)).toBe(0)
    expect(h.requests).toHaveLength(0)
    expect(h.judge.calls).toHaveLength(0)
  })

  it('rejects input with unknown keys', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await expect(h.run({ segments: [], extra: 1 })).rejects.toThrow()
  })

  it('a completeness reason outside the closed list fails instead of leaking text', async () => {
    const h = await harness([reply([])])
    const def = { ...exampleEcho, completeness: () => ({ ok: false as const, reason: 'Patient name missing' }) }
    const audit = await h.run(CONVERSATION, {}, def as never)
    expect(audit).toMatchObject({ status: 'failed', error: { type: 'invalid_abstention_reason' } })
  })

  it('counts a disabled rule and never runs it', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await h.run()
    const row = (await h.sql.query<{ counts: unknown }>('select counts from agent_runs')).rows[0]!
    expect(asJson<Record<string, number>>(row.counts)).toMatchObject({ rules_disabled: 1, rules_fired: 1, candidates: 1, judge_agree: 1 })
  })

  it('empty when no rule fires', async () => {
    const h = await harness([reply([])])
    expect(await h.run()).toMatchObject({ status: 'empty', reason: 'no_candidate_findings' })
  })
})

describe('gate drop rate', () => {
  it('a wrong-role fact and a missing quote are dropped; one clean fact survives under the limit', async () => {
    const h = await harness([reply([GOOD_FACT, GOOD_FACT, GOOD_FACT, WRONG_ROLE])])
    const audit = await h.run()
    expect(audit.status).toBe('ok')
    expect(h.requests).toHaveLength(1)
  })

  it('drop rate above the limit escalates once, and the escalation can recover', async () => {
    const h = await harness([reply([BAD_FACT, GOOD_FACT]), reply([GOOD_FACT])])
    const audit = await h.run()
    expect(audit.status).toBe('ok')
    expect(h.requests.map((request) => request.tier)).toEqual(['haiku', 'sonnet'])
  })

  it('two failed attempts abstain with extraction_unverified and do not reach the judge', async () => {
    const h = await harness([reply([BAD_FACT, GOOD_FACT]), reply([BAD_FACT, WRONG_ROLE])])
    const audit = await h.run()
    expect(audit).toMatchObject({ status: 'abstained', reason: 'extraction_unverified' })
    expect(h.requests).toHaveLength(2)
    expect(h.judge.calls).toHaveLength(0)
  })

  it('a non-object tool payload counts as a failed extraction', async () => {
    const h = await harness([{ kind: 'text', text: 'NOT_JSON' }])
    const audit = await h.run()
    expect(audit).toMatchObject({ status: 'abstained', reason: 'extraction_unverified' })
  })

  it('model outage is unavailable, not a guess', async () => {
    const h = await harness([{ kind: 'throw' }])
    expect(await h.run()).toMatchObject({ status: 'unavailable', error: { type: 'model_unavailable' } })
  })
})

describe('judges', () => {
  it('a judge below threshold drops the finding and counts it', async () => {
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.2))
    expect(await h.run()).toMatchObject({ status: 'empty', reason: 'judge_dropped_all' })
  })

  it('two judges that agree keep the finding', async () => {
    const second = new FakeSecondJudge(() => 0.95)
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.95), second)
    const audit = await h.run(CONVERSATION, { second }, withJudge('gemini'))
    expect(audit.status).toBe('ok')
    expect(second.calls).toHaveLength(1)
  })

  it('one yes and one no abstains with judge_disagree and queues the finding', async () => {
    const second = new FakeSecondJudge(() => 0.1)
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.95), second)
    const audit = await h.run(CONVERSATION, { second }, withJudge('gemini'))
    expect(audit).toMatchObject({ status: 'abstained', reason: 'judge_disagree' })
    expect(audit.findings[0]).toMatchObject({ action: 'abstain' })
    expect(audit.queue).toEqual([expect.objectContaining({ reason: 'judge_disagree' })])
  })

  it('both below threshold drops, no abstention', async () => {
    const second = new FakeSecondJudge(() => 0.1)
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.1), second)
    expect(await h.run(CONVERSATION, { second }, withJudge('gemini'))).toMatchObject({ status: 'empty', reason: 'judge_dropped_all' })
  })

  it('an unavailable second judge never yields a one-judge verdict', async () => {
    const second = new FakeSecondJudge(() => null)
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.99), second)
    const audit = await h.run(CONVERSATION, { second }, withJudge('gemini'))
    expect(audit.status).toBe('unavailable')
    expect(audit.findings.every((finding) => finding.action === 'hold')).toBe(true)
    expect(audit.queue).toEqual([expect.objectContaining({ reason: 'judge_unavailable' })])
  })

  it('a declared second judge that is not wired is unavailable', async () => {
    const h = await harness([reply([GOOD_FACT])])
    expect((await h.run(CONVERSATION, {}, withJudge('gemini'))).status).toBe('unavailable')
  })

  it('an unavailable primary judge holds the finding', async () => {
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => null))
    expect((await h.run()).status).toBe('unavailable')
  })

  it('safety rules use the safety threshold', async () => {
    const def = {
      ...exampleEcho,
      rules: [{ ...exampleEcho.rules[0]!, safety_class: true }],
    }
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.8))
    expect((await h.run(CONVERSATION, {}, def as never)).status).toBe('empty')
    const lenient = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.8))
    expect((await lenient.run()).status).toBe('ok')
  })
})

describe('budget', () => {
  it('stops with budget_exhausted when the per-run llm cap is hit before the escalation', async () => {
    const h = await harness([reply([BAD_FACT, GOOD_FACT]), reply([GOOD_FACT])])
    const def = { ...exampleEcho, budget: { llmCalls: 1, jevCalls: 4 } }
    const audit = await h.run(CONVERSATION, {}, def as never)
    expect(audit).toMatchObject({ status: 'failed', error: { type: 'budget_exhausted' } })
    expect(h.requests).toHaveLength(1)
  })

  it('stops when the per-run jev cap is zero, before any judge call', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const def = { ...exampleEcho, budget: { llmCalls: 2, jevCalls: 0 } }
    expect(await h.run(CONVERSATION, {}, def as never)).toMatchObject({ status: 'failed', error: { type: 'budget_exhausted' } })
    expect(h.judge.calls).toHaveLength(0)
  })

  it('stops before any model call when the global ledger is spent', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await setBudgetMax(h.sql, 'llm', 0)
    expect(await h.run()).toMatchObject({ status: 'failed', error: { type: 'budget_exhausted' } })
    expect(h.requests).toHaveLength(0)
  })

  it('maps to 429 through the existing status path', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const def = { ...exampleEcho, budget: { llmCalls: 0, jevCalls: 0 } }
    const audit = await h.run(CONVERSATION, {}, def as never)
    const body = serialize(audit, 'internal') as { status: string; error: { type: string } }
    expect(body).toMatchObject({ status: 'failed', error: { type: 'budget_exhausted' } })
    expect(httpStatusFor(body)).toBe(429)
  })
})

describe('audience', () => {
  it('refuses the doctor audience when doctorVisible is never', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await expect(h.run(CONVERSATION, { audience: 'doctor' })).rejects.toBeInstanceOf(EmitRefusal)
    expect(h.requests).toHaveLength(0)
  })

  it('refuses an audience outside the ceiling', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const def = { ...exampleEcho, audiences: ['internal'] }
    await expect(h.run(CONVERSATION, { audience: 'operator' }, def as never)).rejects.toBeInstanceOf(EmitRefusal)
  })

  it('policy agents show doctor text only from the rule template sentence', async () => {
    const def = {
      ...exampleEcho,
      doctorVisible: 'policy' as const,
      audiences: ['internal', 'operator', 'doctor'],
      rules: [{ ...exampleEcho.rules[0]!, doctorSentence: 'Please confirm the widget statement.' }],
    }
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, { audience: 'doctor' }, def as never)
    expect(audit.findings[0]).toMatchObject({ doctor_visible: true, summary: 'Please confirm the widget statement.' })
    const body = serialize(audit, 'doctor')
    expect((body as { findings: Array<{ summary: string }> }).findings[0]?.summary).toBe('Please confirm the widget statement.')
  })

  it('an internal audit serializes for operator without the doctor path', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run()
    expect(() => serialize(audit, 'operator')).not.toThrow()
    expect(serialize(audit, 'doctor')).toMatchObject({ status: 'empty' })
  })
})

describe('agent_runs', () => {
  it('writes one metadata row with no input text, quotes or reasons carrying text', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run()
    const rows = await h.sql.query<Record<string, unknown>>('select * from agent_runs')
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]!
    expect(row).toMatchObject({ agent_id: 'example.echo', agent_version: '0.1.0', trace_id: audit.trace_id, status: 'ok' })
    expect(String(row.input_sha)).toMatch(/^[0-9a-f]{64}$/)
    const dump = JSON.stringify(row)
    for (const text of ['blue', 'sealed', 'widget is', 'I think', 'Clinician stated']) expect(dump).not.toContain(text)
    expect(asJson<Record<string, unknown>>(row.versions)).toMatchObject({
      agent: 'example.echo/0.1.0',
      question_set_sha: 'example-echo-sha-0001',
      models: expect.arrayContaining(['fake.anthropic.claude-haiku-4-5']),
    })
  })

  it('records abstentions and failures too, and is idempotent per key', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await h.run({ segments: [] }, { idempotencyKey: 'k1' })
    await h.run({ segments: [] }, { idempotencyKey: 'k1' })
    const rows = await h.sql.query<{ status: string; reason: string }>('select status, reason from agent_runs')
    expect(rows.rows).toEqual([{ status: 'abstained', reason: 'no_segments' }])
  })

  it('stores no drop text: only counts per reason', async () => {
    const h = await harness([reply([BAD_FACT, GOOD_FACT]), reply([BAD_FACT, GOOD_FACT])])
    await h.run()
    const row = (await h.sql.query<{ counts: unknown }>('select counts from agent_runs')).rows[0]!
    const counts = asJson<{ drops: Record<string, number> }>(row.counts)
    expect(counts.drops).toEqual({ quote_not_in_segment: 1 })
    expect(JSON.stringify(row)).not.toContain('never said this')
  })
})

describe('agent_findings', () => {
  const SECRETS = ['blue', 'sealed', 'widget is', 'I think', 'Clinician stated']

  it('writes one row per finding with judge detail and position-only evidence refs', async () => {
    const second = new FakeSecondJudge(() => 0.9)
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.95), second)
    const audit = await h.run(CONVERSATION, { second }, withJudge('gemini'))
    const rows = await h.sql.query<Record<string, unknown>>('select * from agent_findings')
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]!
    const run = (await h.sql.query<{ run_id: string }>('select run_id from agent_runs')).rows[0]!
    expect(row).toMatchObject({
      run_id: run.run_id,
      finding_id: audit.findings[0]!.id,
      rule_id: 'echo.widget_claim',
      rule_version: '1',
      severity: 'quality',
      safety_class: false,
      action: 'valid',
    })
    expect(asJson(row.judge)).toEqual({
      primary_p: 0.95,
      second_p: 0.9,
      agree: true,
      served_model_ids: expect.arrayContaining(['fake.judge-1', 'fake-second-model']),
    })
    expect(asJson(row.evidence_refs)).toEqual([{ source_id: 'conversation', segment_id: 's1', start: 11, end: 25 }])
  })

  it('records disagree and hold findings too', async () => {
    const second = new FakeSecondJudge(() => 0.1)
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.95), second)
    await h.run(CONVERSATION, { second }, withJudge('gemini'))
    const row = (await h.sql.query<Record<string, unknown>>('select action, judge from agent_findings')).rows[0]!
    expect(row.action).toBe('abstain')
    expect(asJson(row.judge)).toMatchObject({ primary_p: 0.95, second_p: 0.1, agree: false })
    const held = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => null))
    await held.run()
    const hold = (await held.sql.query<Record<string, unknown>>('select action, judge from agent_findings')).rows[0]!
    expect(hold.action).toBe('hold')
    expect(asJson(hold.judge)).toMatchObject({ primary_p: null, agree: null })
  })

  it('holds no quote or input text in any column', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await h.run()
    const rows = await h.sql.query<Record<string, unknown>>('select * from agent_findings')
    expect(rows.rows).toHaveLength(1)
    const dump = JSON.stringify(rows.rows)
    for (const text of SECRETS) expect(dump).not.toContain(text)
  })

  it('a retry under the same idempotency key keeps one run row and one finding row', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await h.run(CONVERSATION, { idempotencyKey: 'retry-1' })
    await h.run(CONVERSATION, { idempotencyKey: 'retry-1' })
    expect((await h.sql.query('select 1 from agent_runs')).rows).toHaveLength(1)
    expect((await h.sql.query('select 1 from agent_findings')).rows).toHaveLength(1)
  })

  it('writes no finding rows for a run without findings', async () => {
    const h = await harness([reply([])])
    await h.run()
    expect((await h.sql.query('select 1 from agent_findings')).rows).toHaveLength(0)
    expect((await h.sql.query('select 1 from agent_runs')).rows).toHaveLength(1)
  })
})

describe('reasons', () => {
  it('every reason an agent can emit is a closed snake_case identifier', () => {
    const all = [...exampleEcho.abstention.reasons, ...exampleEcho.abstention.emptyReasons]
    expect(all.length).toBeGreaterThan(0)
    for (const reason of all) expect(reason).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})

describe('unverified served model', () => {
  it('a null served id is left out of versions.models and counted, never replaced by the intended id', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const fake = new FakeModelClient(h.sql, () => reply([GOOD_FACT]))
    const intended: string[] = []
    const models: ModelClient = {
      async complete(request) {
        const outcome = await fake.complete(request)
        if (outcome.status !== 'ok') return outcome
        intended.push(outcome.data.intendedModelId)
        return { status: 'ok', data: { ...outcome.data, servedModelId: null } }
      },
    } as ModelClient
    const audit = await h.run(CONVERSATION, { models })
    expect(audit.status).toBe('ok')
    expect(intended).toHaveLength(1)
    for (const id of audit.versions.models) expect(id).not.toBe(intended[0])
    expect(audit.versions.models).toEqual(['fake.judge-1'])
    const row = (await h.sql.query<{ counts: unknown; versions: unknown }>('select counts, versions from agent_runs')).rows[0]!
    expect(asJson<Record<string, number>>(row.counts)).toMatchObject({ served_unverified: 1 })
    expect(JSON.stringify(asJson(row.versions))).not.toContain(intended[0]!)
  })
})
