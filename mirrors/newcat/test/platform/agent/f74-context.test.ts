import { describe, expect, it, vi } from 'vitest'
import { serialize } from '../../../src/audience/serialize.js'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import type { AgentDefinition, GatedFact } from '../../../src/platform/agent/types.js'
import { CONVERSATION, GOOD_FACT, harness, reply } from './harness.js'

const MARKER = 'zz-ctx-marker-7731'

interface Ctx {
  wanted: string
  secret: string
}

/** One rule that uses the context to decide, and a summary that never mentions it. */
function withContext(overrides: Partial<AgentDefinition<EchoInput, never, Ctx>> = {}): AgentDefinition<EchoInput, never, Ctx> {
  const rule = exampleEcho.rules[0]!
  return {
    ...exampleEcho,
    audiences: ['internal', 'operator', 'doctor'],
    doctorVisible: 'policy',
    context: () => ({ wanted: 'blue', secret: MARKER }),
    rules: [
      {
        ...rule,
        doctorSentence: 'Please confirm the widget statement.',
        evaluate: (facts: GatedFact<{ claim: string }>[], ctx?: Ctx) =>
          facts
            .filter((fact) => fact.group === 'widget_claim' && (ctx === undefined || fact.claim === ctx.wanted))
            .map((fact) => ({ factRefs: [fact.id], summary: `Clinician stated: ${fact.claim}` })),
      },
    ],
    ...overrides,
  } as never
}

describe('F7.4 G1: rule context', () => {
  it('passes the context as the second argument and the rule can use it', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, {}, withContext() as never)
    expect(audit.findings).toHaveLength(1)
    const miss = await (await harness([reply([GOOD_FACT])])).run(CONVERSATION, {}, withContext({ context: () => ({ wanted: 'green', secret: MARKER }) }) as never)
    expect(miss.findings).toHaveLength(0)
  })

  it('context receives the parsed input and each rule gets its own copy', async () => {
    const seen: Ctx[] = []
    const rule = exampleEcho.rules[0]!
    const def = withContext({
      context: (input) => ({ wanted: String(input.segments.length), secret: MARKER }),
      rules: [
        { ...rule, evaluate: (_facts: never[], ctx?: Ctx) => { seen.push({ ...ctx! }); ctx!.wanted = 'changed'; return [] } },
        { ...rule, id: 'echo.second', evaluate: (_facts: never[], ctx?: Ctx) => { seen.push(ctx!); return [] } },
      ] as never,
    })
    await (await harness([reply([GOOD_FACT])])).run(CONVERSATION, {}, def as never)
    expect(seen.map((c) => c.wanted)).toEqual(['2', '2'])
  })

  it('single-argument rules keep working with and without a context', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, {}, { ...exampleEcho, context: () => ({ any: 1 }) } as never)
    expect(audit.findings.length).toBeGreaterThan(0)
  })

  it('a throwing or non-JSON context fails the run with a fixed error and leaks nothing', async () => {
    for (const context of [() => { throw new Error(MARKER) }, () => ({ f: 1n }), () => { const a: Record<string, unknown> = {}; a.a = a; return a }]) {
      const h = await harness([reply([GOOD_FACT])])
      const audit = await h.run(CONVERSATION, {}, withContext({ context: context as never }) as never)
      expect(audit.status).toBe('failed')
      expect(audit.error?.type).toBe('invalid_rule_context')
      expect(JSON.stringify(audit)).not.toContain(MARKER)
    }
  })

  it('never reaches the judge, the claim, logs, run rows or any audience body', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const judge = new FakeJudgePort()
      const h = await harness([reply([GOOD_FACT])], judge)
      const audit = await h.run(CONVERSATION, { audience: 'doctor' }, withContext() as never)
      expect(audit.findings).toHaveLength(1)
      expect(judge.calls.length).toBeGreaterThan(0)
      expect(JSON.stringify(judge.calls)).not.toContain(MARKER)
      expect(JSON.stringify(audit)).not.toContain(MARKER)
      for (const table of ['agent_runs', 'agent_findings']) {
        const rows = (await h.sql.query(`select * from ${table}`)).rows
        expect(rows.length).toBeGreaterThan(0)
        expect(JSON.stringify(rows)).not.toContain(MARKER)
      }
      for (const audience of ['internal', 'operator', 'doctor'] as const) {
        expect(JSON.stringify(serialize(audit, audience))).not.toContain(MARKER)
      }
      const logged = [...write.mock.calls, ...err.mock.calls].map((call) => String(call[0])).join('')
      expect(logged).not.toContain(MARKER)
      expect(JSON.stringify(h.requests)).not.toContain(MARKER)
    } finally {
      write.mockRestore()
      err.mockRestore()
    }
  })
})
