import { randomBytes } from 'node:crypto'
import type { Sql } from '../db/sql.js'
import type { Audience } from '../facts/schema.js'
import { hashSecret } from './crypto.js'

export async function mintConsumer(
  sql: Sql,
  input: { name: string; audience: Audience; scopes: string[] },
): Promise<{ token: string }> {
  const token = `nc_${randomBytes(24).toString('base64url')}`
  await sql.query(
    `insert into api_consumers (id, name, key_hash, scopes, audience)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [input.name, input.name, hashSecret(token), JSON.stringify(input.scopes), input.audience],
  )
  return { token }
}

export async function revokeConsumer(sql: Sql, name: string): Promise<boolean> {
  const rows = await sql.query<{ name: string }>(
    `update api_consumers set revoked_at = now() where name = $1 and revoked_at is null returning name`,
    [name],
  )
  return rows.rows.length > 0
}
