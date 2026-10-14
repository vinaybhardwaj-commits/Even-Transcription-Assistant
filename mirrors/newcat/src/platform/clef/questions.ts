import { registerQuestionSet, type RegisteredQuestionSet } from '../jev/registry.js'
import { ClefParseError } from './wav.js'

export const QUESTION_SET_VERSION = 'timbre-clef-v1'
export const MODEL_NAME = 'clef-omni'
export const MODEL_ID = '@cf/cloudflare/clef-omni'
export const STATE_TEXT =
  'Outpatient clinic consultation. The audio is one short clip of the patient. Judge the patient\'s affect from the audio only.'

export const VALENCE_CRITERIA = ['very negative', 'negative', 'neutral', 'positive', 'very positive'] as const
export const AROUSAL_CRITERIA = ['very calm', 'calm', 'neutral', 'activated', 'very activated'] as const

export type ClefQuestion =
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string }

/** Port of questions_payload(). Key order matches the Python dict. */
export function questionsPayload(): Record<string, ClefQuestion> {
  return {
    valence: { type: 'score', instructions: "How positive is the patient's affect in this clip?", criteria: [...VALENCE_CRITERIA] },
    arousal: {
      type: 'score',
      instructions: "How activated is the patient's voice in this clip? Diagnostic only; not the Timbre arousal score.",
      criteria: [...AROUSAL_CRITERIA],
    },
    anxious: { type: 'noul', instructions: 'Does the patient sound anxious?' },
    engaged: { type: 'noul', instructions: 'Does the patient sound engaged?' },
    one_patient: { type: 'noul', instructions: 'Is this clip mainly one patient speaking?' },
  }
}

/**
 * Registered in the F1 registry as `clef/<set>`. JevQuestion has no `noul` type, so noul questions are
 * registered as `boolean` (yes/no) and score questions as `score` with the criteria as options. The sha
 * therefore covers the same wording and criteria that questionsPayload() sends.
 */
export const CLEF_QUESTION_SET: RegisteredQuestionSet = registerQuestionSet({
  id: `clef/${QUESTION_SET_VERSION}`,
  version: QUESTION_SET_VERSION,
  questions: Object.entries(questionsPayload()).map(([id, q]) =>
    q.type === 'score'
      ? { id, type: 'score' as const, prompt: q.instructions, options: q.criteria }
      : { id, type: 'boolean' as const, prompt: q.instructions, options: ['yes', 'no'] },
  ),
})

/** Expected rater level. Criterion index i is level i + 1. */
export function expectedLevel(probs: readonly number[]): number {
  return probs.reduce((sum, p, i) => sum + (i + 1) * p, 0)
}

function distribution(values: number[]): number[] {
  if (values.some((p) => !Number.isFinite(p) || p < 0)) throw new ClefParseError('score probabilities must be finite and non-negative')
  const total = values.reduce((a, b) => a + b, 0)
  if (total <= 0 || Math.abs(total - 1) > 0.05) throw new ClefParseError('score probabilities are not a distribution')
  return values.map((p) => p / total)
}

/** Port of ordered_score_probs: index keys "0".., then "1".., then the criterion strings. */
export function orderedScoreProbs(answer: unknown, criteria: readonly string[]): number[] {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new ClefParseError('score answer is not an object')
  const raw = (answer as Record<string, unknown>).probabilities
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new ClefParseError('score answer has no probabilities')
  }
  const keyed = new Map<string, number>()
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : Number.NaN
    if (typeof v === 'string' && v.trim() === '') throw new ClefParseError('score probability is not a number')
    if (Number.isNaN(n)) throw new ClefParseError('score probability is not a number')
    keyed.set(k, n)
  }
  const n = criteria.length
  const zero = Array.from({ length: n }, (_, i) => String(i))
  const one = Array.from({ length: n }, (_, i) => String(i + 1))
  const pick = (keys: readonly string[]): number[] => keys.map((k) => keyed.get(k) as number)
  if (zero.every((k) => keyed.has(k))) return distribution(pick(zero))
  if (one.every((k) => keyed.has(k))) return distribution(pick(one))
  if (criteria.every((k) => keyed.has(k))) return distribution(pick(criteria))
  throw new ClefParseError('score probabilities do not cover the 1-5 levels')
}

export function noulProbability(answer: unknown): number {
  if (!answer || typeof answer !== 'object' || !('noul' in answer)) throw new ClefParseError('noul answer has no probability')
  const raw = (answer as { noul: unknown }).noul
  const p = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : Number.NaN
  if (Number.isNaN(p)) throw new ClefParseError('noul probability is not a number')
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new ClefParseError('noul probability is outside 0..1')
  return p
}

export interface ScoreAnswer {
  /** Probability per level 1..5. */
  distribution: number[]
  expected: number
}

export interface ClefAnswers {
  valence: ScoreAnswer
  arousal: ScoreAnswer
  anxious: number
  engaged: number
  onePatient: number
}

export function unwrapResult(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ClefParseError('clef response is not an object')
  const p = payload as Record<string, unknown>
  if (p.success === false) throw new ClefParseError('clef response success is false')
  const inner = p.result
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && 'answers' in inner) return inner as Record<string, unknown>
  if ('answers' in p) return p
  throw new ClefParseError('clef response has no answers')
}

export function usageTokens(inner: Record<string, unknown>): { input: number; output: number } {
  const usage = inner.usage
  if (usage === undefined || usage === null) return { input: 0, output: 0 }
  if (typeof usage !== 'object' || Array.isArray(usage)) throw new ClefParseError('clef usage is not an object')
  const one = (name: string): number => {
    const v = (usage as Record<string, unknown>)[name]
    if (v === undefined || v === null) return 0
    const n = Number(v)
    if (!Number.isInteger(n)) throw new ClefParseError('clef token count is not an integer')
    if (n < 0) throw new ClefParseError('clef token count is negative')
    return n
  }
  return { input: one('input_tokens'), output: one('output_tokens') }
}

export function parseAnswers(payload: unknown): { answers: ClefAnswers; inputTokens: number; outputTokens: number } {
  const inner = unwrapResult(payload)
  const raw = inner.answers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ClefParseError('clef response has no answers')
  const a = raw as Record<string, unknown>
  const usage = usageTokens(inner)
  const valence = orderedScoreProbs(a.valence, VALENCE_CRITERIA)
  const arousal = orderedScoreProbs(a.arousal, AROUSAL_CRITERIA)
  return {
    answers: {
      valence: { distribution: valence, expected: expectedLevel(valence) },
      arousal: { distribution: arousal, expected: expectedLevel(arousal) },
      anxious: noulProbability(a.anxious),
      engaged: noulProbability(a.engaged),
      onePatient: noulProbability(a.one_patient),
    },
    inputTokens: usage.input,
    outputTokens: usage.output,
  }
}
