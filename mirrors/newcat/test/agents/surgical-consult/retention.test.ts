import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { surgicalConsult, surgicalConsultCapability } from '../../../src/agents/surgical-consult/definition.js'
import { ConsultAuditInput } from '../../../src/agents/surgical-consult/input.js'
import { saveConsult, trimInput } from '../../../src/agents/surgical-consult/store.js'
import { createApp, runQueuedJob } from '../../../src/api/http.js'
import { createRetentionRunner, type RetentionLog } from '../../../src/jobs/retention.js'
import { FakeModelClient } from '../../../src/llm/fake.js'
import { postJson, testApp, testEnv } from '../../helpers.js'
import { load, scriptedExtractor } from './helpers.js'

const TOKEN = 'consult-key-0000000001'
const KEYS = [{ name: 'k', token: TOKEN, scopes: ['audit.consult'], audience: 'governance' as const }]
const NATIVE = 'zqxnativemarker'
const CLIP = 'https://clips.invalid/zqxclipmarker.mp3'

// A full input with the fields the trim must drop: text_native and a clip.
const fullInput = () => {
  const base = load('hernia-full-consent')
  return {
    ...base,
    turns: base.turns.map((t) => ({ ...t, text_native: `${NATIVE} ${t.id}` })),
    clips: [{ turn_ids: [base.turns[0]!.id], url: CLIP, expires_at: '2026-10-20T00:00:00Z' }],
  }
}

describe('C3 wiring: storedInput on an async audit.consult job', () => {
  it('declares the hooks the platform reads', () => {
    expect(surgicalConsult.storedInput).toBe(trimInput)
    expect(typeof surgicalConsult.retention).toBe('function')
  })

  it('stores a projection after completion with no text_native and no clips key', async () => {
    const input = fullInput()
    expect(() => ConsultAuditInput.parse(input)).not.toThrow()
    const built = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(KEYS) }), background: false })
    const deps = { ...built.deps, models: new FakeModelClient(built.sql, scriptedExtractor), capabilities: [surgicalConsultCapability] }
    const app = createApp(deps, { background: false })
    const accepted = await postJson(app, '/v1/invoke', TOKEN, {
      capability: 'audit.consult',
      caller: { principal: 'k', purpose: 'test' },
      audience: 'governance',
      idempotency_key: 'idem-consult-0000000001',
      mode: 'async',
      input,
    })
    expect(accepted.status).toBe(202)
    const before = (await built.sql.query<{ request: unknown }>('select request from jobs')).rows[0]!.request
    // The real zod input path accepts the stored request (this is what storedRequestFor runs before projecting).
    expect(surgicalConsultCapability.input.safeParse(before).success).toBe(true)
    expect(JSON.stringify(before)).toContain(NATIVE)
    expect(await runQueuedJob(deps, 'w:1')).toBe(true)
    const after = (await built.sql.query<{ request: Record<string, unknown>; status: string }>('select request, status from jobs')).rows[0]!
    // Jev is not ready in testEnv, so findings hold and the job ends unavailable; the projection applies to every terminal status.
    expect(after.status).toBe('unavailable')
    expect(after.request).toEqual(trimInput(ConsultAuditInput.parse(input)))
    const text = JSON.stringify(after.request)
    expect(text).not.toContain('text_native')
    expect(text).not.toContain('clips')
    expect(text).not.toContain(NATIVE)
    expect(text).not.toContain(CLIP)
  })
})

describe('C3 wiring: the daily retention pass', () => {
  const age = async (sql: Awaited<ReturnType<typeof testApp>>['sql'], encounter: string, days: number, now: Date) =>
    sql.query(`update consult_inputs set created_at = $2::timestamptz where encounter_id = $1`, [encounter, new Date(now.getTime() - days * 86_400_000).toISOString()])

  it('empties a 91-day consult_inputs row and keeps an 89-day one, rows stay', async () => {
    const { sql } = await testApp()
    const now = new Date('2026-10-13T00:05:00Z')
    const base = load('hernia-full-consent')
    for (const [enc, sha] of [['enc-91', 'sha-91'], ['enc-89', 'sha-89']] as const) {
      await saveConsult(sql, {
        encounter_id: enc,
        transcript_sha: sha,
        extractor_version: 'consult-extract/0.1.0',
        input: { ...base, encounter_id: enc },
        facts: [],
        dropped: {},
        served_model_ids: [],
        findings: [],
      })
    }
    await age(sql, 'enc-91', 91, now)
    await age(sql, 'enc-89', 89, now)
    const logs: Parameters<RetentionLog>[0][] = []
    const runner = createRetentionRunner({ sql, agents: [surgicalConsult], now: () => now, log: (f) => logs.push(f) })
    expect(await runner.tick()).toBe(true)
    expect(logs).toContainEqual({ event: 'agent.retention', agent_id: 'audit.consult', swept: 1 })
    const rows = (await sql.query<{ encounter_id: string; input: Record<string, unknown> }>('select encounter_id, input from consult_inputs order by encounter_id')).rows
    expect(rows.map((r) => r.encounter_id)).toEqual(['enc-89', 'enc-91'])
    expect(rows[1]!.input).toEqual({})
    expect(Object.keys(rows[0]!.input).length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toContain(base.turns[0]!.text_en.slice(0, 12))
  })

  it('the hook source names only consult_inputs as the table written', () => {
    const store = readFileSync('src/agents/surgical-consult/store.ts', 'utf8')
    const body = store.slice(store.indexOf('export async function sweepConsultInputs'), store.indexOf('export async function loadFindings'))
    expect(body).toMatch(/update consult_inputs/)
    expect(body).not.toMatch(/consult_extractions|consult_findings|jobs/)
    const def = readFileSync('src/agents/surgical-consult/definition.ts', 'utf8')
    const hook = def.slice(def.indexOf('retention:'), def.indexOf('\n', def.indexOf('retention:')))
    expect(hook).toContain('sweepConsultInputs(sql, now)')
    expect(hook).not.toMatch(/sql\.query|consult_extractions|consult_findings|jobs/)
  })
})
