import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sql } from '../db/sql.js'
import { sha256 } from '../hash.js'
import { catCorpusImportSignature, resolveImportLicence, sourceIdFor } from './approval.js'
import { chunkText, tokenCount } from './chunk.js'
import { vectorLiteral } from './embed.js'
import { EMBEDDING_DIM } from './hits.js'
import { parseCorpusText, type CorpusLine } from './import.js'
import { expandSpellings } from './spelling.js'

/** Bedrock batch recordId is an alphanumeric string of at most 11 characters. */
export const BATCH_RECORD_ID_LENGTH = 11
export const BATCH_RECORDS_PER_FILE = 50_000
export const TITAN_BATCH_MODEL_ID = 'amazon.titan-embed-text-v2:0'

export interface TitanBatchInput {
  recordId: string
  modelInput: { inputText: string; dimensions: number; normalize: true }
}

export interface BatchManifestRow {
  recordId: string
  source: string
  title: string
  section: string
  text: string
  span_start: number
  span_end: number
  token_count: number
  url: string | null
  licence_class: CorpusLine['licence_class']
  line_text: string
  line_hash: string
  external_id: string | null
}

export interface PreparedBatch {
  files: { name: string; records: TitanBatchInput[] }[]
  manifest: BatchManifestRow[]
}

export function recordIdFor(index: number): string {
  const id = String(index + 1).padStart(BATCH_RECORD_ID_LENGTH, '0')
  if (id.length !== BATCH_RECORD_ID_LENGTH) throw new Error('batch record id is longer than 11 characters')
  return id
}

/** Re-chunk corpus lines into Titan v2 batch-inference records and a manifest. */
export function prepareTitanBatch(lines: CorpusLine[], recordsPerFile = BATCH_RECORDS_PER_FILE): PreparedBatch {
  if (!Number.isInteger(recordsPerFile) || recordsPerFile < 1) throw new Error('records per file must be a positive integer')
  const manifest: BatchManifestRow[] = []
  const records: TitanBatchInput[] = []
  for (const line of lines) {
    const pieces = chunkText(line.text)
    const lineHash = sha256(JSON.stringify(line))
    for (const piece of pieces) {
      const recordId = recordIdFor(records.length)
      const inputText = `${line.section}\n${piece.text}`
      records.push({
        recordId,
        modelInput: { inputText, dimensions: EMBEDDING_DIM, normalize: true },
      })
      manifest.push({
        recordId,
        source: line.source,
        title: line.title,
        section: line.section,
        text: piece.text,
        span_start: piece.start,
        span_end: piece.end,
        token_count: piece.tokenCount,
        url: line.url ?? null,
        licence_class: line.licence_class,
        line_text: line.text,
        line_hash: lineHash,
        external_id: line.external_id ?? null,
      })
    }
  }
  const files: PreparedBatch['files'] = []
  for (let offset = 0; offset < records.length; offset += recordsPerFile) {
    const slice = records.slice(offset, offset + recordsPerFile)
    const name = `titan-${String(files.length + 1).padStart(5, '0')}.jsonl`
    files.push({ name, records: slice })
  }
  return { files, manifest }
}

export function writeTitanBatchDir(dir: string, lines: CorpusLine[], recordsPerFile = BATCH_RECORDS_PER_FILE): { files: string[]; records: number } {
  const prepared = prepareTitanBatch(lines, recordsPerFile)
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const file of prepared.files) {
    const path = join(dir, file.name)
    writeFileSync(path, file.records.map((record) => JSON.stringify(record)).join('\n') + (file.records.length ? '\n' : ''))
    written.push(path)
  }
  writeFileSync(dir.endsWith('/') ? `${dir}manifest.jsonl` : join(dir, 'manifest.jsonl'), prepared.manifest.map((row) => JSON.stringify(row)).join('\n') + (prepared.manifest.length ? '\n' : ''))
  return { files: written, records: prepared.manifest.length }
}

export function readCorpusFile(path: string): CorpusLine[] {
  const parsed = parseCorpusText(readFileSync(path, 'utf8'))
  if ('error' in parsed) throw new Error(`Line ${parsed.line} is not a corpus record.`)
  return parsed.lines
}

export interface BatchLoadReport {
  status: 'ok' | 'empty' | 'failed'
  records_read: number
  chunks_written: number
  records_failed: number
  reason?: string
  error?: { type: string; message: string }
}

export async function loadTitanBatchOutput(sql: Sql, outputPath: string, manifestPath: string, now = new Date()): Promise<BatchLoadReport> {
  const manifest = new Map<string, BatchManifestRow>()
  for (const row of readJsonl(manifestPath)) {
    const parsed = parseManifest(row)
    if (!parsed) return { status: 'failed', records_read: 0, chunks_written: 0, records_failed: 0, error: { type: 'invalid_manifest', message: 'A manifest row is not a batch record.' } }
    manifest.set(parsed.recordId, parsed)
  }
  const lines = readJsonl(outputPath)
  if (lines.length === 0) return { status: 'empty', records_read: 0, chunks_written: 0, records_failed: 0, reason: 'no_records' }
  let written = 0
  let failed = 0
  const signedLines = new Set<string>()
  for (const raw of lines) {
    const outcome = readOutputRecord(raw)
    if (!outcome.ok) {
      failed += 1
      continue
    }
    const row = manifest.get(outcome.recordId)
    if (!row || outcome.embedding.length !== EMBEDDING_DIM) {
      failed += 1
      continue
    }
    await insertBatchChunk(sql, row, outcome.embedding, now, signedLines)
    written += 1
  }
  return { status: 'ok', records_read: lines.length, chunks_written: written, records_failed: failed }
}

function readJsonl(path: string): unknown[] {
  const body = readFileSync(path, 'utf8')
  const rows: unknown[] = []
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    rows.push(JSON.parse(trimmed) as unknown)
  }
  return rows
}

function parseManifest(raw: unknown): BatchManifestRow | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Partial<BatchManifestRow>
  if (typeof row.recordId !== 'string' || typeof row.source !== 'string' || typeof row.title !== 'string') return null
  if (typeof row.section !== 'string' || typeof row.text !== 'string' || typeof row.line_text !== 'string' || typeof row.line_hash !== 'string') return null
  if (typeof row.span_start !== 'number' || typeof row.span_end !== 'number' || typeof row.token_count !== 'number') return null
  return {
    recordId: row.recordId,
    source: row.source,
    title: row.title,
    section: row.section,
    text: row.text,
    span_start: row.span_start,
    span_end: row.span_end,
    token_count: row.token_count,
    url: typeof row.url === 'string' ? row.url : null,
    licence_class: row.licence_class,
    line_text: row.line_text,
    line_hash: row.line_hash,
    external_id: typeof row.external_id === 'string' ? row.external_id : null,
  }
}

function readOutputRecord(raw: unknown): { ok: true; recordId: string; embedding: number[] } | { ok: false } {
  if (!raw || typeof raw !== 'object') return { ok: false }
  const row = raw as { recordId?: unknown; modelOutput?: { embedding?: unknown }; error?: unknown }
  if (typeof row.recordId !== 'string' || row.error) return { ok: false }
  const embedding = row.modelOutput?.embedding
  if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) return { ok: false }
  return { ok: true, recordId: row.recordId, embedding }
}

async function insertBatchChunk(sql: Sql, row: BatchManifestRow, embedding: number[], now: Date, signedLines: Set<string>): Promise<void> {
  const licence = resolveImportLicence(row.source, row.licence_class)
  const sourceId = sourceIdFor(row.source)
  const contentHash = sha256(row.line_text)
  const documentId = sha256(`${sourceId}|${contentHash}`)
  const pieceHash = sha256(`${row.span_start}|${row.text}`)
  const chunkId = sha256(`${documentId}|${row.section}|${pieceHash}`)
  const signature = catCorpusImportSignature(now)
  await sql.withTx(async (tx) => {
    await tx.query(
      `insert into sources (id, name, publisher, licence_class, version, retrieved_at, url, doctor_visible)
       values ($1, $2, null, $3, null, $4, $5, $6)
       on conflict (id) do update set
         licence_class = case
           when sources.licence_class = 'licensed_internal' or excluded.licence_class = 'licensed_internal' then 'licensed_internal'::licence_class
           when sources.licence_class = 'commercial_db' or excluded.licence_class = 'commercial_db' then 'commercial_db'::licence_class
           when sources.licence_class = 'india_regulatory' then sources.licence_class
           else excluded.licence_class
         end,
         doctor_visible = case
           when sources.licence_class in ('licensed_internal', 'commercial_db') then false
           when excluded.licence_class in ('licensed_internal', 'commercial_db') then false
           else excluded.doctor_visible
         end,
         url = coalesce(excluded.url, sources.url),
         retrieved_at = excluded.retrieved_at`,
      [sourceId, row.source.trim(), licence.licence_class, now.toISOString(), row.url, licence.doctor_visible],
    )
    await tx.query(
      `insert into documents (id, source_id, title, external_id, content_hash, url, signed_by, signed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (source_id, content_hash) do nothing`,
      [documentId, sourceId, row.title, row.external_id, contentHash, row.url, signature.signed_by, signature.signed_at],
    )
    await tx.query(
      `insert into chunks (
         id, document_id, source_id, section_path, text, token_count, content_hash, embedding, search_text, span_start, span_end
       ) values ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11)
       on conflict (document_id, section_path, content_hash) do nothing`,
      [
        chunkId,
        documentId,
        sourceId,
        row.section,
        row.text,
        row.token_count || tokenCount(row.text),
        pieceHash,
        vectorLiteral(embedding),
        expandSpellings(`${row.section}\n${row.text}`),
        row.span_start,
        row.span_end,
      ],
    )
    if (!signedLines.has(row.line_hash)) {
      await tx.query(
        `insert into import_lines (content_hash, source_id, document_id) values ($1, $2, $3)
         on conflict (content_hash) do nothing`,
        [row.line_hash, sourceId, documentId],
      )
      signedLines.add(row.line_hash)
    }
  })
}
