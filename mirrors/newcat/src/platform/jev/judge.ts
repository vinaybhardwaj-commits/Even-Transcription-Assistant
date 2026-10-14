import { VALIDITY_RUBRIC } from '../../decide/questions.js'
import type { JevTransport } from '../../decide/transport.js'
import { JudgeUnavailable, type JudgeAnswer, type JudgePort, type JudgeQuestionSet } from '../agent/judge-port.js'
import { askChoice, type AskContext } from './asks.js'

/**
 * The F1 adapter behind the template's JudgePort. Validity is a yes/no choice asked in both option
 * orders and averaged by askChoice; p_yes is the averaged P(yes). The criteria text rides inline in
 * the prompt, so the transport's route rubric never applies.
 */
export function jevJudge(ctx: { transport: JevTransport; traceId: string; purpose: string }): JudgePort {
  const askCtx: AskContext = { transport: ctx.transport, traceId: ctx.traceId, purpose: ctx.purpose }
  return {
    async askValidity(state: unknown, question: string, _set: JudgeQuestionSet): Promise<JudgeAnswer> {
      const outcome = await askChoice(askCtx, state, { prompt: question, criteria: VALIDITY_RUBRIC }, ['yes', 'no'])
      if (outcome.status === 'ok') {
        const p = outcome.data.probabilities.yes
        if (p === undefined || !Number.isFinite(p)) throw new JudgeUnavailable('invalid_provider_payload')
        return { p_yes: p, servedModelIds: outcome.data.servedModelIds }
      }
      const type = 'error' in outcome ? outcome.error.type : outcome.status
      throw new JudgeUnavailable(type === 'budget_exhausted' ? 'budget_exhausted' : 'judge_unavailable')
    },
  }
}
