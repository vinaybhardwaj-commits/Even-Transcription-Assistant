import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sql } from './sql.js'

function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, '../../migrations'), path.resolve(here, '../../../migrations')]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

const MIGRATIONS_DIR = migrationsDir()

/** Splits a migration file into single statements. The files do not use dollar quotes. */
export function splitSql(body: string): string[] {
  return body
    .split(/;\s*(?:\r?\n|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--')))
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

export async function appliedMigrations(sql: Sql): Promise<string[]> {
  const rows = await sql.query<{ id: string }>('select id from schema_migrations order by id')
  return rows.rows.map((row) => row.id)
}

/** The only DDL entry point. Each file is applied once and recorded in schema_migrations. */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql.exec(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `)
  const done = new Set(await appliedMigrations(sql))
  const applied: string[] = []
  for (const file of migrationFiles()) {
    if (done.has(file)) continue
    const body = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    await sql.withTx(async (tx) => {
      for (const statement of splitSql(body)) await tx.query(statement)
      await tx.query('insert into schema_migrations (id) values ($1)', [file])
    })
    applied.push(file)
  }
  return applied
}

export async function pendingMigrations(sql: Sql): Promise<string[]> {
  const done = new Set(await appliedMigrations(sql))
  return migrationFiles().filter((file) => !done.has(file))
}

export async function assertMigrated(sql: Sql): Promise<void> {
  const pending = await pendingMigrations(sql)
  if (pending.length > 0) {
    throw new Error(`pending migrations: ${pending.join(', ')}`)
  }
}
