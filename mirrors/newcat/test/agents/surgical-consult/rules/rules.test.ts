import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { FactGroup, GatedFact } from '../../../../src/agents/surgical-consult/facts.js'
import { ConsultAuditInput } from '../../../../src/agents/surgical-consult/input.js'
import { prepass } from '../../../../src/agents/surgical-consult/prepass.js'
import { segmentId } from '../../../../src/agents/surgical-consult/definition.js'
import type { RuleOutput } from '../../../../src/platform/agent/types.js'
import { consultContext } from '../../../../src/agents/surgical-consult/segments.js'
import { INDICATION_RULES, dedupeKey, runRules, RULE_CAPS, RULE_SPECS, MAX_CANDIDATES, type GatedFacts } from '../../../../src/agents/surgical-consult/rules/index.js'
import { effectiveFirmness, saidVsWrittenRules } from '../../../../src/agents/surgical-consult/rules/said-vs-written.js'
import { procedureGroup } from '../../../../src/agents/surgical-consult/procedure-groups.js'
import { RULES_VERSION } from '../../../../src/agents/surgical-consult/versions.js'

const load = (name: string) => ConsultAuditInput.parse(JSON.parse(readFileSync(`fixtures/surgical-consult/${name}.json`, 'utf8')))
type Input = ReturnType<typeof load>

const empty = (): GatedFacts => ({ recommendation: [], indication: [], consent: [], patient_response: [], pressure: [] })

// Stamps segment id, role, t0, t1 and quote from the pre-pass turn, as the platform gate would. Turn ids in the
// fixtures map to segment ids by pre-pass position.
function fact<G extends FactGroup>(
  input: Input,
  group: G,
  turnId: string,
  fields: Omit<GatedFact<G>, 'id' | 'group' | 'source_id' | 'start' | 'end' | 'quote' | 'segment_id' | 'role' | 't0' | 't1'>,
  roleOverride?: GatedFact['role'],
): GatedFact<G> {
  const turns = prepass(input).turns
  const i = turns.findIndex((x) => x.id === turnId)
  const t = turns[i]!
  const seg = segmentId(i)
  return {
    id: `${group}-${seg}-${JSON.stringify(fields).length}`,
    group,
    source_id: 's1',
    start: 0,
    end: t.text_en.length,
    quote: t.text_en,
    segment_id: seg,
    role: roleOverride ?? t.role,
    t0: t.t0,
    t1: t.t1,
    ...fields,
  } as unknown as GatedFact<G>
}
const rec = (input: Input, turn: string, procedure_text: string, firmness: 'firm' | 'conditional' | 'option_mentioned' = 'firm', role?: GatedFact['role']) =>
  fact(input, 'recommendation', turn, { rec_id: 'r1', procedure_text, laterality: 'right', firmness, urgency: 'elective' }, role)
const consent = (input: Input, turn: string, on: Partial<Record<'risks' | 'alternatives' | 'no_surgery_option' | 'recovery' | 'cost' | 'second_opinion_offered', boolean>>, role?: GatedFact['role']) =>
  fact(input, 'consent', turn, { rec_ref: null, risks: false, alternatives: false, no_surgery_option: false, recovery: false, cost: false, second_opinion_offered: false, ...on }, role)
const pressure = (input: Input, turn: string, on: Partial<Record<'decide_today' | 'discount_or_package' | 'fear_framing', boolean>>, role?: GatedFact['role']) =>
  fact(input, 'pressure', turn, { rec_ref: null, decide_today: false, discount_or_package: false, fear_framing: false, ...on }, role)
const resp = (input: Input, turn: string, on: Partial<Record<'question_asked' | 'hesitation_stated' | 'agreement_stated' | 'concern_stated', boolean>>) =>
  fact(input, 'patient_response', turn, { rec_ref: null, question_asked: false, hesitation_stated: false, agreement_stated: false, concern_stated: false, ...on })

const run = (input: Input, facts: GatedFacts) => runRules(facts, input.rx, true)
const types = (r: ReturnType<typeof run>) => [...new Set(r.findings.map((f) => f.finding_type))].sort()
const ids = (r: ReturnType<typeof run>) => r.findings.map((f) => f.rule_id).sort()
const only = (r: ReturnType<typeof run>, type: string) => r.findings.filter((f) => f.finding_type === type)

function herniaFacts(input: Input, withRisks: boolean): GatedFacts {
  const f = empty()
  f.recommendation.push(rec(input, '1', 'hernia repair'))
  f.consent.push(consent(input, '3', { risks: withRisks, alternatives: true }))
  f.consent.push(consent(input, '4', { recovery: true, second_opinion_offered: true, no_surgery_option: true }))
  f.consent.push(consent(input, '5', { cost: true }))
  return f
}

describe('consent', () => {
  it('full consent produces no consent finding', () => {
    const input = load('hernia-full-consent')
    expect(ids(run(input, herniaFacts(input, true)))).toEqual([])
  })

  it('metamorphic: deleting the risk sentence makes consent_incomplete(risks) appear', () => {
    const input = load('hernia-full-consent')
    const r = run(input, herniaFacts(input, false))
    expect(ids(r)).toEqual(['consent.risks'])
    expect(r.findings[0]).toMatchObject({ finding_type: 'consent_incomplete', procedure_group: 'hernia_repair', rule_version: RULES_VERSION, needs_judge: true, doctor_visible: false })
    expect(r.findings[0]!.evidence[0]).toMatchObject({ segment_id: 'seg-0001', role: 'doctor' })
  })

  it('one finding per missing element', () => {
    const input = load('knee-replacement-missing-consent')
    const f = empty()
    f.recommendation.push(rec(input, '1', 'right knee replacement'))
    f.consent.push(consent(input, '3', { recovery: true }))
    expect(ids(run(input, f))).toEqual(['consent.alternatives', 'consent.cost', 'consent.no_surgery_option', 'consent.risks', 'consent.second_opinion_offered'])
  })

  it('incomplete window: the completeness hook stops the run before any rule (no rule-level window abstention)', () => {
    const input = load('incomplete-window')
    expect(prepass(input).complete).toBe(false)
  })

  it('no recommendation: nothing, not even an abstention', () => {
    const input = load('no-surgery-recommended')
    const r = run(input, empty())
    expect(r.findings).toEqual([])
    expect(r.abstention_counts).toEqual({})
  })

  it('metamorphic: swapping roles drops role-gated consent findings', () => {
    const input = load('hernia-full-consent')
    const f = herniaFacts(input, false)
    f.recommendation = [rec(input, '1', 'hernia repair', 'firm', 'patient')]
    expect(only(run(input, f), 'consent_incomplete')).toEqual([])
    const g = herniaFacts(input, false)
    g.consent = g.consent.map((c) => ({ ...c, role: 'patient' as const }))
    expect(ids(run(input, g))).toContain('consent.alternatives')
  })

  it('metamorphic: paraphrased doctor turns with unchanged facts give the same finding types', () => {
    const input = load('hernia-full-consent')
    const para: Input = { ...input, turns: input.turns.map((t) => (t.role === 'doctor' ? { ...t, text_en: `Rephrased: ${t.text_en.toLowerCase()}` } : t)) }
    expect(types(run(para, herniaFacts(para, false)))).toEqual(types(run(input, herniaFacts(input, false))))
  })
})

describe('pressure', () => {
  it('metamorphic: adding a decide-today fact yields pressure_signal', () => {
    const input = load('hernia-full-consent')
    const f = herniaFacts(input, true)
    expect(types(run(input, f))).toEqual([])
    f.pressure.push(pressure(input, '1', { decide_today: true }))
    expect(types(run(input, f))).toEqual(['pressure_signal'])
  })

  it('one finding per flag, doctor role only', () => {
    const input = load('decide-today-package')
    const f = empty()
    f.pressure.push(pressure(input, '2', { decide_today: true, discount_or_package: true }))
    f.pressure.push(pressure(input, '4', { fear_framing: true }))
    expect(only(run(input, f), 'pressure_signal').map((x) => x.rule_id).sort()).toEqual(['pressure.decide_today', 'pressure.discount_or_package', 'pressure.fear_framing'])
    const swapped = empty()
    swapped.pressure.push(pressure(input, '2', { decide_today: true }, 'patient'))
    expect(only(run(input, swapped), 'pressure_signal')).toEqual([])
  })
})

// svw rules read rx from the rule context in the definition; here they are exercised with rx passed in directly.
const runSvw = (input: Input, f: GatedFacts) => runRules(f, input.rx ?? null, true)
describe('said-vs-written', () => {
  it('abstains with no_rx', () => {
    const input = { ...load('hernia-full-consent'), rx: null }
    const f = empty()
    f.recommendation.push(rec(input, '1', 'hernia repair'))
    expect(saidVsWrittenRules(f, null)).toEqual([{ abstain: 'no_rx', rule_id: 'svw.all' }])
    expect(runRules(f, null, true).abstention_counts).toEqual({ no_rx: 1 })
  })

  it('flags a group that differs from rx', () => {
    const input = load('hernia-full-consent')
    const f = empty()
    f.recommendation.push(rec(input, '1', 'right knee replacement'))
    expect(ids(runSvw(input, f))).toContain('svw.group_differs')
  })

  it('same group is clean', () => {
    const input = load('hernia-full-consent')
    const f = empty()
    f.recommendation.push(rec(input, '1', 'inguinal hernia repair'))
    expect(ids(runSvw(input, f)).filter((i) => i.startsWith('svw'))).toEqual([])
  })

  it('flags rx.requires_surgery=false with firm spoken firmness, but not conditional', () => {
    const input = { ...load('hernia-full-consent'), rx: { requires_surgery: false, procedure_text: 'hernia repair' } }
    const firm = empty()
    firm.recommendation.push(rec(input, '1', 'hernia repair', 'firm'))
    expect(ids(runSvw(input, firm))).toContain('svw.rx_no_surgery_but_firm')
    const cond = empty()
    cond.recommendation.push(rec(input, '1', 'hernia repair', 'conditional'))
    expect(ids(runSvw(input, cond)).filter((i) => i.startsWith('svw'))).toEqual([])
  })

  it('generic-indication quote downgrades firm to conditional, and never upgrades', () => {
    const q = (firmness: 'firm' | 'conditional' | 'option_mentioned', quote: string) => effectiveFirmness({ firmness, quote })
    expect(q('firm', 'Surgery should be considered if the pain persists')).toBe('conditional')
    expect(q('firm', 'You need a hernia repair')).toBe('firm')
    expect(q('option_mentioned', 'You need a hernia repair')).toBe('option_mentioned')
    expect(q('conditional', 'You need a hernia repair')).toBe('conditional')
  })

  it('rx says surgery but none was spoken: a count only (no fact to cite as evidence)', () => {
    const input = load('no-surgery-recommended')
    const withRx: Input = { ...input, rx: { requires_surgery: true, procedure_text: 'hernia repair' } }
    const r = runSvw(withRx, empty())
    expect(r.findings).toEqual([])
    expect(r.not_discussed_counts['svw.rx_surgery_not_spoken']).toBe(1)
  })

  it('uses the English procedure_text, so native text cannot change the group', () => {
    const input = load('hernia-full-consent')
    const f = empty()
    f.recommendation.push({ ...rec(input, '1', 'hernia repair'), quote: 'हर्निया का ऑपरेशन' })
    expect(ids(runSvw(input, f)).filter((i) => i.startsWith('svw'))).toEqual([])
  })
})

describe('patient concern', () => {
  it('every concern is a candidate, carrying the facts of the next 3 doctor segments as evidence', () => {
    const input = load('hernia-full-consent')
    const f = herniaFacts(input, true)
    f.recommendation = []
    f.patient_response.push(resp(input, '2', { question_asked: true }))
    const c = only(run(input, f), 'concern_unaddressed')
    expect(c).toHaveLength(1)
    expect(c[0]!.evidence.map((e) => e.segment_id)).toEqual(['seg-0002', 'seg-0003', 'seg-0004', 'seg-0005'])
    expect(c[0]!.fact_refs).toHaveLength(4)
    expect(c[0]!.claim).toBe('The doctor did not address this patient concern in the consult.')
    const g = empty()
    g.patient_response.push(resp(input, '6', { concern_stated: true }))
    const r = only(run(input, g), 'concern_unaddressed')
    expect(r).toHaveLength(1)
    expect(r[0]!.evidence).toHaveLength(1)
    expect(r[0]).toMatchObject({ finding_type: 'concern_unaddressed', needs_judge: true, doctor_visible: false })
  })

  it('agreement alone is not a concern', () => {
    const input = load('hernia-full-consent')
    const f = empty()
    f.patient_response.push(resp(input, '6', { agreement_stated: true }))
    expect(only(run(input, f), 'concern_unaddressed')).toEqual([])
  })
})

describe('indication rules (predicates unwritten, I2c)', () => {
  const base = () => {
    const input = load('hernia-full-consent')
    const f = empty()
    f.recommendation.push(rec(input, '1', 'circumcision'))
    return { input, f }
  }
  const ind = (input: Input, red_flags: string[], role?: GatedFact['role'], conservative_tried: { what: string; how_long: string | null } | null = null) =>
    fact(input, 'indication', '2', { rec_ref: null, symptom_duration: null, conservative_tried, imaging_cited: false, exam_cited: false, red_flags }, role)
  // Everything the plumbing needs to run check(): enabled, verbatim-checked citation, signed predicate.
  const forceSigned = (r: (typeof INDICATION_RULES)[number]) => ({
    ...r,
    enabled: true,
    predicate_status: 'signed' as const,
    citation: r.citation && { primary: { ...r.citation.primary, verbatim_checked: true }, supporting: r.citation.supporting.map((s) => ({ ...s, verbatim_checked: true })) },
  })
  const gaps = (r: ReturnType<typeof run>) => r.findings.filter((x) => x.finding_type === 'indication_gap')

  it('all rules ship disabled, unwritten and unchecked; disabled rules yield only not_discussed counts', () => {
    expect(INDICATION_RULES).toHaveLength(6)
    for (const r of INDICATION_RULES) {
      expect(r.enabled).toBe(false)
      expect(r.predicate_status).toBe('unwritten')
      if (r.citation) expect([r.citation.primary, ...r.citation.supporting].every((c) => c.verbatim_checked === false)).toBe(true)
    }
    const { input, f } = base()
    const r = run(input, f)
    expect(gaps(r)).toEqual([])
    expect(r.not_discussed_counts['indication.circumcision.v0']).toBe(1)
    expect(Object.keys(r.not_discussed_counts).filter((k) => k.startsWith('indication.'))).toHaveLength(6)
  })

  it('(a) enabled + verbatim_checked but predicate_status unwritten: counted only', () => {
    const { input, f } = base()
    const rules = INDICATION_RULES.map((r) => ({ ...forceSigned(r), predicate_status: 'unwritten' as const }))
    let called = 0
    const spied = rules.map((r) => ({ ...r, check: () => (called++, r.check(f)) }))
    const r = runRules(f, input.rx, true, spied)
    expect(called).toBe(0)
    expect(gaps(r)).toEqual([])
    expect(r.not_discussed_counts['indication.circumcision.v0']).toBe(1)
  })

  it('an enabled rule with an unchecked or null citation is counted only', () => {
    const { input, f } = base()
    const unchecked = INDICATION_RULES.map((r) => ({ ...r, enabled: true, predicate_status: 'signed' as const }))
    expect(gaps(runRules(f, input.rx, true, unchecked))).toEqual([])
    const nulled = INDICATION_RULES.map((r) => ({ ...forceSigned(r), citation: null }))
    expect(gaps(runRules(f, input.rx, true, nulled))).toEqual([])
  })

  it('(b) refuter break cases all give not_discussed even when fully "signed"', () => {
    const cases: { name: string; rec: string; facts: (input: Input) => GatedFact<'indication'>[] }[] = [
      { name: 'cross-fact BXO', rec: 'circumcision', facts: (i) => [ind(i, ['ballooning']), ind(i, ['BXO on examination'])] },
      { name: 'refractory phimosis', rec: 'circumcision', facts: (i) => [ind(i, ['ballooning'], undefined, { what: 'steroid cream', how_long: '3 months' })] },
      { name: 'patient role', rec: 'circumcision', facts: (i) => [ind(i, ['ballooning'], 'patient')] },
      { name: 'stone not passed', rec: 'ureteroscopy for ureteric stone', facts: (i) => [ind(i, ['stone has not passed']), ind(i, ['ureteric stone, not yet passed'])] },
      { name: 'stent removal after passed stone', rec: 'DJ stent removal', facts: (i) => [ind(i, ['stone passed'])] },
      { name: 'patient says stone passed', rec: 'ureteroscopy for ureteric stone', facts: (i) => [ind(i, ['the stone passed last week'], 'patient')] },
    ]
    for (const c of cases) {
      const input = load('hernia-full-consent')
      const f = empty()
      f.recommendation.push(rec(input, '1', c.rec))
      f.indication.push(...c.facts(input))
      const r = runRules(f, input.rx, true, INDICATION_RULES.map(forceSigned))
      expect(gaps(r), c.name).toEqual([])
      expect(Object.keys(r.not_discussed_counts).filter((k) => k.startsWith('indication.')), c.name).toHaveLength(6)
    }
  })

  it('check() is pure: a detached call works for every rule', () => {
    const { f } = base()
    for (const r of INDICATION_RULES) {
      const { check } = r
      expect(check(f)).toEqual({ not_discussed: r.rule_id })
    }
  })

  it('circumcision carries a primary citation (3.6) and a supporting one (3.3) on the same url', () => {
    const c = INDICATION_RULES.find((r) => r.group === 'circumcision')!.citation!
    expect(c.primary.section).toBe('3.6 Summary of evidence and recommendations for the management of phimosis')
    expect(c.supporting).toHaveLength(1)
    expect(c.supporting[0]).toMatchObject({ section: '3.3', url: c.primary.url, quoted_passage: 'Simple ballooning of the foreskin during micturition is not an indication for surgery per se.' })
  })

  it('knee degenerative rule: unwritten, carries AAOS primary; acl_ligament never reaches it', () => {
    const k = INDICATION_RULES.find((r) => r.group === 'B_knee_arthroscopy_degenerative')!
    expect(k).toMatchObject({ rule_id: 'indication.knee_arthroscopy_degenerative.v0', enabled: false, predicate_status: 'unwritten' })
    expect(k.citation!.primary.url).toMatch(/^https:\/\/www\.aaos\.org\//)
    let called = 0
    const spied = INDICATION_RULES.map((r) => ({ ...forceSigned(r), check: () => (called++, r.check(empty())) }))
    const input = load('hernia-full-consent')
    const f = empty()
    f.recommendation.push(rec(input, '1', 'acl reconstruction with meniscal repair'))
    const r = runRules(f, input.rx, true, spied)
    expect(called).toBe(0)
    expect(r.not_discussed_counts['indication.knee_arthroscopy_degenerative.v0']).toBe(1)
    const g = empty()
    g.recommendation.push(rec(input, '1', 'arthroscopic partial meniscectomy'))
    runRules(g, input.rx, true, spied)
    expect(called).toBe(1)
  })

  it('consent and said-vs-written run unchanged for both knee groups', () => {
    for (const name of ['arthroscopic partial meniscectomy', 'acl reconstruction with meniscal repair']) {
      const input = load('hernia-full-consent')
      const f = empty()
      f.recommendation.push(rec(input, '1', name))
      f.consent.push(consent(input, '3', { risks: false, alternatives: true }))
      f.consent.push(consent(input, '4', { recovery: true, second_opinion_offered: true, no_surgery_option: true }))
      f.consent.push(consent(input, '5', { cost: true }))
      const r = run(input, f)
      // The fixture's rx is a hernia, so said-vs-written also reports a group mismatch; both rule families ran.
      expect(ids(r), name).toEqual(['consent.risks', 'svw.group_differs'])
      for (const x of r.findings) expect(x.procedure_group, name).toBe(procedureGroup(name))
    }
  })

  it('records which rules have no fetched citation', () => {
    expect(INDICATION_RULES.filter((r) => r.citation === null).map((r) => r.group).sort()).toEqual(['anorectal', 'hernia_repair', 'joint_replacement'])
    for (const r of INDICATION_RULES) if (r.citation && r.group === 'circumcision') expect(r.citation.primary.url).toMatch(/^https:\/\/uroweb\.org\//)
  })
})

describe('dedupe (F3)', () => {
  it('duplicate facts give one finding per (rule_id, procedure_group, fact)', () => {
    const input = load('hernia-full-consent')
    const f = herniaFacts(input, true)
    f.recommendation = [rec(input, '1', 'right knee replacement'), rec(input, '1', 'right knee replacement')]
    f.pressure = [pressure(input, '1', { decide_today: true }), pressure(input, '1', { decide_today: true })]
    f.patient_response = [resp(input, '2', { question_asked: true }), resp(input, '2', { question_asked: true })]
    const r = run(input, f)
    const count = (id: string) => r.findings.filter((x) => x.rule_id === id).length
    expect(count('pressure.decide_today')).toBe(1)
    expect(runSvw(input, f).findings.filter((x) => x.rule_id === 'svw.group_differs')).toHaveLength(1)
    expect(count('concern.unaddressed')).toBe(1)
    const dup = { ...f, recommendation: [rec(input, '1', 'hernia repair', 'firm'), rec(input, '1', 'hernia repair', 'firm')] }
    const input2 = { ...input, rx: { requires_surgery: false, procedure_text: 'hernia repair' } }
    expect(runSvw(input2, dup).findings.filter((x) => x.rule_id === 'svw.rx_no_surgery_but_firm')).toHaveLength(1)
  })

  it('different turns still give separate findings', () => {
    const input = load('decide-today-package')
    const f = empty()
    f.pressure = [pressure(input, '2', { decide_today: true }), pressure(input, '4', { decide_today: true })]
    expect(only(run(input, f), 'pressure_signal')).toHaveLength(2)
  })
})

describe('carry-over 4 and F6 links', () => {
  it('abstentions are counted by reason, not deduped', () => {
    const input = load('hernia-full-consent')
    const f = empty()
    f.recommendation.push(rec(input, '1', 'circumcision'))
    const rules = INDICATION_RULES.map((r) => ({
      ...r,
      enabled: true,
      predicate_status: 'signed' as const,
      citation: r.citation && { primary: { ...r.citation.primary, verbatim_checked: true }, supporting: r.citation.supporting.map((x) => ({ ...x, verbatim_checked: true })) },
      check: () => ({ abstain: 'needs_review', rule_id: r.rule_id }),
    }))
    const circ = rules.filter((r) => r.group === 'circumcision')
    expect(runRules(f, input.rx, true, [...circ, ...circ]).abstention_counts).toEqual({ needs_review: 2 })
  })

  it('the dedupe key includes the procedure group', () => {
    const a = runRules({ ...empty(), recommendation: [rec(load('hernia-full-consent'), '1', 'hernia repair')] }, undefined, true).findings[0]!
    expect(dedupeKey(a)).not.toBe(dedupeKey({ ...a, procedure_group: 'joint_replacement' }))
  })

  it('a consent fact linked to another recommendation does not cover this one', () => {
    const input = load('hernia-full-consent')
    const f = empty()
    f.recommendation.push(rec(input, '1', 'hernia repair'))
    f.recommendation.push({ ...rec(input, '3', 'circumcision'), rec_id: 'r2' })
    f.consent.push({ ...consent(input, '3', { risks: true }), rec_ref: 'r2' })
    const risks = runRules(f, undefined, true).findings.filter((x) => x.rule_id === 'consent.risks')
    expect(risks.map((x) => x.procedure_group)).toEqual(['hernia_repair'])
    f.consent.push({ ...consent(input, '4', { risks: true }), rec_ref: null })
    expect(runRules(f, undefined, true).findings.filter((x) => x.rule_id === 'consent.risks')).toEqual([])
  })

  it('pressure and concern take the group of the recommendation they link to, falling back to the first', () => {
    const input = load('decide-today-package')
    const f = empty()
    f.recommendation.push(rec(input, '1', 'hernia repair'))
    f.recommendation.push({ ...rec(input, '4', 'right knee replacement'), rec_id: 'r2' })
    f.pressure.push({ ...pressure(input, '2', { decide_today: true }), rec_ref: 'r2' })
    f.pressure.push({ ...pressure(input, '4', { fear_framing: true }), rec_ref: 'r9' })
    const groups = only(runRules(f, undefined, true), 'pressure_signal').map((x) => `${x.rule_id}:${x.procedure_group}`).sort()
    expect(groups).toEqual(['pressure.decide_today:joint_replacement', 'pressure.fear_framing:hernia_repair'])
  })

  it('F7 specs: enabled consent, pressure and concern rules respect their caps; the cap total is the jev budget basis', () => {
    expect(MAX_CANDIDATES).toBe(54)
    const input = load('hernia-full-consent')
    const f = empty()
    for (let i = 0; i < 5; i++) f.recommendation.push({ ...rec(input, '1', 'hernia repair'), id: `rec-${i}`, rec_id: `r${i + 1}` })
    const risks = RULE_SPECS.find((s) => s.id === 'consent.risks')!
    const out = risks.evaluate(Object.values(f).flat() as never, consultContext(input)) as RuleOutput
    expect(out.candidates).toHaveLength(RULE_CAPS.consent)
    expect(out.counts).toMatchObject({ over_cap: 5 - RULE_CAPS.consent })
  })
})

describe('S1b fix-up', () => {
  it('B2: risks stated with a rec_ref that matches no recommendation give no consent.risks finding', () => {
    const input = load('hernia-full-consent')
    const f = empty()
    f.recommendation.push(rec(input, '1', 'hernia repair'))
    f.consent.push({ ...consent(input, '3', { risks: true }), rec_ref: 'r2' })
    expect(runRules(f, undefined, true).findings.map((x) => x.rule_id)).not.toContain('consent.risks')
  })

  it('N3: an incomplete window abstains instead of emitting absence findings, on the 3 incomplete fixtures', () => {
    for (const name of ['incomplete-window', 'doctor-only', 'gap-over-120s']) {
      const input = load(name)
      expect(prepass(input).complete, name).toBe(false)
      const f = empty()
      f.recommendation.push(rec(input, '1', 'hernia repair'))
      const r = runRules(f, input.rx, prepass(input).complete)
      expect(r.findings.filter((x) => x.finding_type === 'consent_incomplete'), name).toEqual([])
      expect(r.abstention_counts, name).toMatchObject({ window_incomplete: 1 })
    }
    const withRx = { requires_surgery: true, procedure_text: 'hernia repair' }
    expect(runRules(empty(), withRx, false).abstention_counts).toEqual({ window_incomplete: 1 })
  })

  it('N2: the budget covers every spec that can be enabled', () => {
    const caps = { ...RULE_CAPS }
    const sum =
      RULE_SPECS.filter((s) => s.id.startsWith('consent.')).length * caps.consent +
      RULE_SPECS.filter((s) => s.id.startsWith('pressure.')).length * caps.pressure +
      caps.concern +
      RULE_SPECS.filter((s) => s.id.startsWith('svw.')).length * caps.svw +
      RULE_SPECS.filter((s) => s.id.startsWith('indication.')).length * caps.indication
    expect(MAX_CANDIDATES).toBe(sum)
  })
})
