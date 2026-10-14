import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider'
import type { AwsCredentialIdentityProvider } from '@smithy/types'
import { resolveBedrockAuth, type BedrockAuth, type Env } from '../config.js'
import { gcpCredentialProvider } from './gcp-federation.js'

export type CredentialSource = BedrockAuth

/**
 * Production uses GCP service-account federation (Google ID token, then STS).
 * vercel-oidc is optional and does not set a custom audience.
 * default-chain is the local AWS credential chain, selected only when asked.
 */
export function credentialSource(env: Env): CredentialSource {
  return resolveBedrockAuth(env)
}

export function credentialProvider(env: Env): AwsCredentialIdentityProvider | undefined {
  const mode = resolveBedrockAuth(env)
  if (mode === 'default-chain') return undefined
  if (mode === 'vercel-oidc') {
    if (!env.AWS_ROLE_ARN || !env.BEDROCK_REGION) {
      return async () => {
        const error = new Error('Vercel OIDC federation is not configured.')
        error.name = 'federation_not_configured'
        throw error
      }
    }
    return awsCredentialsProvider({
      roleArn: env.AWS_ROLE_ARN,
      clientConfig: { region: env.BEDROCK_REGION },
    })
  }
  return gcpCredentialProvider(env)
}
