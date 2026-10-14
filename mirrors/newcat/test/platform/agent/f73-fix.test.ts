import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { serialize } from '../../../src/audience/serialize.js'
import { FakeModelClient } from '../../../src/llm/fake.js'
import { FakeJevTransport } from '../../../src/decide/transport.js'
import { asJson } from '../../../src/db/sql.js'
import { runAudit } from '../../../src/pipeline/audit.js'
import { candidatesOf } from '../../../src/platform/agent/types.js'
import { validateDefinition } from '../../../src/platform/agent/define.js'
import type { AgentDefinition, PersistContext } from '../../../src/platform/agent/types.js'
import { testDb } from '../../helpers.js'
import { CONVERSATION, GOOD_FACT, harness, reply } from './harness.js'

function withPersist(persist: (ctx: PersistContext<EchoInput>) => Promise<void>, extra: Record<string, unknown> = {}): AgentDefinition<EchoInput, never> {
  return { ...exampleEcho, persist, ...extra } as never
}

const SECOND_FACT = { group: 'widget_claim', quote: 'sample widget', segment_id: 's1', claim: 'sample' }

describe('F7.3 fix R1: persist hook gets copies', () => {
  it('a mutating hook leaves the returned audit and agent_findings.judge unchanged', async () => {
    const plain = await harness([reply([GOOD_FACT, SECOND_FACT])])
    const expected = await plain.run(CONVERSATION, { traceId: 'trace-mut' })
    const h = await harness([reply([GOOD_FACT, SECOND_FACT])])
    const audit = await h.run(CONVERSATION, { traceId: 'trace-mut' }, withPersist(async (ctx) => {
      ctx.audit.findings[0]!.judge!.primary_p = 0.01
      ctx.audit.findings.sort((a, b) => (a.id < b.id ? 1 : -1))
      ctx.audit.status = 'empty'
      ctx.input.segments.length = 0
    }))
    expect(audit).toEqual(expected)
    expect(audit.status).toBe('ok')
    const rows = (await h.sql.query<{ finding_id: string; judge: unknown }>('select finding_id, judge from agent_findings')).rows
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const finding = audit.findings.find((candidate) => candidate.id === row.finding_id)!
      expect(asJson(row.judge)).toEqual(finding.judge)
      expect(finding.judge!.primary_p).not.toBe(0.01)
    }
  })
})

describe('F7.3 fix R2: count reasons', () => {
  it('rejects Object.prototype names at definition time', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']) {
      expect(() => validateDefinition({ ...exampleEcho, countReasons: [name.toLowerCase()] } as never)).toThrow(/Object\.prototype/)
    }
    expect(() => validateDefinition({ ...exampleEcho, countReasons: ['__proto__'] } as never)).toThrow()
  })

  it('a declared count reason is summed into agent_counts as declared', async () => {
    const rule = exampleEcho.rules[0]!
    const def = {
      ...exampleEcho,
      countReasons: ['seen'],
      rules: [{ ...rule, evaluate: (facts: never[]) => ({ candidates: [], counts: { seen: facts.length } }) }],
    }
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, {}, def as never)
    expect(audit.agent_counts).toEqual({ seen: 1 })
  })
})

describe('F7.3 fix R3: persist timeout', () => {
  it('a hook that never settles counts persist_failed and the run continues', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, {}, withPersist(() => new Promise<void>(() => undefined), { persistTimeoutMs: 30 }))
    expect(audit.status).toBe('ok')
    const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
    expect(asJson(row.counts)).toMatchObject({ persist_failed: 1 })
  })

  it('a hook inside its deadline is not counted', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await h.run(CONVERSATION, {}, withPersist(async () => undefined, { persistTimeoutMs: 1000 }))
    const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
    expect('persist_failed' in (asJson(row.counts) as object)).toBe(false)
  })
})

describe('F7.3 fix R6: judge, meta and agent_counts stay out of non-governance bodies', () => {
  const gold = JSON.parse(readFileSync('fixtures/gold/safety-v1.json', 'utf8')) as {
    cases: { source: string; source_uid: string; source_timestamp: string; body: string }[]
  }

  it('audit.note findings carry no judge, meta or agent_counts, for every audience', async () => {
    const sql = await testDb()
    const note = gold.cases[0]!
    const audit = await runAudit(
      { sql, models: new FakeModelClient(sql), jev: new FakeJevTransport(sql) },
      {
        traceId: 'trace-r6',
        purpose: 'test',
        patientRef: 'pt-1',
        encounterRef: 'enc-1',
        source: note.source,
        sourceUid: note.source_uid,
        sourceTimestamp: note.source_timestamp,
        body: note.body,
        backlogDays: 0,
      },
    )
    expect(audit.findings.length).toBeGreaterThan(0)
    for (const finding of audit.findings) {
      for (const key of ['judge', 'meta']) expect(key in finding).toBe(false)
    }
    expect('agent_counts' in audit).toBe(false)
    for (const audience of ['doctor', 'operator', 'internal'] as const) {
      const text = JSON.stringify(serialize(audit, audience))
      for (const key of ['"judge"', '"meta"', '"agent_counts"', 'primary_p']) expect(text).not.toContain(key)
    }
  })

  it('a doctor-visible agent finding never carries judge or meta in the doctor body', async () => {
    const rule = exampleEcho.rules[0]!
    const def = {
      ...exampleEcho,
      doctorVisible: 'policy' as const,
      audiences: ['internal', 'operator', 'doctor'],
      metaKeys: ['marker'],
      rules: [
        {
          ...rule,
          doctorSentence: 'Please confirm the widget statement.',
          evaluate: (facts: never[]) => candidatesOf(rule.evaluate(facts)).map((candidate) => ({ ...candidate, meta: { marker: 'zz-r6-marker' } })),
        },
      ],
    }
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, { audience: 'doctor' }, def as never)
    expect(audit.findings[0]).toMatchObject({ doctor_visible: true })
    expect(audit.findings[0]!.judge).toBeDefined()
    const body = serialize(audit, 'doctor') as { findings: unknown[] }
    expect(body.findings).toHaveLength(1)
    const text = JSON.stringify(body)
    for (const needle of ['"judge"', '"meta"', 'primary_p', 'zz-r6-marker', 'agent_counts']) expect(text).not.toContain(needle)
  })
})
