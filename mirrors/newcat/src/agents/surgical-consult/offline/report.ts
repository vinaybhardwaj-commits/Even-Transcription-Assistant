import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { aggregate, AGREEMENT_THRESHOLD, cohenKappa, SMALL_N } from '../governance/aggregate.js'
import { RUN_STATUSES, type AgentRunSummary, type JudgedFinding, type RunStatus } from '../governance/types.js'
import type { Role } from '../input.js'

/**
 * The S6 governance report (spec sections 6, 13, 14). Built from the platform governance bodies and the per-consult run
 * records. report.json and report.md stay on t4 (quotes allowed); only busSafeSummary may leave, and it carries counts.
 */

export interface HeldDetail {
  finding_type: string
  procedure_group: string
  rule_id: string
  primary_p: number | null
  evidence: Array<{ segment_id: string; role: string; t0: number; t1: number; quote: string }>
}

export interface ExtractionRecord {
  /** Intended model id(s), comma-joined when a run escalated to a different one; null when no extraction call ran. */
  intended: string | null
  /** Served model id(s) from the response; null when any call had none (the global profile is not resolved by readServedModel). */
  served: string | null
  served_verified: boolean
  calls: number
  errors_by_type: Record<string, number>
}

export const emptyExtraction = (): ExtractionRecord => ({ intended: null, served: null, served_verified: false, calls: 0, errors_by_type: {} })

/**
 * A model id safe for the bus: provider prefix, date and version suffix removed (`eu.anthropic.claude-sonnet-4-5-20250929-v1:0`
 * -> `claude-sonnet-4-5`), an ARN reduced to its last path part, and any digit run of 8 or more masked.
 */
export function shortModelId(id: string): string {
  let out = id.slice(id.lastIndexOf('/') + 1)
  out = out.replace(/^(?:[a-z0-9-]+\.)*anthropic\./i, '')
  out = out.replace(/-\d{8}(?:-v\d+(?::\d+)?)?$/, '')
  return out.replace(/\d{8,}/g, '#')
}

/**
 * One judged candidate: the two judges' answers and the platform's outcome. Numbers, booleans and ids only: no claim, quote or
 * segment id. `*_yes` is p at or above the platform threshold for the rule (safety 0.9, other 0.75). Absent in older runs.jsonl.
 * agree = both yes (valid); dropped = both no; disagree = one yes; unavailable = a judge did not answer.
 */
export interface JudgePairRecord {
  rule_id: string
  question_set: string
  polarity: 'presence' | 'absence'
  primary_p: number | null
  second_p: number | null
  primary_yes: boolean | null
  second_yes: boolean | null
  outcome: 'agree' | 'disagree' | 'dropped' | 'unavailable'
}

export interface RunRecord {
  n: number
  encounter_id: string
  doctor_uid: string | null
  month: string
  source: string
  match_confidence: string
  window_complete: boolean
  status: RunStatus
  reason: string | null
  findings_kept: number
  /** Findings held for want of a second judge: codes and the primary p only, no text. */
  held: Array<Omit<HeldDetail, 'evidence'>>
  abstentions: Record<string, number>
  counts: {
    facts_total: number
    facts_kept: number
    facts_dropped: number
    drops: Record<string, number>
    llm_calls: number
    jev_calls: number
    candidates: number
    judge_agree: number
    judge_disagree: number
    judge_dropped: number
    judge_unavailable: number
    persist_failed?: number
  }
  versions: Record<string, string>
  /** The extraction model calls from the run's model_calls ledger rows: ids and codes only. Absent in older runs.jsonl files. */
  extraction?: ExtractionRecord
  judge_pairs?: JudgePairRecord[]
  /** Every finding both judges answered: probabilities and the rule id only. */
  pairs: Array<{ rule_id: string; jev_p: number; gemini_p: number }>
  error: 'run_threw' | 'governance_refused' | 'serialize_threw' | null
}

export interface BodyFinding {
  finding_type: string
  procedure_group: string
  rule_id: string
  rule_version: string
  summary: string
  evidence: Array<{ segment_id: string; role: string; t0?: number; t1?: number; quote: string }>
  judge: { primary_p: number; second_p: number | null; agree: boolean; served_model_ids: string[] }
}

export interface GovernanceBodyLike {
  status: string
  reason?: string
  findings: BodyFinding[]
  abstentions: Record<string, number>
  versions: Record<string, unknown>
}

export interface Entry {
  record: RunRecord
  body: GovernanceBodyLike | null
  held: HeldDetail[]
}

export interface ReportMeta {
  lines_read: number
  rejects: Record<string, number>
  skipped_for_cap: number
  stopped_by_cap: 'llm' | 'jev' | null
  caps: { llm: number; jev: number }
  metered: { llm: number; jev: number; second: number }
  mode: 'live' | 'fake'
}

// C11: the knee groups come first.
export const KNEE_GROUPS: readonly string[] = ['joint_replacement', 'B_knee_arthroscopy_degenerative', 'acl_ligament']
const EXAMPLES_PER_TYPE = 3
const NO_SECOND = 'n/a (no second judge)'

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const groupRank = (g: string): number => (KNEE_GROUPS.includes(g) ? KNEE_GROUPS.indexOf(g) : KNEE_GROUPS.length)
const byGroupThenType = (a: { procedure_group: string; finding_type: string }, b: { procedure_group: string; finding_type: string }): number =>
  groupRank(a.procedure_group) - groupRank(b.procedure_group) || cmp(a.procedure_group, b.procedure_group) || cmp(a.finding_type, b.finding_type)
const sumInto = (into: Record<string, number>, from: Record<string, number>): void => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v
}
const sorted = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)))
const rate = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000)
const fmt = (n: number): string => n.toFixed(3)

function summaryOf(entry: Entry): AgentRunSummary {
  const { record, body } = entry
  const findings = (body?.findings ?? []).map(
    (f): JudgedFinding =>
      ({
        finding_type: f.finding_type,
        procedure_group: f.procedure_group,
        rule_id: f.rule_id,
        rule_version: f.rule_version,
        claim: f.summary,
        evidence: f.evidence.map((e) => ({ segment_id: e.segment_id, role: e.role as Role, t0: e.t0 ?? 0, t1: e.t1 ?? 0, quote: e.quote })),
        fact_refs: [],
        needs_judge: true,
        doctor_visible: false,
        judge: { jev_p: f.judge.primary_p, gemini_p: f.judge.second_p, agree: f.judge.agree },
        models: f.judge.served_model_ids,
        outcome: 'kept',
      }) as JudgedFinding,
  )
  return {
    encounter_id: record.encounter_id,
    doctor_uid: record.doctor_uid,
    month: record.month,
    status: record.status,
    abstain_reason: record.status === 'abstained' ? record.reason : null,
    findings,
    abstentions: [],
    not_discussed_counts: {},
  }
}

export interface ExtractionRow {
  intended: string
  served: string | null
  served_verified: boolean
  consults: number
  calls: number
  errors_by_type: Record<string, number>
}

/** The 2x2 of Jev (rows) against the second judge (columns) over the candidates both answered. */
export interface AgreementCell {
  pairs: number
  both_yes: number
  jev_yes_second_no: number
  jev_no_second_yes: number
  both_no: number
  agreement: number | null
  kappa: number | null
  jev_yes_rate: number | null
  second_yes_rate: number | null
  /** Candidates a judge did not answer (not in the 2x2). */
  unavailable: number
}

export interface Report {
  meta: ReportMeta
  consults: { read_lines: number; rejected: Record<string, number>; run: number; skipped_for_cap: number; by_source: Record<string, number>; by_match_confidence: Record<string, number>; by_window_complete: Record<string, number> }
  status_mix: Record<RunStatus, number> & { hold: number }
  abstentions: { rate: number; abstained_runs: number; runs: number; run_level_by_reason: Record<string, number>; finding_level_by_reason: Record<string, number> }
  held: { findings: number; consults: number; by_group_type: Array<{ procedure_group: string; finding_type: string; n: number }>; note: string }
  findings: {
    kept: number
    by_type: Array<{ finding_type: string; n: number }>
    by_group_type: Array<{ procedure_group: string; finding_type: string; n: number; knee_group: boolean }>
    by_doctor_type: Array<{ doctor_uid: string; finding_type: string; n: number; small_n: boolean }>
  }
  judge_agreement: { n_both: number; n_agree: number; agreement: number | null; kappa: number | null; threshold: number; label: string }
  judge_by_rule: Array<{ rule_id: string; polarity: string } & AgreementCell>
  judge_by_polarity: Record<'presence' | 'absence', AgreementCell>
  drops: { duplicate_span_different_fields: number; by_reason: Record<string, number> }
  extraction: { facts_total: number; facts_dropped: number; drop_rate: number }
  models: { extraction: ExtractionRow[]; served_by_consults: Record<string, number>; llm_calls: number; judge_asks: number; metered: ReportMeta['metered']; caps: ReportMeta['caps'] }
  empty_reasons: Record<string, number>
  examples: {
    kept: Record<string, Array<{ encounter_id: string; doctor_uid: string | null; procedure_group: string; rule_id: string; judge: { primary_p: number; second_p: number | null }; evidence: Array<{ segment_id: string; role: string; t0: number; t1: number; quote: string }> }>>
    held: Record<string, Array<{ encounter_id: string; procedure_group: string; rule_id: string; primary_p: number | null; evidence: HeldDetail['evidence'] }>>
  }
}

function extractionRows(runs: RunRecord[]): ExtractionRow[] {
  const rows = new Map<string, ExtractionRow>()
  for (const r of runs) {
    const x = r.extraction ?? emptyExtraction()
    if (x.calls === 0 || x.intended === null) continue
    const key = `${x.intended}|${x.served ?? ''}|${x.served_verified}`
    const row = rows.get(key) ?? { intended: x.intended, served: x.served, served_verified: x.served_verified, consults: 0, calls: 0, errors_by_type: {} }
    row.consults += 1
    row.calls += x.calls
    sumInto(row.errors_by_type, x.errors_by_type)
    rows.set(key, row)
  }
  return [...rows.values()].map((row) => ({ ...row, errors_by_type: sorted(row.errors_by_type) })).sort((a, b) => cmp(a.intended, b.intended) || cmp(a.served ?? '', b.served ?? ''))
}

function agreementCell(list: JudgePairRecord[]): AgreementCell {
  const both = list.filter((p) => p.primary_yes !== null && p.second_yes !== null)
  const count = (a: boolean, b: boolean): number => both.filter((p) => p.primary_yes === a && p.second_yes === b).length
  const n = both.length
  const agree = count(true, true) + count(false, false)
  const jevYes = count(true, true) + count(true, false)
  const secondYes = count(true, true) + count(false, true)
  return {
    pairs: n,
    both_yes: count(true, true),
    jev_yes_second_no: count(true, false),
    jev_no_second_yes: count(false, true),
    both_no: count(false, false),
    agreement: n === 0 ? null : rate(agree, n),
    kappa: (() => {
      const k = cohenKappa(both.map((p): [boolean, boolean] => [p.primary_yes as boolean, p.second_yes as boolean]))
      return k === null ? null : Math.round(k * 1000) / 1000
    })(),
    jev_yes_rate: n === 0 ? null : rate(jevYes, n),
    second_yes_rate: n === 0 ? null : rate(secondYes, n),
    unavailable: list.filter((p) => p.outcome === 'unavailable').length,
  }
}

function judgeBreakdown(runs: RunRecord[]): Pick<Report, 'judge_by_rule' | 'judge_by_polarity'> {
  const all = runs.flatMap((r) => r.judge_pairs ?? [])
  const rules = [...new Set(all.map((p) => p.rule_id))].sort()
  return {
    judge_by_rule: rules.map((rule_id) => {
      const list = all.filter((p) => p.rule_id === rule_id)
      return { rule_id, polarity: list[0]!.polarity, ...agreementCell(list) }
    }),
    judge_by_polarity: { presence: agreementCell(all.filter((p) => p.polarity === 'presence')), absence: agreementCell(all.filter((p) => p.polarity === 'absence')) },
  }
}

export function buildReport(entries: Entry[], meta: ReportMeta): Report {
  const runs = entries.map((e) => e.record)
  const agg = aggregate(entries.map(summaryOf))
  const countBy = (key: (r: RunRecord) => string): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const r of runs) out[key(r)] = (out[key(r)] ?? 0) + 1
    return sorted(out)
  }

  const status_mix = { ...agg.runs_by_status, hold: runs.filter((r) => r.held.length > 0).length }

  const findingLevel: Record<string, number> = {}
  for (const r of runs) sumInto(findingLevel, r.abstentions)

  const heldBy = new Map<string, { procedure_group: string; finding_type: string; n: number }>()
  let heldTotal = 0
  for (const r of runs) {
    for (const h of r.held) {
      heldTotal += 1
      const key = `${h.procedure_group}|${h.finding_type}`
      const row = heldBy.get(key) ?? { procedure_group: h.procedure_group, finding_type: h.finding_type, n: 0 }
      row.n += 1
      heldBy.set(key, row)
    }
  }

  const groupType = new Map<string, { procedure_group: string; finding_type: string; n: number; knee_group: boolean }>()
  const doctorType = new Map<string, { doctor_uid: string; finding_type: string; n: number }>()
  for (const row of agg.by_doctor_procedure_type) {
    const g = groupType.get(`${row.procedure_group}|${row.finding_type}`) ?? { procedure_group: row.procedure_group, finding_type: row.finding_type, n: 0, knee_group: KNEE_GROUPS.includes(row.procedure_group) }
    g.n += row.n
    groupType.set(`${row.procedure_group}|${row.finding_type}`, g)
    const uid = row.doctor_uid ?? '(none)'
    const d = doctorType.get(`${uid}|${row.finding_type}`) ?? { doctor_uid: uid, finding_type: row.finding_type, n: 0 }
    d.n += row.n
    doctorType.set(`${uid}|${row.finding_type}`, d)
  }

  const pairs = runs.flatMap((r) => r.pairs)
  const bin = pairs.map((p): [boolean, boolean] => [p.jev_p >= AGREEMENT_THRESHOLD, p.gemini_p >= AGREEMENT_THRESHOLD])
  const nAgree = bin.filter(([a, b]) => a === b).length
  const kappa = cohenKappa(bin)
  const judge_agreement = {
    n_both: pairs.length,
    n_agree: nAgree,
    agreement: pairs.length === 0 ? null : nAgree / pairs.length,
    kappa,
    threshold: AGREEMENT_THRESHOLD,
    label: pairs.length === 0 ? NO_SECOND : kappa === null ? 'n/a (undefined: a judge never varies)' : fmt(kappa),
  }

  const dropsBy: Record<string, number> = {}
  let factsTotal = 0
  let factsDropped = 0
  const served: Record<string, number> = {}
  let llm = 0
  let jev = 0
  const empties: Record<string, number> = {}
  for (const r of runs) {
    sumInto(dropsBy, r.counts.drops)
    factsTotal += r.counts.facts_total
    factsDropped += r.counts.facts_dropped
    llm += r.counts.llm_calls
    jev += r.counts.jev_calls
    for (const id of (r.versions.models ?? '').split(',').filter((s) => s !== '')) served[id] = (served[id] ?? 0) + 1
    if (r.status === 'empty') empties[r.reason ?? 'unspecified'] = (empties[r.reason ?? 'unspecified'] ?? 0) + 1
  }

  const kept: Report['examples']['kept'] = {}
  for (const [type, list] of Object.entries(agg.example_findings)) {
    kept[type] = list.map((f) => ({
      encounter_id: f.encounter_id,
      doctor_uid: f.doctor_uid,
      procedure_group: f.procedure_group,
      rule_id: f.rule_id,
      judge: { primary_p: f.judge.jev_p as number, second_p: f.judge.gemini_p },
      evidence: f.evidence.map((e) => ({ segment_id: e.segment_id, role: e.role, t0: e.t0, t1: e.t1, quote: e.quote })),
    }))
  }
  const heldEx: Report['examples']['held'] = {}
  for (const e of entries) {
    for (const h of e.held) {
      const list = (heldEx[h.finding_type] ??= [])
      if (list.length < EXAMPLES_PER_TYPE) list.push({ encounter_id: e.record.encounter_id, procedure_group: h.procedure_group, rule_id: h.rule_id, primary_p: h.primary_p, evidence: h.evidence })
    }
  }

  return {
    meta,
    consults: {
      read_lines: meta.lines_read,
      rejected: meta.rejects,
      run: runs.length,
      skipped_for_cap: meta.skipped_for_cap,
      by_source: countBy((r) => r.source),
      by_match_confidence: countBy((r) => r.match_confidence),
      by_window_complete: countBy((r) => String(r.window_complete)),
    },
    status_mix,
    abstentions: {
      rate: rate(agg.abstention.n_abstained, agg.abstention.n_runs),
      abstained_runs: agg.abstention.n_abstained,
      runs: agg.abstention.n_runs,
      run_level_by_reason: agg.abstention.by_reason,
      finding_level_by_reason: sorted(findingLevel),
    },
    held: {
      findings: heldTotal,
      consults: status_mix.hold,
      by_group_type: [...heldBy.values()].sort(byGroupThenType),
      note: 'Held for want of a second judge. Not a verdict, never listed as a finding.',
    },
    findings: {
      kept: agg.by_type.reduce((s, t) => s + t.n, 0),
      by_type: agg.by_type,
      by_group_type: [...groupType.values()].sort(byGroupThenType),
      by_doctor_type: [...doctorType.values()]
        .sort((a, b) => cmp(a.doctor_uid, b.doctor_uid) || cmp(a.finding_type, b.finding_type))
        .map((d) => ({ ...d, small_n: d.n < SMALL_N })),
    },
    judge_agreement,
    ...judgeBreakdown(runs),
    drops: { duplicate_span_different_fields: dropsBy.duplicate_span_different_fields ?? 0, by_reason: sorted(dropsBy) },
    extraction: { facts_total: factsTotal, facts_dropped: factsDropped, drop_rate: rate(factsDropped, factsTotal) },
    models: { extraction: extractionRows(runs), served_by_consults: sorted(served), llm_calls: llm, judge_asks: jev, metered: meta.metered, caps: meta.caps },
    empty_reasons: sorted(empties),
    examples: { kept, held: heldEx },
  }
}

// ---- bus-safe block ---------------------------------------------------------------------------------------------------

const pairs = (o: Record<string, number>): string => (Object.keys(o).length === 0 ? 'none' : Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' '))

const cellNum = (n: number | null): string => (n === null ? 'n/a' : fmt(n))
/** `<polarity>: pairs agree kappa jev_yes_rate second_yes_rate`, counts and rates only. */
function polarityLine(polarity: string, c: AgreementCell): string {
  return `judge_${polarity}: pairs=${c.pairs} agree=${cellNum(c.agreement)} kappa=${cellNum(c.kappa)} jev_yes_rate=${cellNum(c.jev_yes_rate)} second_yes_rate=${cellNum(c.second_yes_rate)}`
}

/** `extraction_model=<short intended id(s)> served_verified=yes|no`. Dated ids are shortened; `yes` needs every extraction call's served id present. */
function extractionLine(r: Report): string {
  const rows = r.models.extraction
  const ids = [...new Set(rows.flatMap((x) => x.intended.split(',')).map(shortModelId))].sort()
  const verified = rows.length > 0 && rows.every((x) => x.served_verified)
  return `extraction_model=${ids.length === 0 ? 'none' : ids.join(',')} served_verified=${verified ? 'yes' : 'no'}`
}

/** Counts and short model ids only; consult ids, doctor ids and quotes never appear. */
export function busSafeText(r: Report): string {
  const s = r.status_mix
  return [
    `S6 offline run (${r.meta.mode}): lines_read=${r.consults.read_lines} run=${r.consults.run} skipped_for_cap=${r.consults.skipped_for_cap} rejected: ${pairs(r.consults.rejected)}`,
    `by_source: ${pairs(r.consults.by_source)}; by_match: ${pairs(r.consults.by_match_confidence)}; by_window_complete: ${pairs(r.consults.by_window_complete)}`,
    `status: ok=${s.ok} empty=${s.empty} abstained=${s.abstained} unavailable=${s.unavailable} failed=${s.failed} hold_consults=${s.hold}`,
    `findings_kept=${r.findings.kept} (${pairs(Object.fromEntries(r.findings.by_type.map((t) => [t.finding_type, t.n])))}); held_findings=${r.held.findings}`,
    `abstention_rate=${fmt(r.abstentions.rate)} (${r.abstentions.abstained_runs}/${r.abstentions.runs}); by_reason: ${pairs(r.abstentions.finding_level_by_reason)}`,
    `empty_reasons: ${pairs(r.empty_reasons)}`,
    `judge_kappa=${r.judge_agreement.label} n_both=${r.judge_agreement.n_both}`,
    ...(['presence', 'absence'] as const).map((k) => polarityLine(k, r.judge_by_polarity[k])),
    `drops_duplicate_span_different_fields=${r.drops.duplicate_span_different_fields}; extraction_drop_rate=${fmt(r.extraction.drop_rate)}`,
    extractionLine(r),
    `llm_calls=${r.models.llm_calls}; jev_asks=${r.models.metered.jev}; second_judge_asks=${r.models.metered.second}; judge_asks_platform_sum=${r.models.judge_asks}; stopped_by_cap=${r.meta.stopped_by_cap ?? 'no'}`,
  ].join('\n')
}

/** The block, or a refusal line if it carries a digit run of 8 or more, a quote, or an id from the entries. */
export function busSafeSummary(r: Report, entries: Entry[]): string {
  const text = busSafeText(r)
  if (/\d{8,}/.test(text)) return 'BUS-SAFE BLOCK WITHHELD (digit run)'
  const secrets = new Set<string>()
  for (const e of entries) {
    secrets.add(e.record.encounter_id)
    if (e.record.doctor_uid !== null) secrets.add(e.record.doctor_uid)
    for (const f of e.body?.findings ?? []) for (const ev of f.evidence) secrets.add(ev.quote)
    for (const h of e.held) for (const ev of h.evidence) secrets.add(ev.quote)
  }
  for (const secret of secrets) if (secret.length > 0 && text.includes(secret)) return 'BUS-SAFE BLOCK WITHHELD (id or quote)'
  return text
}

// ---- markdown ---------------------------------------------------------------------------------------------------------

const table = (head: string[], rows: Array<Array<string | number>>): string =>
  rows.length === 0 ? '(none)\n' : [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n') + '\n'

export function renderMarkdown(r: Report, entries: Entry[]): string {
  const out: string[] = []
  out.push('# audit.consult S6 offline report', '', '## Bus-safe summary (counts only; may be posted as is)', '', '```', busSafeSummary(r, entries), '```', '')
  out.push('Everything below stays on t4: it carries quotes and ids. Finding ids and consult or doctor ids are never posted.', '')
  out.push('## Findings by procedure group and type (knee groups first)', '', table(['procedure_group', 'finding_type', 'n'], r.findings.by_group_type.map((x) => [x.procedure_group, x.finding_type, x.n])))
  out.push('## Findings by doctor_uid and type', '', table(['doctor_uid', 'finding_type', 'n', 'small_n'], r.findings.by_doctor_type.map((x) => [x.doctor_uid, x.finding_type, x.n, x.small_n ? `yes (<${SMALL_N})` : 'no'])))
  out.push('## Status mix', '', table(['status', 'consults'], Object.entries(r.status_mix)))
  out.push('## Abstentions', '', `Abstention rate: ${fmt(r.abstentions.rate)} (${r.abstentions.abstained_runs} of ${r.abstentions.runs} consults).`, '', 'Run-level reasons:', '', table(['reason', 'n'], Object.entries(r.abstentions.run_level_by_reason)), 'Finding- and run-level reasons (queue):', '', table(['reason', 'n'], Object.entries(r.abstentions.finding_level_by_reason)))
  out.push('## Held (no second judge)', '', r.held.note, '', `Held findings: ${r.held.findings} in ${r.held.consults} consults.`, '', table(['procedure_group', 'finding_type', 'n'], r.held.by_group_type.map((x) => [x.procedure_group, x.finding_type, x.n])))
  out.push('## Judge agreement (Jev vs second judge)', '', `Kappa: ${r.judge_agreement.label}. Pairs: ${r.judge_agreement.n_both}, agree: ${r.judge_agreement.n_agree}, threshold ${r.judge_agreement.threshold}.`, r.judge_agreement.agreement === null ? `Agreement: ${NO_SECOND}` : `Agreement: ${fmt(r.judge_agreement.agreement)}`, '')
  const cellRow = (label: string, c: AgreementCell): Array<string | number> => [label, c.pairs, c.both_yes, c.jev_yes_second_no, c.jev_no_second_yes, c.both_no, cellNum(c.agreement), cellNum(c.kappa), cellNum(c.jev_yes_rate), cellNum(c.second_yes_rate), c.unavailable]
  const cellHead = ['pairs', 'both yes', 'Jev yes / 2nd no', 'Jev no / 2nd yes', 'both no', 'agreement', 'kappa', 'Jev yes rate', '2nd yes rate', 'unavailable']
  out.push('## Judge agreement by polarity', '', 'Yes means p at or above the platform threshold (safety 0.9, other 0.75). Absence rules are asked "is the claim true given the whole consult"; presence rules "do the quoted words support the claim".', '', table(['polarity', ...cellHead], [cellRow('presence', r.judge_by_polarity.presence), cellRow('absence', r.judge_by_polarity.absence)]))
  out.push('## Judge agreement by rule', '', table(['rule_id', 'polarity', ...cellHead], r.judge_by_rule.map((x) => [x.rule_id, x.polarity, ...cellRow('', x).slice(1)])))
  out.push('## Extraction', '', `Facts total ${r.extraction.facts_total}, dropped ${r.extraction.facts_dropped}, drop rate ${fmt(r.extraction.drop_rate)}.`, '', `drops.duplicate_span_different_fields: ${r.drops.duplicate_span_different_fields}`, '', table(['drop reason', 'n'], Object.entries(r.drops.by_reason)))
  out.push('## Empty reasons', '', table(['reason', 'consults'], Object.entries(r.empty_reasons)))
  out.push('## Models and calls', '', '### Extraction model', '', table(['intended model id', 'served model id', 'consults', 'calls', 'errors by type'], r.models.extraction.map((x) => [x.intended, x.served ?? 'unverified: profile not resolved', x.consults, x.calls, pairs(x.errors_by_type)])), '### Judge served model ids', '', table(['served model id', 'consults'], Object.entries(r.models.served_by_consults)), `Extraction calls: ${r.models.llm_calls}. Judge asks, primary + second (platform sum): ${r.models.judge_asks}. Metered: extraction ${r.models.metered.llm}, Jev (primary) asks ${r.models.metered.jev}, second-judge asks ${r.models.metered.second}. Caps: llm ${r.models.caps.llm}, jev ${r.models.caps.jev}.`, '')
  out.push('## Example findings for review (up to 3 per type)', '')
  const ev = (e: { segment_id: string; t0: number; t1: number; quote: string }): string => `  - ${e.segment_id} [${e.t0}-${e.t1}s]: "${e.quote}"`
  for (const [type, list] of Object.entries(r.examples.kept)) {
    out.push(`### ${type}`, '')
    for (const x of list) out.push(`- ${x.encounter_id} (${x.procedure_group}, ${x.rule_id}) jev_p=${fmt(x.judge.primary_p)} second_p=${x.judge.second_p === null ? 'n/a' : fmt(x.judge.second_p)}`, ...x.evidence.map(ev))
    out.push('')
  }
  out.push('## Held examples (single judge, NOT verdicts)', '')
  for (const [type, list] of Object.entries(r.examples.held)) {
    out.push(`### ${type}`, '')
    for (const x of list) out.push(`- ${x.encounter_id} (${x.procedure_group}, ${x.rule_id}) jev_p=${x.primary_p === null ? 'n/a' : fmt(x.primary_p)}`, ...x.evidence.map(ev))
    out.push('')
  }
  return out.join('\n') + '\n'
}

// ---- rebuild from an out dir ------------------------------------------------------------------------------------------

export function loadEntries(outDir: string): Entry[] {
  const records = readFileSync(path.join(outDir, 'runs.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as RunRecord)
  const read = <T>(sub: string, id: string): T | null => {
    const file = path.join(outDir, sub, `${id}.json`)
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null
  }
  return records.map((record) => ({ record, body: read<GovernanceBodyLike>('governance', record.encounter_id), held: read<HeldDetail[]>('held', record.encounter_id) ?? [] }))
}

export const listGovernanceFiles = (outDir: string): string[] => readdirSync(path.join(outDir, 'governance')).sort()
export { RUN_STATUSES }
