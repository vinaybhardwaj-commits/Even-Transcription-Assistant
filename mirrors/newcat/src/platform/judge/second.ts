import type { JudgeAnswer, JudgeQuestionSet } from '../agent/judge-port.js'
import { JudgeUnavailable } from '../agent/judge-port.js'

/**
 * Independent second opinion on the same question. Interface only here: a real client
 * is shared code built elsewhere and reviewed by newcat-lead.
 */
export interface SecondJudge {
  readonly id: string
  /** Rejects with JudgeUnavailable when the service cannot answer. */
  askValidity(state: unknown, question: string, set: JudgeQuestionSet): Promise<JudgeAnswer>
}

export class FakeSecondJudge implements SecondJudge {
  readonly calls: Array<{ state: unknown; question: string }> = []
  constructor(
    private readonly respond: (state: unknown) => number | null = () => 0.99,
    readonly id = 'fake-second',
  ) {}

  async askValidity(state: unknown, question: string): Promise<JudgeAnswer> {
    this.calls.push({ state, question })
    const p = this.respond(state)
    if (p === null) throw new JudgeUnavailable('second_judge_unavailable')
    return { p_yes: p, servedModelIds: [`${this.id}-model`] }
  }
}
