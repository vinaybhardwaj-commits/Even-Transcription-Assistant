import type { StageOutcome } from '../outcome.js'

function asDecisionError(outcome: StageOutcome<unknown>): StageOutcome<AveragedAnswers<string>> {
  if (outcome.status === 'unavailable' || outcome.status === 'truncated' || outcome.status === 'refused' || outcome.status === 'failed' || outcome.status === 'extraction_failed') {
    return outcome
  }
  return { status: 'failed', error: { type: 'unexpected_decision_status', message: 'The decision service returned an unexpected status.' } }
}
import { averageProbabilities, type ProbabilityAnswer } from './apply.js'
import { reverseQuestion, type JevQuestion } from './questions.js'
import type { JevTransport } from './transport.js'

export type DecideKind = ProbabilityAnswer['question_id']

export interface AveragedAnswers<K extends string = DecideKind> {
  servedModelIds: string[]
  answers: { finding_id: string; question_id: K; probabilities: Record<string, number> }[]
}

const DECIDE_KINDS: readonly DecideKind[] = ['validity', 'route']

/**
 * Question ids are `<subject>:<kind>`. Only answers whose kind is in `kinds` are returned
 * (default validity and route, which is what audit.note reads). `purpose` is the ledger purpose.
 */
export async function classifyAveraged(
  transport: JevTransport,
  input: { traceId: string; state: unknown; questions: JevQuestion[]; purpose?: string },
): Promise<StageOutcome<AveragedAnswers>>
export async function classifyAveraged<K extends string>(
  transport: JevTransport,
  input: { traceId: string; state: unknown; questions: JevQuestion[]; purpose?: string; kinds: readonly K[] },
): Promise<StageOutcome<AveragedAnswers<K>>>
export async function classifyAveraged(
  transport: JevTransport,
  input: { traceId: string; state: unknown; questions: JevQuestion[]; purpose?: string; kinds?: readonly string[] },
): Promise<StageOutcome<AveragedAnswers<string>>> {
  const purpose = input.purpose ?? 'decide'
  const kinds: readonly string[] = input.kinds ?? DECIDE_KINDS
  const forward = await transport.classify({
    traceId: input.traceId,
    purpose,
    state: input.state,
    questions: input.questions,
    optionOrder: 'forward',
  })
  if (forward.status !== 'ok') return asDecisionError(forward)
  const reverse = await transport.classify({
    traceId: input.traceId,
    purpose,
    state: input.state,
    questions: input.questions.map((question) => reverseQuestion(question)),
    optionOrder: 'reverse',
  })
  if (reverse.status !== 'ok') return asDecisionError(reverse)
  const answers: AveragedAnswers<string>['answers'] = []
  for (const question of input.questions) {
    const left = forward.data.answers.find((answer) => answer.question_id === question.id)
    const right = reverse.data.answers.find((answer) => answer.question_id === question.id)
    if (!left || !right) {
      return {
        status: 'failed',
        error: { type: 'incomplete_decision', message: 'The decision service omitted a question.' },
      }
    }
    const split = question.id.lastIndexOf(':')
    const kind = question.id.slice(split + 1)
    if (!kinds.includes(kind)) continue
    answers.push({
      finding_id: question.id.slice(0, split),
      question_id: kind,
      probabilities: averageProbabilities(left.probabilities, right.probabilities),
    })
  }
  return {
    status: 'ok',
    data: {
      servedModelIds: [forward.data.servedModelId, reverse.data.servedModelId],
      answers,
    },
  }
}
