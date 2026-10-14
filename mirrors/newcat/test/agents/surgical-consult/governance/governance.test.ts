import { describe, expect, it } from 'vitest'
import { GovernanceInputError } from '../../../../src/agents/surgical-consult/governance/serialize.js'
import { AGREEMENT_THRESHOLD, aggregate, cohenKappa } from '../../../../src/agents/surgical-consult/governance/aggregate.js'
import { refuseAudience, toGovernance } from '../../../../src/agents/surgical-consult/governance/serialize.js'
import type { AgentRunSummary, JudgedFinding, Outcome } from '../../../../src/agents/surgical-consult/governance/types.js'

const finding = (o: Partial<JudgedFinding> = {}): JudgedFinding => ({
  finding_type: 'consent_incomplete',
  procedure_group: 'hernia_repair',
  rule_id: 'consent.risks',
  rule_version: '1',
  claim: 'Risks were not discussed.',
  evidence: [{ segment_id: 'seg-0001', role: 'doctor', t0: 1, t1: 2, quote: 'We will operate.' }],
  fact_refs: ['f1'],
  needs_judge: true,
  doctor_visible: false,
  judge: { jev_p: 0.9, gemini_p: 0.8, agree: true },
  models: ['jev-x', 'gemini-y'],
  outcome: 'kept',
  ...o,
})
// The spec keep rule: kept only when both judges are at or above the threshold; one yes one no is a disagreement.
const judged = (jev_p: number | null, gemini_p: number | null, o: Partial<JudgedFinding> = {}): JudgedFinding => {
  const yes = (p: number | null) => p !== null && p >= 0.75
  const outcome: Outcome = yes(jev_p) && yes(gemini_p) ? 'kept' : yes(jev_p) !== yes(gemini_p) ? 'abstain_disagree' : 'below_threshold'
  return finding({ judge: { jev_p, gemini_p, agree: jev_p === null || gemini_p === null ? null : yes(jev_p) === yes(gemini_p) }, outcome, ...o })
}
const run = (o: Partial<AgentRunSummary> = {}): AgentRunSummary => ({
  encounter_id: 'e1',
  doctor_uid: 'd1',
  month: '2026-09',
  status: 'ok',
  abstain_reason: null,
  findings: [finding()],
  abstentions: [],
  not_discussed_counts: {},
  ...o,
})

describe('toGovernance', () => {
  it('routes kept to items and the rest to counts', () => {
    const g = toGovernance(
      run({
        findings: [finding(), finding({ outcome: 'abstain_disagree' }), finding({ outcome: 'below_threshold' }), finding({ outcome: 'below_threshold' })],
        abstentions: [{ rule_id: 'r', reason: 'window_incomplete' }, { rule_id: 'r2', reason: 'window_incomplete' }],
        not_discussed_counts: { 'indication.x': 2 },
      }),
    )
    expect(g.findings).toHaveLength(1)
    expect(g.findings[0]).toMatchObject({ finding_type: 'consent_incomplete', rule_id: 'consent.risks', rule_version: '1', claim: 'Risks were not discussed.', models: ['jev-x', 'gemini-y'] })
    expect(g.findings[0]!.evidence[0]).toEqual({ segment_id: 'seg-0001', role: 'doctor', t0: 1, t1: 2, quote: 'We will operate.' })
    expect(g.dropped_counts).toEqual({ abstain_disagree: 1, below_threshold: 2 })
    expect(g.abstention_counts).toEqual({ window_incomplete: 2 })
    expect(g.not_discussed_counts).toEqual({ 'indication.x': 2 })
  })
  it('throws when any finding is doctor-visible, even a dropped one', () => {
    for (const outcome of ['kept', 'below_threshold'] as Outcome[]) {
      const bad = { ...finding({ outcome }), doctor_visible: true } as unknown as JudgedFinding
      expect(() => toGovernance(run({ findings: [bad] }))).toThrow(/doctor_visible/)
    }
  })
  it('never carries text_native or a patient name', () => {
    const f = { ...finding(), text_native: 'नमस्ते', patient_name: 'X' } as unknown as JudgedFinding
    f.evidence = [{ ...f.evidence[0]!, text_native: 'नमस्ते' } as never]
    const s = JSON.stringify(toGovernance(run({ findings: [f] })))
    expect(s).not.toMatch(/text_native|patient_name|नमस्ते/)
  })
  it('refuses the doctor audience only', () => {
    expect(() => refuseAudience('doctor')).toThrow()
    for (const a of ['internal', 'operator', 'governance'] as const) expect(() => refuseAudience(a)).not.toThrow()
  })
})

describe('cohenKappa', () => {
  const rep = (a: boolean, b: boolean, n: number) => Array.from({ length: n }, () => [a, b] as [boolean, boolean])
  it('perfect agreement is 1', () => expect(cohenKappa([...rep(true, true, 2), ...rep(false, false, 2)])).toBe(1))
  it('chance agreement is 0', () => expect(cohenKappa([...rep(true, true, 1), ...rep(true, false, 1), ...rep(false, true, 1), ...rep(false, false, 1)])).toBe(0))
  it('known table 20/5/10/15 is 0.4', () =>
    expect(cohenKappa([...rep(true, true, 20), ...rep(true, false, 5), ...rep(false, true, 10), ...rep(false, false, 15)])).toBeCloseTo(0.4, 12))
  it('is null when undefined', () => {
    expect(cohenKappa([])).toBeNull()
    expect(cohenKappa(rep(true, true, 3))).toBeNull()
  })
})

describe('aggregate', () => {
  it('handles empty input', () => {
    const a = aggregate([])
    expect(a.by_doctor_procedure_type).toEqual([])
    expect(a.by_type).toEqual([])
    expect(a.runs_by_status).toEqual({ ok: 0, empty: 0, abstained: 0, unavailable: 0, failed: 0 })
    expect(a.abstention).toEqual({ n_runs: 0, n_abstained: 0, rate: 0, by_reason: {} })
    expect(a.judge_agreement).toEqual({ n_both: 0, n_agree: 0, threshold: AGREEMENT_THRESHOLD, kappa: null })
    expect(a.not_discussed_totals).toEqual({})
    expect(a.example_findings).toEqual({})
  })
  const runs = (): AgentRunSummary[] => [
    run({ encounter_id: 'e1', findings: [finding(), judged(0.95, 0.8, { finding_type: 'pressure_signal' })], not_discussed_counts: { a: 1 } }),
    run({ encounter_id: 'e2', findings: [judged(0.5, 0.4), judged(0.9, 0.4)], not_discussed_counts: { a: 2, b: 1 } }),
    run({ encounter_id: 'e3', doctor_uid: null, status: 'abstained', abstain_reason: 'window_incomplete', findings: [] }),
    run({ encounter_id: 'e4', status: 'abstained', abstain_reason: 'quote_gate', findings: [judged(null, 0.9)] }),
    run({ encounter_id: 'e5', month: '2026-10', findings: [finding(), finding(), finding()] }),
  ]
  it('counts rows, types, statuses, abstention and not_discussed', () => {
    const a = aggregate(runs())
    const sep = a.by_doctor_procedure_type.find((r) => r.month === '2026-09' && r.finding_type === 'consent_incomplete')!
    expect(sep).toMatchObject({ doctor_uid: 'd1', n: 1, small_n: true })
    expect(a.by_doctor_procedure_type.find((r) => r.finding_type === 'pressure_signal')).toMatchObject({ n: 1, small_n: true })
    expect(a.by_doctor_procedure_type.find((r) => r.month === '2026-10')).toMatchObject({ n: 3, small_n: false })
    expect(a.by_type).toEqual([{ finding_type: 'consent_incomplete', n: 4 }, { finding_type: 'pressure_signal', n: 1 }])
    expect(a.runs_by_status).toMatchObject({ ok: 3, abstained: 2 })
    expect(a.abstention).toEqual({ n_runs: 5, n_abstained: 2, rate: 0.4, by_reason: { quote_gate: 1, window_incomplete: 1 } })
    expect(a.not_discussed_totals).toEqual({ a: 3, b: 1 })
  })
  it('computes judge agreement over every judged finding with both probabilities, whatever its outcome', () => {
    const j = aggregate(runs()).judge_agreement
    // pairs (e4 lacks Jev): yy, yy, nn, yn, yy x3 -> n=7, agree 6. jev yes 6/7, gemini yes 5/7, po=6/7, pe=32/49, kappa=10/17.
    expect(j).toMatchObject({ n_both: 7, n_agree: 6, threshold: 0.75 })
    expect(j.kappa).toBeCloseTo(10 / 17, 12)
  })
  it('refuter probe: 7 judged findings give kappa 0.16, and only kept ones become items', () => {
    const fs = [[0.9, 0.8], [0.95, 0.6], [0.5, 0.9], [0.3, 0.2], [0.8, 0.85], [0.1, 0.1], [0.76, 0.4]].map(([a, b]) => judged(a!, b!))
    expect(fs.map((f) => f.outcome)).toEqual(['kept', 'abstain_disagree', 'abstain_disagree', 'below_threshold', 'kept', 'below_threshold', 'abstain_disagree'])
    const a = aggregate([run({ findings: fs })])
    // yy 2, yn 2, ny 1, nn 2: po=4/7, jev yes 4/7, gemini yes 3/7, pe=24/49, kappa=(28-24)/(49-24)=4/25
    expect(a.judge_agreement).toMatchObject({ n_both: 7, n_agree: 4 })
    expect(a.judge_agreement.kappa).toBeCloseTo(0.16, 12)
    expect(a.by_type).toEqual([{ finding_type: 'consent_incomplete', n: 2 }])
    expect(a.example_findings.consent_incomplete).toHaveLength(2)
  })
  it('picks up to 3 examples per type by min(jev, gemini), ties by encounter', () => {
    const rs = [1, 2, 3, 4, 5].map((i) => run({ encounter_id: `e${i}`, findings: [judged(0.75 + i / 50, 0.99)] }))
    const ex = aggregate(rs).example_findings.consent_incomplete!
    expect(ex.map((e) => e.encounter_id)).toEqual(['e5', 'e4', 'e3'])
    expect(ex[0]!.evidence).toHaveLength(1)
    expect(ex[0]!.score).toBeCloseTo(0.85, 12)
  })
  it('is deterministic under input order', () => {
    const a = JSON.stringify(aggregate(runs()))
    expect(JSON.stringify(aggregate(runs().reverse()))).toBe(a)
    expect(JSON.stringify(aggregate(runs()))).toBe(a)
  })
})

describe('input validation', () => {
  const code = (fn: () => unknown) => {
    try { fn() } catch (e) { return e instanceof GovernanceInputError ? e.code : `other:${String(e)}` }
    return 'no throw'
  }
  it('throws on a duplicate encounter_id', () => {
    expect(code(() => aggregate([run(), run()]))).toBe('duplicate_encounter')
  })
  it('rejects bad probabilities, but allows null', () => {
    for (const p of [NaN, Infinity, -0.1, 1.7]) {
      expect(code(() => toGovernance(run({ findings: [judged(p, 0.9)] })))).toBe('bad_probability')
      expect(code(() => toGovernance(run({ findings: [judged(0.9, p)] })))).toBe('bad_probability')
    }
    expect(code(() => toGovernance(run({ findings: [judged(null, null)] })))).toBe('no throw')
    expect(code(() => toGovernance(run({ findings: [judged(0, 1)] })))).toBe('no throw')
  })
  it('rejects negative or non-finite counts', () => {
    for (const n of [NaN, -1, Infinity]) expect(code(() => toGovernance(run({ not_discussed_counts: { a: n } })))).toBe('bad_count')
  })
  it('rejects an unknown status, month or outcome', () => {
    expect(code(() => toGovernance(run({ status: 'weird' as never })))).toBe('bad_status')
    for (const m of ['Sept', '2026-9', '2026-09-01', '']) expect(code(() => toGovernance(run({ month: m })))).toBe('bad_month')
    expect(code(() => toGovernance(run({ findings: [finding({ outcome: 'x' as never })] })))).toBe('bad_outcome')
    expect(code(() => aggregate([run({ status: 'weird' as never })]))).toBe('bad_status')
  })
  it('treats special keys as plain data', () => {
    const nd = JSON.parse('{"__proto__": 2, "constructor": 1}') as Record<string, number>
    const r = run({ status: 'abstained', abstain_reason: 'constructor', abstentions: [{ rule_id: 'a', reason: '__proto__' }, { rule_id: 'b', reason: 'constructor' }], not_discussed_counts: nd })
    const g = toGovernance(r)
    expect(Object.entries(g.abstention_counts)).toEqual([['__proto__', 1], ['constructor', 1]])
    expect(Object.entries(g.not_discussed_counts)).toEqual([['__proto__', 2], ['constructor', 1]])
    const a = aggregate([r, run({ encounter_id: 'e2', status: 'abstained', abstain_reason: '__proto__', findings: [] })])
    expect(Object.entries(a.abstention.by_reason)).toEqual([['__proto__', 1], ['constructor', 1]])
    expect(a.abstention.n_abstained).toBe(2)
    expect(Object.entries(a.not_discussed_totals)).toEqual([['__proto__', 2], ['constructor', 1]])
    expect(JSON.stringify(a.abstention.by_reason)).toBe('{"__proto__":1,"constructor":1}')
  })
  it('sorts keys in per-run count objects', () => {
    const mk = (order: string[]) => toGovernance(run({ abstentions: order.map((reason) => ({ rule_id: 'r', reason })), not_discussed_counts: Object.fromEntries(order.map((k) => [k, 1])) }))
    expect(JSON.stringify(mk(['b', 'a', 'c']))).toBe(JSON.stringify(mk(['c', 'b', 'a'])))
    expect(Object.keys(mk(['b', 'a']).not_discussed_counts)).toEqual(['a', 'b'])
  })
})
