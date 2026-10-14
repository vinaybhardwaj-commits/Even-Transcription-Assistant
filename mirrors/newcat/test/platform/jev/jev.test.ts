import { describe, expect, it } from 'vitest'
import { classifyAveraged } from '../../../src/decide/client.js'
import { QUESTION_SET_SHA, questionsFor } from '../../../src/decide/questions.js'
import type { JevAnswer, JevCall, JevTransport } from '../../../src/decide/transport.js'
import type { StageOutcome } from '../../../src/outcome.js'
import { askChoice, askNoul, askScore, type AskContext } from '../../../src/platform/jev/asks.js'
import { calibrate, thresholdFor, type JevPolicy } from '../../../src/platform/jev/policy.js'
import {
  AUDIT_DECISIONS_SET,
  JEV_REVIEW_SET,
  getQuestionSet,
  questionSetSha,
  registerQuestionSet,
} from '../../../src/platform/jev/registry.js'
import { QUESTION_SET_ID } from '../../../src/version.js'

type Reply = StageOutcome<{ servedModelId: string; answers: JevAnswer[] }>

/** Local fake: records every call and answers by option position, so order effects are visible. */
class ScriptedTransport implements JevTransport {
  readonly calls: JevCall[] = []
  constructor(private readonly reply: (call: JevCall, n: number) => Reply) {}
  async classify(call: JevCall): Promise<Reply> {
    this.calls.push(call)
    return this.reply(call, this.calls.length - 1)
  }
}

const ok = (served: string, answers: JevAnswer[]): Reply => ({ status: 'ok', data: { servedModelId: served, answers } })
const down: Reply = { status: 'unavailable', error: { type: 'jev_unavailable', message: 'down' } }

/** Gives the first listed option 0.8 and the rest an equal share of 0.2. */
function favourFirst(call: JevCall, served = 'jev-1.13.0'): Reply {
  return ok(
    served,
    call.questions.map((q) => {
      const options = q.options ?? []
      const probabilities: Record<string, number> = {}
      options.forEach((o, i) => (probabilities[o] = i === 0 ? 0.8 : 0.2 / (options.length - 1)))
      return { question_id: q.id, probabilities }
    }),
  )
}

const ctx = (transport: JevTransport): AskContext => ({ transport, traceId: 't1', purpose: 'unit' })

describe('typed asks', () => {
  it('askChoice asks forward and reversed and averages position bias away', async () => {
    const t = new ScriptedTransport((call) => favourFirst(call))
    const out = await askChoice(ctx(t), {}, { prompt: 'p' }, ['a', 'b', 'c'])
    expect(t.calls.map((c) => c.optionOrder)).toEqual(['forward', 'reverse'])
    expect(t.calls[0]?.questions[0]?.options).toEqual(['a', 'b', 'c'])
    expect(t.calls[1]?.questions[0]?.options).toEqual(['c', 'b', 'a'])
    expect(t.calls.every((c) => c.purpose === 'unit')).toBe(true)
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    // forward favours a, reverse favours c: both land at 0.5 on the ends
    expect(out.data.probabilities.a).toBeCloseTo(out.data.probabilities.c ?? -1, 3)
    expect(out.data.probabilities.a).toBeGreaterThan(out.data.probabilities.b ?? 1)
  })

  it('askNoul asks the same question twice, never inverted', async () => {
    const t = new ScriptedTransport((call) =>
      ok('jev-1.13.0', call.questions.map((q) => ({ question_id: q.id, probabilities: { yes: 0.9, no: 0.1 } }))),
    )
    const out = await askNoul(ctx(t), { x: 1 }, { prompt: 'is it?' })
    expect(t.calls).toHaveLength(2)
    expect(t.calls[0]?.questions).toEqual(t.calls[1]?.questions)
    expect(t.calls[0]?.questions[0]?.type).toBe('boolean')
    expect(out).toMatchObject({ status: 'ok', data: { p_yes: 0.9 } })
  })

  it('askScore returns probabilities and expected value', async () => {
    const t = new ScriptedTransport((call) =>
      ok('jev-1.13.0', call.questions.map((q) => ({ question_id: q.id, probabilities: { '1': 0.2, '2': 0.3, '3': 0.5 } }))),
    )
    const out = await askScore(ctx(t), {}, { prompt: 'p' }, ['1', '2', '3'])
    expect(out.status).toBe('ok')
    if (out.status === 'ok') expect(out.data.expected).toBeCloseTo(2.3, 3)
    expect(t.calls[1]?.questions[0]?.options).toEqual(['3', '2', '1'])
    const t2 = new ScriptedTransport((call) =>
      ok('jev-1.13.0', call.questions.map((q) => ({ question_id: q.id, probabilities: { low: 0, mid: 0.5, high: 0.5 } }))),
    )
    const named = await askScore(ctx(t2), {}, { prompt: 'p' }, ['low', 'mid', 'high'])
    // non-numeric criteria score by position: 0.5*1 + 0.5*2
    expect(named.status === 'ok' && named.data.expected).toBeCloseTo(1.5, 5)
  })

  it('one side missing is failed, never a one-sided answer', async () => {
    for (const bad of [0, 1]) {
      const t = new ScriptedTransport((call, n) => (n === bad ? down : favourFirst(call)))
      const out = await askChoice(ctx(t), {}, { prompt: 'p' }, ['a', 'b'])
      expect(out.status).toBe('unavailable')
    }
    // reverse answers omit the question
    const t = new ScriptedTransport((call, n) => (n === 1 ? ok('jev-1.13.0', []) : favourFirst(call)))
    expect((await askChoice(ctx(t), {}, { prompt: 'p' }, ['a', 'b'])).status).toBe('failed')
    const noul = new ScriptedTransport((call, n) => (n === 1 ? down : favourFirst(call)))
    expect((await askNoul(ctx(noul), {}, { prompt: 'p' })).status).toBe('unavailable')
  })

  it('rejects fewer than two distinct options without calling Jev', async () => {
    const t = new ScriptedTransport((call) => favourFirst(call))
    expect((await askChoice(ctx(t), {}, { prompt: 'p' }, ['a'])).status).toBe('failed')
    expect((await askChoice(ctx(t), {}, { prompt: 'p' }, ['a', 'a'])).status).toBe('failed')
    expect(t.calls).toHaveLength(0)
  })

  it('returns the served model id of both responses on every ask', async () => {
    const t = new ScriptedTransport((call, n) => favourFirst(call, n === 0 ? 'jev-1.13.0' : 'jev-1.13.1'))
    const choice = await askChoice(ctx(t), {}, { prompt: 'p' }, ['a', 'b'])
    expect(choice).toMatchObject({ status: 'ok', data: { servedModelId: 'jev-1.13.0', servedModelIds: ['jev-1.13.0', 'jev-1.13.1'] } })
    const t2 = new ScriptedTransport((call) =>
      ok('served-x', call.questions.map((q) => ({ question_id: q.id, probabilities: { yes: 0.5, no: 0.5 } }))),
    )
    expect(await askNoul(ctx(t2), {}, { prompt: 'p' })).toMatchObject({ data: { servedModelId: 'served-x' } })
    expect(await askScore(ctx(t2), {}, { prompt: 'p' }, ['yes', 'no'])).toMatchObject({ data: { servedModelId: 'served-x' } })
  })
})

describe('classifyAveraged purpose and kinds', () => {
  const questions = [
    ...questionsFor([{ id: 'f1', rule_id: 'x', summary: 's', evidence: [{ quote: 'q' }], severity: 'safety' }]),
    { id: 'f1:extra', type: 'choice' as const, prompt: 'p', options: ['a', 'b'] },
  ]

  it('defaults to purpose decide and only validity/route kinds', async () => {
    const t = new ScriptedTransport((call) => favourFirst(call))
    const out = await classifyAveraged(t, { traceId: 't', state: {}, questions })
    expect(t.calls.every((c) => c.purpose === 'decide')).toBe(true)
    expect(out.status === 'ok' && out.data.answers.map((a) => a.question_id)).toEqual(['validity', 'route'])
  })

  it('honours purpose and a kinds filter', async () => {
    const t = new ScriptedTransport((call) => favourFirst(call))
    const out = await classifyAveraged(t, { traceId: 't', state: {}, questions, purpose: 'agent', kinds: ['extra'] })
    expect(t.calls.every((c) => c.purpose === 'agent')).toBe(true)
    expect(out.status === 'ok' && out.data.answers.map((a) => a.question_id)).toEqual(['extra'])
  })
})

describe('question-set registry', () => {
  it('registers audit-decisions/0.3.0 with the sha audit.note uses today', () => {
    expect(AUDIT_DECISIONS_SET.id).toBe(QUESTION_SET_ID)
    expect(AUDIT_DECISIONS_SET.id).toBe('audit-decisions/0.3.0')
    expect(AUDIT_DECISIONS_SET.sha).toBe(QUESTION_SET_SHA)
    expect(getQuestionSet(QUESTION_SET_ID)?.sha).toBe(QUESTION_SET_SHA)
  })

  it('has a stable review set and rejects a changed set under the same id', () => {
    expect(getQuestionSet('jev-review/0.1.0')?.sha).toBe(questionSetSha(JEV_REVIEW_SET))
    expect(registerQuestionSet(JEV_REVIEW_SET)).toBe(JEV_REVIEW_SET)
    expect(() => registerQuestionSet({ ...JEV_REVIEW_SET, questions: [] })).toThrow()
  })
})

describe('JevPolicy', () => {
  const policy: JevPolicy = {
    questionSet: { id: AUDIT_DECISIONS_SET.id, sha: AUDIT_DECISIONS_SET.sha },
    thresholds: { safety: 0.9, nonSafety: 0.7 },
    calibration: { method: 'isotonic', table: { x: [0, 0.5, 1], y: [0, 0.25, 1] } },
  }
  it('picks thresholds and calibrates', () => {
    expect(thresholdFor(policy, true)).toBe(0.9)
    expect(thresholdFor(policy, false)).toBe(0.7)
    expect(calibrate(policy, 0.25)).toBeCloseTo(0.125, 5)
    expect(calibrate({ ...policy, calibration: { method: 'none' } }, 0.3)).toBe(0.3)
  })
})
