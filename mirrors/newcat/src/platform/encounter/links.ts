import type { Sql } from '../../db/sql.js'
import { asIso } from '../../db/sql.js'
import { newId } from '../../ids.js'
import { encounterIdFor } from './identity.js'

/**
 * encounter_links: one row per observation, APPEND-ONLY (migration 0011 refuses UPDATE and DELETE).
 * Newest row per key_kind wins. Values are identifiers: they stay in this table and never enter logs,
 * prompts, the bus or any audience body. This module logs nothing and its errors carry codes only.
 */
export const KEY_KINDS = ['eta_consult_uid', 'presc_uid', 'pulse_consult_uid', 'individual_uid', 'kx_encounter_id', 'eta_freescript_artifact'] as const
export type KeyKind = (typeof KEY_KINDS)[number]
export const LINK_STATUSES = ['probable', 'verified', 'refused'] as const
export type LinkStatus = (typeof LINK_STATUSES)[number]
export const LINK_BASES = ['exact_uid', 'room_doctor_window', 'metabase_lookup', 'manual'] as const
export type LinkBasis = (typeof LINK_BASES)[number]

export interface EncounterLink {
  id: string
  encounter_id: string
  key_kind: KeyKind
  value: string
  link_status: LinkStatus
  basis: LinkBasis
  verified_at: string | null
  created_at: string
}

export type NewLink = Pick<EncounterLink, 'key_kind' | 'value' | 'link_status' | 'basis'>

export class EncounterLinkError extends Error {
  constructor(readonly code: 'bad_key_kind' | 'bad_status' | 'bad_basis' | 'bad_value' | 'verified_needs_lookup') {
    super(`encounter_link_${code}`)
    this.name = 'EncounterLinkError'
  }
}

const VALUE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Creates the encounter row for a consult_uid if missing and returns its opaque encounter_id. The ETA
 * consult_uid is an identifier, so it is stored only as an `eta_consult_uid` link (verified, exact_uid)
 * written once when the encounter is created; `encounters` holds no identifier column.
 */
export async function ensureEncounter(sql: Sql, consultUid: string): Promise<string> {
  const encounterId = encounterIdFor(consultUid)
  await sql.query(`insert into encounters (encounter_id, source) values ($1, 'reb') on conflict do nothing`, [encounterId])
  const { rows } = await sql.query(`select 1 from encounter_links where encounter_id = $1 and key_kind = 'eta_consult_uid' limit 1`, [encounterId])
  if (rows.length === 0) await addLink(sql, encounterId, { key_kind: 'eta_consult_uid', value: consultUid, link_status: 'verified', basis: 'exact_uid' })
  return encounterId
}

/** Insert only. Checks shape; a verified link needs the resolver's lookup (a window basis can never be verified). */
export async function addLink(sql: Sql, encounterId: string, link: NewLink): Promise<EncounterLink> {
  if (!KEY_KINDS.includes(link.key_kind)) throw new EncounterLinkError('bad_key_kind')
  if (!LINK_STATUSES.includes(link.link_status)) throw new EncounterLinkError('bad_status')
  if (!LINK_BASES.includes(link.basis)) throw new EncounterLinkError('bad_basis')
  if (typeof link.value !== 'string' || !VALUE.test(link.value)) throw new EncounterLinkError('bad_value')
  // A window match is by definition not a verification.
  if (link.link_status === 'verified' && link.basis === 'room_doctor_window') throw new EncounterLinkError('verified_needs_lookup')
  const { rows } = await sql.query<Record<string, unknown>>(
    `insert into encounter_links (id, encounter_id, key_kind, value, link_status, basis, verified_at, created_at)
     select $1, $2, $3, $4, $5, $6, case when $5 = 'verified' then t.at else null end, t.at
       from (select greatest(clock_timestamp(), coalesce((select max(created_at) from encounter_links where encounter_id = $2), '-infinity'::timestamptz) + interval '1 microsecond') as at) t
     returning id, encounter_id, key_kind, value, link_status, basis, verified_at, created_at`,
    [newId(), encounterId, link.key_kind, link.value, link.link_status, link.basis],
  )
  return toLink(rows[0]!)
}

function toLink(row: Record<string, unknown>): EncounterLink {
  return {
    id: String(row.id),
    encounter_id: String(row.encounter_id),
    key_kind: row.key_kind as KeyKind,
    value: String(row.value),
    link_status: row.link_status as LinkStatus,
    basis: row.basis as LinkBasis,
    verified_at: row.verified_at == null ? null : asIso(row.verified_at),
    created_at: asIso(row.created_at),
  }
}

/** Newest row per key_kind wins (created_at is made strictly later than the encounter's newest row at insert, so same-tick inserts still order; two concurrent writers for one encounter could still tie, which only matters if both write different values for one key_kind). */
export async function currentLinks(sql: Sql, encounterId: string): Promise<Partial<Record<KeyKind, EncounterLink>>> {
  const { rows } = await sql.query<Record<string, unknown>>(
    `select distinct on (key_kind) id, encounter_id, key_kind, value, link_status, basis, verified_at, created_at
       from encounter_links where encounter_id = $1
      order by key_kind, created_at desc`,
    [encounterId],
  )
  const out: Partial<Record<KeyKind, EncounterLink>> = {}
  for (const row of rows) {
    const link = toLink(row)
    out[link.key_kind] = link
  }
  return out
}
