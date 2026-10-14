import { openDatabase } from '../../db/open.js'
import type { Sql } from '../../db/sql.js'

/** Env var NAME for the read-only CDMSS Neon URL (role newcat_ro). Read only inside this module. */
export const CDMSS_URL_ENV = 'CDMSS_DATABASE_URL_RO'

/** The only surface consumers get: parameterised reads. No exec, no transactions, no close. */
export type CdmssQuery = Pick<Sql, 'query'>

export type CdmssErrorCode = 'not_configured' | 'writable_role' | 'probe_failed'

/** Carries a code only. Never the URL, the role name's secrets, or driver error text. */
export class CdmssClientError extends Error {
  constructor(readonly code: CdmssErrorCode) {
    super(`cdmss_${code}`)
    this.name = 'CdmssClientError'
  }
}

/**
 * Boot probe (PLATFORM-SPEC section 13). The role is read-only only when all three hold:
 * (1) default_transaction_read_only is 'on'; (2) no table, partition, view or foreign table
 * (relkind r, p, v, f) in any schema except pg_catalog, information_schema,
 * pg_toast, pg_temp_* and pg_toast_temp_* grants it INSERT, UPDATE, DELETE or TRUNCATE, nor any
 * column INSERT/UPDATE; (3) it lacks CREATE on schema public. Fails closed: a probe that errors or returns anything unexpected is a refusal, not a pass.
 */
export async function assertReadOnly(sql: Sql): Promise<void> {
  let row: { read_only_default?: unknown; no_writes?: unknown; no_create?: unknown } | undefined
  try {
    const { rows } = await sql.query<NonNullable<typeof row>>(
      `SELECT
         current_setting('default_transaction_read_only') = 'on' AS read_only_default,
         NOT EXISTS (
           SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'p', 'v', 'f')
             AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
             AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
             AND (has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
                  OR has_any_column_privilege(c.oid, 'INSERT,UPDATE'))
         ) AS no_writes,
         NOT has_schema_privilege('public', 'CREATE') AS no_create`,
    )
    row = rows[0]
  } catch {
    throw new CdmssClientError('probe_failed')
  }
  const checks = [row?.read_only_default, row?.no_writes, row?.no_create]
  if (checks.some((v) => typeof v !== 'boolean')) throw new CdmssClientError('probe_failed')
  if (checks.every((v) => v === true)) return
  throw new CdmssClientError('writable_role')
}

/**
 * Opens the CDMSS read-only connection and proves the role cannot write. With no URL it refuses:
 * `openDatabase(undefined)` would hand back an empty in-memory database, which must never stand in
 * for CDMSS.
 */
export async function openCdmssReadOnly(
  env: Record<string, string | undefined> = process.env,
  open: (url: string | undefined) => Promise<Sql> = openDatabase,
): Promise<CdmssQuery> {
  const url = env[CDMSS_URL_ENV]
  if (!url) throw new CdmssClientError('not_configured')
  const sql = await open(url)
  try {
    await assertReadOnly(sql)
  } catch (error) {
    await sql.close().catch(() => undefined)
    throw error
  }
  // A fresh object with only `query`: even a cast cannot reach exec, withTx or close.
  return { query: (text, params) => sql.query(text, params) }
}
