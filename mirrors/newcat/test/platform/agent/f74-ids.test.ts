import { describe, expect, it } from 'vitest'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { assertGovernanceSafe, EmitRefusal, serialize } from '../../../src/audience/serialize.js'
import type { InternalAudit } from '../../../src/pipeline/types.js'
import { CONVERSATION, GOOD_FACT, harness, reply } from './harness.js'

const BODY = {
  findings: [{ action: 'valid', evidence: [{ segment_id: 's1', quote: 'q' }], judge: { primary_p: 0.8, second_p: 0.9 } }],
  abstentions: { judge_disagree: 1 },
}
const withFinding = (patch: Record<string, unknown>) => ({ ...BODY, findings: [{ ...BODY.findings[0], ...patch }] })

describe('F7.4 G7: opaque doctor_uid and encounter_id in governance', () => {
  it('accepts both ids at top level', () => {
    expect(() => assertGovernanceSafe({ ...BODY, doctor_uid: 'D-1042.a:b_c', encounter_id: 'enc:26-10-13.7' })).not.toThrow()
    expect(() => assertGovernanceSafe({ ...BODY, doctor_uid: 'x'.repeat(128) })).not.toThrow()
  })

  it.each([
    ['empty', ''],
    ['129 chars', 'x'.repeat(129)],
    ['space', 'Dr Rao'],
    ['at sign', 'a@b.c'],
    ['slash', 'a/b'],
    ['number', 42],
    ['null', null],
    ['object', { id: 'x' }],
  ])('rejects a bad id value: %s', (_label, value) => {
    expect(() => assertGovernanceSafe({ ...BODY, doctor_uid: value })).toThrow(EmitRefusal)
    expect(() => assertGovernanceSafe({ ...BODY, encounter_id: value })).toThrow(EmitRefusal)
  })

  it.each(['patient_name', 'uhid', 'individual_uid', 'phone', 'email', 'name', 'patient_id', 'doctor_name'])(
    'rejects identifier-like key %s at top level, in a finding, and in finding meta',
    (key) => {
      expect(() => assertGovernanceSafe({ ...BODY, [key]: 'abc' })).toThrow(EmitRefusal)
      expect(() => assertGovernanceSafe(withFinding({ [key]: 'abc' }))).toThrow(EmitRefusal)
      expect(() => assertGovernanceSafe(withFinding({ meta: { [key]: 'abc' } }))).toThrow(EmitRefusal)
    },
  )

  it('rejects the two ids inside a finding or its meta (top level only)', () => {
    for (const key of ['doctor_uid', 'encounter_id']) {
      expect(() => assertGovernanceSafe(withFinding({ [key]: 'abc' }))).toThrow(EmitRefusal)
      expect(() => assertGovernanceSafe(withFinding({ meta: { [key]: 'abc' } }))).toThrow(EmitRefusal)
    }
  })

  it('only the agent sets them, from its input, and bad values are left off', async () => {
    const withIds = (ids: unknown) => ({ ...exampleEcho, identity: () => ids }) as never
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run(CONVERSATION, {}, withIds({ doctor_uid: 'doc-17', encounter_id: 'enc-9' }))
    expect(audit).toMatchObject({ doctor_uid: 'doc-17', encounter_id: 'enc-9' })
    const bad = await (await harness([reply([GOOD_FACT])])).run(CONVERSATION, {}, withIds({ doctor_uid: 'Dr Rao', encounter_id: 7 }))
    expect('doctor_uid' in bad).toBe(false)
    expect('encounter_id' in bad).toBe(false)
    const none = await (await harness([reply([GOOD_FACT])])).run()
    expect('doctor_uid' in none).toBe(false)
    const input = { ...exampleEcho, identity: (i: typeof CONVERSATION) => ({ encounter_id: `enc-${i.segments.length}` }) } as never
    expect(await (await harness([reply([GOOD_FACT])])).run(CONVERSATION, {}, input)).toMatchObject({ encounter_id: 'enc-2' })
  })

  it('never emits them in doctor, operator or internal bodies', async () => {
    const def = { ...exampleEcho, audiences: ['internal', 'operator', 'doctor'], doctorVisible: 'policy', identity: () => ({ doctor_uid: 'doc-zz-17', encounter_id: 'enc-zz-9' }) }
    const h = await harness([reply([GOOD_FACT])])
    const audit = (await h.run(CONVERSATION, { audience: 'doctor' }, def as never)) as InternalAudit
    expect(audit.doctor_uid).toBe('doc-zz-17')
    for (const audience of ['doctor', 'operator', 'internal'] as const) {
      const text = JSON.stringify(serialize(audit, audience))
      expect(text).not.toContain('doc-zz-17')
      expect(text).not.toContain('enc-zz-9')
      expect(text).not.toContain('doctor_uid')
      expect(text).not.toContain('encounter_id')
    }
  })
})
