import { describe, expect, it } from 'vitest'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { asJson } from '../../../src/db/sql.js'
import type { PersistContext } from '../../../src/platform/agent/types.js'
import { CONVERSATION, GOOD_FACT, harness, reply } from './harness.js'

const counts = async (h: Awaited<ReturnType<typeof harness>>) => asJson((await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!.counts) as Record<string, unknown>

describe('F7.4 N1: persistTimeoutMs that is not a finite number uses the default', () => {
  it.each([NaN, Infinity, -Infinity, '30' as unknown as number, null as unknown as number])('%s -> default, a quick hook is not failed', async (value) => {
    const def = { ...exampleEcho, persistTimeoutMs: value, persist: async () => new Promise<void>((resolve) => setTimeout(resolve, 40)) } as never
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, {}, def)
    expect(audit.status).toBe('ok')
    expect('persist_failed' in (await counts(h))).toBe(false)
  })
})

describe('F7.4 N2: a hook that returns a non-promise', () => {
  it.each([undefined, 1, 'x', { then: 3 }, null])('%s is awaited normally and not counted as failed', async (value) => {
    let ran = false
    const def = { ...exampleEcho, persist: ((_ctx: PersistContext<EchoInput>) => { ran = true; return value }) as never }
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, {}, def as never)
    expect(ran).toBe(true)
    expect(audit.status).toBe('ok')
    expect('persist_failed' in (await counts(h))).toBe(false)
  })

  it('a synchronous throw is still counted', async () => {
    const def = { ...exampleEcho, persist: () => { throw new Error('x') } } as never
    const h = await harness([reply([GOOD_FACT])])
    await h.run(CONVERSATION, {}, def)
    expect(await counts(h)).toMatchObject({ persist_failed: 1 })
  })
})
