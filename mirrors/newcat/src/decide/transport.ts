import { z } from 'zod'
import type { Sql } from '../db/sql.js'
import type { StageOutcome } from '../outcome.js'
import { chargeBudget, recordModelCall } from '../llm/ledger.js'
import { estimateCost } from '../llm/prices.js'
import { ROUTE_RUBRIC, VALIDITY_RUBRIC, type JevQuestion } from './questions.js'

export interface JevCall {
  traceId: string
  purpose: string
  state: unknown
  questions: JevQuestion[]
  optionOrder: 'forward' | 'reverse'
}

export interface JevAnswer {
  question_id: string
  probabilities: Record<string, number>
}

export interface JevTransport {
  classify(call: JevCall): Promise<StageOutcome<{ servedModelId: string; answers: JevAnswer[] }>>
}

const SCHEMA_MESSAGE = 'The decision service returned an unexpected payload.'

/** Thrown when a System One body cannot be mapped onto the closed option set. The message never includes the body. */
export class JevSchemaError extends Error {
  readonly type = 'invalid_provider_payload' as const
  constructor() {
    super(SCHEMA_MESSAGE)
    this.name = 'JevSchemaError'
  }
}

const UsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .strict()

const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number() }).strict()
const ChoiceAnswerSchema = z
  .object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  })
  .strict()
const ScoreAnswerSchema = z
  .object({
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  })
  .strict()

const AnswerSchema = z.discriminatedUnion('type', [NoulAnswerSchema, ChoiceAnswerSchema, ScoreAnswerSchema])

const ResponseSchema = z
  .object({
    model: z.string().min(1),
    answers: z.record(z.string(), AnswerSchema),
    usage: UsageSchema.optional(),
  })
  .strict()

type SystemOneAnswer = z.infer<typeof AnswerSchema>

type WireInstructions = string | { question: string; rule_id: string; claim: string; quotes: string[] }

type WireQuestion =
  | { type: 'noul'; instructions: WireInstructions; criteria: { true: string; false: string } | null }
  | { type: 'choice'; instructions: WireInstructions; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: WireInstructions; criteria: string[] }

/**
 * TypeSafe System One. `JEV_BASE_URL` is the origin only (`https://api.typesafe.ai`).
 * POST {base}/v1/systemone
 * Authorization: Bearer ${JEV_API_KEY}
 * { model, state, questions } → { model, answers, usage }
 * Boolean questions are noul. `noul` is a binary P(yes), not a three-way
 * distribution and not confidence. Noul has no option order and is never inverted.
 * Validity uses a two-option Choice so both criteria orders can be run and averaged.
 * Choice criteria key order is the option order. Score criteria follow option order.
 * The question map key is not sent to the model. Claim text and quotes live in instructions.
 * A non-200 or a transport error does not resolve. There is no other provider.
 */
export function systemOneUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/v1/systemone`
}

export function mapSystemOneResponse(
  questions: JevQuestion[],
  json: unknown,
): { servedModelId: string; answers: JevAnswer[]; usage?: { input_tokens: number; output_tokens: number } } {
  const parsed = ResponseSchema.safeParse(json)
  if (!parsed.success) throw new JevSchemaError()
  const ids = Object.keys(parsed.data.answers)
  if (ids.length !== questions.length || questions.some((question) => parsed.data.answers[question.id] === undefined)) {
    throw new JevSchemaError()
  }
  const answers = questions.map((question) => {
    const answer = parsed.data.answers[question.id]
    if (!answer) throw new JevSchemaError()
    return { question_id: question.id, probabilities: probabilitiesFor(question, answer) }
  })
  return {
    servedModelId: parsed.data.model,
    answers,
    ...(parsed.data.usage ? { usage: parsed.data.usage } : {}),
  }
}

export class HttpJevTransport implements JevTransport {
  constructor(
    private readonly sql: Sql,
    private readonly baseUrl: string | undefined,
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async classify(call: JevCall): Promise<StageOutcome<{ servedModelId: string; answers: JevAnswer[] }>> {
    if (!this.baseUrl || !this.apiKey) {
      return {
        status: 'unavailable',
        error: { type: 'jev_not_configured', message: 'TypeSafe Jev is not configured.' },
      }
    }
    const charged = await chargeBudget(this.sql, 'jev')
    if (!charged.ok) {
      return { status: 'refused', error: { type: 'budget_exhausted', message: 'The decision call budget is exhausted.' } }
    }
    const body = JSON.stringify(buildSystemOneRequest(this.model, call.state, call.questions))
    const started = Date.now()
    try {
      const response = await this.fetchImpl(systemOneUrl(this.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      const text = await response.text()
      if (!response.ok) {
        await this.record(call, null, 'unavailable', 'http', started, body.length, text.length)
        return {
          status: 'unavailable',
          error: { type: 'jev_unavailable', message: 'The decision service did not complete the call.' },
        }
      }
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        await this.record(call, null, 'failed', 'invalid_provider_payload', started, body.length, text.length)
        return {
          status: 'failed',
          error: { type: 'invalid_provider_payload', message: 'The decision service returned an unreadable payload.' },
        }
      }
      let mapped: ReturnType<typeof mapSystemOneResponse>
      try {
        mapped = mapSystemOneResponse(call.questions, json)
      } catch (error) {
        if (!(error instanceof JevSchemaError)) throw error
        await this.record(call, null, 'failed', 'invalid_provider_payload', started, body.length, text.length)
        return {
          status: 'failed',
          error: { type: error.type, message: error.message },
        }
      }
      const inputTokens = mapped.usage?.input_tokens ?? Math.ceil(body.length / 4)
      const outputTokens = mapped.usage?.output_tokens ?? Math.ceil(text.length / 4)
      await recordModelCall(this.sql, {
        traceId: call.traceId,
        provider: 'typesafe',
        tier: 'jev',
        intendedModelId: this.model,
        servedModelId: mapped.servedModelId,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - started,
        costUsd: estimateCost('typesafe', 'jev', inputTokens, outputTokens),
        status: 'ok',
        stopReason: null,
        errorType: null,
        purpose: call.purpose,
      })
      return { status: 'ok', data: { servedModelId: mapped.servedModelId, answers: mapped.answers } }
    } catch {
      await this.record(call, null, 'unavailable', 'transport', started, body.length, 0)
      return {
        status: 'unavailable',
        error: { type: 'jev_unavailable', message: 'The decision service did not complete the call.' },
      }
    }
  }

  private async record(
    call: JevCall,
    served: string | null,
    status: 'ok' | 'unavailable' | 'failed',
    errorType: string | null,
    started: number,
    inputChars: number,
    outputChars: number,
  ): Promise<void> {
    await recordModelCall(this.sql, {
      traceId: call.traceId,
      provider: 'typesafe',
      tier: 'jev',
      intendedModelId: this.model,
      servedModelId: served,
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: Math.ceil(outputChars / 4),
      latencyMs: Date.now() - started,
      costUsd: null,
      status,
      stopReason: null,
      errorType,
      purpose: call.purpose,
    })
  }
}

export function buildSystemOneRequest(
  model: string,
  state: unknown,
  questions: JevQuestion[],
): { model: string; state: unknown; questions: Record<string, WireQuestion> } {
  return { model, state, questions: wireQuestions(questions) }
}

function wireQuestions(questions: JevQuestion[]): Record<string, WireQuestion> {
  const wired: Record<string, WireQuestion> = {}
  for (const question of questions) wired[question.id] = wireQuestion(question)
  return wired
}

function wireQuestion(question: JevQuestion): WireQuestion {
  const instructions = instructionsFor(question)
  if (question.type === 'boolean') {
    return {
      type: 'noul',
      instructions,
      criteria: null,
    }
  }
  const options = question.options ?? []
  if (question.type === 'choice') {
    const criteria: Record<string, string | null> = {}
    const rubric = question.id.endsWith(':validity') ? VALIDITY_RUBRIC : ROUTE_RUBRIC
    for (const option of options) criteria[option] = rubric[option] ?? null
    return { type: 'choice', instructions, criteria }
  }
  return { type: 'score', instructions, criteria: [...options] }
}

function instructionsFor(question: JevQuestion): WireInstructions {
  if (!question.context) return question.prompt
  return {
    question: question.prompt,
    rule_id: question.context.rule_id,
    claim: question.context.claim,
    quotes: question.context.quotes,
  }
}

function probabilitiesFor(question: JevQuestion, answer: SystemOneAnswer): Record<string, number> {
  if (question.type === 'boolean') {
    if (answer.type !== 'noul') throw new JevSchemaError()
    const options = question.options ?? []
    if (!sameMembers(options, ['yes', 'no'])) throw new JevSchemaError()
    if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new JevSchemaError()
    return normaliseProbabilities(options, { yes: answer.noul, no: 1 - answer.noul })
  }
  const options = question.options ?? []
  if (question.type === 'choice') {
    if (answer.type !== 'choice') throw new JevSchemaError()
    if (!options.includes(answer.choice)) throw new JevSchemaError()
    return normaliseProbabilities(options, answer.probabilities)
  }
  if (answer.type !== 'score') throw new JevSchemaError()
  if (sameMembers(Object.keys(answer.probabilities), options)) {
    return normaliseProbabilities(options, answer.probabilities)
  }
  const relabeled: Record<string, number> = {}
  for (const [index, probability] of Object.entries(answer.probabilities)) {
    const label = answer.legend[index]
    if (label === undefined || Object.prototype.hasOwnProperty.call(relabeled, label)) throw new JevSchemaError()
    relabeled[label] = probability
  }
  return normaliseProbabilities(options, relabeled)
}

function normaliseProbabilities(options: string[], raw: Record<string, number>): Record<string, number> {
  if (!sameMembers(options, Object.keys(raw))) throw new JevSchemaError()
  let sum = 0
  for (const option of options) {
    const value = raw[option]
    if (value === undefined || !Number.isFinite(value) || value < 0) throw new JevSchemaError()
    sum += value
  }
  if (!(sum > 0)) throw new JevSchemaError()
  const out: Record<string, number> = {}
  for (const option of options) {
    const value = raw[option]
    if (value === undefined) throw new JevSchemaError()
    out[option] = value / sum
  }
  return out
}

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const seen = new Set(right)
  if (seen.size !== right.length) return false
  return left.every((item) => seen.has(item))
}

export interface FakeJevOptions {
  respond?: (call: JevCall) => JevAnswer[]
}

export class FakeJevTransport implements JevTransport {
  constructor(
    private readonly sql: Sql,
    private readonly model = 'fake.jev-1.13.0',
    private readonly respond?: (call: JevCall) => JevAnswer[],
  ) {}

  async classify(call: JevCall): Promise<StageOutcome<{ servedModelId: string; answers: JevAnswer[] }>> {
    const charged = await chargeBudget(this.sql, 'jev')
    if (!charged.ok) {
      return { status: 'refused', error: { type: 'budget_exhausted', message: 'The decision call budget is exhausted.' } }
    }
    const answers = this.respond ? this.respond(call) : this.answer(call)
    const inputTokens = Math.ceil(JSON.stringify(call.state).length / 4)
    await recordModelCall(this.sql, {
      traceId: call.traceId,
      provider: 'fake',
      tier: 'jev',
      intendedModelId: this.model,
      servedModelId: this.model,
      inputTokens,
      outputTokens: answers.length,
      latencyMs: 1,
      costUsd: estimateCost('fake', 'jev', inputTokens, 0),
      status: 'ok',
      stopReason: null,
      errorType: null,
      purpose: call.purpose,
    })
    return { status: 'ok', data: { servedModelId: this.model, answers } }
  }

  /** A choice whose options are exactly yes/no (a typed ask) gets a deterministic yes-heavy answer; the rest is unchanged. */
  private answer(call: JevCall): JevAnswer[] {
    const fallback = defaultAnswers(call)
    return call.questions.map((question, index) => {
      const options = question.options ?? []
      const yesNo = question.type === 'choice' && options.length === 2 && options.includes('yes') && options.includes('no')
      if (!yesNo || question.id.endsWith(':validity')) return fallback[index] as JevAnswer
      return { question_id: question.id, probabilities: { yes: 0.96, no: 0.04 } }
    })
  }
}

function defaultAnswers(call: JevCall): JevAnswer[] {
  const state = call.state as { candidates?: { finding_id: string; safety_class?: boolean }[] }
  const candidates = state.candidates ?? []
  return call.questions.map((question) => {
    if (question.type === 'score') {
      const options = question.options ?? ['0', '1']
      const mid = options[Math.floor(options.length / 2)] ?? options[0] ?? '0'
      const probabilities: Record<string, number> = {}
      for (const option of options) probabilities[option] = option === mid ? 0.7 : 0.3 / Math.max(1, options.length - 1)
      return { question_id: question.id, probabilities }
    }
    const findingId = question.id.slice(0, question.id.lastIndexOf(':'))
    const safety = candidates.find((candidate) => candidate.finding_id === findingId)?.safety_class === true
    if (question.id.endsWith(':validity') || question.type === 'boolean') {
      return { question_id: question.id, probabilities: safety ? { yes: 0.99, no: 0.01 } : { yes: 0.96, no: 0.04 } }
    }
    return {
      question_id: question.id,
      probabilities: safety
        ? { route: 0.99, hold: 0.005, drop_informational: 0.005 }
        : { route: 0.05, hold: 0.9, drop_informational: 0.05 },
    }
  })
}
