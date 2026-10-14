import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertGovernanceSafe, serialize } from '../../../src/audience/serialize.js'
import { ABSENCE_QUESTION_SET, CONSULT_QUESTION_SET, surgicalConsult } from '../../../src/agents/surgical-consult/definition.js'
import type { ExtractedFact } from '../../../src/agents/surgical-consult/facts.js'
import { COUNT_REASONS, CONSULT_META_KEYS, RULE_SPECS, absenceRanges } from '../../../src/agents/surgical-consult/rules/index.js'
import { consultContext, type ConsultContext } from '../../../src/agents/surgical-consult/segments.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { candidatesOf, type GatedFact } from '../../../src/platform/agent/types.js'
import { FakeSecondJudge } from '../../../src/platform/judge/second.js'
import { asJson } from '../../../src/db/sql.js'
import type { Sql } from '../../../src/db/sql.js'
import { load, reply, rig, scriptedExtractor } from './helpers.js'

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
      complete: true,
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
  it('maps every consent rule and concern.unaddressed to the absence question set and leaves the others on the neutral one', () => {
    expect(ABSENCE_QUESTION_SET.question).toBe('Reading only the consult segments given as context, is the claim true? Answer yes or no.')
    expect(surgicalConsult.judge.questionSet).toBe(CONSULT_QUESTION_SET)
    for (const spec of RULE_SPECS) {
      const set = surgicalConsult.judge.questionSets?.[spec.id]
      if (spec.id.startsWith('consent.') || spec.id === 'concern.unaddressed') expect(set).toBe(ABSENCE_QUESTION_SET)
      else expect(set).toBeUndefined()
    }
  })

  it('each consent candidate shows every doctor and patient segment of the window, inside the window, on both judges', async () => {
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

  it('concern.unaddressed shows the whole doctor+patient window on both judges, with the absence claim', async () => {
    const concern = {
      group: 'patient_response', quote: 'How long has this been there, doctor?', segment_id: 'seg-0002', rec_ref: null,
      question_asked: true, hesitation_stated: false, agreement_stated: false, concern_stated: false,
    }
    const second = new FakeSecondJudge(() => 0.95)
    const r = await rig(() => reply([concern]), new FakeJudgePort(() => 0.95), second)
    const audit = await r.run(hernia())
    const f = audit.findings.filter((x) => x.rule_id === 'concern.unaddressed')
    expect(f).toHaveLength(1)
    expect(f[0]!.summary).toBe('A response to this patient concern was not heard in the consult recording.')
    const window = new Set(consultContext(hernia()).segments.map((s) => s.id))
    for (const calls of [r.judge.calls.filter((c) => (c.state as { rule: string }).rule === 'concern.unaddressed'), second.calls.filter((c) => (c.state as { rule: string }).rule === 'concern.unaddressed')]) {
      expect(calls).toHaveLength(1)
      expect(calls[0]!.question).toBe(ABSENCE_QUESTION_SET.question)
      expect((calls[0]!.state as { context_segments: unknown[] }).context_segments).toHaveLength(window.size)
    }
    expect(r.judge.calls.find((c) => (c.state as { rule: string }).rule === 'concern.unaddressed')!.set.id).toBe('consult-absence-claim')
  })

  it('other roles are left out and the range count follows the window', async () => {
    const input = hernia()
    input.turns[1] = { ...input.turns[1]!, role: 'attendant' }
    const r = await rig(() => reply(recOnly))
    await r.run(input)
    const state = r.judge.calls[0]!.state as { context_segments: Array<{ segment_id: string }> }
    expect(state.context_segments.map((s) => s.segment_id)).toEqual(['seg-0001', 'seg-0003', 'seg-0004', 'seg-0005', 'seg-0006'])
  })

  it('W1: consent stated before the recommendation is visible: a late recommendation still sees the whole window', async () => {
    const late = [{ ...recOnly[0]!, quote: 'Recovery is about two weeks off heavy work.', segment_id: 'seg-0004' }]
    const r = await rig(() => reply(late))
    await r.run(hernia())
    expect(r.judge.calls.length).toBeGreaterThan(0)
    for (const call of r.judge.calls) {
      const ids = (call.state as { context_segments: Array<{ segment_id: string }> }).context_segments.map((s) => s.segment_id)
      expect(ids).toEqual(['seg-0001', 'seg-0002', 'seg-0003', 'seg-0004', 'seg-0005', 'seg-0006'])
    }
  })

  it('absenceRanges: one range per run of doctor or patient segments across the whole window', () => {
    const ctx: ConsultContext = {
      rx: null,
      complete: true,
      segments: [
        { id: 'seg-0001', role: 'doctor' },
        { id: 'seg-0002', role: 'patient' },
        { id: 'seg-0003', role: 'unknown' },
        { id: 'seg-0004', role: 'doctor' },
      ],
    }
    expect(absenceRanges(ctx)).toEqual([
      { source_id: 's1', segment_from: 'seg-0001', segment_to: 'seg-0002' },
      { source_id: 's1', segment_from: 'seg-0004', segment_to: 'seg-0004' },
    ])
  })

  it('N1: an incomplete window that reaches the rules (hook bypassed) yields no absence finding, only a counted abstention', () => {
    for (const name of ['incomplete-window', 'doctor-only', 'gap-over-120s']) {
      const input = load(name)
      const ctx = consultContext(input)
      expect(ctx.complete, name).toBe(false)
      const seg = ctx.segments[0]!.id
      const facts = [fakeFact({ group: 'recommendation', segment_id: seg, rec_id: 'r1', procedure_text: 'hernia repair', laterality: 'none', firmness: 'firm', urgency: 'elective' })]
      let counted = 0
      for (const spec of RULE_SPECS.filter((s) => s.id.startsWith('consent.'))) {
        const out = spec.evaluate(facts as never, ctx)
        expect(candidatesOf(out), name).toEqual([])
        if (!Array.isArray(out)) counted += out.counts?.abstain_window_incomplete ?? 0
      }
      expect(counted, name).toBe(1)
    }
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
  // Runtime capture (F7.3 C2): wrap the Sql handle the hook receives during a real run and record every statement.
  const TABLE = /\b(?:from|into|update|join|table)\s+(?:only\s+)?([a-z_][a-z0-9_]*)/gi
  const tablesNamed = (statements: string[]): string[] => [...new Set(statements.flatMap((t) => [...t.matchAll(TABLE)].map((m) => m[1]!.toLowerCase())))].sort()
  const recording = (sql: Sql, seen: string[]): Sql => ({
    query: (text, params) => (seen.push(text), sql.query(text, params)),
    exec: (text) => (seen.push(text), sql.exec(text)),
    withTx: (fn) => sql.withTx((tx) => fn(recording(tx, seen))),
    close: () => sql.close(),
  })
  const capturing = (seen: string[], extra?: (sql: Sql) => Promise<void>) =>
    ({ ...surgicalConsult, persist: async (ctx) => { await surgicalConsult.persist!({ ...ctx, sql: recording(ctx.sql, seen) }); if (extra) await extra(recording(ctx.sql, seen)) } }) as typeof surgicalConsult

  it.skipIf(!existsSync('migrations/0005_consult.sql'))('every statement the persist hook runs names only the three consult tables (F7.3 C2)', async () => {
    const seen: string[] = []
    const r = await rig(undefined, undefined, undefined, capturing(seen))
    expect((await r.run(load('knee-replacement-missing-consent'))).status).toBe('ok')
    expect(seen.length).toBeGreaterThan(0)
    expect(tablesNamed(seen)).toEqual(['consult_extractions', 'consult_findings', 'consult_inputs'])
  })

  it.skipIf(!existsSync('migrations/0005_consult.sql'))('a mutation that adds a quoted-string statement on another table fails the capture', async () => {
    const seen: string[] = []
    const r = await rig(undefined, undefined, undefined, capturing(seen, async (sql) => { await sql.query("update agent_runs set status = 'x' where false") }))
    await r.run(load('knee-replacement-missing-consent'))
    expect(tablesNamed(seen)).toContain('agent_runs')
    expect(tablesNamed(seen)).not.toEqual(['consult_extractions', 'consult_findings', 'consult_inputs'])
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

describe('B1: only ok and empty runs are persisted', () => {
  const have = existsSync('migrations/0005_consult.sql')
  const count = async (r: Awaited<ReturnType<typeof rig>>, table: string) => Number((await r.sql.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n)
  const hernia = () => load('hernia-full-consent')

  it.skipIf(!have)('abstained window_incomplete writes nothing; the later ok run on the same turns stores its findings', async () => {
    const r = await rig()
    const first = await r.run({ ...hernia(), window: { ...hernia().window, complete: false } })
    expect(first).toMatchObject({ status: 'abstained', reason: 'window_incomplete' })
    expect([await count(r, 'consult_inputs'), await count(r, 'consult_extractions'), await count(r, 'consult_findings')]).toEqual([0, 0, 0])
    const second = await r.run(hernia())
    expect(second.status).toBe('ok')
    expect(await count(r, 'consult_findings')).toBe(second.findings.length)
    expect(second.findings.length).toBeGreaterThan(0)
  })

  it.skipIf(!have)('abstained judge_disagree writes nothing; the later ok run stores valid rows', async () => {
    const r = await rig(undefined, new FakeJudgePort(() => 0.95), new FakeSecondJudge(() => 0.1))
    const first = await r.run(hernia())
    expect(first.status).toBe('abstained')
    expect(await count(r, 'consult_findings')).toBe(0)
    const second = await r.run(hernia(), { second: new FakeSecondJudge(() => 0.95) })
    expect(second.status).toBe('ok')
    const rows = await r.sql.query<{ action: string }>('select action from consult_findings')
    expect(rows.rows.length).toBe(second.findings.length)
    expect(rows.rows.every((row) => row.action === 'valid')).toBe(true)
  })

  it.skipIf(!have)('abstained extraction_unverified writes nothing; the later ok run is stored', async () => {
    let bad = true
    const r = await rig((request) => (bad ? reply([{ group: 'recommendation', quote: 'invented words not in the transcript', segment_id: 'seg-0001', rec_id: 'r1', procedure_text: 'hernia repair', laterality: 'right', firmness: 'firm', urgency: 'elective' }]) : scriptedExtractor(request)))
    const first = await r.run(hernia())
    expect(first).toMatchObject({ status: 'abstained', reason: 'extraction_unverified' })
    expect(await count(r, 'consult_extractions')).toBe(0)
    bad = false
    const second = await r.run(hernia())
    expect(second.status).toBe('ok')
    expect(await count(r, 'consult_findings')).toBe(second.findings.length)
  })
})

describe('A1: F7.5 names', () => {
  // F7.5 is not on main yet: this is our own reading of its rule. Tokens split on _ - . and camelCase; no identifier word as a
  // token, no long identifier word run together inside a name, and no run of 8 or more digits.
  const WORDS = ['name', 'uid', 'uhid', 'mrn', 'phone', 'mobile', 'email', 'patient', 'individual', 'dob', 'address', 'ip', 'pan', 'contact', 'ssn']
  const tokens = (key: string): string[] => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const RUN_TOGETHER = WORDS.filter((w) => w.length >= 5)
  const bad = (key: string): string | null => {
    if (tokens(key).some((t) => WORDS.includes(t))) return 'token'
    if (RUN_TOGETHER.some((w) => key.toLowerCase().includes(w))) return 'run-together'
    if (/\d{8,}/.test(key)) return 'digits'
    return null
  }

  it('the checker itself catches the forbidden shapes', () => {
    for (const key of ['patient_name', 'no_patient_turns', 'phoneNumber', 'doctor_uid', 'patientconcern', 'x_12345678', 'contact_id']) expect(bad(key), key).not.toBeNull()
    for (const key of ['concern_unanswered', 'window_incomplete', 'procedure_group']) expect(bad(key), key).toBeNull()
  })

  it('every declared reason, count, meta key, version key and question-set name passes', () => {
    const sets = [surgicalConsult.judge.questionSet, ...Object.values(surgicalConsult.judge.questionSets ?? {})]
    const names = [
      ...surgicalConsult.abstention.reasons,
      ...surgicalConsult.abstention.emptyReasons,
      ...(surgicalConsult.countReasons ?? []),
      ...(surgicalConsult.metaKeys ?? []),
      ...Object.keys(surgicalConsult.versions),
      ...sets.map((set) => set.id),
      'judge_missing',
    ]
    expect(names.length).toBeGreaterThan(10)
    for (const name of names) expect(bad(name), name).toBeNull()
  })

  it('rule ids: token-clean; only concern.unaddressed contains an identifier word run together (the plain word "unaddressed")', () => {
    // Rule ids are outside the F7.5 check. Kept and flagged in the report: renaming touches the rule id contract and the stored findings.
    const kept: string[] = []
    for (const spec of RULE_SPECS) {
      expect(tokens(spec.id).some((t) => WORDS.includes(t)), spec.id).toBe(false)
      if (bad(spec.id) !== null) kept.push(spec.id)
    }
    expect(kept).toEqual(['concern.unaddressed'])
  })

  it('F7.5: every rule id keying a per-rule question set matches ^[a-z][a-z0-9_.]{0,63}$ and has no identifier word token', async () => {
    const RULE_ID_KEY = /^[a-z][a-z0-9_.]{0,63}$/
    const keys = Object.keys(surgicalConsult.judge.questionSets ?? {})
    expect(keys.length).toBeGreaterThan(5)
    for (const id of keys) {
      expect(id, id).toMatch(RULE_ID_KEY)
      expect(tokens(id).some((t) => WORDS.includes(t)), id).toBe(false)
    }
    // And the real governance body: the keys that reach versions.question_sets pass the same check and the emit gate.
    const r = await rig()
    const body = gov(await r.run(load('knee-replacement-missing-consent')))
    const emitted = Object.keys((body.versions as unknown as { question_sets: Record<string, unknown> }).question_sets)
    expect(emitted.length).toBeGreaterThan(0)
    for (const id of emitted) expect(id, id).toMatch(RULE_ID_KEY)
    expect(() => assertGovernanceSafe(body)).not.toThrow()
  })
})

describe('P1P2: the persist hook stores the gated facts and drop counts', () => {
  it('a fake run persists non-empty facts and the drop counts', async () => {
    // One real quote plus one the segment does not contain, so the gate drops it and counts the reason.
    const r = await rig((request) => {
      const real = scriptedExtractor(request)
      const facts = (real as { toolInput: { facts: unknown[] } }).toolInput.facts
      return reply([...facts, { group: 'pressure', quote: 'not said anywhere in this consult', segment_id: 'seg-0001', rec_ref: null, decide_today: true, discount_or_package: false, fear_framing: false }])
    })
    const audit = await r.run(load('hernia-full-consent'))
    expect({ status: audit.status, reason: audit.reason }).toEqual({ status: 'ok', reason: undefined })
    const row = (await r.sql.query<{ facts: unknown; dropped: unknown }>('select facts, dropped from consult_extractions')).rows[0]!
    const facts = asJson<Array<{ group: string; quote: string; segment_id: string }>>(row.facts)
    const dropped = asJson<Record<string, number>>(row.dropped)
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.every((f) => typeof f.quote === 'string' && f.quote.length > 0 && /^seg-\d{4}$/.test(f.segment_id))).toBe(true)
    expect(facts.some((f) => f.quote === 'not said anywhere in this consult')).toBe(false)
    expect(Object.values(dropped).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    expect(Object.values(dropped).every((n) => Number.isInteger(n) && n > 0)).toBe(true)
  })
})
