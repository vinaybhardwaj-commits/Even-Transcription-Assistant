import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadFindings, saveConsult, type ConsultRecord } from '../../../src/agents/surgical-consult/store.js'
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
