import { upsertConsumers } from './auth/consumers.js'
import { createApp, type AppDeps } from './api/http.js'
import { assertBootSecrets, jevReadiness, loadEnv, parseApiKeys, type Env } from './config.js'
import { assertMigrated, migrate } from './db/migrate.js'
import { openDatabase } from './db/open.js'
import type { Sql } from './db/sql.js'
import { log } from './log.js'
import { CdmssClientError, openCdmssConnection, type CdmssConnection } from './platform/cdmss/client.js'
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
  /** Query-only CDMSS handle for capabilities; undefined when CDMSS_DATABASE_URL_RO is unset, outside production, or the probe failed; treat as unavailable. */
  cdmss?: CdmssConnection['query'] | undefined
  /** Closes the CDMSS owner connection at shutdown. */
  closeCdmss?: (() => Promise<void>) | undefined
  app: ReturnType<typeof createApp>
}

export async function bootApp(options: BootOptions): Promise<Booted> {
  const env = loadEnv(process.env)
  assertBootSecrets(env)
  const cdmss = await openBootCdmss(env)
  let sql: Sql
  try {
    sql = await openDatabase(env.DATABASE_URL)
    if (options.migrate !== false) await migrate(sql)
    await assertMigrated(sql)
  } catch (error) {
    await cdmss?.close().catch(() => undefined)
    throw error
  }
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
  return { env, sql, deps, app, cdmss: cdmss?.query, closeCdmss: cdmss?.close }
}

/** Upper bound on the CDMSS connect + read-only probe, so a black-holed host cannot stall boot. */
export const CDMSS_PROBE_TIMEOUT_MS = 10_000

/** The driver's own connect bound for CDMSS, under the race above so an abandoned pool does not linger. */
export const CDMSS_CONNECT_TIMEOUT_MS = 8_000

type CdmssOpener = (url: string | undefined, options?: { connectionTimeoutMillis?: number }) => Promise<Sql>

/**
 * Production only, and only when CDMSS_DATABASE_URL_RO is set. A role that fails the read-only probe
 * (writable_role) refuses the boot; the error names the env var and nothing else. Any other failure
 * (connect error, timeout, malformed probe row) leaves the handle undefined (CDMSS reads are then
 * unavailable), closes the connection, and logs `cdmss_probe_failed` without the cause. No handle is
 * ever returned without a passed probe.
 */
export async function openBootCdmss(
  env: Env,
  open?: CdmssOpener,
  timeoutMs: number = CDMSS_PROBE_TIMEOUT_MS,
): Promise<CdmssConnection | undefined> {
  if (env.NEWCAT_ENV !== 'production' || !env.CDMSS_DATABASE_URL_RO) return undefined
  const opener = open ?? openDatabase
  let timedOut = false
  let opened: Sql | undefined
  const tracked = async (url: string | undefined): Promise<Sql> => {
    const sql = await opener(url, { connectionTimeoutMillis: CDMSS_CONNECT_TIMEOUT_MS })
    opened = sql
    if (timedOut) await sql.close().catch(() => undefined)
    return sql
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new CdmssClientError('probe_failed'))
    }, timeoutMs)
  })
  const attempt = openCdmssConnection({ CDMSS_DATABASE_URL_RO: env.CDMSS_DATABASE_URL_RO }, tracked)
  try {
    return await Promise.race([attempt, deadline])
  } catch (error) {
    if (error instanceof CdmssClientError && error.code === 'writable_role') {
      throw new Error('refusing to boot: CDMSS_DATABASE_URL_RO is not a read-only connection')
    }
    if (timedOut) {
      // Not awaited: pool.end() waits for an in-flight connect, so awaiting it would stall boot.
      void opened?.close().catch(() => undefined)
      // A probe that passes after the deadline must not leak its pool.
      void attempt.then((late) => late.close()).catch(() => undefined)
    }
    log('warn', 'boot', { error_type: 'cdmss_probe_failed' })
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export function warnIfJevUnavailable(env: Env, role: BootOptions['role']): void {
  if (jevReadiness(env) !== 'unavailable') return
  log('warn', 'boot', { status: 'jev_not_configured', role })
}
