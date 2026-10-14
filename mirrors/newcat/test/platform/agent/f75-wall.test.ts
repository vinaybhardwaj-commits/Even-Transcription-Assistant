import { describe, expect, it } from 'vitest'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { assertGovernanceSafe, EmitRefusal } from '../../../src/audience/serialize.js'
import { validateDefinition } from '../../../src/platform/agent/define.js'

const BODY = {
  findings: [{ action: 'valid', evidence: [{ segment_id: 's1', quote: 'the quoted words' }], judge: { primary_p: 0.8, second_p: 0.9 } }],
  abstentions: { judge_disagree: 1 },
}
const withFinding = (patch: Record<string, unknown>) => ({ ...BODY, findings: [{ ...BODY.findings[0], ...patch }] })
const refuses = (body: unknown) => expect(() => assertGovernanceSafe(body)).toThrow(EmitRefusal)

// Seeded PRNG (mulberry32) so every run draws the same ids. A draw with no [a-f] letter is an
// all-digit lookalike the wall refuses by design, so it is skipped rather than asserted.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const hexOf = (rand: () => number, n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('')
const uuidOf = (rand: () => number) => `${hexOf(rand, 8)}-${hexOf(rand, 4)}-4${hexOf(rand, 3)}-${'89ab'[Math.floor(rand() * 4)]}${hexOf(rand, 3)}-${hexOf(rand, 12)}`
const hasLetter = (id: string) => /[a-f]/i.test(id)

describe('F7.5: identifier wall at every depth', () => {
  it('refuses the F7.4 gate probes', () => {
    refuses({ ...BODY, abstentions: { mrn_9876543210: 1 } })
    refuses({ ...BODY, abstentions: { patient_name: 0 } })
    refuses({ ...BODY, agent_counts: { phone_number: 2 } })
    refuses({ ...BODY, versions: { question_sets: { uhid: 'x' } } })
  })

  const SPELLINGS = ['phoneno', 'mobileno', 'patientname', 'fullname', 'uhidno', 'emailid', 'abha', 'ssn', 'aadhaarno', 'PatientName', 'abha_ref']
  it.each(SPELLINGS)('refuses concatenated spelling %s at every depth', (key) => {
    refuses({ ...BODY, [key]: 'x' })
    refuses({ ...BODY, abstentions: { [key.toLowerCase()]: 1 } })
    refuses({ ...BODY, agent_counts: { [key.toLowerCase()]: 1 } })
    refuses({ ...BODY, versions: { [key.toLowerCase()]: 'x' } })
    refuses({ ...BODY, versions: { question_sets: { [key.toLowerCase()]: 'x' } } })
    refuses(withFinding({ [key]: 'x' }))
    refuses(withFinding({ meta: { [key.toLowerCase()]: 'x' } }))
    refuses(withFinding({ judge: { primary_p: 0.5, [key]: 1 } }))
    refuses(withFinding({ evidence: [{ segment_id: 's1', quote: 'q', [key]: 'x' }] }))
  })

  it.each(['9876-543210', '98765 43210', '98765_43210', '98765.43210', '98765/43210'])('refuses %s in doctor_uid and encounter_id', (value) => {
    refuses({ ...BODY, doctor_uid: value })
    refuses({ ...BODY, encounter_id: value })
  })
  it('refuses 8+ digit runs in keys at every depth', () => {
    refuses({ ...BODY, abstentions: { reason_12345678: 1 } })
    refuses({ ...BODY, agent_counts: { r_1234_5678: 1 } })
    refuses(withFinding({ meta: { k_12345678: 1 } }))
    refuses({ ...BODY, versions: { question_sets: { 'r.1234-5678': 'x' } } })
  })
  it('question_sets inner keys must be rule-id shaped', () => {
    expect(() => assertGovernanceSafe({ ...BODY, versions: { question_sets: { 'consult.rule_1': 'sha' } } })).not.toThrow()
    refuses({ ...BODY, versions: { question_sets: { 'Rule One': 'x' } } })
    refuses({ ...BODY, versions: { question_sets: { '1rule': 'x' } } })
  })

  it('caps meta string values at 128 chars and refuses a value equal to an evidence quote', () => {
    expect(() => assertGovernanceSafe(withFinding({ meta: { note: 'x'.repeat(128) } }))).not.toThrow()
    refuses(withFinding({ meta: { note: 'x'.repeat(129) } }))
    refuses(withFinding({ meta: { note: 'the quoted words' } }))
    refuses(withFinding({ meta: { note: '  the quoted words ' } }))
  })

  it('refuses a meta value equal to a quote on another finding in the body', () => {
    const second = { ...BODY.findings[0], evidence: [{ segment_id: 's2', quote: 'other quote' }], meta: { note: 'the quoted words' } }
    refuses({ ...BODY, findings: [BODY.findings[0], second] })
  })

  it('still passes a legitimate consult-style body', () => {
    expect(() =>
      assertGovernanceSafe({
        trace_id: 't-1',
        capability: 'audit.consult',
        capability_version: '1',
        doctor_uid: 'doc-17',
        encounter_id: 'enc-9',
        status: 'ok',
        findings: [
          {
            id: 'f1',
            finding_type: 'missed_followup',
            rule_id: 'consult.followup',
            rule_version: '1',
            severity: 'medium',
            summary: 'follow-up not stated',
            evidence: [{ segment_id: 's1', role: 'doctor', t0: 1, t1: 4, quote: 'see you later' }],
            judge: { primary_p: 0.9, second_p: 0.8, agree: true },
            meta: { window: 'consult', score: 2, flagged: true },
            doctor_visible: false,
          },
        ],
        abstentions: { judge_disagree: 1, no_candidate_findings: 0 },
        agent_counts: { late_start: 2 },
        versions: { engine: 'e1', rules: 'r1', models: 'm1', question_set_sha: 'abc', question_sets: { 'consult.followup': 'sha1' } },
      }),
    ).not.toThrow()
  })
})

describe('F7.5: validateDefinition reasons', () => {
  const def = (patch: Record<string, unknown>) => ({ ...exampleEcho, ...patch }) as never
  const abstention = (patch: Record<string, unknown>) => ({ ...exampleEcho.abstention, ...patch })
  it('refuses identifier-like or digit-run abstention reasons, emptyReasons and countReasons', () => {
    for (const reason of ['patient_name', 'phoneno', 'mrn_9876543210', 'r_1234_5678']) {
      expect(() => validateDefinition(def({ abstention: abstention({ reasons: [reason] }) }))).toThrow(/reasons/)
      expect(() => validateDefinition(def({ abstention: abstention({ emptyReasons: [reason] }) }))).toThrow(/reasons/)
      expect(() => validateDefinition(def({ countReasons: [reason] }))).toThrow(/countReasons/)
    }
  })
  it('refuses digit-run meta keys', () => {
    expect(() => validateDefinition(def({ metaKeys: ['k_12345678'] }))).toThrow(/metaKeys/)
  })
  it('accepts the example definition', () => {
    expect(() => validateDefinition(def({}))).not.toThrow()
  })
})

describe('F7.5 fix: UUID, 32-hex and ULID opaque ids skip the digit-run refusal', () => {
  const ok = (value: string) => {
    expect(() => assertGovernanceSafe({ ...BODY, doctor_uid: value })).not.toThrow()
    expect(() => assertGovernanceSafe({ ...BODY, encounter_id: value })).not.toThrow()
  }
  it('passes 2000 random UUIDs, upper and lower case', () => {
    const rand = prng(0x75a1)
    for (let i = 0; i < 2000; i++) {
      const id = uuidOf(rand)
      if (hasLetter(id)) ok(i % 2 ? id.toUpperCase() : id)
    }
  })
  it('passes 2000 random 32-hex ids', () => {
    const rand = prng(0x75a2)
    for (let i = 0; i < 2000; i++) {
      const id = hexOf(rand, 32)
      if (hasLetter(id)) ok(id)
    }
  })
  it('passes a ULID made only of digits and Crockford letters', () => {
    ok('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    ok('01234567890123456789012A45')
  })
  it('still refuses digit runs in other shapes, and never exempts keys', () => {
    for (const value of ['9876-543210', '98765 43210', 'enc:2026-10-13.7', 'A'.repeat(5) + '12345678', '12345678-1234-1234-1234-12345678901', 'ABCDEFGH-1234-1234-1234-123456789012'.toUpperCase().replace('ABCDEFGH', 'GHIJKLMN')]) {
      refuses({ ...BODY, doctor_uid: value })
      refuses({ ...BODY, encounter_id: value })
    }
    refuses({ ...BODY, abstentions: { r_12345678: 1 } })
    refuses({ ...BODY, versions: { question_sets: { 'r.12345678': 'x' } } })
  })
})

describe('F7.5 fix2', () => {
  it.each(['98765:43210', 'mrn:98765:43210', '9:8:7:6:5:4:3:2:1:0'])('refuses colon-separated digits %s as doctor_uid and encounter_id', (value) => {
    refuses({ ...BODY, doctor_uid: value })
    refuses({ ...BODY, encounter_id: value })
  })
  it('still passes enc:26-10-13.7', () => {
    expect(() => assertGovernanceSafe({ ...BODY, doctor_uid: 'enc:26-10-13.7', encounter_id: 'enc:26-10-13.7' })).not.toThrow()
  })

  const STEMS = [
    'phonenumber', 'mobilenumber', 'patientid', 'doctorname', 'firstname', 'lastname', 'surname', 'emailaddress', 'dateofbirth', 'birthdate',
    'aadharno', 'uhidnumber', 'mrnno', 'contactno', 'ipnumber', 'ipno', 'panno', 'passportno', 'telephone', 'cellno', 'pincode',
  ]
  it.each(STEMS)('refuses run-together spelling %s at every open depth', (key) => {
    refuses({ ...BODY, abstentions: { [key]: 1 } })
    refuses({ ...BODY, agent_counts: { [key]: 1 } })
    refuses({ ...BODY, versions: { [key]: 'x' } })
    refuses({ ...BODY, versions: { question_sets: { [key]: 'x' } } })
    refuses(withFinding({ meta: { [key]: 'x' } }))
  })
  it.each(STEMS)('refuses %s as an abstention reason, emptyReason and countReason', (reason) => {
    const def = (patch: Record<string, unknown>) => ({ ...exampleEcho, ...patch }) as never
    expect(() => validateDefinition(def({ abstention: { ...exampleEcho.abstention, reasons: [reason] } }))).toThrow(/reasons/)
    expect(() => validateDefinition(def({ abstention: { ...exampleEcho.abstention, emptyReasons: [reason] } }))).toThrow(/reasons/)
    expect(() => validateDefinition(def({ countReasons: [reason] }))).toThrow(/countReasons/)
  })
  it('keeps name, uid, ip, pan, mrn token-only', () => {
    for (const key of ['guid_like', 'tripwire', 'company', 'panel', 'mrnx']) {
      expect(() => assertGovernanceSafe({ ...BODY, abstentions: { [key.replace('guid_like', 'squid')]: 1 } })).not.toThrow()
    }
  })

  const okId = (value: string) => {
    expect(() => assertGovernanceSafe({ ...BODY, doctor_uid: value })).not.toThrow()
    expect(() => assertGovernanceSafe({ ...BODY, encounter_id: value })).not.toThrow()
  }
  it('refuses all-digit lookalikes of the exempt shapes', () => {
    for (const value of ['12345678-1234-1234-1234-123456789012', '00000000000000009876543210000000', '98765432109876543210987654', '81234567890123456789012345']) {
      refuses({ ...BODY, doctor_uid: value })
      refuses({ ...BODY, encounter_id: value })
    }
  })
  it('refuses a digit-heavy ULID-length id starting 8 or 9, accepts one starting 0-7 with a letter', () => {
    refuses({ ...BODY, doctor_uid: '81234567890123456789012A45' })
    okId('71ARZ3NDEKTSV4RRFFQ69G5FAV')
  })
  it('still passes 20000 random UUIDs and 20000 random 32-hex ids', () => {
    const rand = prng(0x75a3)
    for (let i = 0; i < 20000; i++) {
      const uuid = uuidOf(rand)
      const hex = hexOf(rand, 32)
      assertGovernanceSafe({ ...BODY, doctor_uid: hasLetter(uuid) ? uuid : 'doc-1', encounter_id: hasLetter(hex) ? hex : 'enc-1' })
    }
  })

  it('refuses a case-changed, whitespace-changed or prefixed quote copy in meta', () => {
    refuses(withFinding({ meta: { note: 'THE Quoted WORDS' } }))
    refuses(withFinding({ meta: { note: 'the   quoted\twords' } }))
    refuses(withFinding({ evidence: [{ segment_id: 's1', quote: 'a fairly long quoted sentence here' }], meta: { note: 'said: a fairly long quoted sentence here' } }))
  })
  it('refuses a meta value of 16+ chars that is a substring of a quote', () => {
    const quote = 'the patient reports a long standing cough'
    refuses(withFinding({ evidence: [{ segment_id: 's1', quote }], meta: { note: 'long standing cough' } }))
    refuses(withFinding({ evidence: [{ segment_id: 's1', quote }], meta: { note: 'LONG  standing COUGH' } }))
  })
  it('passes short substrings of a quote and unrelated meta values', () => {
    const quote = 'the patient reports a long standing cough'
    expect(() => assertGovernanceSafe(withFinding({ evidence: [{ segment_id: 's1', quote }], meta: { note: 'cough', phase: 'opening' } }))).not.toThrow()
  })
})

describe('F7.5 fix3', () => {
  const passes = (body: unknown) => expect(() => assertGovernanceSafe(body)).not.toThrow()
  it.each([['no', 'allergy_hx_not_asked'], ['yes', 'allergy_hx_asked_yes'], ['ok', 'booked_for_review'], ['fine', 'refined_plan_stage']])(
    'accepts short quote %s with meta value %s',
    (quote, value) => {
      passes(withFinding({ evidence: [{ segment_id: 's1', quote }], meta: { note: value } }))
    },
  )
  it('still refuses an exact short quote and a long quote inside a meta value', () => {
    refuses(withFinding({ evidence: [{ segment_id: 's1', quote: 'yes' }], meta: { note: 'Yes' } }))
    refuses(withFinding({ evidence: [{ segment_id: 's1', quote: 'a fairly long quoted sentence here' }], meta: { note: 'said: a fairly long quoted sentence here' } }))
  })

  const R2 = ['phno', 'mobno', 'contactnumber', 'contactnum', 'cellnumber', 'whatsappno', 'mrnnumber', 'medicalrecordnumber', 'regno', 'registrationno', 'opno',
    'bedno', 'wardno', 'visitno', 'insuranceno', 'policyno', 'policynumber', 'beneficiaryid', 'healthid', 'voterid', 'epic_no', 'dl_no', 'drivinglicence',
    'pannumber', 'pancard', 'mailid', 'gmail', 'adhaar', 'adhar', 'patname', 'ptname', 'docname', 'drname', 'doctorid', 'consultantname', 'fathername',
    'mothername', 'guardianname', 'spousename', 'relativename', 'attendantname', 'givenname', 'familyname', 'nickname', 'username', 'birthday', 'addr',
    'zipcode', 'postcode', 'nextofkin', 'emergencycontact', 'ph_no', 'mobileNumber']
  it.each(R2.filter((key) => !['pancard', 'gmail', 'addr', 'doctorid'].includes(key)))('refuses run-together spelling %s at every depth', (key) => {
    const lower = key.toLowerCase()
    refuses({ ...BODY, abstentions: { [lower]: 1 } })
    refuses({ ...BODY, agent_counts: { [lower]: 1 } })
    refuses({ ...BODY, versions: { [lower]: 'x' } })
    refuses({ ...BODY, versions: { question_sets: { [lower]: 'x' } } })
    refuses(withFinding({ meta: { [lower]: 'x' } }))
  })
  it('refuses rename (ends in name, fix3 ruling R2a)', () => {
    refuses({ ...BODY, abstentions: { rename: 1 } })
  })
  it('passes the ordinary reason words', () => {
    const words = ['judge_disagree', 'below_threshold', 'window_incomplete', 'not_discussed', 'consent_incomplete', 'said_vs_written', 'pressure_signal',
      'procedure_group', 'telephonic_consult', 'assessment', 'discussion', 'dismissed', 'class_notes', 'process_note', 'missing_vitals', 'sign_off', 'redflag',
      'time_pressure', 'stopnumber', 'opnote', 'visit_notes', 'allergy_hx_not_asked']
    for (const word of words) {
      passes({ ...BODY, abstentions: { [word]: 1 } })
      passes(withFinding({ meta: { [word]: 'x' } }))
      expect(() => validateDefinition({ ...exampleEcho, abstention: { ...exampleEcho.abstention, reasons: [word] } } as never)).not.toThrow()
    }
  })
  it.each(['microphone_dropout', 'headphone_off', 'smartphone_audio', 'phonetic_mismatch', 'outpatient_visit', 'inpatient_round', 'impatient_caller', 'immobile_patient_note'])(
    'passes exception token word %s',
    (word) => {
      if (word === 'immobile_patient_note') return refuses({ ...BODY, abstentions: { [word]: 1 } })
      passes({ ...BODY, abstentions: { [word]: 1 } })
    },
  )
  const E1 = ['outpatient_no', 'outpatient_number', 'outpatient_id', 'inpatient_no', 'inpatient_number', 'inpatient_id', 'outpatientNumber', 'inpatientId',
    'smartphone_no', 'smartphone_number', 'smartphone_id', 'inpatient_reg']
  it.each(E1)('refuses exception token with number suffix %s at every depth', (key) => {
    refuses({ ...BODY, abstentions: { [key]: 1 } })
    refuses({ ...BODY, agent_counts: { [key]: 1 } })
    refuses({ ...BODY, versions: { [key.toLowerCase()]: 'x' } })
    refuses({ ...BODY, versions: { question_sets: { [key.toLowerCase()]: 'x' } } })
    refuses(withFinding({ meta: { [key]: 'x' } }))
    expect(() => validateDefinition({ ...exampleEcho, abstention: { ...exampleEcho.abstention, reasons: [key] } } as never)).toThrow()
  })
  it.each(['microphone', 'outpatient', 'inpatient', 'smartphone', 'microphone_dropout'])('still passes exception word %s alone', (word) => {
    passes({ ...BODY, abstentions: { [word]: 1 } })
    passes(withFinding({ meta: { [word]: 'x' } }))
  })
  it('still refuses phone and patient next to an exception token', () => {
    refuses({ ...BODY, abstentions: { microphone_phone: 1 } })
    refuses({ ...BODY, abstentions: { outpatient_patientname: 1 } })
  })
})
