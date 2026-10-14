import { upsertConsumers } from './auth/consumers.js'
import { createApp, type AppDeps } from './api/http.js'
import { assertBootSecrets, jevReadiness, loadEnv, parseApiKeys, type Env } from './config.js'
import { assertMigrated, migrate } from './db/migrate.js'
import { openDatabase } from './db/open.js'
import type { Sql } from './db/sql.js'
import { log } from './log.js'
import { applyBudgetCaps, buildEmbedder, buildJev, buildModelClient } from './runtime.js'

export interface BootOptions {
  role: 'api' | 'worker' | 'all'
  /** The API process on Vercel does not apply DDL. Run `npm run migrate` before traffic. */
  migrate?: boolean
}

export interface Booted {
  env: Env
  sql: Sql
  deps: AppDeps
  app: ReturnType<typeof createApp>
}

export async function bootApp(options: BootOptions): Promise<Booted> {
  const env = loadEnv(process.env)
  assertBootSecrets(env)
  const sql = await openDatabase(env.DATABASE_URL)
  if (options.migrate !== false) await migrate(sql)
  await assertMigrated(sql)
  await applyBudgetCaps(sql, env)
  await upsertConsumers(sql, parseApiKeys(env.API_KEYS_JSON))
  const deps: AppDeps = {
    sql,
    env,
    models: buildModelClient(sql, env),
    jev: buildJev(sql, env),
    embedder: buildEmbedder(sql, env),
  }
  const app = createApp(deps, { background: options.role !== 'api' })
  warnIfJevUnavailable(env, options.role)
  log('info', 'boot', { role: options.role, status: env.NEWCAT_LLM === 'fake' ? 'fake' : 'live' })
  return { env, sql, deps, app }
}

export function warnIfJevUnavailable(env: Env, role: BootOptions['role']): void {
  if (jevReadiness(env) !== 'unavailable') return
  log('warn', 'boot', { status: 'jev_not_configured', role })
}
