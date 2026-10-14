import type { Audience } from '../facts/schema.js'
import { asJson, type Sql } from '../db/sql.js'
import type { ApiKeySeed } from '../config.js'
import { hashSecret, safeEqual } from './crypto.js'

export interface Consumer {
  name: string
  scopes: string[]
  audience: Audience
}

const DUMMY_HASH = hashSecret('newcat-dummy-key')

export async function upsertConsumers(sql: Sql, seeds: ApiKeySeed[]): Promise<void> {
  for (const seed of seeds) {
    await sql.query(
      `insert into api_consumers (id, name, key_hash, scopes, audience)
       values ($1, $2, $3, $4::jsonb, $5)
       on conflict (id) do update set
         key_hash = excluded.key_hash,
         scopes = excluded.scopes,
         audience = excluded.audience,
         revoked_at = null`,
      [seed.name, seed.name, hashSecret(seed.token), JSON.stringify(seed.scopes), seed.audience],
    )
  }
}

export function bearerToken(header: string | null): string | null {
  if (!header) return null
  const match = /^Bearer ([^\s]+)$/.exec(header)
  return match?.[1] ?? null
}

export async function authenticateConsumer(sql: Sql, authorization: string | null): Promise<Consumer | null> {
  const token = bearerToken(authorization)
  if (!token) return null
  const hash = hashSecret(token)
  const rows = await sql.query<{ name: string; key_hash: string; scopes: unknown; audience: Audience }>(
    'select name, key_hash, scopes, audience from api_consumers where key_hash = $1 and revoked_at is null',
    [hash],
  )
  const row = rows.rows[0]
  const stored = row?.key_hash ?? DUMMY_HASH
  if (!safeEqual(stored, hash) || !row) return null
  return { name: row.name, scopes: asJson<string[]>(row.scopes), audience: row.audience }
}

export function authenticateCron(authorization: string | null, secret: string | undefined): 'ok' | 'missing_secret' | 'unauthorized' {
  if (!secret) return 'missing_secret'
  const token = bearerToken(authorization)
  if (!token || !safeEqual(token, secret)) return 'unauthorized'
  return 'ok'
}

/**
 * granted -> audiences it may request. Governance is a separate lane, not a rung on the
 * doctor < operator < internal ladder: only internal reaches it, and it reaches nothing else.
 */
const AUDIENCE_ALLOW: Record<Audience, readonly Audience[]> = {
  internal: ['internal', 'operator', 'doctor', 'governance'],
  governance: ['governance'],
  operator: ['operator', 'doctor'],
  doctor: ['doctor'],
}

export function audienceAllowed(granted: Audience, requested: Audience): boolean {
  return AUDIENCE_ALLOW[granted].includes(requested)
}
