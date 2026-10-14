import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { surgicalConsult } from '../../../src/agents/surgical-consult/definition.js'
import type { ConsultAuditInput } from '../../../src/agents/surgical-consult/input.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import type { Segment, Source } from '../../../src/platform/agent/types.js'
import { FakeSecondJudge } from '../../../src/platform/judge/second.js'
import { metamorphic, transforms } from '../../../src/platform/eval/metamorphic.js'
import { plantedClaim } from '../../../src/platform/eval/planted.js'
import { fixtureSha, normalize, regression, type RegressionCase } from '../../../src/platform/eval/regression.js'
import { asJson } from '../../../src/db/sql.js'
import { load, rig, roleBlindExtractor, scriptedExtractor } from './helpers.js'

const hernia = load('hernia-full-consent')
const knee = load('knee-replacement-missing-consent')

/** Runs a transform written for sources against the input's raw turns (segment id = turn id). */
function lens(change: (sources: Source[]) => Source[]) {
  return (input: ConsultAuditInput): ConsultAuditInput => {
    const source: Source = {
      id: 's1',
      segments: input.turns.map((t) => ({ id: t.id, role: t.role, t0: t.t0, t1: t.t1, text: t.text_en })),
    }
    const changed = change([source])[0]!.segments
    return {
      ...input,
      turns: changed.map((seg: Segment) => {
        const original = input.turns.find((t) => t.id === seg.id)
        return {
          id: seg.id,
          role: seg.role as ConsultAuditInput['turns'][number]['role'],
          t0: seg.t0 ?? 0,
          t1: seg.t1 ?? 0,
          text_en: seg.text,
          text_native: original?.text_native ?? null,
          lang: original?.lang ?? 'en',
        }
      }),
    }
  }
}

async function runner(respond = scriptedExtractor) {
  const r = await rig(respond)
  return { r, run: (input: ConsultAuditInput) => r.run(input) }
}

describe('audit.consult eval gate (fake judges)', () => {
  it('metamorphic: deleting the consent quote makes the consent finding appear', async () => {
    const { run } = await runner()
    const result = await metamorphic({
      run,
      fixture: hernia,
      transform: lens((s) => transforms.deleteText(s, '3', 'The risks are infection, bleeding and the hernia coming back. ')),
      expect: { added: ['consent.risks'] },
    })
    expect(result).toMatchObject({ pass: true, base: ['concern.unaddressed'], variant: ['concern.unaddressed', 'consent.risks'] })
  })

  it('metamorphic: a paraphrase outside the facts changes nothing', async () => {
    const { run } = await runner()
    const result = await metamorphic({ run, fixture: hernia, transform: lens((s) => transforms.paraphrase(s, '1', 'Your scan shows', 'The scan shows')), expect: {} })
    expect(result.pass).toBe(true)
  })

  it('metamorphic: swapping roles drops the role-gated facts at the gate', async () => {
    const { r, run } = await runner(roleBlindExtractor)
    const result = await metamorphic({
      run,
      fixture: hernia,
      transform: lens((s) => transforms.swapRoles(s, { doctor: 'patient', patient: 'doctor' })),
      expect: { removed: ['concern.unaddressed'], status: ['abstained'] },
    })
    expect(result).toMatchObject({ pass: true, base: ['concern.unaddressed'], variant: [] })
    // The swapped run attempted facts on the wrong roles: all dropped by the gate, so the run abstains extraction_unverified.
    const counts = (await r.sql.query<{ counts: unknown }>('select counts from agent_runs order by created_at desc')).rows.map((row) => asJson<{ drops: Record<string, number>; facts_kept: number }>(row.counts))
    expect(counts.some((c) => c.facts_kept === 0 && (c.drops.role_not_allowed ?? 0) > 0)).toBe(true)
  })

  it('metamorphic: inserting an unrelated segment adds nothing', async () => {
    const { run } = await runner()
    const result = await metamorphic({
      run,
      fixture: hernia,
      transform: lens((s) => transforms.insertSegment(s, 's1', { id: '7', role: 'patient', t0: 44, t1: 46, text: 'Thank you.' })),
      expect: {},
    })
    expect(result.pass).toBe(true)
  })

  it('metamorphic reports a wrong expectation as a failure', async () => {
    const { run } = await runner()
    expect((await metamorphic({ run, fixture: hernia, transform: (i) => i, expect: { added: ['consent.risks'] } })).pass).toBe(false)
  })

  it('planted claim: both fake judges say no once the evidence is altered', async () => {
    const { run } = await runner()
    const finding = (await run(knee)).findings.find((f) => f.rule_id === 'consent.risks')!
    const contextual = (state: unknown) => (JSON.stringify(state).includes('knee replacement') ? 0.95 : 0.05)
    const primary = new FakeJudgePort((call) => contextual(call.state))
    const second = new FakeSecondJudge(contextual)
    const planted = await plantedClaim({ finding, set: surgicalConsult.judge.questionSet, threshold: surgicalConsult.judge.thresholds.nonSafety, primary, second })
    expect(planted).toMatchObject({ pass: true, p: [0.05, 0.05] })
  })

  it('planted claim fails when a judge still believes the altered claim', async () => {
    const { run } = await runner()
    const finding = (await run(knee)).findings[0]!
    const planted = await plantedClaim({
      finding,
      set: surgicalConsult.judge.questionSet,
      threshold: 0.75,
      primary: new FakeJudgePort(() => 0.99),
    })
    expect(planted.pass).toBe(false)
  })

  it('regression: frozen fixture hashes and expected output', async () => {
    const { run } = await runner()
    const cases: Array<RegressionCase<ConsultAuditInput>> = [
      { id: 'hernia-full-consent', input: hernia, inputSha: fixtureSha(hernia), expected: { status: 'ok', findings: ['concern.unaddressed:valid'] } },
      {
        id: 'knee-replacement-missing-consent',
        input: knee,
        inputSha: fixtureSha(knee),
        expected: {
          status: 'ok',
          findings: [
            'consent.alternatives:valid',
            'consent.cost:valid',
            'consent.no_surgery_option:valid',
            'consent.risks:valid',
            'consent.second_opinion_offered:valid',
          ],
        },
      },
    ]
    expect(await regression(cases, run)).toEqual([])
    expect(await regression([{ ...cases[0]!, inputSha: 'stale' }], run)).toEqual([{ id: 'hernia-full-consent', problem: 'fixture_changed' }])
    expect(await regression([{ ...cases[0]!, expected: { status: 'empty', findings: [] } }], run)).toEqual([{ id: 'hernia-full-consent', problem: 'output_changed' }])
  })

  it('normalize keeps no text', async () => {
    const { run } = await runner()
    const text = JSON.stringify(normalize(await run(knee)))
    expect(text).not.toMatch(/knee|replacement|tablets/i)
  })

  it('the fixtures on disk have the shape the agent accepts', () => {
    for (const path of surgicalConsult.evalGate.fixtures) {
      expect(surgicalConsult.input.safeParse(JSON.parse(readFileSync(path, 'utf8'))).success).toBe(true)
    }
    expect(surgicalConsult.evalGate.regression).toEqual(['hernia-full-consent', 'knee-replacement-missing-consent'])
  })
})
