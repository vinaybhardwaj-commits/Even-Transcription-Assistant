import { classifyAveraged } from '../../decide/client.js'
import { ROUTE_RUBRIC, type JevQuestion, type QuestionContext } from '../../decide/questions.js'
import type { StageOutcome } from '../../outcome.js'
import type { JevTransport } from '../../decide/transport.js'

export interface AskContext {
  transport: JevTransport
  traceId: string
  /** Ledger purpose. Not 'decide', which belongs to audit.note. */
  purpose: string
}

export interface AskQuestion {
  prompt: string
  context?: QuestionContext
  /** Optional text per option. It goes inline in the prompt, never through transport rubrics. */
  criteria?: Record<string, string>
}

/**
 * transport.ts picks option criteria from ROUTE_RUBRIC by option NAME, so a choice ask whose options are
 * named route/hold/drop_informational would silently inherit audit.note's rubric. Options that collide with
 * a rubric key are therefore sent under a prefixed label (no rubric key matches) and mapped back on the way
 * out; other options go unchanged. Each ask carries its own criteria text inline in the prompt.
 */
const LABEL_PREFIX = 'opt_'
const RESERVED = new Set(Object.keys(ROUTE_RUBRIC))
const label = (option: string): string => (RESERVED.has(option) ? `${LABEL_PREFIX}${option}` : option)

function unlabel(probabilities: Record<string, number>, options: string[]): Record<string, number> {
  const back = new Map(options.map((option) => [label(option), option] as const))
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(probabilities)) out[back.get(key) ?? key] = value
  return out
}

function inlinePrompt(question: AskQuestion, options: string[]): string {
  const lines = options.map((option) => {
    const text = question.criteria?.[option]
    return text ? `- ${label(option)}: ${text}` : `- ${label(option)}`
  })
  return `${question.prompt}\nAnswer with exactly one of these options:\n${lines.join('\n')}`
}

export interface ServedStamp {
  /** Model id from the forward response `model` field. */
  servedModelId: string
  /** Forward then reverse. Both are always present on a successful ask. */
  servedModelIds: string[]
}

const KIND = 'ask'

function failed(type: string, message: string): StageOutcome<never> {
  return { status: 'failed', error: { type, message } }
}

async function ask(
  ctx: AskContext,
  state: unknown,
  question: JevQuestion,
  original: string[],
): Promise<StageOutcome<{ probabilities: Record<string, number> } & ServedStamp>> {
  const outcome = await classifyAveraged(ctx.transport, {
    traceId: ctx.traceId,
    purpose: ctx.purpose,
    state,
    questions: [question],
    kinds: [KIND],
  })
  if (outcome.status === 'abstained') return failed('unexpected_decision_status', 'The decision service returned an unexpected status.')
  if (outcome.status !== 'ok') return outcome
  const answer = outcome.data.answers.find((a) => a.question_id === KIND)
  const [forward, reverse] = outcome.data.servedModelIds
  // classifyAveraged already fails when either order is missing; this is the typed guard.
  if (!answer || !forward || !reverse) return failed('incomplete_decision', 'The decision service omitted an answer.')
  return {
    status: 'ok',
    data: { probabilities: unlabel(answer.probabilities, original), servedModelId: forward, servedModelIds: [forward, reverse] },
  }
}

function build(
  type: JevQuestion['type'],
  question: AskQuestion,
  options: string[],
): JevQuestion {
  return {
    id: `q:${KIND}`,
    type,
    prompt: type === 'choice' ? inlinePrompt(question, options) : question.prompt,
    options: type === 'choice' ? options.map(label) : [...options],
    ...(question.context ? { context: question.context } : {}),
  }
}

/** Yes/no question. Noul has no option order, so the two calls are two independent asks of the same question. */
export async function askNoul(
  ctx: AskContext,
  state: unknown,
  question: AskQuestion,
): Promise<StageOutcome<{ p_yes: number } & ServedStamp>> {
  const outcome = await ask(ctx, state, build('boolean', question, ['yes', 'no']), [])
  if (outcome.status === 'abstained') return failed('unexpected_decision_status', 'The decision service returned an unexpected status.')
  if (outcome.status !== 'ok') return outcome
  const p = outcome.data.probabilities.yes
  if (p === undefined || !Number.isFinite(p)) return failed('invalid_provider_payload', 'The decision service returned an unexpected payload.')
  return { status: 'ok', data: { p_yes: p, servedModelId: outcome.data.servedModelId, servedModelIds: outcome.data.servedModelIds } }
}

function checkOptions(options: string[]): StageOutcome<never> | null {
  if (options.length < 2 || new Set(options).size !== options.length) {
    return failed('invalid_options', 'A choice needs at least two distinct options.')
  }
  if (options.some((option) => option.startsWith('opt_'))) {
    return failed('invalid_options', 'Options may not start with opt_ (reserved for relabelling).')
  }
  return null
}

export async function askChoice(
  ctx: AskContext,
  state: unknown,
  question: AskQuestion,
  options: string[],
): Promise<StageOutcome<{ probabilities: Record<string, number> } & ServedStamp>> {
  const bad = checkOptions(options)
  if (bad) return bad
  const outcome = await ask(ctx, state, build('choice', question, options), options)
  if (outcome.status === 'abstained') return failed('unexpected_decision_status', 'The decision service returned an unexpected status.')
  return outcome
}

/**
 * `criteria` are the ordered score options (lowest first). `expected` is sum(p * value) where value is
 * Number(criterion) when every criterion is numeric, else the 0-based position. INFERRED convention.
 */
export async function askScore(
  ctx: AskContext,
  state: unknown,
  question: AskQuestion,
  criteria: string[],
): Promise<StageOutcome<{ probabilities: Record<string, number>; expected: number } & ServedStamp>> {
  const bad = checkOptions(criteria)
  if (bad) return bad
  const outcome = await ask(ctx, state, build('score', question, criteria), [])
  if (outcome.status === 'abstained') return failed('unexpected_decision_status', 'The decision service returned an unexpected status.')
  if (outcome.status !== 'ok') return outcome
  const numeric = criteria.every((c) => c.trim() !== '' && Number.isFinite(Number(c)))
  let expected = 0
  criteria.forEach((criterion, index) => {
    expected += (outcome.data.probabilities[criterion] ?? 0) * (numeric ? Number(criterion) : index)
  })
  return { status: 'ok', data: { ...outcome.data, expected } }
}
