import { describe, expect, it } from 'vitest'
import {
  buildReport,
  busSafeSummary,
  busSafeText,
  KNEE_GROUPS,
  renderMarkdown,
  type BodyFinding,
  type Entry,
  type ReportMeta,
  type RunRecord,
} from '../../../../src/agents/surgical-consult/offline/report.js'

const META: ReportMeta = { lines_read: 7, rejects: { bad_id: 1 }, skipped_for_cap: 0, stopped_by_cap: null, caps: { llm: 14, jev: 378 }, metered: { llm: 9, jev: 20, second: 12 }, mode: 'live' }

const counts = (over: Partial<RunRecord['counts']> = {}): RunRecord['counts'] => ({
  facts_total: 0, facts_kept: 0, facts_dropped: 0, drops: {}, llm_calls: 1, jev_calls: 0, candidates: 0, judge_agree: 0, judge_disagree: 0, judge_dropped: 0, judge_unavailable: 0, ...over,
})

function finding(type: string, group: string, quote: string, over: Partial<BodyFinding> = {}): BodyFinding {
  return {
    finding_type: type,
    procedure_group: group,
    rule_id: `${type.split('_')[0]}.x`,
    rule_version: 'r1',
    summary: 'claim',
    evidence: [{ segment_id: 'seg-0003', role: 'doctor', t0: 12.5, t1: 20, quote }],
    judge: { primary_p: 0.9, second_p: 0.85, agree: true, served_model_ids: ['jev-1.13.0'] },
    ...over,
  }
}

function entry(n: number, rec: Partial<RunRecord>, findings: BodyFinding[] = [], held: Entry['held'] = []): Entry {
  const record: RunRecord = {
    n, encounter_id: `enc-${n}`, doctor_uid: 'doc-a', month: '2026-10', source: 'cutter', match_confidence: 'exact', window_complete: true,
    status: 'ok', reason: null, findings_kept: findings.length, held: held.map(({ evidence: _e, ...h }) => h), abstentions: {}, counts: counts(), versions: { models: 'm-one,jev-1.13.0' }, pairs: [], error: null, ...rec,
  }
  return { record, body: { status: record.status, findings, abstentions: record.abstentions, versions: record.versions }, held }
}

const pair = (j: number, g: number) => ({ rule_id: 'consent.risks', jev_p: j, gemini_p: g })

// Hand-built set. Expected numbers are worked out in the comments.
function fixtureEntries(): Entry[] {
  return [
    // e1 doc-a: 2 knee-replacement consent gaps + 1 hernia pressure
    entry(1, { counts: counts({ facts_total: 20, facts_dropped: 4, drops: { duplicate_span_different_fields: 2, quote_not_found: 2 }, llm_calls: 1, jev_calls: 6 }), pairs: [pair(0.9, 0.9), pair(0.9, 0.9)] }, [
      finding('consent_incomplete', 'joint_replacement', 'QUOTE-ONE'),
      finding('consent_incomplete', 'joint_replacement', 'QUOTE-TWO', { rule_id: 'consent.cost' }),
      finding('pressure_signal', 'hernia_repair', 'QUOTE-THREE'),
    ]),
    // e2 doc-a: 1 hernia consent gap
    entry(2, { counts: counts({ facts_total: 20, facts_dropped: 6, drops: { duplicate_span_different_fields: 1, role_not_allowed: 5 }, llm_calls: 1, jev_calls: 2 }), pairs: [pair(0.9, 0.2), pair(0.2, 0.9)] }, [finding('consent_incomplete', 'hernia_repair', 'QUOTE-FOUR')]),
    // e3 doc-b: abstained judge_disagree
    entry(3, { doctor_uid: 'doc-b', status: 'abstained', reason: 'judge_disagree', abstentions: { judge_disagree: 2 }, pairs: [pair(0.2, 0.2), pair(0.2, 0.2), pair(0.9, 0.2)] }),
    // e4 doc-b: empty, no recommendation
    entry(4, { doctor_uid: 'doc-b', status: 'empty', reason: 'no_surgical_recommendation', counts: counts({ facts_total: 0 }) }),
    // e5: unavailable, 2 held (acl and joint_replacement)
    entry(5, { status: 'unavailable', reason: 'judge_unavailable', abstentions: { judge_unavailable: 2 } }, [], [
      { finding_type: 'concern_unaddressed', procedure_group: 'acl_ligament', rule_id: 'concern.unaddressed', primary_p: 0.8, evidence: [{ segment_id: 'seg-0002', role: 'patient', t0: 3, t1: 5, quote: 'HELD-QUOTE-A' }] },
      { finding_type: 'consent_incomplete', procedure_group: 'joint_replacement', rule_id: 'consent.risks', primary_p: 0.95, evidence: [{ segment_id: 'seg-0001', role: 'doctor', t0: 0, t1: 4, quote: 'HELD-QUOTE-B' }] },
    ]),
    // e6: abstained window_incomplete, caa source, window match
    entry(6, { source: 'caa', match_confidence: 'window', window_complete: false, status: 'abstained', reason: 'window_incomplete', abstentions: { window_incomplete: 1 } }),
  ]
}

describe('report numbers (checked by hand)', () => {
  const entries = fixtureEntries()
  const r = buildReport(entries, META)

  it('status mix and abstention', () => {
    // ok 2, empty 1, abstained 2 (e3, e6), unavailable 1, failed 0; hold = consults with held findings = 1
    expect(r.status_mix).toEqual({ ok: 2, empty: 1, abstained: 2, unavailable: 1, failed: 0, hold: 1 })
    // 2 abstained of 6 consults
    expect(r.abstentions).toMatchObject({ abstained_runs: 2, runs: 6, rate: 0.333, run_level_by_reason: { judge_disagree: 1, window_incomplete: 1 } })
    // queue-level counts: judge_disagree 2, judge_unavailable 2, window_incomplete 1
    expect(r.abstentions.finding_level_by_reason).toEqual({ judge_disagree: 2, judge_unavailable: 2, window_incomplete: 1 })
  })

  it('consults by source, match and window', () => {
    expect(r.consults).toMatchObject({ run: 6, by_source: { caa: 1, cutter: 5 }, by_match_confidence: { exact: 5, window: 1 }, by_window_complete: { false: 1, true: 5 }, rejected: { bad_id: 1 } })
  })

  it('findings by group x type put the knee groups first', () => {
    expect(r.findings.kept).toBe(4)
    expect(r.findings.by_group_type).toEqual([
      { procedure_group: 'joint_replacement', finding_type: 'consent_incomplete', n: 2, knee_group: true },
      { procedure_group: 'hernia_repair', finding_type: 'consent_incomplete', n: 1, knee_group: false },
      { procedure_group: 'hernia_repair', finding_type: 'pressure_signal', n: 1, knee_group: false },
    ])
    expect(r.findings.by_type).toEqual([{ finding_type: 'consent_incomplete', n: 3 }, { finding_type: 'pressure_signal', n: 1 }])
    expect(KNEE_GROUPS).toEqual(['joint_replacement', 'B_knee_arthroscopy_degenerative', 'acl_ligament'])
  })

  it('findings by doctor_uid x type, with small_n', () => {
    expect(r.findings.by_doctor_type).toEqual([
      { doctor_uid: 'doc-a', finding_type: 'consent_incomplete', n: 3, small_n: false },
      { doctor_uid: 'doc-a', finding_type: 'pressure_signal', n: 1, small_n: true },
    ])
  })

  it('held counts by group x type (knee first) and totals', () => {
    expect(r.held).toMatchObject({ findings: 2, consults: 1 })
    expect(r.held.by_group_type).toEqual([
      { procedure_group: 'joint_replacement', finding_type: 'consent_incomplete', n: 1 },
      { procedure_group: 'acl_ligament', finding_type: 'concern_unaddressed', n: 1 },
    ])
  })

  it('kappa against the I3 probe: yy 2, yn 2, ny 1, nn 2 gives 0.16', () => {
    // pairs: e1 yy yy; e2 yn ny; e3 nn nn yn  -> yy2, yn2, ny1, nn2 (n=7). po=4/7, jev yes 4/7, gemini yes 3/7, pe=24/49, kappa=4/25
    expect(r.judge_agreement.n_both).toBe(7)
    expect(r.judge_agreement.n_agree).toBe(4)
    expect(r.judge_agreement.kappa).toBeCloseTo(0.16, 12)
    expect(r.judge_agreement.agreement).toBeCloseTo(4 / 7, 12)
    expect(r.judge_agreement.label).toBe('0.160')
  })

  it('kappa is "n/a (no second judge)" with no pairs', () => {
    const none = buildReport(entries.map((e) => ({ ...e, record: { ...e.record, pairs: [] } })), META)
    expect(none.judge_agreement).toMatchObject({ n_both: 0, kappa: null, agreement: null, label: 'n/a (no second judge)' })
    expect(busSafeText(none)).toContain('judge_kappa=n/a (no second judge)')
  })

  it('drops, extraction drop rate, calls, models, empty reasons', () => {
    expect(r.drops.duplicate_span_different_fields).toBe(3)
    expect(r.drops.by_reason).toEqual({ duplicate_span_different_fields: 3, quote_not_found: 2, role_not_allowed: 5 })
    // 4 + 6 dropped of 20 + 20 facts = 10/40
    expect(r.extraction).toEqual({ facts_total: 40, facts_dropped: 10, drop_rate: 0.25 })
    expect(r.models.llm_calls).toBe(6)
    expect(r.models.judge_asks).toBe(8)
    expect(r.models.served_by_consults).toEqual({ 'jev-1.13.0': 6, 'm-one': 6 })
    expect(r.models.metered).toEqual(META.metered)
    expect(r.empty_reasons).toEqual({ no_surgical_recommendation: 1 })
  })

  it('examples: up to 3 per finding type with quote, segment, times and both p', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      entry(10 + i, { pairs: [] }, [finding('consent_incomplete', 'hernia_repair', `Q${i}`, { judge: { primary_p: [0.8, 0.81, 0.82, 0.83, 0.84][i]!, second_p: 0.9, agree: true, served_model_ids: [] } })]),
    )
    const rep = buildReport(many, META)
    expect(rep.examples.kept.consent_incomplete).toHaveLength(3)
    // best first by min(p): 0.84, 0.83, 0.82 capped by second_p 0.9 -> min is primary
    expect(rep.examples.kept.consent_incomplete!.map((x) => x.evidence[0]!.quote)).toEqual(['Q4', 'Q3', 'Q2'])
    expect(rep.examples.kept.consent_incomplete![0]).toMatchObject({ judge: { primary_p: 0.84, second_p: 0.9 }, evidence: [{ segment_id: 'seg-0003', role: 'doctor', t0: 12.5, t1: 20, quote: 'Q4' }] })
    expect(r.examples.held.concern_unaddressed![0]).toMatchObject({ primary_p: 0.8, evidence: [{ quote: 'HELD-QUOTE-A', segment_id: 'seg-0002' }] })
  })

  it('markdown prints the asks separately and says ids are never posted', () => {
    const md = renderMarkdown(r, entries)
    expect(md).toContain('Judge asks, primary + second (platform sum): 8. Metered: extraction 9, Jev (primary) asks 20, second-judge asks 12.')
    expect(md).toContain('Finding ids and consult or doctor ids are never posted.')
    expect(md).not.toContain('Jev asks: 8')
  })

  it('markdown opens with the bus-safe block, then the tables; quotes appear only below it', () => {
    const md = renderMarkdown(r, entries)
    const block = busSafeSummary(r, entries)
    expect(md.indexOf(block)).toBeGreaterThan(0)
    expect(md.indexOf(block)).toBeLessThan(md.indexOf('## Findings by procedure group'))
    expect(md.indexOf('QUOTE-ONE')).toBeGreaterThan(md.indexOf(block) + block.length)
    expect(md).toContain('HELD-QUOTE-A')
    expect(md.indexOf('joint_replacement')).toBeLessThan(md.indexOf('hernia_repair', md.indexOf('## Findings by procedure group')))
  })
})

describe('bus-safe block', () => {
  it('has no quotes, ids or digit runs', () => {
    const entries = fixtureEntries()
    // Plant things that must not leak: a model id with an 8-digit date and a doctor uid.
    const withIds = entries.map((e) => ({ ...e, record: { ...e.record, versions: { models: 'us.anthropic.claude-sonnet-20250929-v1:0' } } }))
    const r = buildReport(withIds, META)
    const text = busSafeSummary(r, withIds)
    expect(text).toBe(busSafeText(r))
    expect(text).not.toMatch(/\d{8,}/)
    for (const e of withIds) {
      expect(text).not.toContain(e.record.encounter_id)
      expect(text).not.toContain(e.record.doctor_uid!)
      for (const f of e.body!.findings) for (const ev of f.evidence) expect(text).not.toContain(ev.quote)
      for (const h of e.held) for (const ev of h.evidence) expect(text).not.toContain(ev.quote)
    }
    expect(text).not.toContain('20250929')
    expect(text).not.toContain('"')
    expect(text).toContain('status: ok=2 empty=1 abstained=2 unavailable=1 failed=0 hold_consults=1')
    expect(text).toContain('findings_kept=4 (consent_incomplete=3 pressure_signal=1); held_findings=2')
    expect(text).toContain('abstention_rate=0.333 (2/6)')
    expect(text).toContain('extraction_drop_rate=0.250')
    // Primary (Jev) and second-judge asks are metered separately; the platform sum has its own name.
    expect(text).toContain('llm_calls=6; jev_asks=20; second_judge_asks=12; judge_asks_platform_sum=8;')
    expect(text).not.toContain('jev_calls')
  })

  it('is withheld, not posted, if a guard trips: an id, a quote or a digit run', () => {
    const entries = fixtureEntries()
    const leaky = (patch: Partial<RunRecord>) => {
      const e = entries.map((x, i) => (i === 0 ? { ...x, record: { ...x.record, ...patch } } : x))
      return busSafeSummary(buildReport(e, META), e)
    }
    expect(leaky({ source: 'case-123456789' })).toBe('BUS-SAFE BLOCK WITHHELD (digit run)')
    expect(leaky({ source: 'enc-2' })).toBe('BUS-SAFE BLOCK WITHHELD (id or quote)')
    expect(leaky({ source: 'doc-a' })).toBe('BUS-SAFE BLOCK WITHHELD (id or quote)')
    expect(leaky({ source: 'QUOTE-ONE' })).toBe('BUS-SAFE BLOCK WITHHELD (id or quote)')
  })
})
