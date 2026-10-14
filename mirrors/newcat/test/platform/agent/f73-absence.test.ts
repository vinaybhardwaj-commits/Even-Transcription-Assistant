import { describe, expect, it } from 'vitest'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { asJson } from '../../../src/db/sql.js'
import { buildJudgeState, FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { validateDefinition } from '../../../src/platform/agent/define.js'
import { candidatesOf, type AgentDefinition, type Candidate } from '../../../src/platform/agent/types.js'
import { GOOD_FACT, harness, reply } from './harness.js'

const rule = exampleEcho.rules[0]!
const INPUT: EchoInput = {
  segments: [
    { id: 's1', role: 'clinician', text: 'The sample widget is blue and sealed.' },
    { id: 's2', role: 'patient', text: 'I think the widget is red.' },
    { id: 's3', role: 'clinician', text: 'Noted, thank you.' },
  ],
}

function def(extra: Partial<Candidate>, judge: Record<string, unknown> = {}): AgentDefinition<EchoInput, never> {
  return {
    ...exampleEcho,
    judge: { ...exampleEcho.judge, ...judge },
    rules: [{ ...rule, evaluate: (facts: never[]) => candidatesOf(rule.evaluate(facts)).map((candidate) => ({ ...candidate, ...extra })) }, ...exampleEcho.rules.slice(1)],
  } as never
}

describe('F7.3 G8a: per-rule question sets', () => {
  const RULE_SET = { id: 'rule-set-1', sha: 'rule-sha-1', question: 'Is the absence real?' }

  it('uses the rule set for the ask, the decision and the persisted versions', async () => {
    const judge = new FakeJudgePort(() => 0.95)
    const h = await harness([reply([GOOD_FACT])], judge)
    const audit = await h.run(INPUT, {}, def({}, { questionSets: { 'echo.widget_claim': RULE_SET } }))
    expect(judge.calls[0]).toMatchObject({ question: RULE_SET.question, set: RULE_SET })
    expect(audit.decisions[0]!.question_id).toBe('rule-set-1')
    const run = (await h.sql.query<Record<string, unknown>>('select versions from agent_runs')).rows[0]!
    expect(asJson(run.versions)).toMatchObject({ question_sets: { 'echo.widget_claim': 'rule-set-1@rule-sha-1' } })
  })

  it('falls back to the default set for a rule without an entry', async () => {
    const judge = new FakeJudgePort(() => 0.95)
    const h = await harness([reply([GOOD_FACT])], judge)
    const audit = await h.run(INPUT, {}, def({}, { questionSets: { 'echo.widget_safety': RULE_SET } }))
    expect(judge.calls[0]!.set).toEqual(exampleEcho.judge.questionSet)
    expect(audit.decisions[0]!.question_id).toBe(exampleEcho.judge.questionSet.id)
  })

  it('validateDefinition rejects a set for an unknown rule', () => {
    expect(() => validateDefinition(def({}, { questionSets: { 'no.such_rule': RULE_SET } }) as never)).toThrow(/unknown rule/)
    expect(() => validateDefinition(def({}, { questionSets: { 'echo.widget_claim': RULE_SET } }) as never)).not.toThrow()
  })
})

describe('F7.3 G8b: context ranges', () => {
  const range = (from: string, to: string, source = 'conversation') => [{ source_id: source, segment_from: from, segment_to: to }]

  it('puts whole segments (ids, role, text) under context_segments, never in evidence', async () => {
    const judge = new FakeJudgePort(() => 0.95)
    const h = await harness([reply([GOOD_FACT])], judge)
    await h.run(INPUT, {}, def({ contextRanges: range('s2', 's3') }))
    const state = judge.calls[0]!.state as { evidence: unknown[]; context_segments: unknown[] }
    expect(state.context_segments).toEqual([
      { source_id: 'conversation', segment_id: 's2', role: 'patient', text: 'I think the widget is red.' },
      { source_id: 'conversation', segment_id: 's3', role: 'clinician', text: 'Noted, thank you.' },
    ])
    expect(JSON.stringify(state.evidence)).not.toContain('Noted')
    expect(state.evidence).toHaveLength(1)
  })

  it('a candidate without ranges has the unchanged judge state', async () => {
    const judge = new FakeJudgePort(() => 0.95)
    const h = await harness([reply([GOOD_FACT])], judge)
    await h.run(INPUT, {}, def({}))
    expect('context_segments' in (judge.calls[0]!.state as object)).toBe(false)
    expect(buildJudgeState('r', 'c', [{ quote: 'q' }])).toEqual({ rule: 'r', claim: 'c', evidence: [{ quote: 'q' }] })
  })

  it.each([
    ['unknown source', range('s1', 's2', 'other')],
    ['unknown from', range('nope', 's2')],
    ['unknown to', range('s1', 'nope')],
    ['reversed', range('s3', 's1')],
  ])('refuses %s: counted drop context_out_of_range, no judge call, no finding', async (_name, contextRanges) => {
    const judge = new FakeJudgePort(() => 0.95)
    const h = await harness([reply([GOOD_FACT])], judge)
    const audit = await h.run(INPUT, {}, def({ contextRanges }))
    expect(judge.calls).toHaveLength(0)
    expect(audit.findings).toHaveLength(0)
    const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
    expect((asJson(row.counts) as { drops: Record<string, number> }).drops).toMatchObject({ context_out_of_range: 1 })
  })
})
