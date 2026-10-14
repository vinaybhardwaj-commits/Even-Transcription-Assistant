import { upsertConsumers } from '../src/auth/consumers.js'
import { createApp, type AppDeps } from '../src/api/http.js'
import { loadEnv, parseApiKeys, type Env } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { openDatabase } from '../src/db/open.js'
import type { Sql } from '../src/db/sql.js'
import { FakeJevTransport } from '../src/decide/transport.js'
import { FakeEmbedder } from '../src/evidence/embed.js'
import { FakeModelClient } from '../src/llm/fake.js'
import type { ModelClient } from '../src/llm/types.js'

type AppDepsCheck = NonNullable<AppDeps['checkBedrock']>
type AppDepsProbe = NonNullable<AppDeps['probeAws']>

export const DEMO_KEYS = [
  {
    name: 'pulse',
    token: 'pulse-internal-token-01',
    scopes: ['audit.note', 'ask', 'med_reconcile', 'ddx', 'appropriateness', 'triage.decide', 'admin', 'evidence.retrieve'],
    audience: 'internal' as const,
  },
  {
    name: 'pulse-doctor',
    token: 'pulse-doctor-token-0001',
    scopes: ['audit.note'],
    audience: 'doctor' as const,
  },
  {
    name: 'ask-only',
    token: 'ask-only-token-0000001',
    scopes: ['ask'],
    audience: 'internal' as const,
  },
]

export async function testDb(): Promise<Sql> {
  const sql = await openDatabase(undefined)
  await migrate(sql)
  return sql
}

export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return loadEnv({
    NEWCAT_ENV: 'test',
    NEWCAT_LLM: 'fake',
    NEWCAT_JEV: 'fake',
    NEWCAT_EMBED: 'fake',
    CRON_SECRET: 'cron-secret-value',
    WEBHOOK_SIGNING_SECRET: 'webhook-secret-value',
    API_KEYS_JSON: JSON.stringify(DEMO_KEYS),
    ...overrides,
  })
}

export async function testApp(options?: {
  env?: Env
  fetchImpl?: typeof fetch
  now?: () => number
  models?: ModelClient
  checkBedrock?: AppDepsCheck
  probeAws?: AppDepsProbe
  background?: boolean
}): Promise<{ sql: Sql; env: Env; app: ReturnType<typeof createApp>; deps: AppDeps }> {
  const env = options?.env ?? testEnv()
  const sql = await testDb()
  await upsertConsumers(sql, parseApiKeys(env.API_KEYS_JSON))
  const models = options?.models ?? new FakeModelClient(sql)
  const deps: AppDeps = {
    sql,
    env,
    models,
    jev: new FakeJevTransport(sql),
    embedder: new FakeEmbedder(sql),
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.checkBedrock ? { checkBedrock: options.checkBedrock } : {}),
    ...(options?.probeAws ? { probeAws: options.probeAws } : {}),
  }
  const app = createApp(deps, options?.background === false ? { background: false } : {})
  return { sql, env, app, deps }
}

export async function postJson(app: ReturnType<typeof createApp>, path: string, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return app.handle(
    new Request(`http://newcat.test${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  )
}
