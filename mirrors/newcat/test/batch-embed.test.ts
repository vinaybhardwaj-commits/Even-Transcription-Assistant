import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BATCH_RECORD_ID_LENGTH,
  BATCH_RECORDS_PER_FILE,
  loadTitanBatchOutput,
  prepareTitanBatch,
  writeTitanBatchDir,
  type BatchManifestRow,
} from '../src/evidence/batch.js'
import { fakeEmbed } from '../src/evidence/embed.js'
import { EMBEDDING_DIM } from '../src/evidence/hits.js'
import type { CorpusLine } from '../src/evidence/import.js'
import { testDb } from './helpers.js'

function line(index: number): CorpusLine {
  return {
    source: 'who',
    title: 'Warfarin',
    section: 'Dose',
    text: `Passage ${index} mentions warfarin dose.`,
    url: 'https://example.test/warfarin',
    licence_class: 'open',
  }
}

describe('titan batch embed files', () => {
  it('writes 11-character record ids and splits files of about 50,000 records', () => {
    const prepared = prepareTitanBatch([line(1), line(2)])
    expect(BATCH_RECORDS_PER_FILE).toBe(50_000)
    expect(prepared.files).toHaveLength(1)
    expect(prepared.files[0]?.name).toBe('titan-00001.jsonl')
    expect(prepared.manifest).toHaveLength(2)
    for (const record of prepared.files[0]?.records ?? []) {
      expect(record.recordId).toHaveLength(BATCH_RECORD_ID_LENGTH)
      expect(record.modelInput.dimensions).toBe(EMBEDDING_DIM)
      expect(record.modelInput.normalize).toBe(true)
      expect(record.modelInput.inputText.startsWith('Dose\n')).toBe(true)
    }
    expect(prepared.files[0]?.records[0]?.recordId).toBe('00000000001')

    const split = prepareTitanBatch([line(1), line(2), line(3)], 2)
    expect(split.files.map((file) => file.records.length)).toEqual([2, 1])
    expect(split.files.map((file) => file.name)).toEqual(['titan-00001.jsonl', 'titan-00002.jsonl'])

    const dir = mkdtempSync(join(tmpdir(), 'newcat-batch-'))
    const written = writeTitanBatchDir(dir, [line(1), line(2)])
    expect(written.records).toBe(2)
    expect(written.files).toHaveLength(1)
    const onDisk = readFileSync(written.files[0] ?? '', 'utf8').trim().split('\n')
    expect(onDisk).toHaveLength(2)
    expect(readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('loads batch output vectors and counts an error record', async () => {
    const sql = await testDb()
    const dir = mkdtempSync(join(tmpdir(), 'newcat-batch-load-'))
    writeTitanBatchDir(dir, [line(1), line(2)])
    const manifestPath = join(dir, 'manifest.jsonl')
    const rows = readFileSync(manifestPath, 'utf8')
      .trim()
      .split('\n')
      .map((raw) => JSON.parse(raw) as BatchManifestRow)
    const outputPath = join(dir, 'titan-00001.jsonl.out')
    const success = rows.map((row) => ({
      recordId: row.recordId,
      modelOutput: { embedding: fakeEmbed(`${row.section}\n${row.text}`), inputTextTokenCount: row.token_count },
    }))
    const body = [
      ...success.map((row) => JSON.stringify(row)),
      JSON.stringify({ recordId: '00000000999', error: { errorCode: 'throttled', errorMessage: 'slow down' } }),
    ].join('\n')
    writeFileSync(outputPath, `${body}\n`)

    const report = await loadTitanBatchOutput(sql, outputPath, manifestPath)
    expect(report).toMatchObject({ status: 'ok', records_read: 3, chunks_written: 2, records_failed: 1 })
    const stored = await sql.query<{ dims: number; signed_by: string }>(
      `select vector_dims(c.embedding)::int as dims, d.signed_by
       from chunks c join documents d on d.id = c.document_id`,
    )
    expect(stored.rows).toHaveLength(2)
    expect(stored.rows.every((row) => row.dims === EMBEDDING_DIM && row.signed_by === 'cat-corpus-import')).toBe(true)
  })
})
