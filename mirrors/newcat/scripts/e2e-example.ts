import { readFileSync } from 'node:fs'
import { createApp } from '../src/api/http.js'
import { verifyWebhook } from '../src/auth/crypto.js'
import { upsertConsumers } from '../src/auth/consumers.js'
import { loadEnv, parseApiKeys } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { openDatabase } from '../src/db/open.js'
import { FakeJevTransport } from '../src/decide/transport.js'
import { FakeEmbedder } from '../src/evidence/embed.js'
import { assertGoldFrozen, type GoldFile } from '../src/eval/gold.js'
import { FakeModelClient } from '../src/llm/fake.js'

const TOKEN = 'example-pulse-token-01'
const WEBHOOK_SECRET = 'example-webhook-secret'
const gold = JSON.parse(readFileSync('fixtures/gold/safety-v1.json', 'utf8')) as GoldFile
const frozen = assertGoldFrozen(gold)
if (!frozen.ok) throw new Error(frozen.reason)

const env = loadEnv({
  NEWCAT_ENV: 'test',
  NEWCAT_LLM: 'fake',
  NEWCAT_JEV: 'fake',
  NEWCAT_EMBED: 'fake',
  CRON_SECRET: 'example-cron-secret',
  WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
  API_KEYS_JSON: JSON.stringify([
    { name: 'pulse', token: TOKEN, scopes: ['audit.note'], audience: 'internal' },
  ]),
})
const sql = await openDatabase(undefined)
await migrate(sql)
await upsertConsumers(sql, parseApiKeys(env.API_KEYS_JSON))

const now = 1_700_000_000_000
const webhook: { header: string; body: string } = { header: '', body: '' }
const app = createApp({
  sql,
  env,
  models: new FakeModelClient(sql),
  jev: new FakeJevTransport(sql),
  embedder: new FakeEmbedder(sql),
  now: () => now,
  fetchImpl: async (_url, init) => {
    webhook.header = new Headers(init?.headers).get('x-newcat-signature') ?? ''
    webhook.body = String(init?.body ?? '')
    return new Response('ok', { status: 200 })
  },
})

const cases = gold.cases.filter((item) => item.expected_safety_rule_ids.length > 0).slice(0, 3)
if (cases.length !== 3) throw new Error('expected 3 safety-positive notes')

const banned = ['rationale', 'policy_id', 'probabilities', 'rule_id', 'versions', 'queue', 'models', 'chunk_id', 'source_id', 'licence_class', 'evidence_refs', 'evidence_hits', 'evidence_status', 'section_path']

for (const [index, item] of cases.entries()) {
  const request = {
    capability: 'audit.note',
    caller: { principal: 'pulse', purpose: 'e2e-opd-audit' },
    patient_ref: `pt-${item.id}`,
    encounter_ref: `enc-${item.id}`,
    audience: 'doctor',
    idempotency_key: `e2e-${item.id}-0001`,
    mode: 'sync',
    input: {
      source: item.source,
      source_uid: item.source_uid,
      source_timestamp: item.source_timestamp,
      body: item.body,
    },
  }
  const response = await invoke(request)
  if (response.status !== 200) throw new Error(`${item.id} returned HTTP ${response.status}`)
  const body = (await response.json()) as { status: string; findings?: { summary: string; severity: string }[] }
  if (body.status !== 'ok' || !body.findings?.length) throw new Error(`${item.id} did not return doctor findings`)
  if (walk(body).some((key) => banned.includes(key))) throw new Error(`${item.id} leaked an internal field`)
  process.stdout.write(`${item.id} ${body.findings.map((finding) => `${finding.severity}: ${finding.summary}`).join(' | ')}\n`)

  if (index === 0) {
    const replay = await invoke(request)
    if (replay.headers.get('idempotency-replayed') !== 'true') throw new Error('idempotent replay was not marked')
    const redated = await invoke({
      ...request,
      idempotency_key: `e2e-${item.id}-redate`,
      input: { ...request.input, source_timestamp: '2026-10-12T11:00:00.000Z' },
    })
    if (redated.status !== 200) throw new Error('re-dated note failed')
    const versions = await sql.query<{ n: number | string }>('select count(*)::int as n from note_versions where source_uid = $1', [
      item.source_uid,
    ])
    if (Number(versions.rows[0]?.n) !== 1) throw new Error('re-dated note created a new version')
  }
}

const asyncCase = cases[2]
if (!asyncCase) throw new Error('missing async case')
const accepted = await invoke({
  capability: 'audit.note',
  caller: { principal: 'pulse', purpose: 'e2e-async' },
  patient_ref: 'pt-async',
  encounter_ref: 'enc-async',
  audience: 'doctor',
  idempotency_key: 'e2e-async-0001',
  mode: 'async',
  callback_url: 'https://example.test/hooks/newcat',
  input: {
    source: asyncCase.source,
    source_uid: `${asyncCase.source_uid}-async`,
    source_timestamp: asyncCase.source_timestamp,
    body: asyncCase.body,
  },
})
if (accepted.status !== 202) throw new Error(`async accept returned HTTP ${accepted.status}`)
const pending = (await accepted.json()) as { findings?: unknown }
if ('findings' in pending) throw new Error('async accept included findings')
await app.drain()
if (!webhook.body || !verifyWebhook(WEBHOOK_SECRET, webhook.header, webhook.body, now)) throw new Error('webhook signature failed')
const delivered = JSON.parse(webhook.body) as { status: string }
if (delivered.status !== 'ok') throw new Error(`async doctor result was ${delivered.status}`)
if (walk(delivered).some((key) => banned.includes(key))) throw new Error('async doctor result leaked an internal field')
process.stdout.write('async webhook verified\n')

async function invoke(body: unknown): Promise<Response> {
  return app.handle(
    new Request('http://newcat.test/v1/invoke', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

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
