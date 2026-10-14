import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clinicalDateIst } from '../src/clock.js'
import { contentHash } from '../src/hash.js'
import { ingestNote } from '../src/ingest/ingest.js'
import { EXTRACTOR_VERSION } from '../src/version.js'
import { testDb } from './helpers.js'

const gold = JSON.parse(readFileSync('fixtures/gold/safety-v1.json', 'utf8')) as {
  cases: { source: string; source_uid: string; source_timestamp: string; body: string }[]
}

describe('clock and ingest', () => {
  it('derives the IST clinical date from UTC without using the host zone', () => {
    expect(clinicalDateIst(new Date('2026-10-11T20:00:00.000Z'))).toBe('2026-10-12')
    expect(clinicalDateIst(new Date('2026-10-11T18:00:00.000Z'))).toBe('2026-10-11')
  })

  it('keeps a re-dated unchanged note as the same version', async () => {
    const sql = await testDb()
    const note = gold.cases[0]
    if (!note) throw new Error('missing gold case')
    const first = await ingestNote(
      sql,
      {
        source: note.source,
        source_uid: note.source_uid,
        source_timestamp: note.source_timestamp,
        body: note.body,
      },
      { stage: 'extract', stageVersion: EXTRACTOR_VERSION },
    )
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.data.created).toBe(true)
    expect(first.data.note.clinical_date).toBe('2026-10-12')
    expect(first.data.work).not.toBeNull()

    const again = await ingestNote(sql, {
      source: note.source,
      source_uid: note.source_uid,
      source_timestamp: '2026-10-12T09:00:00.000Z',
      body: note.body.replace(/\n/g, '\r\n'),
    })
    expect(again.status).toBe('ok')
    if (again.status !== 'ok') return
    expect(again.data.created).toBe(false)
    expect(again.data.work).toBeNull()
    expect(again.data.note.id).toBe(first.data.note.id)
    expect(again.data.note.source_timestamp).toBe(first.data.note.source_timestamp)
    expect(again.data.note.clinical_date).toBe(first.data.note.clinical_date)

    const changed = await ingestNote(
      sql,
      {
        source: note.source,
        source_uid: note.source_uid,
        source_timestamp: note.source_timestamp,
        body: `${note.body}\nPLAN: refer to emergency`,
      },
      { stage: 'extract', stageVersion: EXTRACTOR_VERSION },
    )
    expect(changed.status).toBe('ok')
    if (changed.status !== 'ok') return
    expect(changed.data.created).toBe(true)
    expect(changed.data.note.id).not.toBe(first.data.note.id)
    expect(changed.data.work?.status).toBe('queued')
  })

  it('omits the source timestamp from the content hash', () => {
    const left = contentHash('AGE: 1\n', { a: 1 })
    const right = contentHash('AGE: 1\r\n', { a: 1 })
    expect(left).toBe(right)
    expect(contentHash('AGE: 2\n', {})).not.toBe(left)
  })
})
