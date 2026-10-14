import { FakeModelClient, type FakeReply } from '../../../src/llm/fake.js'
import type { ModelRequest } from '../../../src/llm/types.js'
import type { Sql } from '../../../src/db/sql.js'
import { runAgent, type AgentDeps } from '../../../src/platform/agent/run.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import type { AgentDefinition } from '../../../src/platform/agent/types.js'
import type { SecondJudge } from '../../../src/platform/judge/second.js'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { testDb } from '../../helpers.js'

export const CONVERSATION: EchoInput = {
  segments: [
    { id: 's1', role: 'clinician', text: 'The sample widget is blue and sealed.' },
    { id: 's2', role: 'patient', text: 'I think the widget is red.' },
  ],
}

export const GOOD_FACT = { group: 'widget_claim', quote: 'widget is blue', segment_id: 's1', claim: 'blue' }

export function reply(facts: unknown[]): FakeReply {
  return { kind: 'text', text: '', toolInput: { facts } }
}

export interface Harness {
  sql: Sql
  requests: ModelRequest[]
  run(input?: unknown, overrides?: Partial<AgentDeps>, def?: AgentDefinition<EchoInput, never>): ReturnType<typeof runAgent>
}

/** `replies` is consumed one per model call; the last one repeats. */
export async function harness(replies: FakeReply[], judge = new FakeJudgePort(), second?: SecondJudge | null): Promise<Harness & { judge: FakeJudgePort }> {
  const sql = await testDb()
  const requests: ModelRequest[] = []
  let index = 0
  const models = new FakeModelClient(sql, (request) => {
    requests.push(request)
    const next = replies[Math.min(index, replies.length - 1)] ?? reply([])
    index += 1
    return next
  })
  return {
    sql,
    requests,
    judge,
    run(input: unknown = CONVERSATION, overrides: Partial<AgentDeps> = {}, def = exampleEcho as never) {
      return runAgent(def as AgentDefinition<EchoInput, unknown>, {
        sql,
        models,
        traceId: `trace-${Math.random().toString(16).slice(2)}`,
        purpose: 'test',
        audience: 'internal',
        judge,
        second: second ?? null,
        ...overrides,
      }, input)
    },
  }
}

export function withJudge(second: 'gemini' | null, thresholds?: { safety: number; nonSafety: number }): AgentDefinition<EchoInput, never> {
  return { ...exampleEcho, judge: { ...exampleEcho.judge, second, ...(thresholds ? { thresholds } : {}) } } as never
}
