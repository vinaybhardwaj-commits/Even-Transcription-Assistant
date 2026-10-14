import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertGovernanceSafe, serialize } from '../../../src/audience/serialize.js'
import { ABSENCE_QUESTION_SET, CONSULT_QUESTION_SET, surgicalConsult } from '../../../src/agents/surgical-consult/definition.js'
import type { ExtractedFact } from '../../../src/agents/surgical-consult/facts.js'
import { COUNT_REASONS, CONSULT_META_KEYS, RULE_SPECS, absenceRanges } from '../../../src/agents/surgical-consult/rules/index.js'
import { consultContext, type ConsultContext } from '../../../src/agents/surgical-consult/segments.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { candidatesOf, type GatedFact } from '../../../src/platform/agent/types.js'
import { FakeSecondJudge } from '../../../src/platform/judge/second.js'
import { load, reply, rig } from './helpers.js'

interface Gov {
  findings: Array<{ judge: Record<string, unknown> }>
  versions: { models: unknown }
  agent_counts?: Record<string, number>
  [key: string]: unknown
}
const gov = (audit: Parameters<typeof serialize>[0]) => serialize(audit, 'governance', { governance: surgicalConsult.serializers!.governance }) as Gov

describe('G2: meta instead of a summary trailer', () => {
  it('declares plain meta keys and carries procedure_group in finding meta', async () => {
    expect(surgicalConsult.metaKeys).toEqual(['procedure_group'])
    const r = await rig()
    const audit = await r.run(load('knee-replacement-missing-consent'))
    expect(audit.findings.length).toBeGreaterThan(0)
    for (const f of audit.findings) {
      expect(f.meta).toEqual({ procedure_group: 'joint_replacement' })
      expect(f.summary).not.toContain('[[')
      expect(f.evidence.every((e) => /^seg-\d{4}$/.test(e.segment_id ?? ''))).toBe(true)
    }
  })
})

describe('G3: both judge probabilities in the governance body', () => {
  it('carries primary_p, second_p and agree, and no min() basis', async () => {
    const r = await rig(undefined, new FakeJudgePort(() => 0.95), new FakeSecondJudge(() => 0.8))
    const body = gov(await r.run(load('knee-replacement-missing-consent')))
    expect(() => assertGovernanceSafe(body)).not.toThrow()
    expect(body.findings.length).toBeGreaterThan(0)
    for (const f of body.findings) {
      expect(f.judge).toMatchObject({ primary_p: 0.95, second_p: 0.8, agree: true })
      expect(f.judge).not.toHaveProperty('basis')
    }
  })
})

const marker = 'ZZMARKER9Q'
function fakeFact(over: Record<string, unknown>): GatedFact<ExtractedFact> {
  return { id: 'f1', source_id: 's1', segment_id: 'seg-0001', role: 'doctor', t0: 0, t1: 5, start: 0, end: 10, quote: `quote ${marker}`, ...over } as never
}

describe('G1: rule context', () => {
  it('svw rules run from ctx.rx: a written group that differs and rx saying no surgery', async () => {
    const input = { ...load('hernia-full-consent'), rx: { requires_surgery: false, procedure_text: 'knee replacement' } }
    const r = await rig()
    const audit = await r.run(input)
    const ids = audit.findings.map((f) => f.rule_id)
    expect(ids).toContain('svw.group_differs')
    expect(ids).toContain('svw.rx_no_surgery_but_firm')
    expect(RULE_SPECS.filter((s) => s.id.startsWith('svw.')).every((s) => s.enabled)).toBe(true)
  })

  it('never copies context or quotes into a summary or a meta value', () => {
    const ctx: ConsultContext = {
      rx: { requires_surgery: false, procedure_text: `${marker} knee replacement` },
      segments: [
        { id: 'seg-0001', role: 'doctor' },
        { id: 'seg-0002', role: 'patient' },
      ],
    }
    const facts = [
      fakeFact({ group: 'recommendation', rec_id: 'r1', procedure_text: `${marker} hernia repair`, laterality: 'none', firmness: 'firm', urgency: 'elective' }),
      fakeFact({ id: 'f2', group: 'pressure', segment_id: 'seg-0001', rec_ref: null, decide_today: true, discount_or_package: true, fear_framing: true }),
      fakeFact({ id: 'f3', group: 'patient_response', segment_id: 'seg-0002', role: 'patient', t0: 6, t1: 9, rec_ref: null, question_asked: true, hesitation_stated: true, agreement_stated: false, concern_stated: true }),
      fakeFact({ id: 'f4', group: 'consent', rec_ref: null, risks: false, alternatives: false, no_surgery_option: false, recovery: false, cost: false, second_opinion_offered: false }),
    ]
    let produced = 0
    for (const spec of RULE_SPECS.filter((s) => s.enabled)) {
      const out = spec.evaluate(facts as never, structuredClone(ctx))
      for (const c of candidatesOf(out)) {
        produced += 1
        expect(c.summary).not.toContain(marker)
        for (const v of Object.values(c.meta ?? {})) expect(String(v)).not.toContain(marker)
        expect(Object.keys(c.meta ?? {}).every((k) => CONSULT_META_KEYS.includes(k))).toBe(true)
      }
      if (!Array.isArray(out)) for (const k of Object.keys(out.counts ?? {})) expect(COUNT_REASONS).toContain(k)
    }
    expect(produced).toBeGreaterThan(5)
  })

  it('an end-to-end run keeps a marker planted in the rx and the transcript out of summaries and meta', async () => {
    const base = load('hernia-full-consent')
    const input = {
      ...base,
      rx: { requires_surgery: false, procedure_text: `${marker} hernia repair` },
      turns: base.turns.map((t, i) => (i === 0 ? { ...t, text_en: `${t.text_en} ${marker}` } : t)),
    }
    const r = await rig()
    const audit = await r.run(input)
    expect(audit.findings.length).toBeGreaterThan(0)
    for (const f of audit.findings) {
      expect(f.summary).not.toContain(marker)
      expect(JSON.stringify(f.meta ?? {})).not.toContain(marker)
    }
    expect(JSON.stringify(gov(audit).versions)).not.toContain(marker)
  })
})

const recOnly = [
  { group: 'recommendation', quote: 'I recommend repairing it soon.', segment_id: 'seg-0001', rec_id: 'r1', procedure_text: 'hernia repair', laterality: 'right', firmness: 'firm', urgency: 'elective' },
]

describe('G8: absence findings use their own question and whole-segment context', () => {
  const hernia = () => load('hernia-full-consent')
  it('maps every consent rule to the absence question set and leaves the others on the neutral one', () => {
    expect(ABSENCE_QUESTION_SET.question).toBe('Reading only the consult segments given as context, is the claim true? Answer yes or no.')
    expect(surgicalConsult.judge.questionSet).toBe(CONSULT_QUESTION_SET)
    for (const spec of RULE_SPECS) {
      const set = surgicalConsult.judge.questionSets?.[spec.id]
      if (spec.id.startsWith('consent.')) expect(set).toBe(ABSENCE_QUESTION_SET)
      else expect(set).toBeUndefined()
    }
  })

  it('each consent candidate shows the doctor and patient segments from its recommendation to the window end, inside the window, on both judges', async () => {
    const second = new FakeSecondJudge(() => 0.95)
    const r = await rig(() => reply(recOnly), new FakeJudgePort(() => 0.95), second)
    const audit = await r.run(hernia())
    expect(audit.findings.length).toBe(6)
    const window = new Set(consultContext(hernia()).segments.map((s) => s.id))
    expect(r.judge.calls).toHaveLength(6)
    for (const call of r.judge.calls) {
      const state = call.state as { rule: string; context_segments?: Array<{ source_id: string; segment_id: string; role: string }> }
      expect(call.set.id).toBe('consult-absence-claim')
      expect(call.question).toBe(ABSENCE_QUESTION_SET.question)
      expect(state.context_segments).toHaveLength(window.size) // seg-0001 .. seg-0006, all doctor or patient
      for (const seg of state.context_segments!) {
        expect(window.has(seg.segment_id)).toBe(true)
        expect(['doctor', 'patient']).toContain(seg.role)
      }
    }
    // The second judge is asked the same question over the same state (inside the window on BOTH judges).
    expect(second.calls).toHaveLength(6)
    for (const call of second.calls) {
      expect(call.question).toBe(ABSENCE_QUESTION_SET.question)
      expect((call.state as { context_segments?: unknown[] }).context_segments).toHaveLength(window.size)
    }
  })

  it('other roles are left out and the range count follows the window', async () => {
    const input = hernia()
    input.turns[1] = { ...input.turns[1]!, role: 'attendant' }
    const r = await rig(() => reply(recOnly))
    await r.run(input)
    const state = r.judge.calls[0]!.state as { context_segments: Array<{ segment_id: string }> }
    expect(state.context_segments.map((s) => s.segment_id)).toEqual(['seg-0001', 'seg-0003', 'seg-0004', 'seg-0005', 'seg-0006'])
  })

  it('absenceRanges: one range per run of doctor or patient segments, none for an unknown segment', () => {
    const ctx: ConsultContext = {
      rx: null,
      segments: [
        { id: 'seg-0001', role: 'doctor' },
        { id: 'seg-0002', role: 'patient' },
        { id: 'seg-0003', role: 'unknown' },
        { id: 'seg-0004', role: 'doctor' },
      ],
    }
    expect(absenceRanges(ctx, 'seg-0001')).toEqual([
      { source_id: 's1', segment_from: 'seg-0001', segment_to: 'seg-0002' },
      { source_id: 's1', segment_from: 'seg-0004', segment_to: 'seg-0004' },
    ])
    expect(absenceRanges(ctx, 'seg-0004')).toEqual([{ source_id: 's1', segment_from: 'seg-0004', segment_to: 'seg-0004' }])
    expect(absenceRanges(ctx, 'seg-9999')).toBeNull()
  })

  it('quote-support findings keep the neutral question and carry no context', async () => {
    const r = await rig()
    await r.run(load('decide-today-package'))
    const pressure = r.judge.calls.filter((c) => (c.state as { rule: string }).rule.startsWith('pressure.'))
    expect(pressure.length).toBeGreaterThan(0)
    for (const c of pressure) {
      expect(c.set.id).toBe('consult-finding-validity')
      expect(c.state).not.toHaveProperty('context_segments')
    }
  })
})

describe('G4/G5: agent counts and the empty reason', () => {
  it('declares plain count reasons', () => {
    expect(surgicalConsult.countReasons).toEqual(COUNT_REASONS)
    for (const reason of COUNT_REASONS) expect(reason).toMatch(/^[a-z][a-z_]*$/)
  })

  it('no recommendation: empty with no_surgical_recommendation', async () => {
    const r = await rig(() => reply([]))
    const audit = await r.run(load('no-surgery-recommended'))
    expect(audit).toMatchObject({ status: 'empty', reason: 'no_surgical_recommendation' })
  })

  it('counts rule abstentions and not_discussed in agent_counts and the governance body', async () => {
    const noRx = await (await rig(() => reply(recOnly))).run({ ...load('hernia-full-consent'), rx: null })
    expect(noRx.agent_counts).toMatchObject({ abstain_no_rx: 1 })
    expect(gov(noRx).agent_counts).toMatchObject({ abstain_no_rx: 1 })
    // rx says surgery but nothing was recommended: a count-only outcome (no fact to cite), and the run is empty.
    const unspoken = await (await rig(() => reply([]))).run(load('hernia-full-consent'))
    expect(unspoken).toMatchObject({ status: 'empty', reason: 'no_surgical_recommendation' })
    expect(unspoken.agent_counts).toMatchObject({ not_discussed: 1 })
  })

  it('over_cap is counted when a rule has more candidates than its cap', () => {
    const ctx = consultContext(load('hernia-full-consent'))
    const facts = [1, 2, 3].map((n) => fakeFact({ id: `r${n}`, group: 'recommendation', rec_id: `r${n}`, procedure_text: 'hernia repair', laterality: 'none', firmness: 'firm', urgency: 'elective' }))
    const out = RULE_SPECS.find((s) => s.id === 'consent.cost')!.evaluate(facts as never, ctx)
    expect(Array.isArray(out) ? [] : out.counts).toMatchObject({ over_cap: 1 })
  })
})

describe('G7: opaque ids', () => {
  it('identity() returns the opaque ids and the body carries them at the top level only', async () => {
    const input = load('hernia-full-consent')
    expect(surgicalConsult.identity!(input)).toEqual({ doctor_uid: input.doctor_uid, encounter_id: input.encounter_id })
    const r = await rig()
    const body = gov(await r.run(input))
    expect(body).toMatchObject({ doctor_uid: input.doctor_uid, encounter_id: input.encounter_id })
    expect(typeof body.versions.models).toBe('string')
    expect(JSON.stringify(body.findings)).not.toContain(input.encounter_id)
    const internal = serialize(await (await rig()).run(input), 'internal') as Record<string, unknown>
    expect(JSON.stringify(internal)).not.toMatch(/doctor_uid|encounter_id/)
  })
})

describe('G6: persist hook', () => {
  it('store.ts SQL names only the three consult tables (F7.3 C2)', () => {
    const src = readFileSync('src/agents/surgical-consult/store.ts', 'utf8')
    const tables = new Set<string>()
    for (const m of src.matchAll(/\b(?:from|into|update|join)\s+([a-z_][a-z0-9_]*)/gi)) tables.add(m[1]!.toLowerCase())
    // "from"/"into" also occur in prose comments; keep only identifiers that look like tables in SQL strings.
    const sqlOnly = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]!).filter((t) => /\b(select|insert|update|delete)\b/i.test(t))
    const used = new Set<string>()
    for (const text of sqlOnly) for (const m of text.matchAll(/\b(?:from|into|update|join)\s+([a-z_][a-z0-9_]*)/gi)) used.add(m[1]!.toLowerCase())
    expect([...used].sort()).toEqual(['consult_extractions', 'consult_findings', 'consult_inputs'])
    expect(sqlOnly.length).toBeGreaterThan(0)
    expect(tables.size).toBeGreaterThan(0)
  })

  it('is wired as the persist hook', () => {
    expect(typeof surgicalConsult.persist).toBe('function')
  })

  it.skipIf(!existsSync('migrations/0005_consult.sql'))('a run writes its input, extraction and findings once, and a repeat adds nothing', async () => {
    const r = await rig()
    const input = load('knee-replacement-missing-consent')
    const audit = await r.run(input)
    const n = async (table: string) => Number((await r.sql.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n)
    expect([await n('consult_inputs'), await n('consult_extractions'), await n('consult_findings')]).toEqual([1, 1, audit.findings.length])
    await r.run(input)
    expect([await n('consult_inputs'), await n('consult_extractions')]).toEqual([1, 1])
  })
})
