import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyDecisions, averageProbabilities, CRITICAL_ROUTE_RATIONALE } from '../src/decide/apply.js'
import { questionsFor } from '../src/decide/questions.js'
import { HttpJevTransport } from '../src/decide/transport.js'
import { activeThresholds, DEFAULT_BUDGET, thresholdsFromBudget, SYNTHETIC_NON_SAFETY_SCORES, SYNTHETIC_SAFETY_SCORES } from '../src/decide/thresholds.js'
import { validateModel } from '../src/facts/validate.js'
import { countModelCalls } from '../src/llm/ledger.js'
import { scriptedModelPayload } from '../src/llm/scripted-note.js'
import { FakeModelClient } from '../src/llm/fake.js'
import { FakeJevTransport } from '../src/decide/transport.js'
import { rescoreStoredNote, runAudit } from '../src/pipeline/audit.js'
import { DEFAULT_PACK, findingKey, isTrueRedFlag, scoreFindings, type FindingDraft } from '../src/rules/pack.js'
import { testDb } from './helpers.js'

const gold = JSON.parse(readFileSync('fixtures/gold/safety-v1.json', 'utf8')) as {
  cases: { id: string; source: string; source_uid: string; source_timestamp: string; body: string }[]
}

function clinicNote(plan: string, redFlags: string[], diagnosis = 'viral fever'): string {
  return [
    'AGE: 40',
    'SEX: male',
    'PREGNANT: no',
    'RENAL: no',
    'HEPATIC: no',
    'ALLERGY: none',
    'COMORBIDITY: none',
    `DIAGNOSIS: ${diagnosis}`,
    'MEDICATION: paracetamol | 500 | mg | tds | oral | 3 days',
    'VITAL: temp_c | 38.4 | c',
    'INVESTIGATION: none',
    `PLAN: ${plan}`,
    ...redFlags.map((flag) => `REDFLAG: ${flag}`),
  ].join('\n')
}

function ruleIds(body: string): string[] {
  const validated = validateModel(scriptedModelPayload(body), body)
  if (!validated.ok) throw new Error(validated.errors.map((issue) => issue.code).join(','))
  return scoreFindings(validated.state).map((finding) => finding.rule_id)
}

function draft(severity: 'critical' | 'safety' | 'quality'): FindingDraft {
  const safety = severity === 'critical' || severity === 'safety'
  return {
    id: safety ? 'safety-1' : 'quality-1',
    rule_id: severity === 'quality' ? 'dx.missing_indication' : severity === 'safety' ? 'dose.renal.metformin' : 'ddi.warfarin_nsaid',
    rule_version: '1',
    severity,
    safety_class: safety,
    summary: 'template summary',
    evidence_fact_refs: [],
    evidence_keys: ['warfarin', 'ibuprofen'],
    evidence: [],
  }
}

describe('rules and decisions', () => {
  it('gives the same finding key when the drug order changes', () => {
    const warfarinFirst = gold.cases.find((item) => item.id === 'syn-ddi-allergy')
    const ibuprofenFirst = gold.cases.find((item) => item.id === 'syn-ddi-order-swap')
    if (!warfarinFirst || !ibuprofenFirst) throw new Error('missing cases')
    const left = validateModel(scriptedModelPayload(warfarinFirst.body), warfarinFirst.body)
    const right = validateModel(scriptedModelPayload(ibuprofenFirst.body), ibuprofenFirst.body)
    expect(left.ok && right.ok).toBe(true)
    if (!left.ok || !right.ok) return
    const leftId = scoreFindings(left.state, DEFAULT_PACK).find((item) => item.rule_id === 'ddi.warfarin_nsaid')?.id
    const rightId = scoreFindings(right.state, DEFAULT_PACK).find((item) => item.rule_id === 'ddi.warfarin_nsaid')?.id
    expect(leftId).toBe(rightId)
    expect(leftId).toBe(findingKey('ddi.warfarin_nsaid', '1', ['med:warfarin', 'med:ibuprofen']))
    const severities = new Set(DEFAULT_PACK.rules.map((rule) => rule.severity))
    expect([...severities].sort()).toEqual(['critical', 'documentation', 'quality', 'safety'])
  })

  it('re-scores stored facts without another model call', async () => {
    const sql = await testDb()
    const note = gold.cases[0]
    if (!note) throw new Error('missing case')
    const audit = await runAudit(
      { sql, models: new FakeModelClient(sql), jev: new FakeJevTransport(sql) },
      {
        traceId: 'trace-rescore',
        purpose: 'test',
        source: note.source,
        sourceUid: note.source_uid,
        sourceTimestamp: note.source_timestamp,
        body: note.body,
        backlogDays: 0,
      },
    )
    expect(audit.status).toBe('ok')
    const before = await countModelCalls(sql)
    const noteId = (
      await sql.query<{ id: string }>('select id from note_versions where source_uid = $1', [note.source_uid])
    ).rows[0]?.id
    if (!noteId) throw new Error('note missing')
    const findings = await rescoreStoredNote(sql, noteId)
    expect(findings.some((item) => item.rule_id === 'ddi.warfarin_nsaid' && item.severity === 'critical')).toBe(true)
    expect(await countModelCalls(sql)).toBe(before)
  })

  it('averages both option orders and abstains instead of dropping safety findings', () => {
    expect(averageProbabilities({ yes: 0.8, no: 0.2 }, { yes: 0.6, no: 0.4 })).toEqual({ yes: 0.7, no: 0.3 })
    const thresholds = activeThresholds(0)
    expect(thresholds.safetyAbstainBelow).toBe(0.97)
    expect(thresholds.nonSafetyAbstainBelow).toBe(0.88)

    const low = applyDecisions(
      [draft('critical')],
      [{ finding_id: 'safety-1', question_id: 'validity', probabilities: { yes: 0.96, no: 0.04 } }],
      thresholds,
    )[0]
    expect(low?.action).toBe('abstain')
    expect(low?.queue).toBe(true)
    expect(low?.doctor_visible).toBe(false)
    expect(low?.decisions.some((decision) => decision.question_id === 'route')).toBe(false)

    const routed = applyDecisions(
      [draft('critical')],
      [
        { finding_id: 'safety-1', question_id: 'validity', probabilities: { yes: 0.99, no: 0.01 } },
        { finding_id: 'safety-1', question_id: 'route', probabilities: { drop_informational: 0.99, route: 0.005, hold: 0.005 } },
      ],
      thresholds,
    )[0]
    expect(routed?.action).toBe('route')
    expect(routed?.queue).toBe(false)
    expect(routed?.doctor_visible).toBe(true)
    expect(routed?.decisions.find((decision) => decision.question_id === 'route')?.rationale).toBe(CRITICAL_ROUTE_RATIONALE)

    const safetyDrop = applyDecisions(
      [draft('safety')],
      [
        { finding_id: 'safety-1', question_id: 'validity', probabilities: { yes: 0.99, no: 0.01 } },
        { finding_id: 'safety-1', question_id: 'route', probabilities: { drop_informational: 0.99, route: 0.005, hold: 0.005 } },
      ],
      thresholds,
    )[0]
    expect(safetyDrop?.action).toBe('abstain')
    expect(safetyDrop?.queue).toBe(true)
    expect(safetyDrop?.doctor_visible).toBe(false)

    const invalid = applyDecisions(
      [draft('critical')],
      [{ finding_id: 'safety-1', question_id: 'validity', probabilities: { no: 0.99, yes: 0.01 } }],
      thresholds,
    )[0]
    expect(invalid?.action).toBe('suppressed_invalid')
    expect(invalid?.queue).toBe(false)

    const renal = { ...draft('safety'), id: 'safety-renal' }
    const ids = questionsFor([draft('critical'), renal, draft('quality')]).map((question) => question.id)
    expect(ids.filter((id) => id.endsWith(':route'))).toEqual(['safety-renal:route', 'quality-1:route'])
  })

  it('keeps a 60% safety share and shrinks non-safety slots when the backlog is over two days', () => {
    const tight = thresholdsFromBudget(
      { ...DEFAULT_BUDGET, safetyShare: 0.1 },
      SYNTHETIC_SAFETY_SCORES,
      SYNTHETIC_NON_SAFETY_SCORES,
    )
    expect(tight.safetySlots).toBe(15)
    const backlog = thresholdsFromBudget({ ...DEFAULT_BUDGET, backlogDays: 3 }, SYNTHETIC_SAFETY_SCORES, SYNTHETIC_NON_SAFETY_SCORES)
    expect(backlog.safetySlots).toBe(15)
    expect(backlog.nonSafetySlots).toBe(2)
  })

  it('raises the warfarin and penicillin findings from a quote-only model reply', async () => {
    const sql = await testDb()
    const body = [
      '54-year-old female, not pregnant.',
      'Renal function is normal. Hepatic function is normal.',
      'Known allergy to penicillin.',
      'Medications include warfarin 5 mg oral daily, ibuprofen 400 mg tds, and amoxicillin 500 mg tds.',
      'Plan: review in clinic.',
    ].join('\n')
    const quote = (text: string) => ({ quote: text })
    const toolInput = {
      patient: {
        age_years: 54,
        age_span: quote('54-year-old'),
        sex: 'female',
        sex_span: quote('female'),
        pregnancy: 'no',
        pregnancy_span: quote('not pregnant'),
        renal_impairment: 'no',
        renal_span: quote('Renal function is normal.'),
        hepatic_impairment: 'no',
        hepatic_span: quote('Hepatic function is normal.'),
        allergies: [{ substance: 'penicillin', span: quote('penicillin') }],
        comorbidities: [],
      },
      medications: [
        { drug: 'warfarin', dose: 5, unit: 'mg', frequency: 'daily', route: 'oral', duration: null, span: quote('warfarin 5 mg oral daily') },
        { drug: 'ibuprofen', dose: 400, unit: 'mg', frequency: 'tds', route: null, duration: null, span: quote('ibuprofen 400 mg tds') },
        { drug: 'amoxicillin', dose: 500, unit: 'mg', frequency: 'tds', route: null, duration: null, span: quote('amoxicillin 500 mg tds') },
      ],
      diagnoses: [],
      vitals: [],
      investigations: [],
      plan: [{ text: 'review in clinic', span: quote('review in clinic') }],
      red_flags: [],
    }
    const audit = await runAudit(
      { sql, models: new FakeModelClient(sql, () => ({ kind: 'text', text: 'recorded', toolInput })), jev: new FakeJevTransport(sql) },
      {
        traceId: 'trace-prose',
        purpose: 'test',
        source: 'synthetic',
        sourceUid: 'prose-ddi-allergy',
        sourceTimestamp: '2026-10-12T00:00:00.000Z',
        body,
        backlogDays: 0,
      },
    )
    expect(audit.status).toBe('ok')
    expect(audit.findings.map((finding) => finding.rule_id).sort()).toEqual(['allergy.beta_lactam', 'ddi.warfarin_nsaid'])
  })

  it('accepts pregnancy no on a male sex span and still raises both safety findings', async () => {
    const sql = await testDb()
    const body = [
      '62-year-old male.',
      'Known allergy to penicillin.',
      'Medications include warfarin 5 mg oral daily, ibuprofen 400 mg tds, and amoxicillin 500 mg tds.',
      'Plan: review in clinic.',
    ].join('\n')
    const quote = (text: string) => ({ quote: text })
    const toolInput = {
      patient: {
        age_years: 62,
        age_span: quote('62-year-old'),
        sex: 'male',
        sex_span: quote('male'),
        pregnancy: 'no',
        pregnancy_span: null,
        renal_impairment: 'no',
        renal_span: null,
        hepatic_impairment: 'no',
        hepatic_span: null,
        allergies: [{ substance: 'penicillin', span: quote('penicillin') }],
        comorbidities: [],
      },
      medications: [
        { drug: 'warfarin', dose: 5, unit: 'mg', frequency: 'daily', route: 'oral', duration: null, span: quote('warfarin 5 mg oral daily') },
        { drug: 'ibuprofen', dose: 400, unit: 'mg', frequency: 'tds', route: null, duration: null, span: quote('ibuprofen 400 mg tds') },
        { drug: 'amoxicillin', dose: 500, unit: 'mg', frequency: 'tds', route: null, duration: null, span: quote('amoxicillin 500 mg tds') },
      ],
      diagnoses: [],
      vitals: [],
      investigations: [],
      plan: [{ text: 'review in clinic', span: quote('review in clinic') }],
      red_flags: [],
    }
    const audit = await runAudit(
      { sql, models: new FakeModelClient(sql, () => ({ kind: 'text', text: 'recorded', toolInput })), jev: new FakeJevTransport(sql) },
      {
        traceId: 'trace-male-prose',
        purpose: 'test',
        source: 'synthetic',
        sourceUid: 'prose-male-ddi-allergy',
        sourceTimestamp: '2026-10-12T00:00:00.000Z',
        body,
        backlogDays: 0,
      },
    )
    expect(audit.status).toBe('ok')
    expect(audit.findings.map((finding) => finding.rule_id).sort()).toEqual(['allergy.beta_lactam', 'ddi.warfarin_nsaid'])
    const facts = await sql.query<{ facts: { patient: { pregnancy: { value: string; span: { quote: string } | null } } } }>(
      'select facts from extractions',
    )
    expect(facts.rows[0]?.facts.patient.pregnancy.value).toBe('no')
    expect(facts.rows[0]?.facts.patient.pregnancy.span?.quote).toBe('male')
  })

  it('fires redflag.no_urgent_plan only for a true emergency without an urgent plan', () => {
    expect(isTrueRedFlag('sudden chest pain')).toBe(true)
    expect(isTrueRedFlag('fever')).toBe(false)
    expect(isTrueRedFlag('pneumonia')).toBe(false)

    const fever = ruleIds(clinicNote('review in 1 week', ['fever', 'pneumonia'], 'pneumonia'))
    expect(fever).not.toContain('redflag.no_urgent_plan')

    const routineChestPain = ruleIds(clinicNote('review in 1 week', ['sudden chest pain']))
    expect(routineChestPain).toContain('redflag.no_urgent_plan')

    const referred = ruleIds(clinicNote('refer to emergency', ['sudden chest pain']))
    expect(referred).not.toContain('redflag.no_urgent_plan')

    const mixed = ruleIds(clinicNote('review in 1 week', ['fever', 'sudden chest pain']))
    expect(mixed).toContain('redflag.no_urgent_plan')

    const pregnancy = gold.cases.find((item) => item.id === 'syn-pregnancy-fdc-redflag')
    if (!pregnancy) throw new Error('missing gold case')
    expect(ruleIds(pregnancy.body)).toContain('redflag.no_urgent_plan')
  })

  it('does not call Jev when the client is not configured', async () => {
    const sql = await testDb()
    let called = false
    const transport = new HttpJevTransport(sql, undefined, undefined, 'jev-1.13.0', async () => {
      called = true
      return new Response('no')
    })
    const result = await transport.classify({
      traceId: 't',
      purpose: 'decide',
      state: {},
      questions: [],
      optionOrder: 'forward',
    })
    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') expect(result.error.type).toBe('jev_not_configured')
    expect(called).toBe(false)
  })
})
