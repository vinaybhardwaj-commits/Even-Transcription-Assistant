import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FakeJevTransport, type JevAnswer } from '../src/decide/transport.js'
import { activeThresholds } from '../src/decide/thresholds.js'
import { calibrateValidity, summarize, UNSUPPORTED_CLAIM, unsupportedTwin } from '../src/eval/jev-calibration.js'
import type { GoldFile } from '../src/eval/gold.js'
import type { FindingDraft } from '../src/rules/pack.js'
import { testDb } from './helpers.js'

const gold = JSON.parse(readFileSync('fixtures/gold/safety-v1.json', 'utf8')) as GoldFile

describe('Jev validity calibration', () => {
  it('keeps the safety bar at 0.97 and separates planted unsupported claims in the report', async () => {
    expect(activeThresholds(0).safetyAbstainBelow).toBe(0.97)
    const sql = await testDb()
    const transport = new FakeJevTransport(sql, 'fake.jev-1.13.0', (call) => {
      const answers: JevAnswer[] = []
      for (const question of call.questions) {
        const unsupported = question.context?.claim === UNSUPPORTED_CLAIM
        const yes = unsupported ? 0.04 : 0.99
        if (question.id.endsWith(':validity')) {
          answers.push({ question_id: question.id, probabilities: { yes, no: 1 - yes } })
        } else {
          answers.push({
            question_id: question.id,
            probabilities: { route: 0.99, hold: 0.005, drop_informational: 0.005 },
          })
        }
      }
      return answers
    })
    const report = await calibrateValidity(gold, transport, { model: 'jev-latest', traceId: 'cal' })
    expect(report.status).toBe('measured')
    expect(report.safety_bar).toBe(0.97)
    expect(report.probability_field).toBe('probabilities.yes')
    expect(report.served_models).toEqual(['fake.jev-1.13.0'])
    expect(report.missing_expected).toEqual([])
    expect(report.valid_safety.n).toBeGreaterThan(0)
    expect(report.valid_safety.min).toBe(0.99)
    expect(report.valid_safety.below_safety_bar).toBe(0)
    expect(report.invalid.n).toBeGreaterThan(0)
    expect(report.invalid.max).toBe(0.04)
    expect(report.invalid.at_or_above_safety_bar).toBe(0)
    expect(report.cases.some((row) => row.case_id === 'syn-clean-fever' && row.label === 'invalid')).toBe(true)
    expect(report.cases.some((row) => row.rule_id === 'redflag.no_urgent_plan' && row.label === 'valid' && row.p_yes === 0.99)).toBe(true)
    const fever = report.cases.find((row) => row.case_id === 'syn-clean-fever' && row.label === 'valid' && row.rule_id === 'redflag.no_urgent_plan')
    expect(fever).toBeUndefined()
    expect(JSON.stringify(report)).not.toContain('Aspirin')
    expect(JSON.stringify(report)).not.toContain('5 mg')
  })

  it('reports fixture coverage without calling Jev when the transport is absent', async () => {
    const report = await calibrateValidity(gold, null, { model: 'jev-latest', traceId: 'offline' })
    expect(report.status).toBe('not_configured')
    expect(report.safety_bar).toBe(0.97)
    expect(report.valid_safety.n).toBeGreaterThan(0)
    expect(report.valid_safety.min).toBeNull()
    expect(report.invalid.min).toBeNull()
    expect(report.cases.every((row) => row.p_yes === null)).toBe(true)
  })

  it('builds an invalid twin that keeps the original quotes and replaces the claim', () => {
    const source: FindingDraft = {
      id: 'finding-1',
      rule_id: 'ddi.warfarin_nsaid',
      rule_version: '1',
      severity: 'critical',
      safety_class: true,
      summary: 'Warfarin and ibuprofen are prescribed together.',
      evidence_fact_refs: [],
      evidence_keys: ['med:warfarin'],
      evidence: [{ quote: 'warfarin 5 mg', start: 0, end: 13 }],
    }
    const twin = unsupportedTwin(source)
    expect(twin.summary).toBe(UNSUPPORTED_CLAIM)
    expect(twin.evidence).toEqual(source.evidence)
    expect(twin.id).not.toBe(source.id)
    expect(summarize([0.99, 0.7, null], 0.97)).toEqual({
      n: 2,
      min: 0.7,
      p50: 0.7,
      max: 0.99,
      mean: 0.845,
      below_safety_bar: 1,
      at_or_above_safety_bar: 1,
    })
  })
})
