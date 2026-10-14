import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { AGENTS } from '../../../src/agents/index.js'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { FakeJevTransport } from '../../../src/decide/transport.js'
import { FakeEmbedder } from '../../../src/evidence/embed.js'
import { FakeModelClient } from '../../../src/llm/fake.js'
import { defaultWiring, toCapability, validateDefinition } from '../../../src/platform/agent/define.js'
import { buildJudgeState, JudgeUnavailable } from '../../../src/platform/agent/judge-port.js'
import { plantedClaim } from '../../../src/platform/eval/planted.js'
import { askChoice } from '../../../src/platform/jev/asks.js'
import { jevJudge } from '../../../src/platform/jev/judge.js'
import type { JevAnswer, JevCall, JevTransport } from '../../../src/decide/transport.js'
import type { StageOutcome } from '../../../src/outcome.js'
import { testDb, testEnv } from '../../helpers.js'
import { CONVERSATION, GOOD_FACT, harness, reply } from '../agent/harness.js'

type Reply = StageOutcome<{ servedModelId: string; answers: JevAnswer[] }>

class Scripted implements JevTransport {
  readonly calls: JevCall[] = []
  constructor(private readonly pYes: number, private readonly down = false) {}
  async classify(call: JevCall): Promise<Reply> {
    this.calls.push(call)
    if (this.down) return { status: 'unavailable', error: { type: 'jev_unavailable', message: 'down' } }
    return {
      status: 'ok',
      data: {
        servedModelId: 'jev-test-1',
        answers: call.questions.map((q) => {
          const probabilities: Record<string, number> = {}
          for (const option of q.options ?? []) probabilities[option] = option === 'yes' || option === 'opt_yes' ? this.pYes : 1 - this.pYes
          return { question_id: q.id, probabilities }
        }),
      },
    }
  }
}

const ctx = (transport: JevTransport) => ({ transport, traceId: 't', purpose: 'unit' })

describe('judge wiring (A)', () => {
  it('the Jev adapter answers p_yes from a yes/no choice and stamps served ids', async () => {
    const t = new Scripted(0.8)
    const answer = await jevJudge({ transport: t, traceId: 't', purpose: 'agent_judge' }).askValidity(
      buildJudgeState('r1', 'claim', [{ quote: 'q' }]),
      'Is it valid?',
      { id: 'x', sha: 's', question: 'Is it valid?' },
    )
    expect(answer.p_yes).toBeCloseTo(0.8, 5)
    expect(answer.servedModelIds).toEqual(['jev-test-1', 'jev-test-1'])
    expect(t.calls).toHaveLength(2)
  })

  it('an unavailable Jev is JudgeUnavailable, so the run holds the finding', async () => {
    const judge = jevJudge({ transport: new Scripted(0.8, true), traceId: 't', purpose: 'agent_judge' })
    await expect(judge.askValidity({}, 'q', { id: 'x', sha: 's', question: 'q' })).rejects.toBeInstanceOf(JudgeUnavailable)
  })

  it('defaultWiring uses Jev when ready and the unavailable judge when NEWCAT_JEV is unavailable', async () => {
    const sql = await testDb()
    const base = {
      sql,
      models: new FakeModelClient(sql),
      jev: new FakeJevTransport(sql),
      embedder: new FakeEmbedder(sql),
      traceId: 't',
      purpose: 'test',
      audience: 'internal' as const,
    }
    const ready = defaultWiring.judge({ ...base, jev: new Scripted(0.9), env: testEnv() })
    expect((await ready.askValidity({}, 'q', { id: 'x', sha: 's', question: 'q' })).servedModelIds.length).toBeGreaterThan(0)
    const none = defaultWiring.judge({ ...base, env: testEnv({ NEWCAT_JEV: 'live' }) })
    await expect(none.askValidity({}, 'q', { id: 'x', sha: 's', question: 'q' })).rejects.toBeInstanceOf(JudgeUnavailable)
  })

  it('choice options named route/hold/drop_informational never reach the transport under those names (LOW-3)', async () => {
    const t = new Scripted(0.5)
    const out = await askChoice(ctx(t), {}, { prompt: 'p', criteria: { route: 'my own criteria' } }, ['route', 'hold', 'drop_informational'])
    for (const call of t.calls) {
      const q = call.questions[0]!
      expect(q.options).toEqual(expect.not.arrayContaining(['route', 'hold', 'drop_informational']))
      expect(q.prompt).toContain('my own criteria')
    }
    expect(out.status).toBe('ok')
    if (out.status === 'ok') expect(Object.keys(out.data.probabilities).sort()).toEqual(['drop_informational', 'hold', 'route'])
  })
})

describe('jev-review ref guard (LOW-2)', () => {
  it.each(['--output=/tmp/x', '-p'])('rejects a ref starting with a dash: %s', (ref) => {
    const result = spawnSync('npx', ['tsx', 'scripts/jev-review.ts', '--base', ref, '--head', 'HEAD'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/usage/)
  }, 60_000)
})

describe('run trail (B)', () => {
  it('uses the envelope idempotency key for agent_runs, the trace id only when absent', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await h.run(CONVERSATION, { traceId: 'trace-a', idempotencyKey: 'idem-key-1' })
    await h.run(CONVERSATION, { traceId: 'trace-b' })
    const rows = await h.sql.query<{ trace_id: string; idempotency_key: string }>('select trace_id, idempotency_key from agent_runs order by trace_id')
    expect(rows.rows).toEqual([
      { trace_id: 'trace-a', idempotency_key: 'idem-key-1' },
      { trace_id: 'trace-b', idempotency_key: 'trace-b' },
    ])
  })

  it('toCapability carries ctx.idempotencyKey into the run row', async () => {
    const sql = await testDb()
    const capability = toCapability(exampleEcho, { judge: () => ({ askValidity: async () => ({ p_yes: 0.95, servedModelIds: ['j'] }) }), second: () => null })
    await capability.run(
      {
        sql,
        models: new FakeModelClient(sql, () => reply([GOOD_FACT])),
        jev: new FakeJevTransport(sql),
        embedder: new FakeEmbedder(sql),
        env: testEnv(),
        traceId: 'trace-c',
        idempotencyKey: 'envelope-key-0001',
        purpose: 'test',
        audience: 'internal',
      },
      CONVERSATION,
    )
    const rows = await sql.query<{ idempotency_key: string }>('select idempotency_key from agent_runs')
    expect(rows.rows).toEqual([{ idempotency_key: 'envelope-key-0001' }])
  })

  it('a retry with a different outcome writes no finding rows when the run row already exists', async () => {
    const h = await harness([reply([]), reply([GOOD_FACT])])
    const first = await h.run(CONVERSATION, { idempotencyKey: 'retry-key-0001' })
    expect(first.status).toBe('empty')
    const second = await h.run(CONVERSATION, { idempotencyKey: 'retry-key-0001' })
    expect(second.findings).toHaveLength(1)
    const runs = await h.sql.query<{ status: string }>('select status from agent_runs')
    expect(runs.rows).toEqual([{ status: 'empty' }])
    expect((await h.sql.query('select 1 from agent_findings')).rows).toHaveLength(0)
  })

  it('every registered agent validates, and the template agent validates too', () => {
    for (const def of [...AGENTS, exampleEcho]) expect(() => validateDefinition(def)).not.toThrow()
    for (const def of AGENTS) expect(() => toCapability(def)).not.toThrow()
  })

  it('toCapability validates: an invalid definition throws even without defineAgent', () => {
    expect(() => toCapability({ ...exampleEcho, id: 'Bad Id' } as never)).toThrow()
  })

  it('run.ts and planted.ts build judge state with the same helper', async () => {
    const seen: unknown[] = []
    const primary = { askValidity: async (state: unknown) => (seen.push(state), { p_yes: 0.9, servedModelIds: [] }) }
    const h = await harness([reply([GOOD_FACT])], Object.assign(primary, { calls: [] }) as never)
    const finding = (await h.run()).findings[0]!
    await plantedClaim({ finding, primary, threshold: 0.75, set: { id: 'x', sha: 's', question: 'q' } })
    const keys = (seen as { rule: string; claim: string; evidence: Record<string, unknown>[] }[]).map((s) => Object.keys(s).sort())
    expect(keys.every((k) => k.join() === 'claim,evidence,rule')).toBe(true)
    expect(buildJudgeState('r', 'c', [{ quote: 'q' }])).toEqual({ rule: 'r', claim: 'c', evidence: [{ quote: 'q' }] })
  })
})
