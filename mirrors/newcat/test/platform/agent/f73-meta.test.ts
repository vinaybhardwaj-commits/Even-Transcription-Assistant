import { describe, expect, it } from 'vitest'
import { assertGovernanceSafe, EmitRefusal, serialize } from '../../../src/audience/serialize.js'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { candidatesOf, type AgentDefinition } from '../../../src/platform/agent/types.js'
import { GOOD_FACT, harness, reply } from './harness.js'

const MARK = 'zz-meta-marker-91'
const rule = exampleEcho.rules[0]!

/** example.echo whose rule attaches meta, and whose segments carry timings. */
function withMeta(meta: Record<string, string | number | boolean>): AgentDefinition<EchoInput, never> {
  return {
    ...exampleEcho,
    metaKeys: Object.keys(meta),
    sources: (input: EchoInput) => [
      { id: 'conversation', segments: input.segments.map((segment, index) => ({ ...segment, ...(index === 0 ? { t0: 1.5, t1: 4 } : {}) })) },
    ],
    rules: [{ ...rule, evaluate: (facts: never[]) => candidatesOf(rule.evaluate(facts)).map((candidate) => ({ ...candidate, meta })) }, ...exampleEcho.rules.slice(1)],
  } as never
}

describe('F7.3 G2: evidence segment_id and agent meta', () => {
  it('stamps segment_id, role, t0 and t1 on evidence from the gated fact', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(undefined, {}, withMeta({}))
    expect(audit.findings[0]!.evidence[0]).toMatchObject({ quote: 'widget is blue', segment_id: 's1', role: 'clinician', t0: 1.5, t1: 4 })
  })

  it('omits t0/t1 when the segment has none', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run()
    const item = audit.findings[0]!.evidence[0]!
    expect(item).toMatchObject({ segment_id: 's1', role: 'clinician' })
    expect('t0' in item).toBe(false)
    expect('t1' in item).toBe(false)
  })

  it('copies candidate.meta to the finding', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(undefined, {}, withMeta({ lane: 'a_b', score: 3, flag: true }))
    expect(audit.findings[0]!.meta).toEqual({ lane: 'a_b', score: 3, flag: true })
  })

  it('a finding without candidate meta has no meta key', async () => {
    const h = await harness([reply([GOOD_FACT])])
    expect('meta' in (await h.run()).findings[0]!).toBe(false)
  })

  it('meta never reaches the judge state or the claim text', async () => {
    const judge = new FakeJudgePort(() => 0.95)
    const h = await harness([reply([GOOD_FACT])], judge)
    const audit = await h.run(undefined, {}, withMeta({ note_tag: MARK }))
    expect(judge.calls).toHaveLength(1)
    expect(JSON.stringify(judge.calls[0])).not.toContain(MARK)
    expect(audit.findings[0]!.summary).not.toContain(MARK)
    expect(audit.findings[0]!.meta).toEqual({ note_tag: MARK })
  })

  it('doctor, operator and internal bodies never carry meta', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(undefined, {}, withMeta({ note_tag: MARK }))
    for (const audience of ['doctor', 'operator', 'internal'] as const) {
      const out = JSON.stringify(serialize(audit, audience))
      expect(out).not.toContain(MARK)
      expect(out).not.toContain('"meta"')
      expect(out).not.toContain('segment_id')
    }
  })
})

describe('F7.3 G2: governance meta check', () => {
  const body = (meta: unknown) => ({
    findings: [{ evidence: [{ segment_id: 's1', quote: 'q' }], judge: { primary_p: 0.8 }, meta }],
    abstentions: {},
  })
  it('accepts a flat record of scalars with slug keys', () => {
    expect(() => assertGovernanceSafe(body({ lane: 'x', n: 2, ok: false }))).not.toThrow()
  })
  it.each([
    ['nested object', { a: { b: 1 } }],
    ['array value', { a: [1] }],
    ['null value', { a: null }],
    ['NaN value', { a: Number.NaN }],
    ['non-slug key', { 'Bad Key': 1 }],
    ['uppercase key', { Lane: 1 }],
    ['key too long', { ['a'.repeat(65)]: 1 }],
    ['meta an array', [1]],
    ['meta a string', 'x'],
    ['banned key inside meta', { rationale: 'x' }],
  ])('refuses: %s', (_name, meta) => {
    expect(() => assertGovernanceSafe(body(meta))).toThrow(EmitRefusal)
  })
})
