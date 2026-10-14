import { jevConfig, type Env } from './config.js'
import type { Sql } from './db/sql.js'
import { FakeJevTransport, HttpJevTransport } from './decide/transport.js'
import type { JevTransport } from './decide/transport.js'
import { buildEmbedder } from './evidence/embed.js'
import type { Embedder } from './evidence/embed.js'
import { credentialProvider } from './llm/aws.js'
import { BedrockModelClient, sdkSender, type BedrockSender } from './llm/bedrock.js'
import { FakeModelClient } from './llm/fake.js'
import { setBudgetMax } from './llm/ledger.js'
import type { ModelClient } from './llm/types.js'

export async function applyBudgetCaps(sql: Sql, env: Env): Promise<void> {
  await setBudgetMax(sql, 'llm', env.CALL_BUDGET_MAX)
  await setBudgetMax(sql, 'jev', env.JEV_BUDGET_MAX)
  await setBudgetMax(sql, 'embed', env.EMBED_BUDGET_MAX)
}

export { buildEmbedder }
export type { Embedder }

export function buildModelClient(sql: Sql, env: Env): ModelClient {
  if (env.NEWCAT_LLM === 'fake') return new FakeModelClient(sql)
  const sender: BedrockSender = env.BEDROCK_REGION
    ? sdkSender(env.BEDROCK_REGION, credentialProvider(env))
    : {
        async send() {
          throw new Error('BEDROCK_REGION is unset')
        },
      }
  return new BedrockModelClient(sql, sender, {
    haiku: env.BEDROCK_MODEL_HAIKU,
    sonnet: env.BEDROCK_MODEL_SONNET,
    opus: env.BEDROCK_MODEL_OPUS,
  })
}

export function buildJev(sql: Sql, env: Env): JevTransport {
  if (env.NEWCAT_JEV === 'fake') return new FakeJevTransport(sql)
  const jev = jevConfig(env)
  return new HttpJevTransport(sql, jev.baseUrl, jev.apiKey, jev.model, fetch)
}
