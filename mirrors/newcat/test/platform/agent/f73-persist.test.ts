import { describe, expect, it, vi } from 'vitest'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { asJson } from '../../../src/db/sql.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import type { AgentDefinition, PersistContext } from '../../../src/platform/agent/types.js'
import { CONVERSATION, GOOD_FACT, harness, reply } from './harness.js'

function withPersist(persist: (ctx: PersistContext<EchoInput>) => Promise<void>): AgentDefinition<EchoInput, never> {
  return { ...exampleEcho, persist } as never
}

describe('F7.3 G6: post-run persist hook', () => {
  it('receives sql, run id, trace id, the parsed input and the audit, after the run rows exist', async () => {
    let seen: PersistContext<EchoInput> | undefined
    let rowsThen = 0
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, { traceId: 'trace-persist-1' }, withPersist(async (ctx) => {
      seen = ctx
      rowsThen = (await ctx.sql.query('select 1 from agent_runs where run_id = $1', [ctx.runId])).rows.length
    }))
    expect(seen?.input).toEqual(CONVERSATION)
    expect(seen?.traceId).toBe('trace-persist-1')
    expect(seen?.audit).toEqual(audit)
    expect(rowsThen).toBe(1)
    const run = (await h.sql.query<{ run_id: string }>('select run_id from agent_runs')).rows[0]!
    expect(seen?.runId).toBe(run.run_id)
  })

  it('a throwing hook leaves the audit unchanged, counts persist_failed and logs a code only', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const plain = await harness([reply([GOOD_FACT])])
      const expected = await plain.run(CONVERSATION, { traceId: 'trace-same' })
      const h = await harness([reply([GOOD_FACT])])
      const audit = await h.run(CONVERSATION, { traceId: 'trace-same' }, withPersist(async () => {
        throw new Error('patient text in an error message')
      }))
      expect(audit).toEqual(expected)
      const row = (await h.sql.query<Record<string, unknown>>('select status, counts from agent_runs')).rows[0]!
      expect(row.status).toBe('ok')
      expect(asJson(row.counts)).toMatchObject({ persist_failed: 1 })
      const logged = write.mock.calls.map((call) => String(call[0])).join('')
      expect(logged).toContain('persist_failed')
      expect(logged).not.toContain('patient text')
    } finally {
      write.mockRestore()
    }
  })

  it('a rejected promise from the hook is handled the same way', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await expect(h.run(CONVERSATION, {}, withPersist(() => Promise.reject(new Error('x'))))).resolves.toMatchObject({ status: 'ok' })
  })

  it('runs for empty and abstained, not for failed or unavailable', async () => {
    const statuses: string[] = []
    const def = withPersist(async (ctx) => {
      statuses.push(ctx.audit.status)
    })
    await (await harness([reply([])])).run(CONVERSATION, {}, def) // empty
    await (await harness([reply([GOOD_FACT])])).run({ segments: [{ id: 's1', role: 'clinician', text: ' ' }] }, {}, def) // abstained
    await (await harness([reply([GOOD_FACT])], new FakeJudgePort(() => null))).run(CONVERSATION, {}, def) // unavailable
    expect(statuses).toEqual(['empty', 'abstained'])
    const failed = await harness([{ kind: 'text', text: 'x', toolInput: null }])
    const budgetDef = { ...def, budget: { llmCalls: 0, jevCalls: 0 } } as never
    expect((await failed.run(CONVERSATION, {}, budgetDef)).status).toBe('failed')
    expect(statuses).toEqual(['empty', 'abstained'])
  })

  it('a run without a hook has no persist_failed count', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await h.run()
    const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
    expect('persist_failed' in (asJson(row.counts) as object)).toBe(false)
  })
})
