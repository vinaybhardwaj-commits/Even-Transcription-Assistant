import { asIso, type Sql } from '../db/sql.js'
import { newId } from '../ids.js'

export const WORK_STATUSES = ['queued', 'leased', 'ok', 'empty', 'unavailable', 'extraction_failed', 'failed'] as const
export type WorkStatus = (typeof WORK_STATUSES)[number]

export const ATTEMPT_CAP = 2
const LEASE_MS = 30_000

export interface WorkItem {
  id: string
  note_version_id: string
  stage: string
  stage_version: string
  status: WorkStatus
  attempts: number
  max_attempts: number
  lease_owner: string | null
  lease_until: string | null
  last_error: string | null
}

interface WorkRow {
  id: string
  note_version_id: string
  stage: string
  stage_version: string
  status: WorkStatus
  attempts: number | string
  max_attempts: number | string
  lease_owner: string | null
  lease_until: unknown
  last_error: string | null
}

function mapWork(row: WorkRow | undefined): WorkItem | null {
  if (!row) return null
  return {
    id: row.id,
    note_version_id: row.note_version_id,
    stage: row.stage,
    stage_version: row.stage_version,
    status: row.status,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    lease_owner: row.lease_owner,
    lease_until: row.lease_until == null ? null : asIso(row.lease_until),
    last_error: row.last_error,
  }
}

export async function enqueueWork(sql: Sql, noteVersionId: string, stage: string, stageVersion: string): Promise<WorkItem> {
  const id = newId()
  const inserted = await sql.query<WorkRow>(
    `insert into work_items (id, note_version_id, stage, stage_version, status, max_attempts)
     values ($1, $2, $3, $4, 'queued', $5)
     on conflict (note_version_id, stage, stage_version) do nothing
     returning id, note_version_id, stage, stage_version, status, attempts, max_attempts, lease_owner, lease_until, last_error`,
    [id, noteVersionId, stage, stageVersion, ATTEMPT_CAP],
  )
  const created = mapWork(inserted.rows[0])
  if (created) return created
  const existing = await getWork(sql, noteVersionId, stage, stageVersion)
  if (!existing) throw new Error('work item disappeared after conflict')
  return existing
}

export async function getWork(sql: Sql, noteVersionId: string, stage: string, stageVersion: string): Promise<WorkItem | null> {
  const rows = await sql.query<WorkRow>(
    `select id, note_version_id, stage, stage_version, status, attempts, max_attempts, lease_owner, lease_until, last_error
     from work_items where note_version_id = $1 and stage = $2 and stage_version = $3`,
    [noteVersionId, stage, stageVersion],
  )
  return mapWork(rows.rows[0])
}

async function leaseWhere(sql: Sql, whereSql: string, params: unknown[], owner: string, leaseMs: number): Promise<WorkItem | null> {
  return sql.withTx(async (tx) => {
    const picked = await tx.query<{ id: string }>(
      `select id from work_items where ${whereSql} order by created_at limit 1 for update`,
      params,
    )
    const id = picked.rows[0]?.id
    if (!id) return null
    const updated = await tx.query<WorkRow>(
      `update work_items
       set status = 'leased', lease_owner = $2, lease_until = now() + ($3 * interval '1 millisecond'),
           attempts = attempts + 1, updated_at = now()
       where id = $1
       returning id, note_version_id, stage, stage_version, status, attempts, max_attempts, lease_owner, lease_until, last_error`,
      [id, owner, leaseMs],
    )
    return mapWork(updated.rows[0])
  })
}

const LEASABLE = `attempts < max_attempts and (status = 'queued' or (status = 'leased' and lease_until < now()))`

export async function leaseById(sql: Sql, id: string, owner: string, leaseMs = LEASE_MS): Promise<WorkItem | null> {
  return leaseWhere(sql, `id = $1 and ${LEASABLE}`, [id], owner, leaseMs)
}

export async function leaseNext(sql: Sql, owner: string, leaseMs = LEASE_MS): Promise<WorkItem | null> {
  return leaseWhere(sql, LEASABLE, [], owner, leaseMs)
}

export async function finishWork(sql: Sql, id: string, status: Exclude<WorkStatus, 'queued' | 'leased'>, error: string | null): Promise<void> {
  await sql.query(
    `update work_items
     set status = $2, lease_owner = null, lease_until = null, last_error = $3, updated_at = now()
     where id = $1`,
    [id, status, error],
  )
}

/** Returns the terminal status. Attempt cap is 2; the next failure after the cap is `failed`. */
export async function retryOrFail(sql: Sql, item: WorkItem, error: string): Promise<'queued' | 'failed'> {
  if (item.attempts >= item.max_attempts) {
    await finishWork(sql, item.id, 'failed', error)
    return 'failed'
  }
  await sql.query(
    `update work_items
     set status = 'queued', lease_owner = null, lease_until = null, last_error = $2, updated_at = now()
     where id = $1`,
    [item.id, error],
  )
  return 'queued'
}
