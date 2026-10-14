import { existsSync } from 'node:fs'
import { sha256 } from '../../../src/hash.js'
import type { Sql } from '../../../src/db/sql.js'
import { describe, expect, it } from 'vitest'
import { loadFindings, saveConsult, sweepConsultInputs, trimInput, type ConsultRecord } from '../../../src/agents/surgical-consult/store.js'
import { asJson } from '../../../src/db/sql.js'
import { testDb } from '../../helpers.js'
import { load } from './helpers.js'

const finding = (id: string) => ({
  finding_id: id,
  rule_id: 'consent.risks',
  rule_version: 'sc-rules/0.1.0',
  finding_type: 'consent_incomplete',
  procedure_group: 'hernia_repair',
  action: 'valid',
  judge: { primary_p: 0.9, second_p: 0.8, agree: true, served_model_ids: ['m1'] },
  evidence: [{ segment_id: 'seg-0001', role: 'doctor', t0: 0, t1: 6, quote: 'I recommend repairing it soon.' }],
})
const record = (over: Partial<ConsultRecord> = {}): ConsultRecord => ({
  encounter_id: 'enc-1',
  transcript_sha: 'sha-1',
  extractor_version: 'consult-extract/0.1.0',
  input: load('hernia-full-consent'),
  facts: [{ id: 'f1', group: 'recommendation' }],
  dropped: { quote_not_in_segment: 1 },
  served_model_ids: ['m1'],
  findings: [finding('a'), finding('b')],
  ...over,
})
const count = async (sql: Awaited<ReturnType<typeof testDb>>, table: string) =>
  Number((await sql.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n)

// Migration 0005 lands in its own commit (the registration commit), so these run once that file is present.
describe.skipIf(!existsSync('migrations/0005_consult.sql'))('consult store (migration 0005)', () => {
  it('writes input, extraction and findings, and reads the findings back', async () => {
    const sql = await testDb()
    expect(await saveConsult(sql, record())).toBe(true)
    expect([await count(sql, 'consult_inputs'), await count(sql, 'consult_extractions'), await count(sql, 'consult_findings')]).toEqual([1, 1, 2])
    const back = await loadFindings(sql, record())
    expect(back.map((f) => f.finding_id)).toEqual(['a', 'b'])
    expect(back[0]).toMatchObject({ rule_id: 'consent.risks', judge: { primary_p: 0.9 }, evidence: [{ segment_id: 'seg-0001' }] })
    const ext = (await sql.query<{ dropped: unknown; served_model_ids: unknown }>('select dropped, served_model_ids from consult_extractions')).rows[0]!
    expect(asJson(ext.dropped)).toEqual({ quote_not_in_segment: 1 })
    expect(asJson(ext.served_model_ids)).toEqual(['m1'])
  })

  it('is idempotent on (encounter_id, transcript_sha, extractor_version): a repeat writes nothing', async () => {
    const sql = await testDb()
    await saveConsult(sql, record())
    expect(await saveConsult(sql, record({ findings: [finding('c')] }))).toBe(false)
    expect(await count(sql, 'consult_findings')).toBe(2)
  })

  it('a new extractor version re-uses the input row and adds its own extraction and findings', async () => {
    const sql = await testDb()
    await saveConsult(sql, record())
    expect(await saveConsult(sql, record({ extractor_version: 'consult-extract/0.2.0', findings: [finding('a')] }))).toBe(true)
    expect([await count(sql, 'consult_inputs'), await count(sql, 'consult_extractions'), await count(sql, 'consult_findings')]).toEqual([1, 2, 3])
  })

  it('a different transcript for the same encounter is a separate input', async () => {
    const sql = await testDb()
    await saveConsult(sql, record())
    await saveConsult(sql, record({ transcript_sha: 'sha-2' }))
    expect(await count(sql, 'consult_inputs')).toBe(2)
  })
})

const keysAt = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysAt(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      out.push(k)
      keysAt(x, out)
    }
  return out
}

describe.skipIf(!existsSync('migrations/0005_consult.sql'))('S2b: trimmed input and the 90-day sweep', () => {
  it('stores only turn_id, role, t0, t1, text_en, the window bounds and the opaque ids', async () => {
    const sql = await testDb()
    const input = load('hernia-full-consent')
    expect(input.turns[0]!.text_native).not.toBeNull()
    await saveConsult(sql, record({ input: { ...input, clips: [{ turn_ids: ['1'], url: 'https://clips.example/a?sig=1', expires_at: '2026-10-02T00:00:00Z' }] } }))
    const stored = asJson<Record<string, unknown>>((await sql.query<{ input: unknown }>('select input from consult_inputs')).rows[0]!.input)
    expect(stored).toEqual(trimInput(input))
    expect(Object.keys(stored).sort()).toEqual(['doctor_uid', 'encounter_id', 'turns', 'window'])
    expect(Object.keys((stored.turns as object[])[0]!).sort()).toEqual(['role', 't0', 't1', 'text_en', 'turn_id'])
    const keys = keysAt(stored)
    for (const bad of ['text_native', 'lang', 'clips', 'clip', 'url', 'expires_at', 'room', 'presc_uid', 'presc_match', 'rx', 'specialty']) expect(keys).not.toContain(bad)
    expect(keys.some((k) => /clip|url|room|presc|native/.test(k))).toBe(false)
    expect(JSON.stringify(stored)).not.toContain('clips.example')
    expect(JSON.stringify(stored)).not.toContain(input.room)
    expect(JSON.stringify(stored)).not.toContain(input.turns[0]!.text_native!)
    expect((stored.turns as Array<{ text_en: string }>)[0]!.text_en).toBe(input.turns[0]!.text_en)
  })

  it('transcript_sha is unchanged: sha256 of JSON.stringify(input.turns) over the full parsed turns', async () => {
    const { persistConsult } = await import('../../../src/agents/surgical-consult/store.js')
    const sql = await testDb()
    const input = load('hernia-full-consent')
    await persistConsult({ sql, runId: 'r', traceId: 't', input, audit: { status: 'empty', findings: [], versions: { extractor: 'x', models: [] } } as never, facts: [], drops: {} })
    const row = (await sql.query<{ transcript_sha: string }>('select transcript_sha from consult_inputs')).rows[0]!
    expect(row.transcript_sha).toBe(sha256(JSON.stringify(input.turns)))
  })

  const ageDays = async (sql: Sql, id: string, days: number, now: Date) =>
    sql.query('update consult_inputs set created_at = $2::timestamptz where encounter_id = $1', [id, new Date(now.getTime() - days * 86_400_000).toISOString()])

  it('empties a 91-day-old input, keeps an 89-day-old one, keeps every row and every other table', async () => {
    const sql = await testDb()
    const now = new Date('2026-10-13T12:00:00Z')
    await saveConsult(sql, record({ encounter_id: 'old', transcript_sha: 'sha-old' }))
    await saveConsult(sql, record({ encounter_id: 'new', transcript_sha: 'sha-new' }))
    await ageDays(sql, 'old', 91, now)
    await ageDays(sql, 'new', 89, now)
    const before = {
      ext: (await sql.query('select * from consult_extractions order by encounter_id')).rows,
      fin: (await sql.query('select * from consult_findings order by encounter_id, finding_id')).rows,
    }
    const statements: string[] = []
    const spy = { ...sql, query: (text: string, params?: unknown[]) => (statements.push(text), sql.query(text, params)) } as unknown as Sql
    expect(await sweepConsultInputs(spy, now)).toBe(1)
    const rows = (await sql.query<{ encounter_id: string; input: unknown }>('select encounter_id, input from consult_inputs order by encounter_id')).rows
    expect(rows.map((r) => r.encounter_id)).toEqual(['new', 'old']) // the row stays
    expect(asJson(rows.find((r) => r.encounter_id === 'old')!.input)).toEqual({})
    expect(asJson<Record<string, unknown>>(rows.find((r) => r.encounter_id === 'new')!.input).turns).toBeDefined()
    // FKs hold and the dependent tables are untouched
    expect((await sql.query('select * from consult_extractions order by encounter_id')).rows).toEqual(before.ext)
    expect((await sql.query('select * from consult_findings order by encounter_id, finding_id')).rows).toEqual(before.fin)
    // runtime SQL capture: one statement, naming only consult_inputs
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/update consult_inputs\b/)
    expect(statements[0]).not.toMatch(/consult_extractions|consult_findings|agent_runs|agent_findings|delete/i)
    // a second sweep has nothing left to empty
    expect(await sweepConsultInputs(sql, now)).toBe(0)
  })

  it('exactly 90 days old is kept; one second older is emptied (strict <)', async () => {
    const sql = await testDb()
    const now = new Date('2026-10-13T12:00:00Z')
    await saveConsult(sql, record({ encounter_id: 'edge', transcript_sha: 'sha-edge' }))
    await saveConsult(sql, record({ encounter_id: 'past', transcript_sha: 'sha-past' }))
    await ageDays(sql, 'edge', 90, now)
    await sql.query('update consult_inputs set created_at = $2::timestamptz where encounter_id = $1', ['past', new Date(now.getTime() - 90 * 86_400_000 - 1000).toISOString()])
    expect(await sweepConsultInputs(sql, now)).toBe(1)
    const rows = (await sql.query<{ encounter_id: string; input: unknown }>('select encounter_id, input from consult_inputs')).rows
    expect(asJson<Record<string, unknown>>(rows.find((r) => r.encounter_id === 'edge')!.input).turns).toBeDefined()
    expect(asJson(rows.find((r) => r.encounter_id === 'past')!.input)).toEqual({})
  })

  it('honours the days argument and the cutoff edge', async () => {
    const sql = await testDb()
    const now = new Date('2026-10-13T12:00:00Z')
    await saveConsult(sql, record())
    await ageDays(sql, 'enc-1', 30, now)
    expect(await sweepConsultInputs(sql, now)).toBe(0)
    expect(await sweepConsultInputs(sql, now, 29)).toBe(1)
  })

  it('the sweep source names only consult_inputs', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/agents/surgical-consult/store.ts', 'utf8')
    const body = src.slice(src.indexOf('export async function sweepConsultInputs'), src.indexOf('export async function loadFindings'))
    expect(body).toMatch(/consult_inputs/)
    expect(body).not.toMatch(/consult_extractions|consult_findings/)
  })
})
