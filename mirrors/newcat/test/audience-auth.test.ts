import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { authenticateCron } from '../src/auth/consumers.js'
import { assertDoctorSafe, EmitRefusal, serialize } from '../src/audience/serialize.js'
import { assertBootSecrets, loadEnv } from '../src/config.js'
import { FakeJevTransport } from '../src/decide/transport.js'
import { UnavailableEvidenceRetriever, type EvidenceRetriever } from '../src/evidence/retriever.js'
import { resolveIdentity } from '../src/identity/resolve.js'
import { FakeModelClient } from '../src/llm/fake.js'
import { runAudit } from '../src/pipeline/audit.js'
import { testDb, testEnv } from './helpers.js'

const BANNED = [
  'rationale',
  'policy_id',
  'probabilities',
  'question_set_sha',
  'served_model_id',
  'intended_model_id',
  'models',
  'extractor',
  'extractor_version',
  'top_probability',
  'rule_id',
  'rule_version',
  'queue',
  'versions',
  'chunk_id',
  'source_id',
  'licence_class',
  'evidence_refs',
  'evidence_hits',
  'evidence_status',
  'section_path',
]

const gold = JSON.parse(readFileSync('fixtures/gold/safety-v1.json', 'utf8')) as {
  cases: { source: string; source_uid: string; source_timestamp: string; body: string }[]
}

describe('audience, identity, and auth', () => {
  it('strips internal fields from the doctor audience and keeps them for internal', async () => {
    const sql = await testDb()
    const note = gold.cases[0]
    if (!note) throw new Error('missing case')
    const audit = await runAudit(
      { sql, models: new FakeModelClient(sql), jev: new FakeJevTransport(sql) },
      {
        traceId: 'trace-audience',
        purpose: 'test',
        patientRef: 'pt-1',
        encounterRef: 'enc-1',
        source: note.source,
        sourceUid: note.source_uid,
        sourceTimestamp: note.source_timestamp,
        body: note.body,
        backlogDays: 0,
      },
    )
    const doctor = serialize(audit, 'doctor') as Record<string, unknown>
    expect(doctor.status).toBe('ok')
    expect(walk(doctor).some((key) => BANNED.includes(key))).toBe(false)
    const operator = serialize(audit, 'operator') as { findings: { rule_id: string }[]; decisions: Record<string, unknown>[] }
    expect(operator.findings[0]?.rule_id).toBeTruthy()
    expect('probabilities' in (operator.decisions[0] ?? {})).toBe(false)
    const internal = serialize(audit, 'internal') as { decisions: { probabilities: Record<string, number>; policy_id: string }[]; versions: { models: string[] } }
    expect(internal.decisions[0]?.policy_id).toBe('abstention-policy/0.2.0')
    expect(Object.keys(internal.decisions[0]?.probabilities ?? {}).length).toBeGreaterThan(0)
    expect(internal.versions.models.length).toBeGreaterThan(0)
    expect(() => assertDoctorSafe({ findings: [{ rationale: 'hidden' }] })).toThrow(EmitRefusal)
  })

  it('requires both identity refs and refuses an unset cron secret', () => {
    expect(resolveIdentity({ patient_ref: 'p' }).status).toBe('unmapped')
    expect(resolveIdentity({ patient_ref: 'p', encounter_ref: 'e' })).toMatchObject({ status: 'ok', match_source: 'caller_asserted' })
    expect(authenticateCron('Bearer cron-secret-value', 'cron-secret-value')).toBe('ok')
    expect(authenticateCron('Bearer wrong-secret-value', 'cron-secret-value')).toBe('unauthorized')
    expect(authenticateCron(null, undefined)).toBe('missing_secret')
    expect(authenticateCron('Bearer x-vercel-cron', 'cron-secret-value')).toBe('unauthorized')
    expect(() => assertBootSecrets(loadEnv({ NEWCAT_ENV: 'production' }))).toThrow(/refusing to boot/)
    expect(() => assertBootSecrets(testEnv())).not.toThrow()
  })

  it('returns unavailable from the evidence stub', async () => {
    const retriever: EvidenceRetriever = new UnavailableEvidenceRetriever()
    const result = await retriever.retrieve({ fact_ids: [], question: 'why' })
    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') expect(result.error.type).toBe('evidence_layer_not_built')
  })
})

function walk(value: unknown, keys: string[] = []): string[] {
  if (!value || typeof value !== 'object') return keys
  if (Array.isArray(value)) {
    for (const item of value) walk(item, keys)
    return keys
  }
  for (const [key, child] of Object.entries(value)) {
    keys.push(key)
    walk(child, keys)
  }
  return keys
}
