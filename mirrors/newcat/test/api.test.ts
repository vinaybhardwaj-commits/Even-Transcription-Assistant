import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { verifyWebhook } from '../src/auth/crypto.js'
import { asJson } from '../src/db/sql.js'
import { DEMO_KEYS, postJson, testApp, testEnv } from './helpers.js'

const gold = JSON.parse(readFileSync('fixtures/gold/safety-v1.json', 'utf8')) as {
  cases: { source: string; source_uid: string; source_timestamp: string; body: string }[]
}
const note = gold.cases[0]
if (!note) throw new Error('missing gold case')
const goldNote = note

const BANNED = ['rationale', 'policy_id', 'probabilities', 'rule_id', 'versions', 'queue', 'models']

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    capability: 'audit.note',
    caller: { principal: 'pulse', purpose: 'opd-audit' },
    patient_ref: 'pt-synthetic-1',
    encounter_ref: 'enc-synthetic-1',
    audience: 'doctor',
    idempotency_key: `idem-${Math.random().toString(16).slice(2)}abcd`,
    mode: 'sync',
    input: {
      source: goldNote.source,
      source_uid: goldNote.source_uid,
      source_timestamp: goldNote.source_timestamp,
      body: goldNote.body,
    },
    ...overrides,
  }
}

describe('universal API contracts', () => {
  it('exposes only a bare health check without a key', async () => {
    const { app } = await testApp()
    const health = await app.handle(new Request('http://newcat.test/health'))
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok', jev: 'fake' })
    const open = await postJson(app, '/v1/invoke', null, envelope())
    expect(open.status).toBe(401)
  })

  it('rejects an invalid envelope, a scope miss, and a principal mismatch', async () => {
    const { app } = await testApp()
    const invalid = await postJson(app, '/v1/invoke', DEMO_KEYS[0]?.token ?? '', { capability: 'audit.note' })
    expect(invalid.status).toBe(422)
    expect((await invalid.json()).error.type).toBe('invalid_envelope')

    const denied = await postJson(
      app,
      '/v1/invoke',
      DEMO_KEYS[2]?.token ?? '',
      envelope({ caller: { principal: 'ask-only', purpose: 'opd-audit' } }),
    )
    expect(denied.status).toBe(403)
    expect((await denied.json()).error.type).toBe('forbidden')

    const mismatch = await postJson(app, '/v1/invoke', DEMO_KEYS[0]?.token ?? '', envelope({ caller: { principal: 'someone-else', purpose: 'opd-audit' } }))
    expect(mismatch.status).toBe(403)
    expect((await mismatch.json()).error.type).toBe('principal_mismatch')

    const ceiling = await postJson(
      app,
      '/v1/invoke',
      DEMO_KEYS[1]?.token ?? '',
      envelope({ caller: { principal: 'pulse-doctor', purpose: 'opd-audit' }, audience: 'internal' }),
    )
    expect(ceiling.status).toBe(403)
    expect((await ceiling.json()).error.type).toBe('audience_not_permitted')
  })

  it('returns a doctor-safe audit and replays the same idempotency key', async () => {
    const { app } = await testApp()
    const body = envelope()
    const first = await postJson(app, '/v1/invoke', DEMO_KEYS[0]?.token ?? '', body)
    expect(first.status).toBe(200)
    const payload = (await first.json()) as { status: string; findings: { summary: string }[] }
    expect(payload.status).toBe('ok')
    expect(payload.findings.length).toBeGreaterThan(0)
    expect(walk(payload).some((key) => BANNED.includes(key))).toBe(false)

    const replay = await postJson(app, '/v1/invoke', DEMO_KEYS[0]?.token ?? '', body)
    expect(replay.status).toBe(200)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(await replay.json()).toEqual(payload)

    const conflict = await postJson(app, '/v1/invoke', DEMO_KEYS[0]?.token ?? '', { ...body, caller: { principal: 'pulse', purpose: 'other-purpose' } })
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).error.type).toBe('idempotency_conflict')
  })

  it('accepts an async job, signs one webhook, and strips the doctor audience', async () => {
    const now = 1_700_000_000_000
    let captured: { url: string; header: string; body: string } | null = null
    const { app, sql } = await testApp({
      now: () => now,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), header: new Headers(init?.headers).get('x-newcat-signature') ?? '', body: String(init?.body ?? '') }
        return new Response('ok', { status: 200 })
      },
    })
    const accepted = await postJson(
      app,
      '/v1/invoke',
      DEMO_KEYS[1]?.token ?? '',
      envelope({
        caller: { principal: 'pulse-doctor', purpose: 'opd-audit' },
        audience: 'doctor',
        mode: 'async',
        callback_url: 'https://example.test/hooks/newcat',
        input: { ...envelope().input, source_uid: 'syn-async-1' },
      }),
    )
    expect(accepted.status).toBe(202)
    const pending = (await accepted.json()) as { pending?: boolean; findings?: unknown; job_id: string }
    expect(pending.pending).toBe(true)
    expect(pending.findings).toBeUndefined()
    await app.drain()
    expect(captured).not.toBeNull()
    const delivery = captured as unknown as { url: string; header: string; body: string }
    expect(verifyWebhook('webhook-secret-value', delivery.header, delivery.body, now)).toBe(true)
    expect(verifyWebhook('webhook-secret-value', delivery.header, `${delivery.body} `, now)).toBe(false)
    const delivered = JSON.parse(delivery.body) as { status: string }
    expect(walk(delivered).some((key) => BANNED.includes(key))).toBe(false)

    const job = await app.handle(
      new Request(`http://newcat.test/v1/jobs/${pending.job_id}`, { headers: { authorization: `Bearer ${DEMO_KEYS[1]?.token}` } }),
    )
    expect(job.status).toBe(200)
    const events = await app.handle(
      new Request('http://newcat.test/v1/events', { headers: { authorization: `Bearer ${DEMO_KEYS[1]?.token}` } }),
    )
    const listed = (await events.json()) as { status: string; events: { type: string }[] }
    expect(listed.status).toBe('ok')
    expect(listed.events.some((event) => event.type === 'webhook.delivered')).toBe(true)
    const rows = await sql.query<{ n: number | string }>('select count(*)::int as n from jobs')
    expect(Number(rows.rows[0]?.n)).toBe(1)
  })

  it('refuses a webhook when the signing secret is unset', async () => {
    let called = false
    const { app } = await testApp({
      env: testEnv({ WEBHOOK_SIGNING_SECRET: '' }),
      fetchImpl: async () => {
        called = true
        return new Response('no')
      },
    })
    const accepted = await postJson(
      app,
      '/v1/invoke',
      DEMO_KEYS[0]?.token ?? '',
      envelope({ mode: 'async', callback_url: 'https://example.test/hooks/newcat', input: { ...envelope().input, source_uid: 'syn-async-2' } }),
    )
    expect(accepted.status).toBe(202)
    await app.drain()
    expect(called).toBe(false)
    const events = await app.handle(new Request('http://newcat.test/v1/events', { headers: { authorization: `Bearer ${DEMO_KEYS[0]?.token}` } }))
    const listed = (await events.json()) as { events: { type: string }[] }
    expect(listed.events.some((event) => event.type === 'webhook.refused')).toBe(true)
  })

  it('returns typed unavailable for a stub capability', async () => {
    const { app } = await testApp()
    const response = await postJson(app, '/v1/invoke', DEMO_KEYS[0]?.token ?? '', {
      capability: 'ask',
      caller: { principal: 'pulse', purpose: 'question' },
      audience: 'operator',
      idempotency_key: 'ask-idem-0001',
      mode: 'sync',
      input: { question: 'Why warfarin with ibuprofen?' },
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { status: string; error: { type: string } }
    expect(body.status).toBe('unavailable')
    expect(body.error.type).toBe('not_implemented')
  })

  it('denies the cron tick unless the bearer secret matches', async () => {
    const { app } = await testApp()
    const spoofed = await app.handle(
      new Request('http://newcat.test/v1/internal/work/tick', { method: 'POST', headers: { 'x-vercel-cron': '1' } }),
    )
    expect(spoofed.status).toBe(401)
    const { app: unsigned } = await testApp({ env: testEnv({ CRON_SECRET: '' }) })
    const missing = await unsigned.handle(
      new Request('http://newcat.test/v1/internal/work/tick', {
        method: 'POST',
        headers: { authorization: 'Bearer cron-secret-value' },
      }),
    )
    expect(missing.status).toBe(401)
    expect((await missing.json()).error.type).toBe('missing_secret')
    const empty = await app.handle(
      new Request('http://newcat.test/v1/internal/work/tick', {
        method: 'POST',
        headers: { authorization: 'Bearer cron-secret-value' },
      }),
    )
    expect(empty.status).toBe(200)
    const tickBody = await empty.json()
    expect(tickBody).toMatchObject({ status: 'empty', reason: 'no_queued_work' })
    expect(JSON.stringify(tickBody)).not.toContain('findings')
  })

  it('replays an async accept without creating a second job', async () => {
    const { app, sql } = await testApp()
    const body = envelope({ mode: 'async', input: { ...envelope().input, source_uid: 'syn-async-replay' } })
    const first = await postJson(app, '/v1/invoke', DEMO_KEYS[0]?.token ?? '', body)
    const second = await postJson(app, '/v1/invoke', DEMO_KEYS[0]?.token ?? '', body)
    expect(first.status).toBe(202)
    expect(second.headers.get('idempotency-replayed')).toBe('true')
    expect(await second.json()).toEqual(await first.json())
    const rows = await sql.query<{ n: number | string }>('select count(*)::int as n from jobs')
    expect(Number(asJson(rows.rows[0]?.n))).toBe(1)
  })
})

function walk(value: unknown, keys: string[] = []): string[] {
  if (!value || typeof value !== 'object') return keys
  if (Array.isArray(value)) {
    for (const item of value) walk(item, keys)
    return keys
  }
  for (const [key, child] of Object.entries(value)) {
    keys.push(key)
    walk(child, keys)
  }
  return keys
}
