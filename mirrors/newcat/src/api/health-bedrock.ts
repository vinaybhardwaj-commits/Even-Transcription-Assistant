import type { Sql } from '../db/sql.js'
import { resolveBedrockAuth, type Env } from '../config.js'
import { authenticateCron } from '../auth/consumers.js'
import { credentialProvider } from '../llm/aws.js'
import { probeServedModel, sdkSender, type BedrockSender } from '../llm/bedrock.js'

/** GET /v1/health/bedrock. CRON_SECRET bearer. One 1-token Haiku call, charged to the 'llm' budget and ledgered (purpose 'health'). NEWCAT_LLM=fake answers 200 with served_source 'fake' and makes no call. 429 when the budget is exhausted. Ids only. */
export async function bedrockHealth(
  env: Env,
  authorization: string | null,
  sql: Sql,
  traceId: string,
  sender?: BedrockSender,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const auth = authenticateCron(authorization, env.CRON_SECRET)
  if (auth === 'missing_secret') return { status: 401, body: { status: 'failed', error: { type: 'missing_secret' } } }
  if (auth !== 'ok') return { status: 401, body: { status: 'failed', error: { type: 'unauthorized' } } }
  const mode = resolveBedrockAuth(env)
  if (env.NEWCAT_LLM === 'fake') {
    // Fake mode never reaches Bedrock: no budget charge, no ledger row, no served id.
    return {
      status: 200,
      body: { status: 'ok', auth_mode: mode, intended: env.BEDROCK_MODEL_HAIKU ?? null, served: null, served_source: 'fake' },
    }
  }
  const send =
    sender ??
    (env.BEDROCK_REGION
      ? sdkSender(env.BEDROCK_REGION, credentialProvider(env))
      : {
          async send(): Promise<never> {
            const error = new Error('BEDROCK_REGION is unset')
            error.name = 'region_not_configured'
            throw error
          },
        })
  const result = await probeServedModel(sql, env.BEDROCK_MODEL_HAIKU, mode, send, traceId)
  if (!result.ok && result.reason === 'budget_exhausted') {
    return { status: 429, body: { status: 'failed', auth_mode: mode, error: { type: 'budget_exhausted' } } }
  }
  if (!result.ok) {
    return { status: 503, body: { status: 'failed', auth_mode: mode, error: { type: result.errorType } } }
  }
  return { status: 200, body: { status: 'ok', ...result.probe } }
}
