import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ROLES,
  ConsentFact,
  ConsultFacts,
  FACT_GROUPS,
  FactSchemas,
  IndicationFact,
  PatientResponseFact,
  PressureFact,
  RecommendationFact,
  type GatedFact,
} from '../../../src/agents/surgical-consult/facts.js'
import { SURGICAL_CONSULT_FACTS_VERSION, PREPASS_VERSION } from '../../../src/agents/surgical-consult/versions.js'

const q = { quote: 'I recommend repair', segment_id: 'seg-0001' }
const rec = { ...q, rec_id: 'r1', procedure_text: 'hernia repair', laterality: 'right', firmness: 'firm', urgency: 'today' }
const ind = { ...q, rec_ref: null, symptom_duration: '3 years', conservative_tried: { what: 'physio', how_long: '6 weeks' }, imaging_cited: true, exam_cited: false, red_flags: [] }
const con = { ...q, rec_ref: null, risks: true, alternatives: false, no_surgery_option: false, recovery: true, cost: false, second_opinion_offered: false }
const pat = { ...q, rec_ref: null, question_asked: true, hesitation_stated: false, agreement_stated: false, concern_stated: false }
const pre = { ...q, rec_ref: null, decide_today: true, discount_or_package: true, fear_framing: false }

describe('fact schemas', () => {
  it('accepts a valid fact of each group', () => {
    expect(RecommendationFact.safeParse(rec).success).toBe(true)
    expect(IndicationFact.safeParse(ind).success).toBe(true)
    expect(ConsentFact.safeParse(con).success).toBe(true)
    expect(PatientResponseFact.safeParse(pat).success).toBe(true)
    expect(PressureFact.safeParse(pre).success).toBe(true)
  })

  it('rejects bad enums', () => {
    expect(RecommendationFact.safeParse({ ...rec, firmness: 'maybe' }).success).toBe(false)
    expect(RecommendationFact.safeParse({ ...rec, urgency: 'asap' }).success).toBe(false)
    for (const f of ['firm', 'conditional', 'option_mentioned']) expect(RecommendationFact.safeParse({ ...rec, firmness: f }).success).toBe(true)
    for (const u of ['today', 'elective', 'unspecified']) expect(RecommendationFact.safeParse({ ...rec, urgency: u }).success).toBe(true)
  })

  it('requires quote and segment_id, and rejects extra keys', () => {
    expect(RecommendationFact.safeParse({ ...rec, quote: '' }).success).toBe(false)
    expect(RecommendationFact.safeParse({ ...rec, segment_id: '' }).success).toBe(false)
    const { quote: _q, ...noQuote } = rec
    expect(RecommendationFact.safeParse(noQuote).success).toBe(false)
    expect(RecommendationFact.safeParse({ ...rec, role: 'doctor' }).success).toBe(false)
    expect(RecommendationFact.safeParse({ ...rec, t0: 1 }).success).toBe(false)
  })

  it('validates the whole facts payload', () => {
    const ok = { recommendation: [rec], indication: [ind], consent: [con], patient_response: [pat], pressure: [pre] }
    expect(ConsultFacts.safeParse(ok).success).toBe(true)
    expect(ConsultFacts.safeParse({ ...ok, pressure: undefined }).success).toBe(false)
    expect(ConsultFacts.safeParse({ ...ok, extra: [] }).success).toBe(false)
    expect(ConsultFacts.safeParse({ ...ok, consent: [rec] }).success).toBe(false)
  })

  it('has one schema per group', () => {
    expect(Object.keys(FactSchemas).sort()).toEqual([...FACT_GROUPS].sort())
  })

  it('matches the section 4 allowed-role table', () => {
    expect(ALLOWED_ROLES.recommendation).toEqual(['doctor'])
    expect(ALLOWED_ROLES.consent).toEqual(['doctor'])
    expect(ALLOWED_ROLES.pressure).toEqual(['doctor'])
    expect(ALLOWED_ROLES.patient_response).toEqual(['patient', 'attendant'])
    expect([...ALLOWED_ROLES.indication].sort()).toEqual(['attendant', 'doctor', 'patient', 'unknown'])
  })

  it('types a gated fact as fact plus role, t0, t1', () => {
    const gated: GatedFact<'pressure'> = { ...PressureFact.parse(pre), id: 'f1', group: 'pressure', source_id: 's1', role: 'doctor', t0: 1, t1: 2, start: 0, end: 5 }
    expect(gated.role).toBe('doctor')
  })

  it('stamps versions', () => {
    expect(SURGICAL_CONSULT_FACTS_VERSION).toBe('sc-facts/0.1.0')
    expect(PREPASS_VERSION).toBe('sc-prepass/0.1.0')
  })
})
