import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Sql } from '../db/sql.js'
import { sha256 } from '../hash.js'
import { catCorpusImportSignature, resolveImportLicence, sourceIdFor, type LicenceClass } from './approval.js'
import { chunkText, type TextChunk } from './chunk.js'
import type { Embedder } from './embed.js'
import { vectorLiteral } from './embed.js'
import { expandSpellings } from './spelling.js'

const LineSchema = z
  .object({
    source: z.string().min(1),
    title: z.string().min(1),
    section: z.string().min(1),
    text: z.string().min(1),
    url: z.string().url().optional(),
    licence_class: z.enum(['open', 'licensed_internal', 'india_regulatory', 'commercial_db']).optional(),
  })
  .strict()

export interface CorpusLine {
  source: string
  title: string
  section: string
  text: string
  url?: string | undefined
  licence_class?: LicenceClass | undefined
  external_id?: string | undefined
}

export interface ImportReport {
  status: 'ok' | 'empty' | 'unavailable' | 'failed'
  lines_read: number
  lines_imported: number
  lines_skipped: number
  chunks_written: number
  reason?: string
  error?: { type: string; message: string }
}

/** Vercel functions stop at 60s. At concurrency 8 the live path embeds about 3 lines a second. */
export const IMPORT_SAMPLE_MAX_LINES = 150

export interface ImportOptions {
  signer: 'cat-corpus' | 'none'
  batchSize: number
  /** In-flight embed calls. Defaults to 8. */
  concurrency?: number | undefined
  now?: Date | undefined
  traceId?: string | undefined
}

export function nonEmptyLineCount(body: string): number {
  let count = 0
  for (const raw of body.split(/\r?\n/)) {
    if (raw.trim() !== '') count += 1
  }
  return count
}

export function assertCorpusDatabase(url: string | undefined): asserts url is string {
  if (!url) {
    throw new Error('DATABASE_URL is required. The corpus CLI does not write to the in-memory database.')
  }
}

export function parseCorpusText(body: string): { lines: CorpusLine[] } | { error: string; line: number } {
  const lines: CorpusLine[] = []
  const rawLines = body.split(/\r?\n/)
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]?.trim() ?? ''
    if (raw === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { error: 'invalid_jsonl', line: index + 1 }
    }
    const line = LineSchema.safeParse(parsed)
    if (!line.success) return { error: 'invalid_jsonl', line: index + 1 }
    lines.push(line.data)
  }
  return { lines }
}

export async function importCorpusText(sql: Sql, embedder: Embedder, body: string, options: ImportOptions): Promise<ImportReport> {
  const rawLines = body.split(/\r?\n/)
  const accepted: CorpusLine[] = []
  let read = 0
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]?.trim() ?? ''
    if (raw === '') continue
    read += 1
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return invalidAfter(sql, embedder, accepted, options, index + 1, read)
    }
    const line = LineSchema.safeParse(parsed)
    if (!line.success) return invalidAfter(sql, embedder, accepted, options, index + 1, read)
    accepted.push(line.data)
  }
  if (read === 0) {
    return { status: 'empty', lines_read: 0, lines_imported: 0, lines_skipped: 0, chunks_written: 0, reason: 'no_lines' }
  }
  const report = await importCorpusLines(sql, embedder, accepted, options)
  return { ...report, lines_read: read }
}

async function invalidAfter(
  sql: Sql,
  embedder: Embedder,
  accepted: CorpusLine[],
  options: ImportOptions,
  line: number,
  read: number,
): Promise<ImportReport> {
  const partial =
    accepted.length === 0
      ? { lines_imported: 0, lines_skipped: 0, chunks_written: 0 }
      : await importCorpusLines(sql, embedder, accepted, options)
  return {
    status: 'failed',
    lines_read: read,
    lines_imported: partial.lines_imported,
    lines_skipped: partial.lines_skipped,
    chunks_written: partial.chunks_written,
    error: { type: 'invalid_jsonl', message: `Line ${line} is not a corpus record.` },
  }
}

export async function importCorpusFile(sql: Sql, embedder: Embedder, path: string, options: ImportOptions): Promise<ImportReport> {
  const body = readFileSync(path, 'utf8')
  return importCorpusText(sql, embedder, body, options)
}

interface PendingLine {
  line: CorpusLine
  lineHash: string
  pieces: TextChunk[]
  embedded: { piece: TextChunk; vector: number[]; hash: string }[]
  error?: { type: string; message: string }
}

interface EmbedJob {
  pending: PendingLine
  batch: TextChunk[]
  inputs: string[]
}

export async function importCorpusLines(sql: Sql, embedder: Embedder, lines: CorpusLine[], options: ImportOptions): Promise<ImportReport> {
  if (lines.length === 0) {
    return { status: 'empty', lines_read: 0, lines_imported: 0, lines_skipped: 0, chunks_written: 0, reason: 'no_lines' }
  }
  const now = options.now ?? new Date()
  const traceId = options.traceId ?? 'corpus-import'
  const concurrency = normalizeConcurrency(options.concurrency)
  let skipped = 0
  const seen = new Set<string>()
  const pending: PendingLine[] = []
  for (const line of lines) {
    const lineHash = sha256(JSON.stringify(line))
    if (seen.has(lineHash)) {
      skipped += 1
      continue
    }
    seen.add(lineHash)
    const existing = await sql.query<{ content_hash: string }>('select content_hash from import_lines where content_hash = $1', [lineHash])
    if (existing.rows[0]) {
      skipped += 1
      continue
    }
    const pieces = chunkText(line.text)
    const row: PendingLine = { line, lineHash, pieces, embedded: [] }
    if (pieces.length === 0) row.error = { type: 'empty_text', message: 'A corpus line had no text to chunk.' }
    pending.push(row)
  }
  const jobs: EmbedJob[] = []
  for (const row of pending) {
    if (row.error) continue
    for (let offset = 0; offset < row.pieces.length; offset += options.batchSize) {
      const batch = row.pieces.slice(offset, offset + options.batchSize)
      jobs.push({
        pending: row,
        batch,
        inputs: batch.map((piece) => `${row.line.section}\n${piece.text}`),
      })
    }
  }
  await mapWithConcurrency(jobs, concurrency, async (job) => {
    if (job.pending.error) return
    const vectors = await embedder.embed(job.inputs, 'document', traceId)
    if (job.pending.error) return
    if (vectors.status !== 'ok') {
      job.pending.error = 'error' in vectors ? vectors.error : { type: 'embedding_empty', message: 'The embedding response was empty.' }
      return
    }
    if (vectors.data.length !== job.batch.length) {
      job.pending.error = { type: 'embedding_empty', message: 'The embedding response was empty.' }
      return
    }
    job.batch.forEach((piece, index) => {
      const vector = vectors.data[index]
      if (!vector) return
      job.pending.embedded.push({ piece, vector, hash: sha256(`${piece.start}|${piece.text}`) })
    })
  })
  let imported = 0
  let chunksWritten = 0
  let failure: { type: string; message: string } | undefined
  for (const row of pending) {
    if (row.error || row.embedded.length !== row.pieces.length) {
      failure ??= row.error ?? { type: 'embedding_empty', message: 'The embedding response was empty.' }
      continue
    }
    await insertLine(sql, row, options, now)
    imported += 1
    chunksWritten += row.embedded.length
  }
  if (failure) {
    return {
      status: 'unavailable',
      lines_read: lines.length,
      lines_imported: imported,
      lines_skipped: skipped,
      chunks_written: chunksWritten,
      error: failure,
    }
  }
  return {
    status: 'ok',
    lines_read: lines.length,
    lines_imported: imported,
    lines_skipped: skipped,
    chunks_written: chunksWritten,
  }
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return 8
  return Math.min(value, 64)
}

async function mapWithConcurrency<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const workers = Math.max(1, Math.min(limit, items.length))
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) return
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => run()))
}

async function insertLine(sql: Sql, row: PendingLine, options: ImportOptions, now: Date): Promise<void> {
  const line = row.line
  const licence = resolveImportLicence(line.source, line.licence_class)
  const sourceId = sourceIdFor(line.source)
  const contentHash = sha256(line.text)
  const documentId = sha256(`${sourceId}|${contentHash}`)
  const signature = options.signer === 'cat-corpus' ? catCorpusImportSignature(now) : null
  const embedded = row.embedded
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
      [sourceId, line.source.trim(), licence.licence_class, now.toISOString(), line.url ?? null, licence.doctor_visible],
    )
    await tx.query(
      `insert into documents (id, source_id, title, external_id, content_hash, url, signed_by, signed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (source_id, content_hash) do nothing`,
      [documentId, sourceId, line.title, line.external_id ?? null, contentHash, line.url ?? null, signature?.signed_by ?? null, signature?.signed_at ?? null],
    )
    for (const item of embedded) {
      const id = sha256(`${documentId}|${line.section}|${item.hash}`)
      await tx.query(
        `insert into chunks (
           id, document_id, source_id, section_path, text, token_count, content_hash, embedding, search_text, span_start, span_end
         ) values ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11)
         on conflict (document_id, section_path, content_hash) do nothing`,
        [
          id,
          documentId,
          sourceId,
          line.section,
          item.piece.text,
          item.piece.tokenCount,
          item.hash,
          vectorLiteral(item.vector),
          expandSpellings(`${line.section}\n${item.piece.text}`),
          item.piece.start,
          item.piece.end,
        ],
      )
    }
    await tx.query(
      `insert into import_lines (content_hash, source_id, document_id) values ($1, $2, $3)
       on conflict (content_hash) do nothing`,
      [row.lineHash, sourceId, documentId],
    )
  })
}
