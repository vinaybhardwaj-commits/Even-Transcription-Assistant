import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { debugFixture } from '../src/eval/jev-debug.js'
import type { GoldFile } from '../src/eval/gold.js'

const gold = JSON.parse(readFileSync('fixtures/gold/safety-v1.json', 'utf8')) as GoldFile

describe('Jev wire debugger', () => {
  it('prints both exact option orders, raw responses, derivation steps, and no key', async () => {
    const calls: unknown[] = []
    const report = await debugFixture(
      gold,
      'syn-ddi-order-swap',
      { baseUrl: 'https://api.typesafe.ai', apiKey: 'debug-secret-key', model: 'jev-1.13.0' },
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          questions: Record<string, { type: string; criteria: Record<string, string> }>
        }
        calls.push(body)
        const answers: Record<string, unknown> = {}
        for (const id of Object.keys(body.questions)) {
          if (id.endsWith(':validity')) {
            answers[id] = {
              type: 'choice',
              choice: 'yes',
              probabilities: { yes: 0.98, no: 0.02 },
              confidence: 0.96,
            }
          } else {
            answers[id] = {
              type: 'choice',
              choice: 'route',
              probabilities: { route: 0.98, hold: 0.01, drop_informational: 0.01 },
              confidence: 0.96,
            }
          }
        }
        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers,
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { status: 200 },
        )
      },
    )

    expect(calls).toHaveLength(2)
    const forward = report.orders[0]
    const reverse = report.orders[1]
    const validityId = Object.keys(forward?.request.body.questions ?? {}).find((id) => id.endsWith(':validity'))
    if (!forward || !reverse || !validityId) throw new Error('missing debug orders')
    expect(Object.keys(forward.request.body.questions[validityId]?.criteria ?? {})).toEqual(['yes', 'no'])
    expect(Object.keys(reverse.request.body.questions[validityId]?.criteria ?? {})).toEqual(['no', 'yes'])
    expect(forward.request.headers.Authorization).toBe('Bearer <redacted>')
    expect(JSON.stringify(report)).not.toContain('debug-secret-key')
    expect(forward.raw_response).toMatchObject({ model: 'jev-1.13.0' })
    expect(forward.derived_p_yes[0]).toMatchObject({
      answer_type: 'choice',
      raw_noul: null,
      raw_probability_yes: 0.98,
      raw_probability_sum: 1,
      normalized_p_yes: 0.98,
    })
    expect(reverse.derived_p_yes[0]?.normalized_p_yes).toBe(0.98)
    expect(report.averaged_p_yes[0]?.average).toBe(0.98)
  })
})
