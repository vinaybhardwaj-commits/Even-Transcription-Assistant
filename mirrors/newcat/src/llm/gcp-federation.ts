import { AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import type { AwsCredentialIdentityProvider } from '@smithy/types'
import { GoogleAuth, Impersonated, type JWTInput } from 'google-auth-library'
import { sha256 } from '../hash.js'

const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'

/** Renew while the 1-hour STS session still has this much life left. */
export const RENEW_BEFORE_MS = 5 * 60 * 1000

export interface AssumedCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiration: Date
}

export interface WebIdentityExchange {
  mintIdToken(): Promise<string>
  assumeRole(webIdentityToken: string): Promise<AssumedCredentials>
}

const providers = new Map<string, AwsCredentialIdentityProvider>()

export function clearGcpCredentialCache(): void {
  providers.clear()
}

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function ownError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === 'InvalidServiceAccountKey' || error.name === 'EmptyIdToken' || error.name === 'IncompleteCredentials')
  )
}

/** Drop provider messages. They can echo a key, a token, or a session secret. */
export function scrubError(error: unknown, fallbackName: string): Error {
  let name = fallbackName
  if (error && typeof error === 'object' && 'name' in error && typeof (error as { name: unknown }).name === 'string') {
    const raw = (error as { name: string }).name
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(raw)) name = raw
  }
  return named(name, fallbackName)
}

export function parseServiceAccountKey(raw: string): JWTInput {
  const trimmed = raw.trim()
  const jsonText = trimmed.startsWith('{') ? trimmed : decodeBase64Key(trimmed)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw named('InvalidServiceAccountKey', 'The service account key could not be read.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw named('InvalidServiceAccountKey', 'The service account key could not be read.')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.client_email !== 'string' || typeof record.private_key !== 'string' || record.client_email.length === 0) {
    throw named('InvalidServiceAccountKey', 'The service account key could not be read.')
  }
  return parsed as JWTInput
}

function decodeBase64Key(compactSource: string): string {
  const compact = compactSource.replace(/\s+/g, '')
  const decoded = Buffer.from(compact, 'base64').toString('utf8').trim()
  if (!decoded.startsWith('{')) {
    throw named('InvalidServiceAccountKey', 'The service account key could not be read.')
  }
  return decoded
}

/**
 * Mint a Google ID token the way Even's Bedrock guide does.
 * IAM Credentials impersonation, not a token signed locally from the key.
 * Audience is GCP_AUDIENCE when set, otherwise the service account email.
 */
export async function mintGcpIdToken(keyJson: string, audience: string | undefined): Promise<string> {
  const credentials = parseServiceAccountKey(keyJson)
  const auth = new GoogleAuth({
    credentials,
    scopes: [CLOUD_PLATFORM],
  })
  const loaded = await auth.getCredentials()
  const clientEmail = loaded.client_email
  if (!clientEmail) throw named('InvalidServiceAccountKey', 'The service account key could not be read.')
  const targetAudience = audience?.trim() || clientEmail
  const sourceClient = await auth.getClient()
  try {
    const impersonated = new Impersonated({
      sourceClient,
      targetPrincipal: clientEmail,
      targetScopes: [CLOUD_PLATFORM],
      lifetime: 3600,
    })
    const idToken = await impersonated.fetchIdToken(targetAudience, { includeEmail: true })
    if (!idToken) throw named('EmptyIdToken', 'Google did not return an ID token.')
    return idToken
  } catch (error) {
    if (ownError(error)) throw error
    throw scrubError(error, 'IdTokenMintFailed')
  }
}

export function sessionName(envName: string): string {
  const cleaned = envName.replace(/[^\w+=,.@-]/g, '').slice(0, 50)
  return `newcat-${cleaned || 'env'}`
}

export async function assumeWithWebIdentity(input: {
  roleArn: string
  sessionName: string
  webIdentityToken: string
  region: string
  now?: () => number
}): Promise<AssumedCredentials> {
  const sts = new STSClient({
    region: input.region,
    authSchemePreference: ['smithy.api#noAuth'],
  })
  try {
    const response = await sts.send(
      new AssumeRoleWithWebIdentityCommand({
        RoleArn: input.roleArn,
        RoleSessionName: input.sessionName,
        WebIdentityToken: input.webIdentityToken,
        DurationSeconds: 3600,
      }),
    )
    const credentials = response.Credentials
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      throw named('IncompleteCredentials', 'STS did not return credentials.')
    }
    const now = input.now ?? Date.now
    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration ?? new Date(now() + 3_600_000),
    }
  } catch (error) {
    if (ownError(error)) throw error
    throw scrubError(error, 'AssumeRoleFailed')
  }
}

export function refreshingWebIdentityProvider(
  exchange: WebIdentityExchange,
  options?: { now?: () => number; renewBeforeMs?: number },
): AwsCredentialIdentityProvider {
  const now = options?.now ?? (() => Date.now())
  const renewBeforeMs = options?.renewBeforeMs ?? RENEW_BEFORE_MS
  let cached: AssumedCredentials | undefined
  let inflight: Promise<AssumedCredentials> | undefined

  async function refresh(): Promise<AssumedCredentials> {
    try {
      const token = await exchange.mintIdToken()
      const next = await exchange.assumeRole(token)
      cached = next
      return next
    } catch (error) {
      if (cached && cached.expiration.getTime() > now()) return cached
      throw error
    }
  }

  return async () => {
    if (cached && cached.expiration.getTime() - now() > renewBeforeMs) return cached
    if (!inflight) {
      const pending = refresh().finally(() => {
        if (inflight === pending) inflight = undefined
      })
      inflight = pending
    }
    return inflight
  }
}

export function gcpCredentialProvider(env: {
  GCP_SA_KEY_JSON?: string | undefined
  GCP_AUDIENCE?: string | undefined
  AWS_ROLE_ARN?: string | undefined
  AWS_STS_REGION: string
  NEWCAT_ENV: string
}): AwsCredentialIdentityProvider {
  if (!env.GCP_SA_KEY_JSON || !env.AWS_ROLE_ARN) {
    return async () => {
      throw named('federation_not_configured', 'GCP federation is not configured.')
    }
  }
  const keyJson = env.GCP_SA_KEY_JSON
  const roleArn = env.AWS_ROLE_ARN
  const cacheKey = sha256([roleArn, env.AWS_STS_REGION, env.GCP_AUDIENCE ?? '', env.NEWCAT_ENV, sha256(keyJson)].join('\n'))
  const hit = providers.get(cacheKey)
  if (hit) return hit
  const provider = refreshingWebIdentityProvider({
    mintIdToken: () => mintGcpIdToken(keyJson, env.GCP_AUDIENCE),
    assumeRole: (webIdentityToken) =>
      assumeWithWebIdentity({
        roleArn,
        sessionName: sessionName(env.NEWCAT_ENV),
        webIdentityToken,
        region: env.AWS_STS_REGION,
      }),
  })
  providers.set(cacheKey, provider)
  return provider
}
