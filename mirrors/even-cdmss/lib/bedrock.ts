/**
 * lib/bedrock.ts — the Amazon Bedrock transport (Bedrock PRD §4.1/§4.2, Unit A + B, 7 Aug 2026).
 *
 * ONE FILE OWNS EVERYTHING AWS. The auth chain, the client, and the Converse call live here; the
 * pure parts (model catalogue, refresh decision, Converse mapping) live in lib/bedrock-core.ts and
 * are unit-tested without a network.
 *
 * ══ THE CHAIN ════════════════════════════════════════════════════════════════════════════════
 *   GCP_SA_KEY → Google ID token (target_audience = BEDROCK_OIDC_AUDIENCE)
 *              → AWS STS AssumeRoleWithWebIdentity (BEDROCK_ROLE_ARN, BEDROCK_REGION)
 *              → temporary credentials (60 min)
 *              → Bedrock Converse
 *
 * THERE IS NO AWS SECRET. `GCP_SA_KEY` — already in Vercel for Vertex — is the only one, so
 * rotating it rotates Bedrock access too. Nothing below ever logs a token, a key, a session token
 * or an expiry-bearing credential object; the only identities that reach a log line are the service
 * account's client_email and the role ARN, matching the Vertex 403-diagnosis pattern.
 *
 * ══ F11 ══════════════════════════════════════════════════════════════════════════════════════
 * ERRORS LOUD, NEVER FALLS BACK. An explicit `bedrock:` target that cannot be served THROWS. It
 * never degrades to Gemini, to OpenRouter, or to the local mini — a row that says Bedrock while
 * another model answered is precisely the unattributable-row defect this machinery exists to stop.
 *
 * ⚠️ PHI: `bedrockConverse` is reachable ONLY through the governed layer (lib/trace.ts →
 * tracedChat / governedChat). scripts/reasoning-governance-check.mjs hard-fails any other call
 * site. De-identification (`rowToOpdCase`) runs upstream of the governed layer, unchanged.
 */
// ⚠️ THE AWS SDK IS IMPORTED LAZILY, TYPES ONLY UP HERE. This module is reachable from lib/llm.ts,
// which every clinical route loads, so a static import would put ~MBs of AWS middleware into the
// cold start of /api/ask, /api/ddx and every audit worker — routes that will never call Bedrock.
// The dynamic imports below are module-cached, so only the FIRST Bedrock call in a process pays,
// and it pays inside a call already measured in seconds. (Same reasoning as lib/llm.ts's lazy
// `await import('./trace')`, for a different reason: there it breaks a cycle, here it breaks weight.)
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { getGcpIdToken, vertexSaEmail } from './gcp-auth';
import { createWithRetry } from './openrouter-retry';
import {
  beginProviderCall, endProviderCall, providerCallsInFlight, providerErrorPayload,
} from './provider-error-core';
import { PROVIDER_BUDGETS } from './lab-provider-core';
import {
  assertKnownBedrockModel, bedrockConfiguredFrom, credentialsUsable, fromConverseOutput,
  toConverseInput, type BedrockCredentials, type ChatCompletionLike, type ChatParams,
  type ConverseOutput,
} from './bedrock-core';

export {
  BEDROCK_MODELS, bedrockModelLabel, isKnownBedrockModel, singleChunkStream,
  type ChatCompletionLike,
} from './bedrock-core';

/** The role session name AWS records for every assumed session (integration reference §1.1). */
export const BEDROCK_ROLE_SESSION_NAME = 'bedrock-session';
/** STS credential lifetime, seconds. 60 minutes — the reference's number, and the reason the
 *  refresh decision (credentialsUsable) has to be right on a warm instance. */
export const BEDROCK_SESSION_SECONDS = 3600;

export function bedrockRegion(): string { return process.env.BEDROCK_REGION || ''; }
export function bedrockRoleArn(): string { return process.env.BEDROCK_ROLE_ARN || ''; }
export function bedrockAudience(): string { return process.env.BEDROCK_OIDC_AUDIENCE || ''; }

/**
 * CONFIGURATION probe, the shape `geminiConfigured()` has: are all four vars present? It does NOT
 * ping AWS — see the reachability note in lib/lab-override.ts. Read at CALL time, so setting the
 * env vars in Vercel flips it without a code change, and unsetting one is the documented rollback.
 */
export function bedrockConfigured(): boolean {
  return bedrockConfiguredFrom(process.env as Record<string, string | undefined>);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The credential provider
// ─────────────────────────────────────────────────────────────────────────────────────────────

let cachedCreds: BedrockCredentials | null = null;

/**
 * Mint (or reuse) temporary AWS credentials.
 *
 * Module-scope cache with a 5-minute skew, the same discipline `getVertexAccessToken` uses. A warm
 * Vercel instance reuses; a cold start mints. `AssumeRoleWithWebIdentity` is an UNSIGNED call, so
 * the STS client needs no credentials of its own — that is what makes a keyless chain possible.
 *
 * The returned object carries `expiration`, which is what lets the AWS SDK refresh on its own when
 * it holds this provider; our cache is the belt to that suspenders and the thing `credentialsUsable`
 * makes testable.
 */
export async function bedrockCredentials(): Promise<BedrockCredentials> {
  if (credentialsUsable(cachedCreds, Date.now())) return cachedCreds as BedrockCredentials;

  const region = bedrockRegion();
  const roleArn = bedrockRoleArn();
  const audience = bedrockAudience();
  if (!region || !roleArn || !audience) {
    throw new Error(
      `bedrock: not configured — BEDROCK_REGION / BEDROCK_ROLE_ARN / BEDROCK_OIDC_AUDIENCE must all be set (region=${region ? 'set' : 'MISSING'} role=${roleArn ? 'set' : 'MISSING'} audience=${audience ? 'set' : 'MISSING'})`,
    );
  }

  const webIdentityToken = await getGcpIdToken(audience);
  const { STSClient, AssumeRoleWithWebIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ region });
  const res = await sts.send(new AssumeRoleWithWebIdentityCommand({
    RoleArn: roleArn,
    RoleSessionName: BEDROCK_ROLE_SESSION_NAME,
    WebIdentityToken: webIdentityToken,
    DurationSeconds: BEDROCK_SESSION_SECONDS,
  }));

  const c = res.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    throw new Error('bedrock: STS AssumeRoleWithWebIdentity returned an incomplete credential set');
  }
  cachedCreds = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
  // IDENTITIES ONLY. Never the token, never the key, never the session token — and deliberately
  // not the expiry-bearing credential object either. This line is the operator's proof that the
  // federation worked and WHICH identity it worked as.
  console.info(`[bedrock] assumed ${roleArn} in ${region} as ${vertexSaEmail() ?? 'unknown-sa'} (session ${BEDROCK_ROLE_SESSION_NAME})`);
  return cachedCreds;
}

/** TEST SEAM — drop the cached credentials. Not used in production code. */
export function __resetBedrockCredentialCache(): void { cachedCreds = null; }

let cachedClient: { region: string; client: BedrockRuntimeClient } | null = null;

async function bedrockClient(): Promise<BedrockRuntimeClient> {
  const region = bedrockRegion();
  if (cachedClient && cachedClient.region === region) return cachedClient.client;
  const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({
    region,
    // The provider is a FUNCTION, so every send re-resolves through our cache and mints a fresh
    // set once the old one is inside the skew. This is the warm-instance refresh (verification 8).
    credentials: () => bedrockCredentials(),
    // Our retry budget lives in the shared policy (createWithRetry). The SDK's own 3 attempts
    // underneath it would multiply into up to 9 wire calls per logical budget — the same trap
    // RetryAttemptOpts.maxRetries:0 closes on the OpenAI-SDK transports.
    maxAttempts: 1,
  });
  cachedClient = { region, client };
  return client;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Converse call
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BedrockConverseOpts {
  /** Full Bedrock modelId. Must be one of BEDROCK_MODELS — an unlisted id is refused, not sent. */
  model: string;
  /** Caller's abort signal (the shared retry loop's per-attempt deadline rides this). */
  signal?: AbortSignal;
}

/**
 * ONE Converse call, mapped in and out. No retry, no fallback, no logging — the caller owns all
 * three. Respects the caller's abort signal, which is how the class budget actually bounds it.
 */
export async function bedrockConverse(params: ChatParams, opts: BedrockConverseOpts): Promise<ChatCompletionLike> {
  assertKnownBedrockModel(opts.model);
  const input = toConverseInput(params, opts.model);
  const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const client = await bedrockClient();
  const res = await client.send(new ConverseCommand(input), { abortSignal: opts.signal });
  return fromConverseOutput(res as ConverseOutput, opts.model);
}

/**
 * The provider_error payload for a Bedrock failure. NAMES THE IDENTITIES THAT COULD HAVE BEEN
 * REFUSED — role ARN and SA email — because an IAM trust-policy denial, a missing model grant and
 * a bad audience are indistinguishable without them (the exact lesson of the Vertex 403 diagnosis,
 * where `vertexSaEmail()` answers the same question).
 *
 * `fellBackTo` is always 'none'. There is no fallback tier behind a Bedrock target, by design.
 */
export function bedrockErrorPayload(
  label: string | null,
  model: string,
  error: unknown,
  inFlightAtError: { total: number; by: Record<string, number> },
): Record<string, unknown> {
  return providerErrorPayload({
    provider: 'bedrock',
    label,
    feature: null,
    fellBackTo: 'none',
    intendedModel: model,
    fallbackModel: null,
    region: bedrockRegion() || null,
    saIdentity: vertexSaEmail(),
    roleArn: bedrockRoleArn() || null,
    error,
    inFlightAtError,
  });
}

/** Where `bedrockGenerate` parks the payload it built at the moment of failure. */
const FAILURE_PAYLOAD = Symbol.for('cdmss.bedrock.failurePayload');

/**
 * The payload for a failed Bedrock call: the one `bedrockGenerate` built AT THE MOMENT OF FAILURE
 * if it is still attached, else one built now.
 *
 * ⚠️ WHY IT IS BUILT INSIDE THE CATCH AND CARRIED OUT. `inFlightAtError` must be snapshotted BEFORE
 * the failing call is decremented out of the in-flight count — that is the field the whole
 * load-correlation hypothesis turns on (403-diagnosis §3), and a caller that snapshots after the
 * throw has already lost it. Building there and reading here keeps both properties: one payload
 * definition, and an honest concurrency number.
 */
export function bedrockFailurePayload(label: string | null, model: string, e: unknown): Record<string, unknown> {
  const attached = (e as Record<symbol, unknown> | null)?.[FAILURE_PAYLOAD];
  if (attached && typeof attached === 'object') return attached as Record<string, unknown>;
  return bedrockErrorPayload(label, model, e, providerCallsInFlight());
}

export interface BedrockGenerateOpts {
  model: string;
  /** The caller's per-attempt ceiling. Absent ⇒ the `utility` class budget from PROVIDER_BUDGETS. */
  timeoutMs?: number;
  /** The caller's try count. Absent ⇒ the `utility` class budget from PROVIDER_BUDGETS. */
  maxTries?: number;
  label?: string;
}

/**
 * THE GOVERNED-LAYER ENTRY POINT. One definition of "call Bedrock", used by BOTH arms of
 * governedChat — the traced one (lib/trace.ts) and the traceless one (lib/llm.ts).
 *
 * ⚠️ ONE FUNCTION ON PURPOSE. The Gemini/OpenRouter ladder is written twice, once per arm, and
 * that duplication is exactly how the 110 s ceiling fix (3039c42) reached one arm and not the
 * other for four days. Bedrock gets one loop; the arms differ only in what they LOG.
 *
 * Runs the repo's shared provider policy (`createWithRetry`): a per-attempt AbortController
 * deadline, transport/429/5xx retryable on a bounded budget, and a 200-that-is-not-a-completion
 * judged by `classifyProviderResponse` — which works here because `fromConverseOutput` returns the
 * OpenAI shape that classifier reads.
 *
 * THE DEFAULT BUDGET IS READ FROM THE TABLE, never restated as a literal: no caller ceiling ⇒
 * PROVIDER_BUDGETS.bedrock.utility (110 s × 3), the class every un-budgeted surface belongs to.
 * An audit-class caller passes its own, exactly as it does for Vertex and OpenRouter.
 *
 * Throws on failure. There is no second tier.
 */
export async function bedrockGenerate(params: ChatParams, opts: BedrockGenerateOpts): Promise<ChatCompletionLike> {
  assertKnownBedrockModel(opts.model);
  const util = PROVIDER_BUDGETS.bedrock.utility;
  beginProviderCall('bedrock');
  try {
    const res = await createWithRetry(
      (ro) => bedrockConverse(params, { model: opts.model, signal: ro.signal }),
      {
        provider: 'bedrock',
        model: opts.model,
        timeoutMs: opts.timeoutMs,
        maxTries: opts.maxTries,
        defaultTimeoutMs: util?.perAttemptMs,
        defaultMaxTries: util?.maxTries,
        onAttemptFailure: (f) => console.error(
          `[provider-retry] bedrock ${opts.model} attempt ${f.attempt}/${f.maxTries} ${f.kind}${f.status != null ? ` ${f.status}` : ''} — ${f.willRetry ? 'retrying' : 'giving up'}: ${f.message}`),
      },
    );
    endProviderCall('bedrock');
    return res as ChatCompletionLike;
  } catch (e) {
    // Snapshot in-flight BEFORE decrementing — the failing call counts (403-diagnosis §4.1).
    const inFlightAtError = providerCallsInFlight();
    endProviderCall('bedrock');
    const payload = bedrockErrorPayload(opts.label ?? null, opts.model, e, inFlightAtError);
    try { (e as Record<symbol, unknown>)[FAILURE_PAYLOAD] = payload; } catch { /* frozen/primitive throw — the reader rebuilds */ }
    // Loud, stable prefix, full body. There is no fallback line to write: fellBackTo is 'none'.
    console.error(`[provider-failed] bedrock ${opts.model} → none (F11: never falls back):`, JSON.stringify(payload));
    throw e;
  }
}
