import { clinicalDateIst } from '../clock.js'
import { asDay, asIso, type Sql } from '../db/sql.js'
import { contentHash, normalizeBody } from '../hash.js'
import { newId } from '../ids.js'
import type { StageOutcome } from '../outcome.js'
import { enqueueWork, type WorkItem } from './queue.js'

export interface NoteInput {
  source: string
  source_uid: string
  source_timestamp: string
  body: string
  structured_fields?: unknown
}

export interface NoteVersion {
  id: string
  source: string
  source_uid: string
  source_timestamp: string
  content_hash: string
  body: string
  structured_fields: unknown
  clinical_date: string
  visible_at: string
}

export interface IngestData {
  note: NoteVersion
  created: boolean
  work: WorkItem | null
}

interface NoteRow {
  id: string
  source: string
  source_uid: string
  source_timestamp: unknown
  content_hash: string
  body: string
  structured_fields: unknown
  clinical_date: unknown
  visible_at: unknown
}

function mapNote(row: NoteRow): NoteVersion {
  return {
    id: row.id,
    source: row.source,
    source_uid: row.source_uid,
    source_timestamp: asIso(row.source_timestamp),
    content_hash: row.content_hash,
    body: row.body,
    structured_fields: row.structured_fields,
    clinical_date: asDay(row.clinical_date),
    visible_at: asIso(row.visible_at),
  }
}

async function findNote(sql: Sql, source: string, sourceUid: string, hash: string): Promise<NoteVersion | null> {
  const rows = await sql.query<NoteRow>(
    `select id, source, source_uid, source_timestamp, content_hash, body, structured_fields, clinical_date, visible_at
     from note_versions where source = $1 and source_uid = $2 and content_hash = $3`,
    [source, sourceUid, hash],
  )
  const row = rows.rows[0]
  return row ? mapNote(row) : null
}

export async function getNote(sql: Sql, id: string): Promise<NoteVersion | null> {
  const rows = await sql.query<NoteRow>(
    `select id, source, source_uid, source_timestamp, content_hash, body, structured_fields, clinical_date, visible_at
     from note_versions where id = $1`,
    [id],
  )
  const row = rows.rows[0]
  return row ? mapNote(row) : null
}

export async function ingestNote(
  sql: Sql,
  input: NoteInput,
  work?: { stage: string; stageVersion: string },
): Promise<StageOutcome<IngestData>> {
  const body = normalizeBody(input.body)
  if (!input.source.trim() || !input.source_uid.trim() || !body.trim()) {
    return { status: 'failed', error: { type: 'invalid_note', message: 'source, source_uid, and body are required' } }
  }
  const timestamp = new Date(input.source_timestamp)
  if (Number.isNaN(timestamp.getTime())) {
    return { status: 'failed', error: { type: 'invalid_note', message: 'source_timestamp is not a valid time' } }
  }
  const hash = contentHash(body, input.structured_fields ?? {})
  const existing = await findNote(sql, input.source, input.source_uid, hash)
  if (existing) return { status: 'ok', data: { note: existing, created: false, work: null } }

  const id = newId()
  const clinicalDate = clinicalDateIst(timestamp)
  const structured = JSON.stringify(input.structured_fields ?? {})
  try {
    return await sql.withTx(async (tx) => {
      const inserted = await tx.query<NoteRow>(
        `insert into note_versions (
           id, source, source_uid, source_timestamp, content_hash, body, structured_fields, clinical_date, visible_at
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
         on conflict (source, source_uid, content_hash) do nothing
         returning id, source, source_uid, source_timestamp, content_hash, body, structured_fields, clinical_date, visible_at`,
        [id, input.source, input.source_uid, timestamp.toISOString(), hash, body, structured, clinicalDate],
      )
      const row = inserted.rows[0]
      if (!row) {
        const raced = await findNote(tx, input.source, input.source_uid, hash)
        if (!raced) return { status: 'failed' as const, error: { type: 'ingest_conflict', message: 'note version could not be stored' } }
        return { status: 'ok' as const, data: { note: raced, created: false, work: null } }
      }
      const note = mapNote(row)
      const queued = work ? await enqueueWork(tx, note.id, work.stage, work.stageVersion) : null
      return { status: 'ok' as const, data: { note, created: true, work: queued } }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ingest failed'
    return { status: 'failed', error: { type: 'ingest_failed', message } }
  }
}
