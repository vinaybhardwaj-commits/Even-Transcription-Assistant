import { describe, expect, it } from 'vitest'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { asJson } from '../../../src/db/sql.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import type { AgentDefinition, PersistContext } from '../../../src/platform/agent/types.js'
import type { SecondJudge } from '../../../src/platform/judge/second.js'
import { FakeSecondJudge } from '../../../src/platform/judge/second.js'
import { CONVERSATION, GOOD_FACT, harness, reply, withJudge } from './harness.js'

function withPersist(persist: (ctx: PersistContext<EchoInput>) => Promise<void>, extra: Record<string, unknown> = {}): AgentDefinition<EchoInput, never> {
  return { ...exampleEcho, ...extra, persist } as never
}

const BAD_QUOTE = { group: 'widget_claim', quote: 'not in the text', segment_id: 's1', claim: 'x' }
const TOLERANT = { extract: { ...exampleEcho.extract, maxDropRate: 0.6 } }
const RULE_SET = { id: 'rule-set-1', sha: 'rule-sha-1', question: 'Is the absence real?' }

describe('P1: gated facts and drop counts reach the persist hook', () => {
  it('gets the facts the gate kept (group, fields, segment_id, role, t0, t1, quote) and the drops the gate counted', async () => {
    let seen: PersistContext<EchoInput> | undefined
    const h = await harness([reply([GOOD_FACT, BAD_QUOTE])])
    const audit = await h.run(CONVERSATION, {}, withPersist(async (ctx) => {
      seen = ctx
    }, TOLERANT))
    expect(seen?.facts).toEqual([{ group: 'widget_claim', fields: { claim: 'blue' }, segment_id: 's1', role: 'clinician', t0: null, t1: null, quote: 'widget is blue' }])
    const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
    const stored = asJson(row.counts) as { drops: Record<string, number> }
    expect(Object.keys(stored.drops).length).toBeGreaterThan(0)
    expect(seen?.drops).toEqual(stored.drops)
    expect(audit.status).toBe('ok')
  })

  it('mutating facts and drops changes neither the returned audit nor agent_runs', async () => {
    const plain = await harness([reply([GOOD_FACT, BAD_QUOTE])])
    const expected = await plain.run(CONVERSATION, { traceId: 'trace-p1' }, { ...exampleEcho, ...TOLERANT } as never)
    const expectedRow = (await plain.sql.query<Record<string, unknown>>('select versions, counts from agent_runs')).rows[0]!
    const h = await harness([reply([GOOD_FACT, BAD_QUOTE])])
    const audit = await h.run(CONVERSATION, { traceId: 'trace-p1' }, withPersist(async (ctx) => {
      ctx.facts[0]!.quote = 'tampered'
      ctx.facts[0]!.fields.claim = 'tampered'
      ctx.facts.push(ctx.facts[0]!)
      for (const key of Object.keys(ctx.drops)) ctx.drops[key] = 99
      ctx.drops.extra = 1
    }, TOLERANT))
    expect(audit).toEqual(expected)
    const row = (await h.sql.query<Record<string, unknown>>('select versions, counts from agent_runs')).rows[0]!
    expect(asJson(row.counts)).toEqual(asJson(expectedRow.counts))
    expect(asJson(row.versions)).toEqual(asJson(expectedRow.versions))
  })

  it('a run that abstains before the gate gives empty facts and drops', async () => {
    let seen: PersistContext<EchoInput> | undefined
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run({ segments: [{ id: 's1', role: 'clinician', text: ' ' }] }, {}, withPersist(async (ctx) => {
      seen = ctx
    }))
    expect(audit.status).toBe('abstained')
    expect(seen?.facts).toEqual([])
    expect(seen?.drops).toEqual({})
  })

  it('an extraction_unverified run gives no facts (the failed gate is not trusted) but the drop counts', async () => {
    let seen: PersistContext<EchoInput> | undefined
    const h = await harness([reply([BAD_QUOTE])])
    const audit = await h.run(CONVERSATION, {}, withPersist(async (ctx) => {
      seen = ctx
    }))
    expect(audit.reason).toBe('extraction_unverified')
    expect(seen?.facts).toEqual([])
    expect(Object.keys(seen?.drops ?? {}).length).toBeGreaterThan(0)
  })
})

describe('P2: question_sets in audit.versions', () => {
  it('is rule id -> id@sha, identical to agent_runs.versions.question_sets, when per-rule sets are used', async () => {
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.95))
    const def = { ...exampleEcho, judge: { ...exampleEcho.judge, questionSets: { 'echo.widget_claim': RULE_SET } } } as never
    const audit = await h.run(CONVERSATION, {}, def)
    expect(audit.versions.question_sets).toEqual({ 'echo.widget_claim': 'rule-set-1@rule-sha-1' })
    const row = (await h.sql.query<Record<string, unknown>>('select versions from agent_runs')).rows[0]!
    expect((asJson(row.versions) as { question_sets: unknown }).question_sets).toEqual(audit.versions.question_sets)
  })

  it('a default-set-only run leaves the key absent in both', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run()
    expect('question_sets' in audit.versions).toBe(false)
    const row = (await h.sql.query<Record<string, unknown>>('select versions from agent_runs')).rows[0]!
    expect('question_sets' in (asJson(row.versions) as object)).toBe(false)
  })
})

describe('S3-P flag 3: second judge with no served model id', () => {
  const silent: SecondJudge = { id: 'silent', askValidity: async () => ({ p_yes: 0.99, servedModelIds: [] }) }

  it('counts served_unverified_second per answer when the second judge returns []', async () => {
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.95), silent)
    const audit = await h.run(CONVERSATION, { second: silent }, withJudge('gemini'))
    expect(audit.status).toBe('ok')
    const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
    expect(asJson(row.counts)).toMatchObject({ served_unverified_second: 1 })
  })

  it('is absent when the second judge names its model, and when no second judge is declared', async () => {
    const second = new FakeSecondJudge(() => 0.99)
    const a = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.95), second)
    await a.run(CONVERSATION, { second }, withJudge('gemini'))
    const b = await harness([reply([GOOD_FACT])])
    await b.run()
    for (const h of [a, b]) {
      const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
      expect('served_unverified_second' in (asJson(row.counts) as object)).toBe(false)
    }
  })
})

describe('P1P2-1: question_sets through the audience bodies', () => {
  it('internal accepts versions.question_sets; operator and doctor bodies omit it', async () => {
    const { serialize } = await import('../../../src/audience/serialize.js')
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.95))
    const audit = await h.run(CONVERSATION, {}, { ...exampleEcho, doctorVisible: 'policy', judge: { ...exampleEcho.judge, questionSets: { 'echo.widget_claim': RULE_SET } } } as never)
    expect(audit.versions.question_sets).toBeDefined()
    expect((serialize(audit, 'internal') as { versions: { question_sets?: unknown } }).versions.question_sets).toEqual(audit.versions.question_sets)
    for (const audience of ['operator', 'doctor'] as const) {
      expect(JSON.stringify(serialize(audit, audience))).not.toContain('question_sets')
    }
  })
})
