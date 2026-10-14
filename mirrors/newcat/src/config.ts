import { z } from 'zod'
import { disallowedModelEnv, isAllowedGeminiModel } from './llm/allowlist.js'
import { geminiConfig } from './llm/gemini.js'
import { parseServiceAccountKey } from './llm/gcp-federation.js'

const optionalText = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
  })

const EnvSchema = z.object({
  NEWCAT_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(43123),
  DATABASE_URL: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim()
      return trimmed ? trimmed : undefined
    }),
  /** Read-only CDMSS Neon URL (role newcat_ro). Optional: unset means CDMSS reads are `unavailable`. Never log it. */
  CDMSS_DATABASE_URL_RO: optionalText,
  BEDROCK_REGION: z.string().optional(),
  BEDROCK_MODEL_HAIKU: z.string().optional(),
  BEDROCK_MODEL_SONNET: z.string().optional(),
  BEDROCK_MODEL_OPUS: z.string().optional(),
  /**
   * Production default is gcp-federation. vercel-oidc and default-chain are explicit alternatives.
   * When unset outside production, a present GCP_SA_KEY_JSON still selects gcp-federation.
   */
  BEDROCK_AUTH: optionalText.pipe(z.enum(['gcp-federation', 'vercel-oidc', 'default-chain']).optional()),
  /** Service-account JSON, raw or base64. Never log it. */
  GCP_SA_KEY_JSON: optionalText,
  /** OIDC audience registered for Google on the AWS identity provider. Falls back to client_email. */
  GCP_AUDIENCE: optionalText,
  AWS_ROLE_ARN: optionalText,
  /** STS AssumeRoleWithWebIdentity region. Bedrock calls use BEDROCK_REGION. */
  AWS_STS_REGION: optionalText.transform((value) => value ?? 'ap-south-1'),
  JEV_BASE_URL: z.string().optional(),
  JEV_API_KEY: z.string().optional(),
  JEV_MODEL: z.string().optional(),
  /** Accepted aliases of JEV_BASE_URL, JEV_API_KEY, and JEV_MODEL. */
  TYPESAFE_BASE_URL: z.string().optional(),
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  WEBHOOK_SIGNING_SECRET: z.string().optional(),
  API_KEYS_JSON: z.string().optional(),
  CALL_BUDGET_MAX: z.coerce.number().int().positive().default(100_000),
  JEV_BUDGET_MAX: z.coerce.number().int().positive().default(100_000),
  EMBED_BUDGET_MAX: z.coerce.number().int().positive().default(100_000),
  EMBED_BATCH_SIZE: z.coerce.number().int().min(1).max(96).default(8),
  /** In-flight embed calls while a corpus import is writing chunks. */
  EMBED_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  EMBEDDING_MODEL: optionalText.transform((value) => value ?? 'amazon.titan-embed-text-v2:0'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  /** `haiku` asks BEDROCK_MODEL_HAIKU to reorder fused hits. A failure keeps that order. */
  BEDROCK_RERANK: z.enum(['off', 'haiku']).default('off'),
  NEWCAT_EMBED: z.enum(['bedrock', 'fake']).default('bedrock'),
  ABSTENTION_BACKLOG_DAYS: z.coerce.number().int().nonnegative().default(0),
  NEWCAT_LLM: z.enum(['bedrock', 'fake']).default('bedrock'),
  /** `http` is a deprecated alias of `live`. */
  NEWCAT_JEV: z
    .enum(['live', 'fake', 'http'])
    .default('live')
    .transform((value) => (value === 'http' ? 'live' : value)),
  /** Gemini second judge via Vertex. `fake` is refused in production; defaultWiring wires only `live`. */
  NEWCAT_GEMINI: z.enum(['live', 'fake', 'off']).default('off'),
  VERTEX_PROJECT: optionalText,
  VERTEX_LOCATION: optionalText,
  /** Service-account JSON, raw or base64. Never log it. Distinct from GCP_SA_KEY_JSON (Bedrock federation). */
  VERTEX_SA_KEY_JSON: optionalText,
  GEMINI_MODEL: optionalText,
  GEMINI_BUDGET_MAX: z.coerce.number().int().positive().default(1000),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(2000),
})

export type Env = z.infer<typeof EnvSchema>
export type BedrockAuth = NonNullable<Env['BEDROCK_AUTH']>

export function resolveBedrockAuth(
  env: Env,
  runtime: { vercelOidcToken?: string | undefined } = { vercelOidcToken: process.env.VERCEL_OIDC_TOKEN },
): BedrockAuth {
  if (env.BEDROCK_AUTH) return env.BEDROCK_AUTH
  if (env.NEWCAT_ENV === 'production' || env.GCP_SA_KEY_JSON) return 'gcp-federation'
  if (env.AWS_ROLE_ARN && runtime.vercelOidcToken) return 'vercel-oidc'
  return 'default-chain'
}

export interface ApiKeySeed {
  name: string
  token: string
  scopes: string[]
  audience: 'internal' | 'operator' | 'doctor' | 'governance'
}

const KeySeedSchema = z.array(
  z.object({
    name: z.string().min(1),
    token: z.string().min(8),
    scopes: z.array(z.string().min(1)).min(1),
    audience: z.enum(['internal', 'operator', 'doctor', 'governance']),
  }),
)

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`)
  }
  return parsed.data
}

export function jevConfig(env: Env): { baseUrl: string | undefined; apiKey: string | undefined; model: string } {
  const baseUrl = env.JEV_BASE_URL?.trim() || env.TYPESAFE_BASE_URL?.trim() || undefined
  const apiKey = env.JEV_API_KEY?.trim() || env.TYPESAFE_API_KEY?.trim() || undefined
  // Alias, not a pinned id. System One returns the served id (jev-1.13.0 on the current line).
  const model = env.JEV_MODEL?.trim() || env.TYPESAFE_MODEL?.trim() || 'jev-latest'
  return { baseUrl, apiKey, model }
}

export type JevReadiness = 'ok' | 'fake' | 'unavailable'

/** `fake` is the test client. `unavailable` means live mode has no base URL or key. */
export function jevReadiness(env: Env): JevReadiness {
  if (env.NEWCAT_JEV === 'fake') return 'fake'
  const jev = jevConfig(env)
  if (!jev.baseUrl || !jev.apiKey) return 'unavailable'
  return 'ok'
}

export function assertBootSecrets(env: Env, runtime: { vercel?: boolean } = { vercel: process.env.VERCEL === '1' }): void {
  if (env.NEWCAT_ENV !== 'production') return
  const missing: string[] = []
  if (!env.DATABASE_URL) missing.push('DATABASE_URL')
  if (!env.CRON_SECRET) missing.push('CRON_SECRET')
  if (!env.WEBHOOK_SIGNING_SECRET) missing.push('WEBHOOK_SIGNING_SECRET')
  if (!env.BEDROCK_REGION) missing.push('BEDROCK_REGION')
  if (!env.BEDROCK_MODEL_HAIKU) missing.push('BEDROCK_MODEL_HAIKU')
  if (!env.BEDROCK_MODEL_SONNET) missing.push('BEDROCK_MODEL_SONNET')
  if (!env.BEDROCK_MODEL_OPUS) missing.push('BEDROCK_MODEL_OPUS')
  missing.push(...disallowedModelEnv({ haiku: env.BEDROCK_MODEL_HAIKU, sonnet: env.BEDROCK_MODEL_SONNET, opus: env.BEDROCK_MODEL_OPUS }))
  if (env.NEWCAT_LLM !== 'bedrock') missing.push('NEWCAT_LLM=bedrock')
  if (env.NEWCAT_JEV !== 'live') missing.push('NEWCAT_JEV=live')
  if (env.NEWCAT_EMBED !== 'bedrock') missing.push('NEWCAT_EMBED=bedrock')
  if (env.EMBEDDING_DIMENSIONS !== 1024) missing.push('EMBEDDING_DIMENSIONS=1024')
  if (env.NEWCAT_GEMINI === 'fake') missing.push('NEWCAT_GEMINI (fake refused)')
  if (env.GEMINI_MODEL && !isAllowedGeminiModel(env.GEMINI_MODEL)) missing.push('GEMINI_MODEL (not in allowlist)')
  if (env.NEWCAT_GEMINI === 'live') {
    const before = missing.length
    if (!env.GEMINI_MODEL) missing.push('GEMINI_MODEL')
    if (!env.VERTEX_PROJECT) missing.push('VERTEX_PROJECT')
    if (!env.VERTEX_LOCATION) missing.push('VERTEX_LOCATION')
    if (!env.VERTEX_SA_KEY_JSON || !readableServiceAccount(env.VERTEX_SA_KEY_JSON)) missing.push('VERTEX_SA_KEY_JSON')
    if (env.VERTEX_LOCATION && env.VERTEX_LOCATION !== 'asia-northeast1') missing.push('VERTEX_LOCATION (must be asia-northeast1)')
    if (missing.length === before && geminiConfig(env) === null) missing.push('VERTEX_PROJECT/VERTEX_LOCATION/GEMINI_MODEL (live config unusable)')
  }
  const auth = resolveBedrockAuth(env, { vercelOidcToken: runtime.vercel ? process.env.VERCEL_OIDC_TOKEN : undefined })
  if (auth === 'gcp-federation') {
    if (!env.GCP_SA_KEY_JSON || !readableServiceAccount(env.GCP_SA_KEY_JSON)) missing.push('GCP_SA_KEY_JSON')
    if (!env.AWS_ROLE_ARN) missing.push('AWS_ROLE_ARN')
  }
  if (auth === 'vercel-oidc' && !env.AWS_ROLE_ARN) missing.push('AWS_ROLE_ARN')
  if (missing.length > 0) {
    throw new Error(`refusing to boot: missing or invalid production configuration: ${missing.join(', ')}`)
  }
}

function readableServiceAccount(keyJson: string): boolean {
  try {
    parseServiceAccountKey(keyJson)
    return true
  } catch {
    return false
  }
}

export function parseApiKeys(json: string | undefined): ApiKeySeed[] {
  if (!json || !json.trim()) return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('API_KEYS_JSON is not valid JSON')
  }
  const parsed = KeySeedSchema.safeParse(raw)
  if (!parsed.success) throw new Error('API_KEYS_JSON does not match the consumer schema')
  return parsed.data
}
