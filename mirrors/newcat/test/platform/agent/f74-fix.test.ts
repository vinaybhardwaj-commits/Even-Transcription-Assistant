import { describe, expect, it } from 'vitest'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { assertGovernanceSafe, EmitRefusal } from '../../../src/audience/serialize.js'
import { asJson } from '../../../src/db/sql.js'
import { validateDefinition } from '../../../src/platform/agent/define.js'
import { candidatesOf } from '../../../src/platform/agent/types.js'
import { CONVERSATION, GOOD_FACT, harness, reply } from './harness.js'

const BODY = {
  findings: [{ action: 'valid', evidence: [{ segment_id: 's1', quote: 'q' }], judge: { primary_p: 0.8 } }],
  abstentions: {},
}
const withMeta = (meta: Record<string, unknown>) => ({ ...BODY, findings: [{ ...BODY.findings[0], meta }] })
const rule = exampleEcho.rules[0]!
const SYNTHETIC = 'x'

const VARIANTS = [
  'mrn', 'phone_number', 'mobile_no', 'email_address', 'full_name', 'first_name', 'aadhaar', 'ip_number', 'patient', 'doctor_name',
  'patientName', 'individualUid', 'UHID', 'Patient_Name', 'Doctor_UID', 'contact-no', 'home.address', 'IPNumber', 'encounter_id',
]

describe('F7.4 fix R1: identifier-like keys are refused by token', () => {
  it.each(VARIANTS)('refuses %s in meta and versions', (key) => {
    expect(() => assertGovernanceSafe(withMeta({ [key]: SYNTHETIC }))).toThrow(EmitRefusal)
    expect(() => assertGovernanceSafe({ ...BODY, versions: { [key]: SYNTHETIC } })).toThrow(EmitRefusal)
  })

  it('still accepts ordinary meta and versions keys', () => {
    expect(() => assertGovernanceSafe(withMeta({ lane: 'a', score: 3, flag: true, note_tag: 'x' }))).not.toThrow()
    expect(() =>
      assertGovernanceSafe({
        ...BODY,
        doctor_uid: 'doc-1',
        encounter_id: 'enc-1',
        versions: { engine: 'e', rules: 'r', extractor: 'x', models: 'm', question_set_sha: 's', question_sets: { r1: 'q@sha' }, agent: 'a/1' },
      }),
    ).not.toThrow()
  })

  it('metaKeys: a declared identifier-like key fails validateDefinition', () => {
    for (const key of ['mrn', 'phone_number', 'patientName', 'Bad', '1x', '']) {
      expect(() => validateDefinition({ ...exampleEcho, metaKeys: [key] } as never)).toThrow()
    }
    expect(() => validateDefinition({ ...exampleEcho, metaKeys: ['lane', 'lane'] } as never)).toThrow()
    expect(() => validateDefinition({ ...exampleEcho, metaKeys: ['lane', 'score'] } as never)).not.toThrow()
  })

  it('metaKeys: a rule using an undeclared meta key fails the run with invalid_meta_key', async () => {
    const d = {
      ...exampleEcho,
      metaKeys: ['lane'],
      rules: [{ ...rule, evaluate: (facts: never[]) => candidatesOf(rule.evaluate(facts)).map((c) => ({ ...c, meta: { lane: 'a', other: 'b' } })) }],
    } as never
    const audit = await (await harness([reply([GOOD_FACT])])).run(CONVERSATION, {}, d)
    expect(audit.status).toBe('failed')
    expect(audit.error?.type).toBe('invalid_meta_key')
  })

  it('metaKeys: no declaration means no meta allowed', async () => {
    const d = {
      ...exampleEcho,
      rules: [{ ...rule, evaluate: (facts: never[]) => candidatesOf(rule.evaluate(facts)).map((c) => ({ ...c, meta: { lane: 'a' } })) }],
    } as never
    const audit = await (await harness([reply([GOOD_FACT])])).run(CONVERSATION, {}, d)
    expect(audit.error?.type).toBe('invalid_meta_key')
  })
})

describe('F7.4 fix R2: versions keys and values', () => {
  it.each(['doctor_uid', 'UHID', 'patient_name', 'mrn', 'phone_number'])('refuses versions.%s', (key) => {
    expect(() => assertGovernanceSafe({ ...BODY, versions: { [key]: 'Dr Rao' } })).toThrow(EmitRefusal)
  })

  it('refuses non-slug agent keys, non-string values and a non-record question_sets', () => {
    expect(() => assertGovernanceSafe({ ...BODY, versions: { 'Bad Key': 'x' } })).toThrow(EmitRefusal)
    expect(() => assertGovernanceSafe({ ...BODY, versions: { agent: 3 } })).toThrow(EmitRefusal)
    expect(() => assertGovernanceSafe({ ...BODY, versions: { question_sets: 'x' } })).toThrow(EmitRefusal)
    expect(() => assertGovernanceSafe({ ...BODY, versions: { question_sets: { r: 1 } } })).toThrow(EmitRefusal)
  })
})

describe('F7.4 fix R3: a dropped id is counted', () => {
  const withIds = (ids: unknown) => ({ ...exampleEcho, identity: () => ids }) as never
  const countsOf = async (h: Awaited<ReturnType<typeof harness>>) =>
    asJson((await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!.counts) as Record<string, unknown>

  it('a malformed doctor_uid is left off the audit and counted', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, {}, withIds({ doctor_uid: 'Dr Rao', encounter_id: 'enc-1' }))
    expect('doctor_uid' in audit).toBe(false)
    expect(audit).toMatchObject({ encounter_id: 'enc-1' })
    expect((await countsOf(h)).identity_invalid).toEqual({ doctor_uid: 1 })
  })

  it('a malformed encounter_id and a throwing identity are counted by field', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await h.run(CONVERSATION, {}, withIds({ encounter_id: 7 }))
    expect((await countsOf(h)).identity_invalid).toEqual({ encounter_id: 1 })
    const h2 = await harness([reply([GOOD_FACT])])
    const audit = await h2.run(CONVERSATION, {}, { ...exampleEcho, identity: () => { throw new Error('boom') } } as never)
    expect('doctor_uid' in audit).toBe(false)
    expect((await countsOf(h2)).identity_invalid).toEqual({ threw: 1 })
  })

  it('good ids and absent ids leave no identity_invalid', async () => {
    const h = await harness([reply([GOOD_FACT])])
    await h.run(CONVERSATION, {}, withIds({ doctor_uid: 'doc-1' }))
    expect('identity_invalid' in (await countsOf(h))).toBe(false)
  })
})

describe('F7.4 fix R4: opaque ids refuse long digit runs', () => {
  it.each(['9876543210', 'doc-12345678', '12345678'])('refuses %s', (value) => {
    expect(() => assertGovernanceSafe({ ...BODY, doctor_uid: value })).toThrow(EmitRefusal)
    expect(() => assertGovernanceSafe({ ...BODY, encounter_id: value })).toThrow(EmitRefusal)
  })

  it('accepts runs of 7 digits or fewer', () => {
    expect(() => assertGovernanceSafe({ ...BODY, doctor_uid: 'doc-1234567', encounter_id: 'e1-234-567' })).not.toThrow()
  })

  it('identity() with a digit run is dropped and counted', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, {}, { ...exampleEcho, identity: () => ({ doctor_uid: '9876543210' }) } as never)
    expect('doctor_uid' in audit).toBe(false)
    const row = (await h.sql.query<Record<string, unknown>>('select counts from agent_runs')).rows[0]!
    expect((asJson(row.counts) as { identity_invalid: unknown }).identity_invalid).toEqual({ doctor_uid: 1 })
  })
})

