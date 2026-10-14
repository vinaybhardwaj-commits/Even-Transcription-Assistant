import { describe, expect, it } from 'vitest'
import { warnIfJevUnavailable } from '../src/boot.js'
import { jevConfig, jevReadiness, loadEnv } from '../src/config.js'
import { classifyAveraged } from '../src/decide/client.js'
import { questionsFor, VALIDITY_RUBRIC, type JevQuestion } from '../src/decide/questions.js'
import { HttpJevTransport, JevSchemaError, mapSystemOneResponse, systemOneUrl } from '../src/decide/transport.js'
import { testApp, testDb, testEnv } from './helpers.js'

const validity: JevQuestion = {
  id: 'f:validity',
  type: 'boolean',
  prompt: 'Is this candidate supported by the typed facts and source spans?',
  options: ['yes', 'no'],
}

const route: JevQuestion = {
  id: 'f:route',
  type: 'choice',
  prompt: 'What should happen to this candidate?',
  options: ['route', 'hold', 'drop_informational'],
}

const score: JevQuestion = {
  id: 'f:frustration',
  type: 'score',
  prompt: 'How frustrated is the customer?',
  options: ['Calm', 'Frustrated', 'Very angry'],
}

const TEST_KEY = 'test-jev-key'

describe('TypeSafe System One adapter', () => {
  it('posts to /v1/systemone on the origin, with the default model and a bearer token', async () => {
    expect(systemOneUrl('https://api.typesafe.ai')).toBe('https://api.typesafe.ai/v1/systemone')
    expect(systemOneUrl('https://api.typesafe.ai/')).toBe('https://api.typesafe.ai/v1/systemone')
    expect(systemOneUrl('https://api.typesafe.ai///')).toBe('https://api.typesafe.ai/v1/systemone')
    expect(jevConfig(loadEnv({})).model).toBe('jev-latest')
    expect(jevConfig(loadEnv({ JEV_MODEL: 'jev-1.13.0' })).model).toBe('jev-1.13.0')
    expect(jevConfig(loadEnv({ TYPESAFE_MODEL: 'jev-1.13.0' })).model).toBe('jev-1.13.0')
    expect(jevConfig(loadEnv({ JEV_MODEL: 'jev-latest', TYPESAFE_MODEL: 'other' })).model).toBe('jev-latest')

    const sql = await testDb()
    let captured: { url: string; init: RequestInit } | undefined
    const transport = new HttpJevTransport(sql, 'https://api.typesafe.ai/', TEST_KEY, jevConfig(loadEnv({})).model, async (url, init) => {
      captured = { url: String(url), init: init ?? {} }
      return jsonResponse({
        model: 'jev-1.13.0',
        answers: { 'f:validity': { type: 'noul', noul: 0.95 } },
        usage: { input_tokens: 307, output_tokens: 20 },
      })
    })
    const outcome = await transport.classify({
      traceId: 'trace-jev',
      purpose: 'decide',
      state: { synthetic: true },
      questions: [validity],
      optionOrder: 'forward',
    })
    expect(captured?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(headerValue(captured?.init, 'authorization')).toBe(`Bearer ${TEST_KEY}`)
    expect(headerValue(captured?.init, 'content-type')).toBe('application/json')
    const sent = JSON.parse(String(captured?.init.body)) as {
      model: string
      questions: Record<string, { type: string; criteria: { true: string; false: string } }>
    }
    expect(sent.model).toBe('jev-latest')
    expect(sent.questions['f:validity']).toEqual({
      type: 'noul',
      instructions: validity.prompt,
      criteria: null,
    })
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.data.servedModelId).toBe('jev-1.13.0')
    expect(outcome.data.answers[0]?.probabilities.yes).toBeCloseTo(0.95)
    expect(outcome.data.answers[0]?.probabilities.no).toBeCloseTo(0.05)
    expect(JSON.stringify(outcome)).not.toContain(TEST_KEY)
  })

  it('sends an overridden model and encodes choice order in criteria keys', async () => {
    const sql = await testDb()
    const bodies: { model: string; questions: Record<string, { type: string; criteria: Record<string, string | null> }> }[] = []
    const transport = new HttpJevTransport(sql, 'https://api.typesafe.ai', TEST_KEY, 'jev-1.13.0', async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number])
      return jsonResponse({
        model: 'jev-1.13.0',
        answers: {
          'f:route': {
            type: 'choice',
            choice: 'hold',
            probabilities: { route: 2, hold: 2, drop_informational: 0 },
            confidence: 0.5,
          },
        },
        usage: { input_tokens: 12, output_tokens: 4 },
      })
    })
    const averaged = await classifyAveraged(transport, { traceId: 'trace-order', state: { synthetic: true }, questions: [route] })
    const forward = bodies[0]
    const reverse = bodies[1]
    if (!forward || !reverse) throw new Error('expected both option orders')
    expect(forward.model).toBe('jev-1.13.0')
    expect(Object.keys(forward.questions['f:route']?.criteria ?? {})).toEqual(['route', 'hold', 'drop_informational'])
    expect(Object.keys(reverse.questions['f:route']?.criteria ?? {})).toEqual(['drop_informational', 'hold', 'route'])
    expect(averaged.status).toBe('ok')
    if (averaged.status !== 'ok') return
    const answer = averaged.data.answers.find((item) => item.question_id === 'route')
    expect(answer?.probabilities.route).toBeCloseTo(0.5)
    expect(answer?.probabilities.hold).toBeCloseTo(0.5)
    expect(answer?.probabilities.drop_informational).toBe(0)
    expect(forward.questions['f:route']?.criteria.route).toContain('literally support')
    expect(reverse.questions['f:route']?.criteria.drop_informational).toContain('informational')
  })

  it('puts a concrete claim and quotes on a binary choice and averages both actual option orders', async () => {
    const subject = questionsFor([
      {
        id: 'abc',
        rule_id: 'ddi.warfarin_nsaid',
        summary: 'Warfarin and ibuprofen are prescribed together.',
        evidence: [{ quote: 'warfarin 5 mg oral daily' }, { quote: 'ibuprofen 400 mg tds' }],
      },
    ]).find((question) => question.id === 'abc:validity')
    if (!subject) throw new Error('missing validity question')
    expect(subject.context).toEqual({
      rule_id: 'ddi.warfarin_nsaid',
      claim: 'Warfarin and ibuprofen are prescribed together.',
      quotes: ['warfarin 5 mg oral daily', 'ibuprofen 400 mg tds'],
    })
    expect(subject.type).toBe('choice')
    expect(subject.prompt).toBe('Do `quotes` list both warfarin and the NSAID named in `claim` as current medications?')

    const sql = await testDb()
    const bodies: {
      questions: Record<string, { instructions: { claim?: string; quotes?: string[] }; criteria: Record<string, string> }>
    }[] = []
    const transport = new HttpJevTransport(sql, 'https://api.typesafe.ai', TEST_KEY, 'jev-latest', async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as (typeof bodies)[number]
      bodies.push(body)
      return jsonResponse({
        model: 'jev-1.13.0',
        answers: {
          'abc:validity': {
            type: 'choice',
            choice: 'yes',
            probabilities: { yes: 0.99, no: 0.01 },
            confidence: 0.98,
          },
        },
      })
    })
    const averaged = await classifyAveraged(transport, { traceId: 'trace-choice-order', state: { synthetic: true }, questions: [subject] })
    const forward = bodies[0]?.questions['abc:validity']
    const reverse = bodies[1]?.questions['abc:validity']
    expect(forward?.instructions.claim).toBe('Warfarin and ibuprofen are prescribed together.')
    expect(forward?.instructions.quotes).toEqual(['warfarin 5 mg oral daily', 'ibuprofen 400 mg tds'])
    expect(forward?.criteria).toEqual(VALIDITY_RUBRIC)
    expect(Object.keys(forward?.criteria ?? {})).toEqual(['yes', 'no'])
    expect(Object.keys(reverse?.criteria ?? {})).toEqual(['no', 'yes'])
    expect(averaged.status).toBe('ok')
    if (averaged.status !== 'ok') return
    expect(averaged.data.answers[0]?.probabilities.yes).toBeCloseTo(0.99)
    expect(averaged.data.servedModelIds).toEqual(['jev-1.13.0', 'jev-1.13.0'])
  })

  it('reads noul directly as binary P(yes) and does not invent an option-order inversion', () => {
    const reversed: JevQuestion = { ...validity, options: ['no', 'yes'] }
    const mapped = mapSystemOneResponse([reversed], {
      model: 'jev-1.13.0',
      answers: { 'f:validity': { type: 'noul', noul: 0.2 } },
    })
    expect(mapped.answers[0]?.probabilities.yes).toBeCloseTo(0.2)
    expect(mapped.answers[0]?.probabilities.no).toBeCloseTo(0.8)
  })

  it('normalises documented choice and score answers onto the closed option set', () => {
    const choice = mapSystemOneResponse([route], {
      model: 'jev-1.13.0',
      answers: {
        'f:route': {
          type: 'choice',
          choice: 'hold',
          probabilities: { route: 2, hold: 6, drop_informational: 0 },
          confidence: 0.81,
        },
      },
      usage: { input_tokens: 318, output_tokens: 34 },
    })
    expect(choice.servedModelId).toBe('jev-1.13.0')
    expect(choice.answers[0]?.probabilities).toEqual({ route: 0.25, hold: 0.75, drop_informational: 0 })

    const rated = mapSystemOneResponse([score], {
      model: 'jev-1.13.0',
      answers: {
        'f:frustration': {
          type: 'score',
          score: 1.05,
          legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
          probabilities: { '0': 0, '1': 19, '2': 1 },
          confidence: 0.92,
        },
      },
      usage: { input_tokens: 304, output_tokens: 18 },
    })
    expect(rated.answers[0]?.probabilities).toEqual({ Calm: 0, Frustrated: 0.95, 'Very angry': 0.05 })
  })

  it('throws a typed schema error and does not resolve a mismatched payload', async () => {
    const mismatches = [
      { served_model: 'jev-1.13.0', answers: [{ question_id: validity.id, text: 'yes, route it' }] },
      {
        model: 'jev-1.13.0',
        answers: { 'f:validity': { type: 'noul', noul: 1.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        model: 'jev-1.13.0',
        answers: {
          'f:route': {
            type: 'choice',
            choice: 'hold',
            probabilities: { route: 0.5, hold: 0.5, extra: 0 },
            confidence: 0.4,
          },
        },
      },
      {
        model: 'jev-1.13.0',
        answers: {
          'f:route': {
            type: 'choice',
            choice: 'hold',
            probabilities: { route: 0, hold: 0, drop_informational: 0 },
            confidence: 0,
          },
        },
      },
    ]
    for (const body of mismatches) {
      expect(() => mapSystemOneResponse(body.answers && 'f:route' in (body.answers as object) ? [route] : [validity], body)).toThrow(JevSchemaError)
    }
    try {
      mapSystemOneResponse([validity], mismatches[0])
    } catch (error) {
      expect(error).toBeInstanceOf(JevSchemaError)
      expect((error as Error).message).toBe('The decision service returned an unexpected payload.')
      expect((error as Error).message).not.toContain('route it')
    }

    const sql = await testDb()
    const transport = new HttpJevTransport(sql, 'https://api.typesafe.ai', TEST_KEY, 'jev-latest', async () => jsonResponse(mismatches[0]))
    const rejected = await transport.classify({
      traceId: 'trace-bad',
      purpose: 'decide',
      state: {},
      questions: [validity],
      optionOrder: 'forward',
    })
    expect(rejected.status).toBe('failed')
    if (rejected.status === 'failed') {
      expect(rejected.error.type).toBe('invalid_provider_payload')
      expect(rejected.error.message).not.toContain(TEST_KEY)
    }
  })

  it('reports jev readiness on /health and warns when production has no Jev config', async () => {
    const fake = await testApp()
    expect(await (await fake.app.handle(new Request('http://newcat.test/health'))).json()).toEqual({ status: 'ok', jev: 'fake' })

    const missing = await testApp({ env: testEnv({ NEWCAT_JEV: 'live' }) })
    expect(jevReadiness(missing.env)).toBe('unavailable')
    expect(await (await missing.app.handle(new Request('http://newcat.test/health'))).json()).toEqual({
      status: 'ok',
      jev: 'unavailable',
    })

    const live = await testApp({
      env: testEnv({ NEWCAT_JEV: 'live', JEV_BASE_URL: 'https://api.typesafe.ai', JEV_API_KEY: TEST_KEY }),
    })
    expect(await (await live.app.handle(new Request('http://newcat.test/health'))).json()).toEqual({ status: 'ok', jev: 'ok' })

    const warned = captureStdout(() => warnIfJevUnavailable(missing.env, 'api'))
    expect(warned).toContain('jev_not_configured')
    expect(warned).not.toContain(TEST_KEY)
    expect(warned).not.toContain('api.typesafe.ai')
    const parsed = JSON.parse(warned.trim()) as { level: string; status: string; role: string }
    expect(parsed).toMatchObject({ level: 'warn', status: 'jev_not_configured', role: 'api' })
    expect(captureStdout(() => warnIfJevUnavailable(live.env, 'api'))).toBe('')
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function headerValue(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers
  if (!headers || headers instanceof Headers || Array.isArray(headers)) throw new Error('expected a header record')
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  if (!entry) throw new Error(`missing ${name}`)
  return String(entry[1])
}

function captureStdout(run: () => void): string {
  const lines: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  try {
    run()
  } finally {
    process.stdout.write = original
  }
  return lines.join('')
}
