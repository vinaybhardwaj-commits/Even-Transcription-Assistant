import { sha256, stableStringify } from '../../hash.js'
import { QUESTION_SET_ID } from '../../version.js'
import { QUESTION_TEMPLATES, type JevQuestion } from '../../decide/questions.js'

export interface QuestionSet {
  id: string
  version: string
  questions: JevQuestion[]
}

/**
 * sha256 of the stable JSON of {id, questions}. The version is not hashed: the id already carries it
 * (audit-decisions/0.3.0), and hashing {id, questions} is what keeps today's QUESTION_SET_SHA.
 */
export function questionSetSha(set: QuestionSet): string {
  return sha256(stableStringify({ id: set.id, questions: set.questions }))
}

export interface RegisteredQuestionSet extends QuestionSet {
  sha: string
}

const SETS = new Map<string, RegisteredQuestionSet>()

export function registerQuestionSet(set: QuestionSet): RegisteredQuestionSet {
  const sha = questionSetSha(set)
  const existing = SETS.get(set.id)
  if (existing) {
    if (existing.sha !== sha) throw new Error(`question set ${set.id} is already registered with different content`)
    return existing
  }
  const registered: RegisteredQuestionSet = { ...set, questions: set.questions.map((q) => ({ ...q })), sha }
  SETS.set(set.id, registered)
  return registered
}

export function getQuestionSet(id: string): RegisteredQuestionSet | undefined {
  return SETS.get(id)
}

export function listQuestionSets(): RegisteredQuestionSet[] {
  return [...SETS.values()]
}

export const AUDIT_DECISIONS_SET = registerQuestionSet({
  id: QUESTION_SET_ID,
  version: '0.3.0',
  questions: QUESTION_TEMPLATES,
})

/** Review questions for scripts/jev-review.ts. State is {task, diff}. */
export const JEV_REVIEW_SET = registerQuestionSet({
  id: 'jev-review/0.1.0',
  version: '0.1.0',
  questions: [
    { id: 'meets_task', type: 'boolean', options: ['yes', 'no'], prompt: 'Does `state.diff` implement what `state.task` asks for?' },
    { id: 'out_of_scope', type: 'boolean', options: ['yes', 'no'], prompt: 'Does `state.diff` change anything that `state.task` does not ask for?' },
    { id: 'adds_secret_or_phi', type: 'boolean', options: ['yes', 'no'], prompt: 'Does `state.diff` add a credential, key, token, or patient-identifying data?' },
    { id: 'missing_tests', type: 'boolean', options: ['yes', 'no'], prompt: 'Does `state.diff` change behaviour without adding or updating a test?' },
    {
      id: 'verdict',
      type: 'choice',
      options: ['accept', 'revise', 'reject'],
      prompt: 'Given `state.task`, what should happen to `state.diff`? accept, revise, or reject.',
    },
    {
      id: 'risk',
      type: 'score',
      options: ['low', 'medium', 'high'],
      prompt: 'How risky is `state.diff` to merge for `state.task`?',
    },
  ],
})
