import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FakeJevTransport } from '../src/decide/transport.js'
import { extractFacts, readFacts } from '../src/extract/extract.js'
import { EXTRACT_TOOL_NAME, extractionInputSchema, extractionSystem, extractionTool } from '../src/extract/prompt.js'
import { ModelPayload } from '../src/facts/schema.js'
import { validateModel } from '../src/facts/validate.js'
import { FakeModelClient, type FakeReply } from '../src/llm/fake.js'
import { countModelCalls, setBudgetMax } from '../src/llm/ledger.js'
import { scriptedModelPayload } from '../src/llm/scripted-note.js'
import { BedrockModelClient, converseToolConfig } from '../src/llm/bedrock.js'
import type { ModelRequest } from '../src/llm/types.js'
import { runAudit } from '../src/pipeline/audit.js'
import { testDb } from './helpers.js'

const gold = JSON.parse(readFileSync('fixtures/gold/safety-v1.json', 'utf8')) as { cases: { body: string }[] }

function payloadFor(body: string): Record<string, unknown> {
  return scriptedModelPayload(body) as Record<string, unknown>
}

describe('fact validators and extraction', () => {
  it('keeps a note when a non-critical fact is unsupported and fails a missing medication or allergy quote', () => {
    const body = gold.cases[0]?.body
    if (!body) throw new Error('missing body')

    const unit = payloadFor(body)
    const meds = unit.medications as { unit: string; span: { quote: string } }[]
    const firstMed = meds[0]
    if (!firstMed) throw new Error('missing medication')
    firstMed.unit = 'stones'
    const unitResult = validateModel(unit, body)
    expect(unitResult.ok).toBe(true)
    if (unitResult.ok) expect(unitResult.state.medications[0]?.value.unit).toBeNull()

    const range = payloadFor(body)
    const vitals = range.vitals as { value: number }[]
    const firstVital = vitals[0]
    if (!firstVital) throw new Error('missing vital')
    firstVital.value = 900
    const rangeResult = validateModel(range, body)
    expect(rangeResult.ok).toBe(true)
    if (rangeResult.ok) expect(rangeResult.state.vitals).toEqual([])

    const negated = payloadFor(body)
    const allergies = (negated.patient as { allergies: { substance: string }[] }).allergies
    const allergy = allergies[0]
    if (!allergy) throw new Error('missing allergy')
    allergy.substance = 'none'
    const negatedResult = validateModel(negated, body)
    expect(negatedResult.ok).toBe(true)
    if (negatedResult.ok) expect(negatedResult.state.patient.allergies).toEqual([])

    const missingMed = payloadFor(body)
    const missingMeds = missingMed.medications as { span: { quote: string } }[]
    const quoted = missingMeds[0]
    if (!quoted) throw new Error('missing medication')
    quoted.span.quote = 'this quote is not in the note'
    const missingMedResult = validateModel(missingMed, body)
    expect(missingMedResult.ok).toBe(false)
    if (!missingMedResult.ok) expect(missingMedResult.errors.some((issue) => issue.path === 'medications.0')).toBe(true)

    const missingAllergy = payloadFor(body)
    const allergyRows = (missingAllergy.patient as { allergies: { span: { quote: string } }[] }).allergies
    const allergyRow = allergyRows[0]
    if (!allergyRow) throw new Error('missing allergy')
    allergyRow.span.quote = 'this quote is not in the note'
    const missingAllergyResult = validateModel(missingAllergy, body)
    expect(missingAllergyResult.ok).toBe(false)
    if (!missingAllergyResult.ok) expect(missingAllergyResult.errors.some((issue) => issue.path === 'patient.allergies.0')).toBe(true)
  })

  it('accepts a valid Haiku extraction and does not call Sonnet', async () => {
    const sql = await testDb()
    const tiers: string[] = []
    const models = new FakeModelClient(sql, (request) => {
      tiers.push(request.tier)
      return { kind: 'text', text: JSON.stringify(scriptedModelPayload(bodyOf(request))) }
    })
    const body = gold.cases[0]?.body ?? ''
    const result = await extractFacts(models, body, 'trace-ok')
    expect(result.status).toBe('ok')
    expect(tiers).toEqual(['haiku'])
  })

  it('escalates once to Sonnet after a validation failure and fails closed if that also fails', async () => {
    const sql = await testDb()
    const tiers: string[] = []
    const models = new FakeModelClient(sql, (request) => {
      tiers.push(request.tier)
      if (request.tier === 'haiku') return { kind: 'text', text: '{"patient":{}}' }
      return { kind: 'text', text: JSON.stringify(scriptedModelPayload(bodyOf(request))) }
    })
    const recovered = await extractFacts(models, gold.cases[0]?.body ?? '', 'trace-escalate')
    expect(recovered.status).toBe('ok')
    expect(tiers).toEqual(['haiku', 'sonnet'])

    const both = new FakeModelClient(sql, () => ({ kind: 'text', text: '{"patient":{}}' }))
    const failed = await extractFacts(both, gold.cases[0]?.body ?? '', 'trace-both')
    expect(failed.status).toBe('extraction_failed')
    if (failed.status === 'extraction_failed') expect(failed.errors.length).toBeGreaterThan(0)
  })

  it('does not escalate a Haiku transport failure or a truncation', async () => {
    const sql = await testDb()
    const unavailableTiers: string[] = []
    const unavailable = new FakeModelClient(sql, (request) => {
      unavailableTiers.push(request.tier)
      return { kind: 'throw' }
    })
    expect((await extractFacts(unavailable, 'AGE: 1', 'trace-down')).status).toBe('unavailable')
    expect(unavailableTiers).toEqual(['haiku'])

    const truncatedTiers: string[] = []
    const truncated = new FakeModelClient(sql, (request): FakeReply => {
      truncatedTiers.push(request.tier)
      return { kind: 'truncated', text: '{' }
    })
    expect((await extractFacts(truncated, 'AGE: 1', 'trace-cut')).status).toBe('truncated')
    expect(truncatedTiers).toEqual(['haiku'])
  })

  it('parses a realistic model reply through ModelPayload', () => {
    const body = [
      '54 year old female, not pregnant.',
      'Renal function is unknown.',
      'Hepatic function is unknown.',
      'Takes warfarin 5 mg oral daily.',
      'Plan: repeat INR next week.',
    ].join('\n')
    const quote = (text: string) => {
      const start = body.indexOf(text)
      if (start < 0) throw new Error('quote missing')
      return { start, end: start + text.length, quote: text }
    }
    const reply = JSON.stringify({
      patient: {
        age_years: 54,
        age_span: quote('54 year old'),
        sex: 'female',
        sex_span: quote('female'),
        pregnancy: 'no',
        pregnancy_span: quote('not pregnant'),
        renal_impairment: 'unknown',
        renal_span: quote('Renal function is unknown.'),
        hepatic_impairment: 'unknown',
        hepatic_span: quote('Hepatic function is unknown.'),
        allergies: [],
        comorbidities: [],
      },
      medications: [
        {
          drug: 'warfarin',
          dose: 5,
          unit: 'mg',
          frequency: 'daily',
          route: 'oral',
          duration: null,
          span: quote('Takes warfarin 5 mg oral daily.'),
        },
      ],
      diagnoses: [],
      vitals: [],
      investigations: [],
      plan: [{ text: 'repeat INR next week', span: quote('repeat INR next week') }],
      red_flags: [],
    })
    const parsed = ModelPayload.parse(JSON.parse(reply))
    expect(parsed.patient.sex).toBe('female')
    expect(parsed.medications[0]?.drug).toBe('warfarin')
    expect(parsed.medications[0]?.span.quote).toBe('Takes warfarin 5 mg oral daily.')
    expect(parsed.plan[0]?.text).toBe('repeat INR next week')
    const checked = validateModel(parsed, body)
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.state.medications[0]?.value.drug).toBe('warfarin')
      expect(checked.state.plan[0]?.value).toBe('repeat INR next week')
    }

    const invented = ModelPayload.safeParse({
      demographics: { age: '54F' },
      medications: [{ name: 'warfarin', dose: '5 mg daily' }],
      plan: [{ action: 'repeat INR' }],
    })
    expect(invented.success).toBe(false)
    if (!invented.success) {
      const paths = invented.error.issues.map((issue) => issue.path.join('.'))
      expect(paths).toContain('patient')
      expect(paths).toContain('medications.0.drug')
      expect(paths).toContain('medications.0.span')
      expect(paths).toContain('plan.0.text')
    }
  })

  it('locates exact quotes, drifted quotes, null unknown spans, and a missing quote', () => {
    const exactBody = '54 year old female.\nTakes warfarin 5 mg oral daily.'
    const exact = validateModel(
      ModelPayload.parse(
        payloadShell(
          {
            age_years: 54,
            age_span: { quote: '54 year old' },
            sex: 'female',
            sex_span: { quote: 'female' },
          },
          {
            medications: [
              {
                drug: 'warfarin',
                dose: 5,
                unit: 'mg',
                frequency: 'daily',
                route: 'oral',
                duration: null,
                span: { quote: 'warfarin 5 mg oral daily' },
              },
            ],
          },
        ),
      ),
      exactBody,
    )
    expect(exact.ok).toBe(true)
    if (exact.ok) {
      const med = exact.state.medications[0]
      if (!med) throw new Error('missing medication')
      expect(med.span).toEqual({
        start: exactBody.indexOf('warfarin 5 mg oral daily'),
        end: exactBody.indexOf('warfarin 5 mg oral daily') + 'warfarin 5 mg oral daily'.length,
        quote: 'warfarin 5 mg oral daily',
      })
      expect(exact.state.patient.sex.span?.quote).toBe('female')
    }

    const driftedBody = `Morning ibuprofen.\n${'x'.repeat(80)}\nEvening ibuprofen.`
    const drifted = validateModel(
      ModelPayload.parse(
        payloadShell(
          {},
          {
            medications: [med('ibuprofen', 'ibuprofen'), med('ibuprofen', 'ibuprofen')],
          },
        ),
      ),
      driftedBody,
    )
    expect(drifted.ok).toBe(true)
    if (drifted.ok) {
      expect(drifted.state.medications[0]?.span.quote).toBe('ibuprofen')
      expect(drifted.state.medications[1]?.span.quote).toBe('ibuprofen')
      const firstEnd = drifted.state.medications[0]?.span.end ?? 0
      expect(drifted.state.medications[1]?.span.start ?? 0).toBeGreaterThan(firstEnd)
      expect(drifted.state.medications[0]?.span.start).toBe(driftedBody.indexOf('ibuprofen'))
    }

    const spaced = validateModel(
      ModelPayload.parse(payloadShell({}, { medications: [med('warfarin', 'Warfarin 5 mg')] })),
      'Takes warfarin   5 mg tonight.',
    )
    expect(spaced.ok).toBe(true)
    if (spaced.ok) expect(spaced.state.medications[0]?.span.quote).toBe('warfarin   5 mg')

    const unknown = validateModel(ModelPayload.parse(payloadShell({}, {})), 'No clinical facts.')
    expect(unknown.ok).toBe(true)
    if (unknown.ok) {
      expect(unknown.state.patient.sex).toMatchObject({ value: 'unknown', span: null })
      expect(unknown.state.patient.pregnancy.span).toBeNull()
      expect(unknown.state.patient.renal_impairment.span).toBeNull()
      expect(unknown.state.patient.hepatic_impairment.span).toBeNull()
    }

    const knownWithoutQuote = validateModel(
      ModelPayload.parse(payloadShell({ sex: 'female', sex_span: null, pregnancy: 'no', pregnancy_span: null }, {})),
      'female',
    )
    expect(knownWithoutQuote.ok).toBe(true)
    if (knownWithoutQuote.ok) {
      expect(knownWithoutQuote.state.patient.sex.value).toBe('unknown')
      expect(knownWithoutQuote.state.patient.pregnancy.value).toBe('unknown')
    }

    const maleBody = '62 year old male.'
    const male = validateModel(
      ModelPayload.parse(
        payloadShell(
          {
            sex: 'male',
            sex_span: { quote: 'male' },
            pregnancy: 'no',
            pregnancy_span: null,
            renal_impairment: 'no',
            renal_span: null,
            hepatic_impairment: 'yes',
            hepatic_span: null,
          },
          {},
        ),
      ),
      maleBody,
    )
    expect(male.ok).toBe(true)
    if (male.ok) {
      expect(male.state.patient.sex.value).toBe('male')
      expect(male.state.patient.pregnancy.value).toBe('no')
      expect(male.state.patient.pregnancy.span?.quote).toBe('male')
      expect(male.state.patient.pregnancy.span).toEqual(male.state.patient.sex.span)
      expect(male.state.patient.renal_impairment.value).toBe('unknown')
      expect(male.state.patient.hepatic_impairment.value).toBe('unknown')
    }
  })

  it('stores redacted tool input on the extraction row when validation fails', async () => {
    const sql = await testDb()
    const secret = 'zephyr-quote-not-in-note'
    const models = new FakeModelClient(sql, () => ({
      kind: 'text',
      text: secret,
      toolInput: payloadShell({}, { medications: [med('warfarin', secret)] }),
    }))
    const audit = await runAudit(
      { sql, models, jev: new FakeJevTransport(sql) },
      {
        traceId: 'trace-redact',
        purpose: 'test',
        source: 'synthetic',
        sourceUid: 'redact-1',
        sourceTimestamp: '2026-10-12T00:00:00.000Z',
        body: '54 year old female.',
        backlogDays: 0,
      },
    )
    expect(audit.status).toBe('failed')
    const rows = await sql.query<{ model_input: unknown }>('select model_input from extractions')
    const stored = rows.rows[0]?.model_input
    const encoded = JSON.stringify(stored)
    expect(encoded).not.toContain(secret)
    const input = stored as {
      sonnet: { tool_input: { medications: { span: { quote: { redacted: boolean; chars: number } } }[] } }
    }
    expect(input.sonnet.tool_input.medications[0]?.span.quote).toEqual({ redacted: true, chars: secret.length })
  })

  it('sends a forced tool schema and reads tool input when the text is not JSON', async () => {
    const schema = extractionInputSchema()
    expect(JSON.stringify(schema)).not.toContain('"$ref"')
    expect(JSON.stringify(schema)).not.toContain('"start"')
    expect(JSON.stringify(schema)).not.toContain('"end"')
    expect(schema.$schema).toBeUndefined()
    const properties = schema.properties as Record<string, unknown>
    expect(properties.patient).toBeTypeOf('object')
    expect(properties.medications).toBeTypeOf('object')
    expect(properties.plan).toBeTypeOf('object')
    const tool = extractionTool()
    expect(tool.name).toBe(EXTRACT_TOOL_NAME)
    expect(tool.description).toContain('must be unknown unless the note states it')
    const forced = converseToolConfig(tool)
    expect(forced.toolChoice.tool.name).toBe(EXTRACT_TOOL_NAME)
    expect(forced.tools[0]?.toolSpec.inputSchema.json).toEqual(schema)
    expect(extractionSystem()).toContain('"patient"')

    const sql = await testDb()
    const seen: ModelRequest[] = []
    const models = new FakeModelClient(sql, (request) => {
      seen.push(request)
      return { kind: 'text', text: 'facts recorded', toolInput: scriptedModelPayload(bodyOf(request)) }
    })
    const result = await extractFacts(models, gold.cases[0]?.body ?? '', 'trace-tool')
    expect(result.status).toBe('ok')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.tool?.name).toBe(EXTRACT_TOOL_NAME)
    expect(seen[0]?.system).toContain(JSON.stringify(schema))
    const prose = readFacts({ text: 'not json', toolInput: scriptedModelPayload(gold.cases[0]?.body ?? '') }, gold.cases[0]?.body ?? '')
    expect(prose.ok).toBe(true)
  })

  it('returns tool input when Bedrock stops on tool_use', async () => {
    const sql = await testDb()
    let sentTool = false
    const client = new BedrockModelClient(
      sql,
      {
        async send(_modelId, input) {
          sentTool = Boolean(input.tool)
          return {
            text: '',
            toolInput: { patient: { sex: 'female' } },
            stopReason: 'tool_use',
            inputTokens: 4,
            outputTokens: 8,
            latencyMs: 3,
          }
        },
      },
      { haiku: 'anthropic.haiku', sonnet: 'anthropic.sonnet', opus: 'anthropic.opus' },
    )
    const outcome = await client.complete({ ...request('haiku'), tool: extractionTool() })
    expect(sentTool).toBe(true)
    expect(outcome.status).toBe('ok')
    if (outcome.status === 'ok') {
      expect(outcome.data.stopReason).toBe('tool_use')
      expect(outcome.data.toolInput).toEqual({ patient: { sex: 'female' } })
      expect(outcome.data.text).toBe(JSON.stringify({ patient: { sex: 'female' } }))
    }
  })

  it('charges the budget before the call and keeps the charge when the provider throws', async () => {
    const sql = await testDb()
    await setBudgetMax(sql, 'llm', 1)
    let sends = 0
    const client = new BedrockModelClient(
      sql,
      {
        async send() {
          sends += 1
          throw new Error('down')
        },
      },
      { haiku: 'anthropic.haiku', sonnet: 'anthropic.sonnet', opus: 'anthropic.opus' },
    )
    const first = await client.complete(request('haiku'))
    expect(first.status).toBe('unavailable')
    expect(sends).toBe(1)
    const rows = await sql.query<{ served_model_id: string | null; intended_model_id: string }>(
      'select served_model_id, intended_model_id from model_calls',
    )
    expect(rows.rows[0]?.intended_model_id).toBe('anthropic.haiku')
    expect(rows.rows[0]?.served_model_id).toBeNull()
    const second = await client.complete(request('haiku'))
    expect(second.status).toBe('refused')
    if (second.status === 'refused') expect(second.error.type).toBe('budget_exhausted')
    expect(sends).toBe(1)
    expect(await countModelCalls(sql)).toBe(1)
  })
})

function payloadShell(patient: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    patient: {
      age_years: null,
      age_span: null,
      sex: 'unknown',
      sex_span: null,
      pregnancy: 'unknown',
      pregnancy_span: null,
      renal_impairment: 'unknown',
      renal_span: null,
      hepatic_impairment: 'unknown',
      hepatic_span: null,
      allergies: [],
      comorbidities: [],
      ...patient,
    },
    medications: [],
    diagnoses: [],
    vitals: [],
    investigations: [],
    plan: [],
    red_flags: [],
    ...extra,
  }
}

function med(drug: string, quote: string): Record<string, unknown> {
  return { drug, dose: null, unit: null, frequency: null, route: null, duration: null, span: { quote } }
}

function bodyOf(request: ModelRequest): string {
  return /NOTE_BODY_START\n([\s\S]*?)\nNOTE_BODY_END/.exec(request.user)?.[1] ?? ''
}

function request(tier: 'haiku' | 'sonnet' | 'opus'): ModelRequest {
  return { tier, system: 's', user: 'u', maxOutputTokens: 16, traceId: 't', purpose: 'extract' }
}
