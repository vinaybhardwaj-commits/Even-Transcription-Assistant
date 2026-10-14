import { activeThresholds } from '../decide/thresholds.js'
import { classifyAveraged } from '../decide/client.js'
import { questionsFor } from '../decide/questions.js'
import type { JevTransport } from '../decide/transport.js'
import { validateModel } from '../facts/validate.js'
import type { ClinicalState } from '../facts/schema.js'
import { scriptedModelPayload } from '../llm/scripted-note.js'
import { decisionState } from '../pipeline/audit.js'
import { scoreFindings, type FindingDraft } from '../rules/pack.js'
import { assertGoldFrozen, type GoldFile } from './gold.js'

/** A claim none of the gold notes support. Quotes stay the note's real quotes. */
export const UNSUPPORTED_CLAIM =
  'Aspirin 300 mg and digoxin are prescribed together, and a cephalosporin allergy is recorded.'

export interface Distribution {
  n: number
  min: number | null
  p50: number | null
  max: number | null
  mean: number | null
  below_safety_bar: number | null
  at_or_above_safety_bar: number | null
}

export interface CalibrationRow {
  case_id: string
  rule_id: string
  label: 'valid' | 'invalid'
  safety_class: boolean
  p_yes: number | null
}

export interface CalibrationReport {
  status: 'measured' | 'not_configured' | 'error' | 'gold_rejected'
  model_requested: string | null
  served_models: string[]
  safety_bar: number
  probability_field: 'probabilities.yes'
  averaged_option_orders: true
  valid: Distribution
  valid_safety: Distribution
  invalid: Distribution
  missing_expected: { case_id: string; rule_id: string }[]
  cases: CalibrationRow[]
  error_type?: string
}

interface PreparedCase {
  caseId: string
  state: ClinicalState
  findings: FindingDraft[]
  twins: FindingDraft[]
  missing: string[]
}

export function unsupportedTwin(source: FindingDraft): FindingDraft {
  return {
    id: `unsupported-${source.id}`,
    rule_id: 'planted.unsupported',
    rule_version: '0',
    severity: 'critical',
    safety_class: true,
    summary: UNSUPPORTED_CLAIM,
    evidence_fact_refs: [],
    evidence_keys: ['planted:unsupported'],
    evidence: source.evidence.map((item) => ({ quote: item.quote, start: item.start, end: item.end })),
  }
}

export async function calibrateValidity(
  doc: GoldFile,
  transport: JevTransport | null,
  options: { model: string | null; traceId: string },
): Promise<CalibrationReport> {
  const safetyBar = activeThresholds(0).safetyAbstainBelow
  const frozen = assertGoldFrozen(doc)
  if (!frozen.ok) {
    return emptyReport('gold_rejected', options.model, safetyBar, frozen.reason)
  }
  const prepared: PreparedCase[] = []
  for (const goldCase of doc.cases) {
    const validated = validateModel(scriptedModelPayload(goldCase.body), goldCase.body)
    if (!validated.ok) {
      return emptyReport('error', options.model, safetyBar, 'extraction_failed')
    }
    const findings = scoreFindings(validated.state)
    const twins = calibrationSubjects(goldCase.id, validated.state, findings).filter(
      (finding) => finding.rule_id === 'planted.unsupported',
    )
    const raised = new Set(findings.map((finding) => finding.rule_id))
    prepared.push({
      caseId: goldCase.id,
      state: validated.state,
      findings,
      twins,
      missing: goldCase.expected_safety_rule_ids.filter((ruleId) => !raised.has(ruleId)),
    })
  }
  const missing = prepared.flatMap((item) => item.missing.map((ruleId) => ({ case_id: item.caseId, rule_id: ruleId })))
  if (!transport) {
    const rows = plannedRows(prepared)
    return report('not_configured', options.model, [], safetyBar, rows, missing)
  }
  const served = new Set<string>()
  const rows: CalibrationRow[] = []
  for (const item of prepared) {
    const subjects = [...item.findings, ...item.twins]
    if (subjects.length === 0) continue
    const classified = await classifyAveraged(transport, {
      traceId: options.traceId,
      state: decisionState(item.state, item.findings),
      questions: questionsFor(subjects),
    })
    if (classified.status !== 'ok') {
      const errorType = 'error' in classified ? classified.error.type : classified.status
      const partial = report('error', options.model, [...served], safetyBar, rows, missing)
      return { ...partial, error_type: errorType }
    }
    for (const modelId of classified.data.servedModelIds) served.add(modelId)
    for (const subject of subjects) {
      const answer = classified.data.answers.find((row) => row.finding_id === subject.id && row.question_id === 'validity')
      const label = subject.rule_id === 'planted.unsupported' ? 'invalid' : 'valid'
      rows.push({
        case_id: item.caseId,
        rule_id: subject.rule_id,
        label,
        safety_class: subject.safety_class,
        p_yes: answer ? round4(answer.probabilities.yes ?? 0) : null,
      })
    }
  }
  return report('measured', options.model, [...served], safetyBar, rows, missing)
}

export function calibrationSubjects(caseId: string, state: ClinicalState, findings: FindingDraft[]): FindingDraft[] {
  if (findings.length > 0) return [...findings, ...findings.map((finding) => unsupportedTwin(finding))]
  const quotes = quotesFrom(state)
  if (quotes.length === 0) return []
  return [
    unsupportedTwin({
      id: caseId,
      rule_id: 'planted.unsupported',
      rule_version: '0',
      severity: 'critical',
      safety_class: true,
      summary: UNSUPPORTED_CLAIM,
      evidence_fact_refs: [],
      evidence_keys: [],
      evidence: quotes,
    }),
  ]
}

function quotesFrom(state: ClinicalState): FindingDraft['evidence'] {
  const quotes = [
    ...state.medications.map((item) => item.span),
    ...state.diagnoses.map((item) => item.span),
    ...state.plan.map((item) => item.span),
  ]
  return quotes.slice(0, 4).map((span) => ({ quote: span.quote, start: span.start, end: span.end }))
}

function plannedRows(prepared: PreparedCase[]): CalibrationRow[] {
  const rows: CalibrationRow[] = []
  for (const item of prepared) {
    for (const finding of item.findings) {
      rows.push({ case_id: item.caseId, rule_id: finding.rule_id, label: 'valid', safety_class: finding.safety_class, p_yes: null })
    }
    for (const twin of item.twins) {
      rows.push({ case_id: item.caseId, rule_id: twin.rule_id, label: 'invalid', safety_class: twin.safety_class, p_yes: null })
    }
  }
  return rows
}

function report(
  status: CalibrationReport['status'],
  model: string | null,
  served: string[],
  safetyBar: number,
  rows: CalibrationRow[],
  missing: CalibrationReport['missing_expected'],
): CalibrationReport {
  const ordered = [...rows].sort((a, b) => `${a.case_id}:${a.label}:${a.rule_id}`.localeCompare(`${b.case_id}:${b.label}:${b.rule_id}`))
  const valid = ordered.filter((row) => row.label === 'valid')
  return {
    status,
    model_requested: model,
    served_models: served,
    safety_bar: safetyBar,
    probability_field: 'probabilities.yes',
    averaged_option_orders: true,
    valid: summarize(valid.map((row) => row.p_yes), safetyBar),
    valid_safety: summarize(valid.filter((row) => row.safety_class).map((row) => row.p_yes), safetyBar),
    invalid: summarize(ordered.filter((row) => row.label === 'invalid').map((row) => row.p_yes), safetyBar),
    missing_expected: missing,
    cases: ordered,
  }
}

function emptyReport(status: 'error' | 'gold_rejected', model: string | null, safetyBar: number, errorType: string): CalibrationReport {
  const base = report(status, model, [], safetyBar, [], [])
  return { ...base, error_type: errorType }
}

export function summarize(values: Array<number | null>, safetyBar: number): Distribution {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (present.length === 0) {
    return {
      n: values.length,
      min: null,
      p50: null,
      max: null,
      mean: null,
      below_safety_bar: null,
      at_or_above_safety_bar: null,
    }
  }
  const sorted = [...present].sort((a, b) => a - b)
  const mid = sorted[Math.ceil(sorted.length / 2) - 1] ?? null
  const mean = present.reduce((sum, value) => sum + value, 0) / present.length
  return {
    n: present.length,
    min: sorted[0] ?? null,
    p50: mid,
    max: sorted[sorted.length - 1] ?? null,
    mean: round4(mean),
    below_safety_bar: present.filter((value) => value < safetyBar).length,
    at_or_above_safety_bar: present.filter((value) => value >= safetyBar).length,
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
