import type { FindingDraft } from '../rules/pack.js'
import { asksRouteQuestion } from './questions.js'
import type { Thresholds } from './thresholds.js'

export const CRITICAL_ROUTE_RATIONALE =
  'A critical finding with validity at or above the safety bar is routed to the doctor. The route question was not asked.'

export interface ProbabilityAnswer {
  finding_id: string
  question_id: 'validity' | 'route'
  probabilities: Record<string, number>
}

export interface AppliedDecision {
  finding_id: string
  question_id: 'validity' | 'route'
  probabilities: Record<string, number>
  top_label: string
  top_probability: number
  outcome: 'resolve' | 'abstain'
  action: 'valid' | 'route' | 'hold' | 'drop_informational' | 'suppressed_invalid' | 'abstain'
  rationale: string
  safety_class: boolean
}

export interface AppliedFinding {
  finding: FindingDraft
  decisions: AppliedDecision[]
  doctor_visible: boolean
  action: AppliedDecision['action']
  queue: boolean
  queue_reason: string | null
}

function topOf(probabilities: Record<string, number>): { label: string; p: number } {
  let label = ''
  let p = -1
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > p) {
      label = key
      p = value
    }
  }
  return { label, p }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export function averageProbabilities(left: Record<string, number>, right: Record<string, number>): Record<string, number> {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const merged: Record<string, number> = {}
  let sum = 0
  for (const key of keys) {
    const value = ((left[key] ?? 0) + (right[key] ?? 0)) / 2
    merged[key] = value
    sum += value
  }
  if (sum <= 0) return merged
  const out: Record<string, number> = {}
  for (const key of keys) out[key] = round4((merged[key] ?? 0) / sum)
  return out
}

export function applyDecisions(findings: FindingDraft[], answers: ProbabilityAnswer[], thresholds: Thresholds): AppliedFinding[] {
  return findings.map((finding) => {
    const bar = finding.safety_class ? thresholds.safetyAbstainBelow : thresholds.nonSafetyAbstainBelow
    const validity = answers.find((answer) => answer.finding_id === finding.id && answer.question_id === 'validity')
    const route = answers.find((answer) => answer.finding_id === finding.id && answer.question_id === 'route')
    if (!validity || (asksRouteQuestion(finding.severity) && !route)) {
      throw new Error(`incomplete decision for finding ${finding.id}`)
    }
    const validityTop = topOf(validity.probabilities)
    const routeTop = route ? topOf(route.probabilities) : null
    const validityOutcome = validityTop.p < bar ? 'abstain' : 'resolve'
    const routeOutcome = routeTop && routeTop.p < bar ? 'abstain' : 'resolve'
    const decisions: AppliedDecision[] = []

    if (validityOutcome === 'abstain') {
      decisions.push(decision(finding, 'validity', validity.probabilities, validityTop, 'abstain', 'abstain', bar))
      if (route && routeTop && asksRouteQuestion(finding.severity)) {
        decisions.push(decision(finding, 'route', route.probabilities, routeTop, routeOutcome, routeOutcome === 'abstain' ? 'abstain' : routeAction(routeTop.label), bar))
      }
      return {
        finding,
        decisions,
        doctor_visible: false,
        action: 'abstain',
        queue: true,
        queue_reason: 'validity probability is below the abstention threshold',
      }
    }

    if (validityTop.label !== 'yes') {
      decisions.push(decision(finding, 'validity', validity.probabilities, validityTop, 'resolve', 'suppressed_invalid', bar))
      if (route && routeTop && asksRouteQuestion(finding.severity)) {
        decisions.push(decision(finding, 'route', route.probabilities, routeTop, routeOutcome, routeOutcome === 'abstain' ? 'abstain' : routeAction(routeTop.label), bar))
      }
      return {
        finding,
        decisions,
        doctor_visible: false,
        action: 'suppressed_invalid',
        queue: false,
        queue_reason: null,
      }
    }

    decisions.push(decision(finding, 'validity', validity.probabilities, validityTop, 'resolve', 'valid', bar))

    if (!asksRouteQuestion(finding.severity)) {
      decisions.push(policyRoute(finding))
      return {
        finding,
        decisions,
        doctor_visible: true,
        action: 'route',
        queue: false,
        queue_reason: null,
      }
    }

    if (!route || !routeTop) throw new Error(`incomplete decision for finding ${finding.id}`)

    if (routeOutcome === 'abstain') {
      decisions.push(decision(finding, 'route', route.probabilities, routeTop, 'abstain', 'abstain', bar))
      return {
        finding,
        decisions,
        doctor_visible: false,
        action: 'abstain',
        queue: true,
        queue_reason: 'route probability is below the abstention threshold',
      }
    }

    if (routeTop.label === 'drop_informational' && finding.safety_class) {
      decisions.push(
        decision(
          finding,
          'route',
          route.probabilities,
          routeTop,
          'abstain',
          'abstain',
          bar,
          'safety-class findings are never auto-dropped',
        ),
      )
      return {
        finding,
        decisions,
        doctor_visible: false,
        action: 'abstain',
        queue: true,
        queue_reason: 'safety-class finding was not auto-dropped',
      }
    }

    const action = routeAction(routeTop.label)
    decisions.push(decision(finding, 'route', route.probabilities, routeTop, 'resolve', action, bar))
    return {
      finding,
      decisions,
      doctor_visible: action === 'route',
      action,
      queue: false,
      queue_reason: null,
    }
  })
}

function policyRoute(finding: FindingDraft): AppliedDecision {
  return {
    finding_id: finding.id,
    question_id: 'route',
    probabilities: { route: 1, hold: 0, drop_informational: 0 },
    top_label: 'route',
    top_probability: 1,
    outcome: 'resolve',
    action: 'route',
    rationale: CRITICAL_ROUTE_RATIONALE,
    safety_class: finding.safety_class,
  }
}

function routeAction(label: string): 'route' | 'hold' | 'drop_informational' | 'abstain' {
  if (label === 'route' || label === 'hold' || label === 'drop_informational') return label
  return 'abstain'
}

function decision(
  finding: FindingDraft,
  questionId: 'validity' | 'route',
  probabilities: Record<string, number>,
  top: { label: string; p: number },
  outcome: 'resolve' | 'abstain',
  action: AppliedDecision['action'],
  bar: number,
  rationale?: string,
): AppliedDecision {
  return {
    finding_id: finding.id,
    question_id: questionId,
    probabilities,
    top_label: top.label,
    top_probability: round4(top.p),
    outcome,
    action,
    rationale: rationale ?? `${questionId} top probability ${round4(top.p)} against threshold ${bar}`,
    safety_class: finding.safety_class,
  }
}
