import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CAPABILITIES, getCapability } from '../../../src/api/registry.js'
import { AGENTS } from '../../../src/agents/index.js'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { defineAgent, toCapability, validateDefinition } from '../../../src/platform/agent/define.js'
import { EmitRefusal } from '../../../src/audience/serialize.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { testDb, testEnv } from '../../helpers.js'
import { FakeModelClient } from '../../../src/llm/fake.js'
import { FakeJevTransport } from '../../../src/decide/transport.js'
import { FakeEmbedder } from '../../../src/evidence/embed.js'
import { CONVERSATION, GOOD_FACT, reply } from './harness.js'

describe('defineAgent', () => {
  it('returns a capability with the agent id as its scope', () => {
    const capability = defineAgent(exampleEcho)
    expect(capability).toMatchObject({ id: 'example.echo', requiredScopes: ['example.echo'], modes: ['sync'], audiences: ['internal', 'operator'] })
  })

  it('never lists the doctor audience for a doctorVisible never agent', () => {
    expect(defineAgent(exampleEcho).audiences).not.toContain('doctor')
    expect(() => validateDefinition({ ...exampleEcho, audiences: ['internal', 'doctor'] })).toThrow(/doctor/)
  })

  it.each([
    ['loose input schema', { input: z.object({ segments: z.array(z.any()) }) }],
    ['bad id', { id: 'Echo' }],
    ['bad reason', { abstention: { reasons: ['Has Space'], emptyReasons: [] } }],
    ['bad threshold', { judge: { ...exampleEcho.judge, thresholds: { safety: 1.5, nonSafety: 0.5 } } }],
    ['duplicate rule id', { rules: [exampleEcho.rules[0]!, exampleEcho.rules[0]!] }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateDefinition({ ...exampleEcho, ...patch } as never)).toThrow()
  })

  it('the capability run holds findings under the default wiring when Jev is unavailable', async () => {
    const sql = await testDb()
    const capability = toCapability(exampleEcho)
    const audit = await capability.run(
      {
        sql,
        models: new FakeModelClient(sql, () => reply([GOOD_FACT])),
        jev: new FakeJevTransport(sql),
        embedder: new FakeEmbedder(sql),
        env: testEnv({ NEWCAT_JEV: 'live' }),
        traceId: 't1',
        purpose: 'test',
        audience: 'internal',
      },
      CONVERSATION,
    )
    expect(audit.status).toBe('unavailable')
    expect(audit.findings[0]?.action).toBe('hold')
  })

  it('the capability run refuses doctor', async () => {
    const sql = await testDb()
    const capability = toCapability(exampleEcho, { judge: () => new FakeJudgePort(), second: () => null })
    await expect(
      capability.run(
        {
          sql,
          models: new FakeModelClient(sql),
          jev: new FakeJevTransport(sql),
          embedder: new FakeEmbedder(sql),
          env: testEnv(),
          traceId: 't2',
          purpose: 'test',
          audience: 'doctor',
        },
        CONVERSATION,
      ),
    ).rejects.toBeInstanceOf(EmitRefusal)
  })
})

describe('registry', () => {
  it('lists core capabilities first and then the registered agents', () => {
    expect(CAPABILITIES.slice(0, 2).map((capability) => capability.id)).toEqual(['audit.note', 'evidence.retrieve'])
    expect(CAPABILITIES).toHaveLength(7 + AGENTS.length)
    expect(getCapability('audit.note')).toBeDefined()
  })

  it('does not register the toy agent', () => {
    expect(getCapability('example.echo')).toBeUndefined()
  })
})
