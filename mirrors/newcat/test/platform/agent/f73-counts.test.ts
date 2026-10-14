import { describe, expect, it } from 'vitest'
import { assertGovernanceSafe, EmitRefusal, serialize } from '../../../src/audience/serialize.js'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { asJson } from '../../../src/db/sql.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { validateDefinition } from '../../../src/platform/agent/define.js'
import { candidatesOf, type AgentDefinition, type RuleResult } from '../../../src/platform/agent/types.js'
import { GOOD_FACT, harness, reply } from './harness.js'

const base = exampleEcho.rules[0]!

function def(result: (facts: never[]) => RuleResult, extra: Record<string, unknown> = {}): AgentDefinition<EchoInput, never> {
  return {
    ...exampleEcho,
    countReasons: ['not_applicable', 'low_signal'],
    abstention: { ...exampleEcho.abstention, emptyReasons: ['no_widget_claims', 'out_of_scope'] },
    rules: [{ ...base, evaluate: result as never }, ...exampleEcho.rules.slice(1)],
    ...extra,
  } as never
}
const runs = async (d: AgentDefinition<EchoInput, never>, facts: unknown[] = [GOOD_FACT]) => {
  const h = await harness([reply(facts)])
  return { h, audit: await h.run(undefined, {}, d) }
}

describe('F7.3 G4: candidate-free counts channel', () => {
  it('sums declared reasons into audit.agent_counts and the run row', async () => {
    const two = { ...base, id: 'echo.second', evaluate: () => ({ candidates: [], counts: { not_applicable: 2, low_signal: 1 } }) }
    const d = def(() => ({ candidates: [], counts: { not_applicable: 3 } }))
    d.rules = [d.rules[0]!, two as never]
    const { h, audit } = await runs(d)
    expect(audit.agent_counts).toEqual({ not_applicable: 5, low_signal: 1 })
    const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
    expect(asJson(row.counts)).toMatchObject({ agent_counts: { not_applicable: 5, low_signal: 1 } })
  })

  it('counts come with candidates too, and the run still judges them', async () => {
    const { audit } = await runs(def((facts) => ({ candidates: candidatesOf(base.evaluate(facts)), counts: { low_signal: 1 } })))
    expect(audit.status).toBe('ok')
    expect(audit.agent_counts).toEqual({ low_signal: 1 })
  })

  it('a bare candidate list leaves agent_counts absent', async () => {
    const { audit, h } = await runs(def((facts) => base.evaluate(facts)))
    expect('agent_counts' in audit).toBe(false)
    const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
    expect('agent_counts' in (asJson(row.counts) as object)).toBe(false)
  })

  it.each([
    ['undeclared reason', { surprise: 1 }],
    ['negative', { low_signal: -1 }],
    ['fractional', { low_signal: 1.5 }],
  ])('refuses %s: the run fails and carries no counts', async (_name, counts) => {
    const { audit } = await runs(def(() => ({ candidates: [], counts })))
    expect(audit.status).toBe('failed')
    expect(audit.error?.type).toBe('invalid_agent_count')
    expect(audit.agent_counts).toBeUndefined()
  })

  it('validateDefinition requires snake_case, unique countReasons', () => {
    expect(() => validateDefinition(def(() => []) as never)).not.toThrow()
    expect(() => validateDefinition(def(() => [], { countReasons: ['Bad Reason'] }) as never)).toThrow(/countReasons/)
    expect(() => validateDefinition(def(() => [], { countReasons: ['a', 'a'] }) as never)).toThrow(/unique/)
  })

  it('doctor, operator and internal bodies never carry agent_counts', async () => {
    const { audit } = await runs(def(() => ({ candidates: [], counts: { low_signal: 1 } })))
    for (const audience of ['doctor', 'operator', 'internal'] as const) {
      expect(JSON.stringify(serialize(audit, audience))).not.toContain('agent_counts')
    }
  })

  describe('governance allowlist', () => {
    const body = (agent_counts: unknown) => ({ findings: [], abstentions: {}, agent_counts })
    it('accepts a record of non-negative integers', () => expect(() => assertGovernanceSafe(body({ low_signal: 0, not_applicable: 4 }))).not.toThrow())
    it.each([
      ['negative', { a: -1 }],
      ['fractional', { a: 1.5 }],
      ['string', { a: '2' }],
      ['non-slug key', { 'Free Text': 1 }],
      ['an array', [1]],
      ['null', null],
    ])('refuses %s', (_name, value) => expect(() => assertGovernanceSafe(body(value))).toThrow(EmitRefusal))
  })
})

describe('F7.3 G5: agent empty reason', () => {
  it('a declared empty_reason replaces no_candidate_findings when there are no candidates', async () => {
    const { audit } = await runs(def(() => ({ candidates: [], empty_reason: 'out_of_scope' })))
    expect(audit).toMatchObject({ status: 'empty', reason: 'out_of_scope' })
  })

  it('an undeclared empty_reason is refused', async () => {
    const { audit } = await runs(def(() => ({ candidates: [], empty_reason: 'made_up' })))
    expect(audit.status).toBe('failed')
    expect(audit.error?.type).toBe('invalid_abstention_reason')
  })

  it('a platform reason is not accepted as an agent empty_reason unless declared', async () => {
    const { audit } = await runs(def(() => ({ candidates: [], empty_reason: 'judge_dropped_all' })))
    expect(audit.status).toBe('failed')
  })

  it('does not apply when candidates exist and the judge drops them all', async () => {
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.01))
    const audit = await h.run(undefined, {}, def((facts) => ({ candidates: candidatesOf(base.evaluate(facts)), empty_reason: 'out_of_scope' })))
    expect(audit).toMatchObject({ status: 'empty', reason: 'judge_dropped_all' })
  })

  it('does not apply when a finding is produced', async () => {
    const { audit } = await runs(def((facts) => ({ candidates: candidatesOf(base.evaluate(facts)), empty_reason: 'out_of_scope' })))
    expect(audit.status).toBe('ok')
    expect(audit.reason).toBeUndefined()
  })

  it('the first rule in order wins when several set one', async () => {
    const d = def(() => ({ candidates: [], empty_reason: 'out_of_scope' }))
    d.rules = [d.rules[0]!, { ...base, id: 'echo.later', evaluate: () => ({ candidates: [], empty_reason: 'no_widget_claims' }) } as never]
    const { audit } = await runs(d)
    expect(audit.reason).toBe('out_of_scope')
  })
})
