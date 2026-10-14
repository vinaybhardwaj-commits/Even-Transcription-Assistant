import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { exampleEcho, type EchoInput } from '../../../src/agents/example-echo/index.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { FakeSecondJudge } from '../../../src/platform/judge/second.js'
import { metamorphic, transforms } from '../../../src/platform/eval/metamorphic.js'
import { plantedClaim } from '../../../src/platform/eval/planted.js'
import { fixtureSha, normalize, regression, type RegressionCase } from '../../../src/platform/eval/regression.js'
import { GOOD_FACT, harness, reply } from '../../platform/agent/harness.js'

const fixture = JSON.parse(readFileSync('fixtures/example-echo/basic.json', 'utf8')) as { input: EchoInput }

function lens(change: (sources: ReturnType<typeof exampleEcho.sources>) => ReturnType<typeof exampleEcho.sources>) {
  return (input: EchoInput): EchoInput => ({
    segments: change(exampleEcho.sources(input))[0]!.segments.map((segment) => ({
      id: segment.id,
      role: segment.role as 'clinician' | 'patient',
      text: segment.text,
    })),
  })
}

/** Fake model that extracts a claim only when the clinician segment still says it. */
async function runner() {
  const h = await harness([])
  const judge = new FakeJudgePort(() => 0.95)
  const run = async (input: EchoInput) => {
    const quote = 'widget is blue'
    const segment = input.segments.find((item) => item.text.includes(quote))
    const facts = segment ? [{ ...GOOD_FACT, segment_id: segment.id }] : []
    const local = await harness([reply(facts)], judge)
    return local.run(input)
  }
  return { run, h }
}

describe('example.echo eval gate (fake judges)', () => {
  it('metamorphic: deleting the claim removes the finding', async () => {
    const { run } = await runner()
    const result = await metamorphic({
      run,
      fixture: fixture.input,
      transform: lens((sources) => transforms.deleteText(sources, 's1', 'widget is blue')),
      expect: { removed: ['echo.widget_claim'], status: ['empty'] },
    })
    expect(result).toMatchObject({ pass: true, base: ['echo.widget_claim'], variant: [] })
  })

  it('metamorphic: a paraphrase that keeps the claim changes nothing', async () => {
    const { run } = await runner()
    const result = await metamorphic({
      run,
      fixture: fixture.input,
      transform: lens((sources) => transforms.paraphrase(sources, 's2', 'I think', 'Maybe')),
      expect: {},
    })
    expect(result.pass).toBe(true)
  })

  it('metamorphic: swapping roles moves the claim to a role the table rejects', async () => {
    const { run } = await runner()
    const result = await metamorphic({
      run,
      fixture: fixture.input,
      transform: lens((sources) => transforms.swapRoles(sources, { clinician: 'patient', patient: 'clinician' })),
      expect: { removed: ['echo.widget_claim'] },
    })
    expect(result.pass).toBe(true)
  })

  it('metamorphic: inserting an unrelated segment adds nothing', async () => {
    const { run } = await runner()
    const result = await metamorphic({
      run,
      fixture: fixture.input,
      transform: lens((sources) => transforms.insertSegment(sources, 'conversation', { id: 's3', role: 'patient', text: 'Nothing else.' })),
      expect: {},
    })
    expect(result.pass).toBe(true)
  })

  it('metamorphic reports a wrong expectation as a failure', async () => {
    const { run } = await runner()
    const result = await metamorphic({ run, fixture: fixture.input, transform: (input) => input, expect: { added: ['echo.other'] } })
    expect(result.pass).toBe(false)
  })

  it('planted claim: both fake judges say no once the evidence is altered', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(fixture.input)
    const finding = audit.findings[0]!
    const contextual = (state: unknown) => (JSON.stringify(state).includes('widget is blue') ? 0.95 : 0.05)
    const primary = new FakeJudgePort((call) => contextual(call.state))
    const second = new FakeSecondJudge(contextual)
    const planted = await plantedClaim({ finding, set: exampleEcho.judge.questionSet, threshold: 0.75, primary, second })
    expect(planted).toMatchObject({ pass: true, p: [0.05, 0.05] })
  })

  it('planted claim fails when a judge still believes the altered claim', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const finding = (await h.run(fixture.input)).findings[0]!
    const gullible = new FakeJudgePort(() => 0.99)
    const planted = await plantedClaim({ finding, set: exampleEcho.judge.questionSet, threshold: 0.75, primary: gullible })
    expect(planted.pass).toBe(false)
  })

  it('regression: frozen fixture hash and expected output', async () => {
    const { run } = await runner()
    const cases: Array<RegressionCase<EchoInput>> = [
      {
        id: 'basic',
        input: fixture.input,
        inputSha: fixtureSha(fixture.input),
        expected: { status: 'ok', findings: ['echo.widget_claim:valid'] },
      },
    ]
    expect(await regression(cases, run)).toEqual([])
    expect(await regression([{ ...cases[0]!, inputSha: 'stale' }], run)).toEqual([{ id: 'basic', problem: 'fixture_changed' }])
    expect(await regression([{ ...cases[0]!, expected: { status: 'empty', findings: [] } }], run)).toEqual([
      { id: 'basic', problem: 'output_changed' },
    ])
  })

  it('normalize keeps no text', async () => {
    const h = await harness([reply([GOOD_FACT])])
    expect(JSON.stringify(normalize(await h.run(fixture.input)))).not.toContain('blue')
  })

  it('the fixture on disk has the shape the agent accepts', () => {
    expect(exampleEcho.input.safeParse(fixture.input).success).toBe(true)
    for (const path of exampleEcho.evalGate.fixtures) expect(() => readFileSync(path, 'utf8')).not.toThrow()
  })
})
