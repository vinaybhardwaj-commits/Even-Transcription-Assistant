import { probeAws } from '../src/llm/aws-probe.js'
import { credentialProvider } from '../src/llm/aws.js'
import { probeServedModel, sdkSender, type BedrockSender } from '../src/llm/bedrock.js'
import { loadEnv, resolveBedrockAuth } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { openDatabase } from '../src/db/open.js'
import { newId } from '../src/ids.js'

async function main(): Promise<number> {
  const env = loadEnv(process.env)
  if (env.BEDROCK_REGION && !env.DATABASE_URL) {
    console.error(
      'probe:bedrock refused: BEDROCK_REGION is set but DATABASE_URL is not. The served-model call must charge the llm budget and write a ledger row, which needs the real database. Set DATABASE_URL and rerun.',
    )
    return 2
  }
  const sql = await openDatabase(env.DATABASE_URL)
  try {
    if (!env.DATABASE_URL) await migrate(sql)
    const sender: BedrockSender = env.BEDROCK_REGION
      ? sdkSender(env.BEDROCK_REGION, credentialProvider(env))
      : {
          async send(): Promise<never> {
            throw new Error('region_not_configured')
          },
        }
    const served = await probeServedModel(sql, env.BEDROCK_MODEL_HAIKU, resolveBedrockAuth(env), sender, newId())
    console.log(JSON.stringify({ aws: await probeAws(env), served }, null, 2))
    return 0
  } finally {
    await sql.close()
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.name : 'Error')
    process.exit(1)
  },
)
