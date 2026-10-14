import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appliedMigrations, migrate } from '../src/db/migrate.js'
import { ingestNote } from '../src/ingest/ingest.js'
import { enqueueWork, leaseNext, retryOrFail } from '../src/ingest/queue.js'
import { EXTRACTOR_VERSION } from '../src/version.js'
import { testDb } from './helpers.js'

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...filesUnder(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('migrations and work leases', () => {
  it('applies each migration once and records it', async () => {
    const sql = await testDb()
    const second = await migrate(sql)
    expect(second).toEqual([])
    expect(await appliedMigrations(sql)).toEqual(['0001_init.sql', '0002_ops.sql', '0003_evidence.sql', '0004_extract_trace.sql', '0005_consult.sql', '0006_agent_runs.sql', '0008_governance_audience.sql'])
  })

  it('keeps DDL out of runtime source', () => {
    const source = [...filesUnder('src'), ...filesUnder('scripts')].map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(source).not.toMatch(/alter\s+table/i)
    expect(source).not.toMatch(/openrouter|ollama|qwen/i)
    expect(source).not.toMatch(/x-vercel-cron/)
  })

  it('caps attempts at 2 and then fails the work item', async () => {
    const sql = await testDb()
    const ingested = await ingestNote(sql, {
      source: 'synthetic',
      source_uid: 'lease-1',
      source_timestamp: '2026-10-12T00:00:00.000Z',
      body: 'AGE: 40\n',
    })
    expect(ingested.status).toBe('ok')
    if (ingested.status !== 'ok') return
    await enqueueWork(sql, ingested.data.note.id, 'extract', EXTRACTOR_VERSION)
    const first = await leaseNext(sql, 'worker-a')
    expect(first?.attempts).toBe(1)
    expect(await leaseNext(sql, 'worker-b')).toBeNull()
    expect(first && (await retryOrFail(sql, first, 'try again'))).toBe('queued')
    const second = await leaseNext(sql, 'worker-a')
    expect(second?.attempts).toBe(2)
    expect(second && (await retryOrFail(sql, second, 'give up'))).toBe('failed')
    expect(await leaseNext(sql, 'worker-c')).toBeNull()
  })
})
