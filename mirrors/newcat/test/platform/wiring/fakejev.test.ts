import { describe, expect, it } from 'vitest'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { FakeJevTransport } from '../../../src/decide/transport.js'
import { FakeEmbedder } from '../../../src/evidence/embed.js'
import { FakeModelClient } from '../../../src/llm/fake.js'
import { defaultWiring, toCapability } from '../../../src/platform/agent/define.js'
import { askChoice } from '../../../src/platform/jev/asks.js'
import { testDb, testEnv } from '../../helpers.js'
import { CONVERSATION, GOOD_FACT, reply } from '../agent/harness.js'

describe('FakeJevTransport under NEWCAT_JEV=fake', () => {
  it('answers a yes/no choice yes-heavy and deterministically', async () => {
    const sql = await testDb()
    const t = new FakeJevTransport(sql)
    const a = await askChoice({ transport: t, traceId: 't', purpose: 'unit' }, {}, { prompt: 'p' }, ['yes', 'no'])
    const b = await askChoice({ transport: t, traceId: 't', purpose: 'unit' }, {}, { prompt: 'p' }, ['yes', 'no'])
    expect(a).toEqual(b)
    expect(a.status === 'ok' && a.data.probabilities.yes).toBeCloseTo(0.96, 5)
  })

  it('rejects options that start with opt_ (relabelling collision)', async () => {
    const sql = await testDb()
    const out = await askChoice({ transport: new FakeJevTransport(sql), traceId: 't', purpose: 'unit' }, {}, { prompt: 'p' }, ['route', 'opt_route'])
    expect(out).toMatchObject({ status: 'failed' })
  })

  it('a registered toy agent gets a resolved judge (valid finding, not held)', async () => {
    const sql = await testDb()
    const env = testEnv()
    expect(env.NEWCAT_JEV).toBe('fake')
    const audit = await toCapability(exampleEcho, defaultWiring).run(
      {
        sql,
        models: new FakeModelClient(sql, () => reply([GOOD_FACT])),
        jev: new FakeJevTransport(sql),
        embedder: new FakeEmbedder(sql),
        env,
        traceId: 'trace-fake-jev',
        purpose: 'test',
        audience: 'internal',
      },
      CONVERSATION,
    )
    expect(audit.status).toBe('ok')
    expect(audit.findings[0]).toMatchObject({ action: 'valid' })
  })

  it('route/hold choices keep the previous fake answers', async () => {
    const sql = await testDb()
    const out = await askChoice({ transport: new FakeJevTransport(sql), traceId: 't', purpose: 'unit' }, {}, { prompt: 'p' }, ['route', 'hold', 'drop_informational'])
    expect(out.status === 'ok' && out.data.probabilities.hold).toBeCloseTo(0.9, 5)
  })
})
