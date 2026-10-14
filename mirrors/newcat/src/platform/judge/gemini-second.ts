import { GeminiClient, type GeminiConfig, type GeminiSender } from '../../llm/gemini.js'
import type { Sql } from '../../db/sql.js'
import { JudgeUnavailable, type JudgeAnswer, type JudgeQuestionSet } from '../agent/judge-port.js'
import type { SecondJudge } from './second.js'

const SYSTEM =
  'You are an independent reviewer. You are given a question and a JSON state. ' +
  'Reply with a JSON object {"p_yes": number} where p_yes is the probability, between 0 and 1, that the answer to the question is yes. ' +
  'Use only the state. Reply with nothing else.'

/**
 * The Gemini second opinion. The state is exactly what buildJudgeState produced (the one the Jev judge receives):
 * no meta, no identifiers are added. An unreadable served model id is not replaced: servedModelIds is empty (unverified).
 */
export class GeminiSecondJudge implements SecondJudge {
  readonly id = 'gemini'
  constructor(
    private readonly client: GeminiClient,
    private readonly traceId: string,
  ) {}

  async askValidity(state: unknown, question: string, _set: JudgeQuestionSet): Promise<JudgeAnswer> {
    try {
      const answer = await this.client.ask({
        system: SYSTEM,
        user: `Question:\n${question}\n\nState:\n${JSON.stringify(state)}`,
        traceId: this.traceId,
        purpose: 'second_judge',
      })
      return { p_yes: answer.p_yes, servedModelIds: answer.servedModelId ? [answer.servedModelId] : [] }
    } catch (error) {
      if (error instanceof JudgeUnavailable) throw error
      throw new JudgeUnavailable('judge_unavailable')
    }
  }
}

export function geminiSecondJudge(input: { sql: Sql; config: GeminiConfig; sender: GeminiSender; traceId: string }): GeminiSecondJudge {
  return new GeminiSecondJudge(new GeminiClient(input.sql, input.config, input.sender), input.traceId)
}
