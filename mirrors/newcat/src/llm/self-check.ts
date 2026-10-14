import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { resolveBedrockAuth, type BedrockAuth, type Env } from '../config.js'
import type { Sql } from '../db/sql.js'
import { openDatabase } from '../db/open.js'
import { newId } from '../ids.js'
import type { AwsCredentialIdentityProvider } from '@smithy/types'
import { credentialProvider } from './aws.js'
import type { BedrockSender } from './bedrock.js'
import { normalizeServed, sdkSender } from './bedrock.js'
import { chargeBudget, recordModelCall } from './ledger.js'
import { assumeWithWebIdentity, mintGcpIdToken, sessionName, type AssumedCredentials } from './gcp-federation.js'

export interface Probe {
  ok: boolean
  error_type: string | null
}

export interface BedrockCheckReport {
  status: 'ok' | 'failed'
  auth_mode: BedrockAuth
  credential_source: BedrockAuth
  region: string | null
  sts_region: string
  model_id: string | null
  id_token: Probe
  assume_role: Probe
  caller_identity: Probe
  caller_arn: string | null
  converse: Probe
}

export interface BedrockCheckIo {
  mintIdToken?(): Promise<void>
  assumeRole?(): Promise<void>
  identify(): Promise<void | { arn?: string | null }>
  /** May return what the provider reported, which is written to the ledger row. */
  converse(modelId: string): Promise<void | { servedModelId?: string | null }>
}

function errorType(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof (error as { name: unknown }).name === 'string') {
    return (error as { name: string }).name.slice(0, 80)
  }
  return 'Error'
}

const skipped = (ok: boolean): Probe => ({ ok, error_type: 'skipped' })

function failedReport(
  env: Env,
  mode: BedrockAuth,
  idToken: Probe,
  assume: Probe,
  caller: Probe,
  callerArn: string | null,
  converse: Probe,
): BedrockCheckReport {
  return {
    status: 'failed',
    auth_mode: mode,
    credential_source: mode,
    region: env.BEDROCK_REGION ?? null,
    sts_region: env.AWS_STS_REGION,
    model_id: env.BEDROCK_MODEL_HAIKU ?? null,
    id_token: idToken,
    assume_role: assume,
    caller_identity: caller,
    caller_arn: callerArn,
    converse,
  }
}

export function defaultBedrockCheckIo(env: Env): BedrockCheckIo | { error_type: string } {
  if (!env.BEDROCK_REGION) return { error_type: 'region_not_configured' }
  const mode = resolveBedrockAuth(env)
  if (mode === 'gcp-federation') {
    if (!env.GCP_SA_KEY_JSON || !env.AWS_ROLE_ARN) return { error_type: 'federation_not_configured' }
    const keyJson = env.GCP_SA_KEY_JSON
    const roleArn = env.AWS_ROLE_ARN
    const region = env.BEDROCK_REGION
    let token = ''
    let creds: AssumedCredentials | undefined
    return {
      async mintIdToken() {
        token = await mintGcpIdToken(keyJson, env.GCP_AUDIENCE)
      },
      async assumeRole() {
        creds = await assumeWithWebIdentity({
          roleArn,
          sessionName: sessionName(env.NEWCAT_ENV),
          webIdentityToken: token,
          region: env.AWS_STS_REGION,
        })
      },
      async identify() {
        if (!creds) {
          const error = new Error('STS did not return credentials.')
          error.name = 'IncompleteCredentials'
          throw error
        }
        const current = creds
        const sts = new STSClient({
          region: env.AWS_STS_REGION,
          credentials: async () => current,
        })
        const out = await sts.send(new GetCallerIdentityCommand({}))
        return { arn: out.Arn ?? null }
      },
      async converse(modelId: string) {
        if (!creds) {
          const error = new Error('STS did not return credentials.')
          error.name = 'IncompleteCredentials'
          throw error
        }
        const shared = federatedSender(region)
        shared.use(creds)
        return converseOnce(shared.sender, modelId)
      },
    }
  }
  const credentials = mode === 'vercel-oidc' ? credentialProvider(env) : undefined
  const shared = sharedDefault(env.BEDROCK_REGION, mode, credentials)
  return {
    async identify() {
      const out = await shared.sts.send(new GetCallerIdentityCommand({}))
      return { arn: out.Arn ?? null }
    },
    converse: (modelId: string) => converseOnce(shared.sender, modelId),
  }
}

async function converseOnce(sender: BedrockSender, modelId: string): Promise<{ servedModelId: string | null }> {
  const raw = await sender.send(modelId, { system: 'Reply with one token.', user: 'ok', maxTokens: 1 })
  return { servedModelId: normalizeServed(raw.servedModelId, raw.servedSource).servedModelId }
}

// One sender (and its profile-resolver cache) per process, not one per check.
const federated = new Map<string, { sender: BedrockSender; use(creds: AssumedCredentials): void }>()
const defaults = new Map<string, { sender: BedrockSender; sts: STSClient }>()

function federatedSender(region: string): { sender: BedrockSender; use(creds: AssumedCredentials): void } {
  let entry = federated.get(region)
  if (!entry) {
    let current: AssumedCredentials | undefined
    const provider: AwsCredentialIdentityProvider = async () => {
      if (!current) throw new Error('STS did not return credentials.')
      return current
    }
    entry = { sender: sdkSender(region, provider), use: (creds) => void (current = creds) }
    federated.set(region, entry)
  }
  return entry
}

function sharedDefault(
  region: string,
  mode: BedrockAuth,
  credentials: AwsCredentialIdentityProvider | undefined,
): { sender: BedrockSender; sts: STSClient } {
  const key = `${region}|${mode}`
  let entry = defaults.get(key)
  if (!entry) {
    entry = {
      sts: new STSClient({ region, ...(credentials ? { credentials } : {}) }),
      sender: sdkSender(region, credentials),
    }
    defaults.set(key, entry)
  }
  return entry
}

let processSql: Promise<Sql> | undefined

/** Where the admin check charges the budget: the caller's sql, else one connection per process from DATABASE_URL, else none (dev/test without a database). */
function ledgerSql(env: Env, sql: Sql | undefined): Promise<Sql | null> {
  if (sql) return Promise.resolve(sql)
  if (!env.DATABASE_URL) return Promise.resolve(null)
  if (!processSql) {
    const opening = openDatabase(env.DATABASE_URL)
    // A rejected open must not be cached: the next check retries instead of replaying the failure.
    opening.catch(() => {
      if (processSql === opening) processSql = undefined
    })
    processSql = opening
  }
  return processSql
}

/** Proves the configured credential path and one Converse call. The prompt is not a clinical note. */
export async function checkBedrock(env: Env, io?: BedrockCheckIo, sql?: Sql): Promise<BedrockCheckReport> {
  const mode = resolveBedrockAuth(env)
  const region = env.BEDROCK_REGION ?? null
  const modelId = env.BEDROCK_MODEL_HAIKU ?? null
  if (!region) {
    return failedReport(env, mode, skipped(true), { ok: false, error_type: 'region_not_configured' }, skipped(false), null, skipped(false))
  }
  const resolved = io ?? defaultBedrockCheckIo(env)
  if ('error_type' in resolved) {
    const probe = { ok: false, error_type: resolved.error_type }
    const idToken = mode === 'gcp-federation' ? probe : skipped(true)
    return failedReport(env, mode, idToken, mode === 'gcp-federation' ? skipped(false) : probe, skipped(false), null, skipped(false))
  }

  let idToken = skipped(true)
  if (mode === 'gcp-federation') {
    idToken = await probe(() => {
      if (!resolved.mintIdToken) {
        const error = new Error('GCP federation is not configured.')
        error.name = 'federation_not_configured'
        throw error
      }
      return resolved.mintIdToken()
    })
    if (!idToken.ok) return failedReport(env, mode, idToken, skipped(false), skipped(false), null, skipped(false))
  }

  let assume = mode === 'default-chain' ? skipped(true) : { ok: true, error_type: null }
  if (mode === 'gcp-federation') {
    assume = await probe(() => {
      if (!resolved.assumeRole) {
        const error = new Error('GCP federation is not configured.')
        error.name = 'federation_not_configured'
        throw error
      }
      return resolved.assumeRole()
    })
    if (!assume.ok) return failedReport(env, mode, idToken, assume, skipped(false), null, skipped(false))
  }

  const identity = await probeArn(() => resolved.identify())
  if (mode === 'vercel-oidc') assume = { ok: identity.ok, error_type: identity.error_type }
  if (!identity.ok) return failedReport(env, mode, idToken, assume, identity, null, skipped(false))
  if (!modelId) {
    return failedReport(env, mode, idToken, assume, identity, identity.arn, { ok: false, error_type: 'model_not_configured' })
  }
  const ledger = await ledgerSql(env, sql).catch(() => null)
  const charged = ledger ? await chargeBudget(ledger, 'llm').catch(() => null) : { ok: true as const, callsUsed: 0 }
  if (charged === null || !charged.ok) {
    const refused = { ok: false, error_type: charged === null ? 'ledger_unavailable' : 'budget_exhausted' }
    return failedReport(env, mode, idToken, assume, identity, identity.arn, refused)
  }
  const started = Date.now()
  let served: string | null = null
  let converse = await probe(async () => {
    const result = await resolved.converse(modelId)
    if (result && typeof result === 'object' && typeof result.servedModelId === 'string') served = result.servedModelId
  })
  let ledgerWritten = true
  if (ledger) {
    await recordModelCall(ledger, {
      traceId: newId(),
      provider: 'bedrock',
      tier: 'haiku',
      intendedModelId: modelId,
      servedModelId: converse.ok ? served : null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: Date.now() - started,
      costUsd: null,
      status: converse.ok ? 'ok' : 'unavailable',
      stopReason: null,
      errorType: converse.ok ? null : 'transport',
      purpose: 'self_check',
    }).catch(() => {
      ledgerWritten = false
    })
  }
  // The call was charged but not recorded: the spend is unaccounted, so the check is not ok.
  if (!ledgerWritten) converse = { ok: false, error_type: 'ledger_unavailable' }
  const status = idToken.ok && assume.ok && identity.ok && converse.ok ? 'ok' : 'failed'
  return {
    status,
    auth_mode: mode,
    credential_source: mode,
    region,
    sts_region: env.AWS_STS_REGION,
    model_id: modelId,
    id_token: idToken,
    assume_role: assume,
    caller_identity: identity,
    caller_arn: identity.arn,
    converse,
  }
}

async function probe(run: () => Promise<void>): Promise<Probe> {
  try {
    await run()
    return { ok: true, error_type: null }
  } catch (error) {
    return { ok: false, error_type: errorType(error) }
  }
}

async function probeArn(run: () => Promise<void | { arn?: string | null }>): Promise<Probe & { arn: string | null }> {
  try {
    const result = await run()
    const arn = result && typeof result === 'object' && typeof result.arn === 'string' ? result.arn : null
    return { ok: true, error_type: null, arn }
  } catch (error) {
    return { ok: false, error_type: errorType(error), arn: null }
  }
}
