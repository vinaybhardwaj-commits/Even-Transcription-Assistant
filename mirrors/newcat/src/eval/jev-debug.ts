import { averageProbabilities } from '../decide/apply.js'
import { reverseQuestion, questionsFor, type JevQuestion } from '../decide/questions.js'
import {
  buildSystemOneRequest,
  mapSystemOneResponse,
  systemOneUrl,
  type JevAnswer,
} from '../decide/transport.js'
import { validateModel } from '../facts/validate.js'
import { scriptedModelPayload } from '../llm/scripted-note.js'
import { decisionState } from '../pipeline/audit.js'
import { scoreFindings } from '../rules/pack.js'
import { calibrationSubjects } from './jev-calibration.js'
import type { GoldFile } from './gold.js'

interface DebugStep {
  question_id: string
  rule_id: string
  answer_type: string | null
  raw_noul: number | null
  raw_probability_yes: number | null
  raw_probability_sum: number | null
  normalized_p_yes: number
}

interface DebugOrder {
  order: 'forward' | 'reverse'
  request: {
    url: string
    method: 'POST'
    headers: { Authorization: 'Bearer <redacted>'; 'Content-Type': 'application/json' }
    body: ReturnType<typeof buildSystemOneRequest>
  }
  raw_response: unknown
  derived_p_yes: DebugStep[]
}

export interface JevDebugReport {
  fixture_id: string
  requested_model: string
  orders: DebugOrder[]
  averaged_p_yes: { question_id: string; rule_id: string; forward: number; reverse: number; average: number }[]
}

export async function debugFixture(
  doc: GoldFile,
  fixtureId: string,
  config: { baseUrl: string; apiKey: string; model: string },
  fetchImpl: typeof fetch = fetch,
): Promise<JevDebugReport> {
  const fixture = doc.cases.find((item) => item.id === fixtureId)
  if (!fixture) throw new Error(`unknown fixture: ${fixtureId}`)
  const validated = validateModel(scriptedModelPayload(fixture.body), fixture.body)
  if (!validated.ok) throw new Error('fixture extraction failed')
  const findings = scoreFindings(validated.state)
  const subjects = calibrationSubjects(fixture.id, validated.state, findings)
  const state = decisionState(validated.state, findings)
  const forward = questionsFor(subjects)
  const orders: DebugOrder[] = []

  for (const [order, questions] of [
    ['forward', forward],
    ['reverse', forward.map((question) => reverseQuestion(question))],
  ] as const) {
    const body = buildSystemOneRequest(config.model, state, questions)
    const request = {
      url: systemOneUrl(config.baseUrl),
      method: 'POST' as const,
      headers: {
        Authorization: 'Bearer <redacted>' as const,
        'Content-Type': 'application/json' as const,
      },
      body,
    }
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      raw = text
    }
    if (!response.ok) {
      orders.push({ order, request, raw_response: raw, derived_p_yes: [] })
      continue
    }
    const mapped = mapSystemOneResponse(questions, raw)
    orders.push({
      order,
      request,
      raw_response: raw,
      derived_p_yes: validitySteps(questions, raw, mapped.answers),
    })
  }

  const left = orders.find((item) => item.order === 'forward')
  const right = orders.find((item) => item.order === 'reverse')
  const averaged = (left?.derived_p_yes ?? []).flatMap((step) => {
    const reverse = right?.derived_p_yes.find((item) => item.question_id === step.question_id)
    if (!reverse) return []
    const probabilities = averageProbabilities(
      { yes: step.normalized_p_yes, no: 1 - step.normalized_p_yes },
      { yes: reverse.normalized_p_yes, no: 1 - reverse.normalized_p_yes },
    )
    return [
      {
        question_id: step.question_id,
        rule_id: step.rule_id,
        forward: step.normalized_p_yes,
        reverse: reverse.normalized_p_yes,
        average: probabilities.yes ?? 0,
      },
    ]
  })
  return { fixture_id: fixtureId, requested_model: config.model, orders, averaged_p_yes: averaged }
}

function validitySteps(questions: JevQuestion[], raw: unknown, mapped: JevAnswer[]): DebugStep[] {
  const answers = asAnswers(raw)
  return questions
    .filter((question) => question.id.endsWith(':validity'))
    .flatMap((question) => {
      const answer = answers[question.id]
      const normalized = mapped.find((item) => item.question_id === question.id)?.probabilities.yes
      if (normalized === undefined) return []
      const rawProbabilities =
        answer && typeof answer === 'object' && 'probabilities' in answer && isNumberRecord(answer.probabilities)
          ? answer.probabilities
          : null
      const rawNoul =
        answer && typeof answer === 'object' && 'noul' in answer && typeof answer.noul === 'number'
          ? answer.noul
          : null
      return [
        {
          question_id: question.id,
          rule_id: question.context?.rule_id ?? 'unknown',
          answer_type:
            answer && typeof answer === 'object' && 'type' in answer && typeof answer.type === 'string'
              ? answer.type
              : null,
          raw_noul: rawNoul,
          raw_probability_yes: rawProbabilities?.yes ?? rawNoul,
          raw_probability_sum: rawProbabilities
            ? Object.values(rawProbabilities).reduce((sum, value) => sum + value, 0)
            : rawNoul === null
              ? null
              : 1,
          normalized_p_yes: normalized,
        },
      ]
    })
}

function asAnswers(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || !('answers' in raw)) return {}
  const answers = raw.answers
  return answers && typeof answers === 'object' && !Array.isArray(answers)
    ? (answers as Record<string, unknown>)
    : {}
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((item) => typeof item === 'number')
  )
}
