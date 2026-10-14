import type { Sql } from '../db/sql.js'

const TABLES = {
  drug_interactions: 'drug_interactions',
  dose_limits: 'dose_limits',
  banned_fdc: 'banned_fdc',
  nlem_items: 'nlem_items',
} as const

export type StructuredTable = keyof typeof TABLES

/** Rows from a new source stay unused until signed_by and signed_at are both set. */
export async function signedStructuredRows(sql: Sql, table: StructuredTable): Promise<Record<string, unknown>[]> {
  const name = TABLES[table]
  const rows = await sql.query<Record<string, unknown>>(
    `select * from ${name} where signed_by is not null and signed_at is not null`,
  )
  return rows.rows
}
