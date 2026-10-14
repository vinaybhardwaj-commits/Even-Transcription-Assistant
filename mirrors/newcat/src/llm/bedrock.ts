import { BedrockClient, GetInferenceProfileCommand } from '@aws-sdk/client-bedrock'
import { BedrockRuntimeClient, ConverseCommand, type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime'
import type { AwsCredentialIdentityProvider } from '@smithy/types'
import type { Sql } from '../db/sql.js'
import type { StageOutcome } from '../outcome.js'
import { acceptsTemperature } from './allowlist.js'
import { chargeBudget, recordModelCall } from './ledger.js'
import { estimateCost } from './prices.js'
import { type ModelClient, type ModelCompletion, type ModelRequest, type ModelTier, type ModelToolSpec, type ServedSource } from './types.js'

export interface BedrockTurn {
  system: string
  user: string
  maxTokens: number
  tool?: ModelToolSpec
}

export interface BedrockRaw {
  text: string
  toolInput: unknown | null
  stopReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  /** The model the provider says served the call. Null when it did not say. Never the intended id by default. */
  servedModelId?: string | null
  /** Absent means unverified. */
  servedSource?: ServedSource
}

/** A served id implies a source; a null id is always unverified. */
export function normalizeServed(
  servedModelId: string | null | undefined,
  servedSource: ServedSource | undefined,
): { servedModelId: string | null; servedSource: ServedSource } {
  if (!servedModelId) return { servedModelId: null, servedSource: 'unverified' }
  return { servedModelId, servedSource: servedSource && servedSource !== 'unverified' ? servedSource : 'response' }
}

/** Resolves an inference profile id or ARN to the one foundation model behind it, or null. */
export type ProfileResolver = (modelId: string) => Promise<string | null>

const PROFILE_ID = /^(?:us|eu|apac|jp|au|ca|global|us-gov)\./

export function isInferenceProfile(modelId: string): boolean {
  return PROFILE_ID.test(modelId) || modelId.includes(':inference-profile/')
}

/** `arn:...:foundation-model/<id>` to `<id>`. */
export function foundationModelId(modelArn: string): string | null {
  const marker = 'foundation-model/'
  const at = modelArn.indexOf(marker)
  const id = at < 0 ? '' : modelArn.slice(at + marker.length)
  return id || null
}

/**
 * Served model for one Converse call. INFERRED: ConverseResponse has no served-model field in
 * @aws-sdk/client-bedrock-runtime 3.1149.0; only `trace.promptRouter.invokedModelId` (prompt routers).
 * For an inference profile the resolved model comes from GetInferenceProfile, cached per process.
 */
export async function readServedModel(
  invokedModelId: string | undefined,
  intendedId: string,
  resolveProfile: ProfileResolver,
): Promise<{ servedModelId: string | null; servedSource: ServedSource }> {
  if (invokedModelId) return normalizeServed(invokedModelId, 'response')
  if (isInferenceProfile(intendedId)) {
    const resolved = await resolveProfile(intendedId).catch(() => null)
    if (resolved) return normalizeServed(resolved, 'inference_profile')
  }
  return { servedModelId: null, servedSource: 'unverified' }
}

export function sdkProfileResolver(region: string, credentials?: AwsCredentialIdentityProvider): ProfileResolver {
  const client = new BedrockClient({ region, ...(credentials ? { credentials } : {}) })
  const cache = new Map<string, string | null>()
  return async (modelId) => {
    if (cache.has(modelId)) return cache.get(modelId) ?? null
    let resolved: string | null = null
    try {
      const profile = await client.send(new GetInferenceProfileCommand({ inferenceProfileIdentifier: modelId }))
      const ids = new Set<string>()
      for (const model of profile.models ?? []) {
        const id = model.modelArn ? foundationModelId(model.modelArn) : null
        if (id) ids.add(id)
      }
      resolved = ids.size === 1 ? ([...ids][0] ?? null) : null
    } catch {
      resolved = null
    }
    cache.set(modelId, resolved)
    return resolved
  }
}

export interface BedrockSender {
  send(modelId: string, input: BedrockTurn): Promise<BedrockRaw>
}

/** Forced tool choice. The input schema is the caller's JSON Schema object. */
export function converseToolConfig(tool: ModelToolSpec): {
  tools: { toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } } }[]
  toolChoice: { tool: { name: string } }
} {
  return {
    tools: [
      {
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { json: tool.inputSchema },
        },
      },
    ],
    toolChoice: { tool: { name: tool.name } },
  }
}

export function sdkSender(
  region: string,
  credentials?: AwsCredentialIdentityProvider,
  resolveProfile: ProfileResolver = sdkProfileResolver(region, credentials),
): BedrockSender {
  const client = new BedrockRuntimeClient({
    region,
    ...(credentials ? { credentials } : {}),
  })
  return {
    async send(modelId, input) {
      const response = await client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: input.system }],
          messages: [{ role: 'user', content: [{ text: input.user }] }],
          inferenceConfig: { maxTokens: input.maxTokens, ...(acceptsTemperature(modelId) ? { temperature: 0 } : {}) },
          ...(input.tool ? { toolConfig: converseToolConfig(input.tool) as ToolConfiguration } : {}),
        }),
      )
      const blocks = response.output?.message?.content ?? []
      let text = ''
      let toolInput: unknown | null = null
      for (const block of blocks) {
        if ('text' in block && block.text) text += block.text
        if ('toolUse' in block && block.toolUse && block.toolUse.input !== undefined) toolInput = block.toolUse.input
      }
      const served = await readServedModel(response.trace?.promptRouter?.invokedModelId, modelId, resolveProfile)
      return {
        ...served,
        text,
        toolInput,
        stopReason: response.stopReason ?? null,
        inputTokens: response.usage?.inputTokens ?? null,
        outputTokens: response.usage?.outputTokens ?? null,
        latencyMs: response.metrics?.latencyMs ?? null,
      }
    },
  }
}

/** The provider error's class name (e.g. ValidationException), never its message. */
function providerErrorName(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? (error as { name: unknown }).name : null
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(name) ? name : 'transport'
}

export class BedrockModelClient implements ModelClient {
  constructor(
    private readonly sql: Sql,
    private readonly sender: BedrockSender,
    private readonly modelIds: Record<ModelTier, string | undefined>,
  ) {}

  async complete(request: ModelRequest): Promise<StageOutcome<ModelCompletion>> {
    const intended = this.modelIds[request.tier]
    if (!intended) {
      return {
        status: 'unavailable',
        error: { type: 'model_not_configured', message: 'No Bedrock model id is configured for this tier.' },
      }
    }
    const charged = await chargeBudget(this.sql, 'llm')
    if (!charged.ok) {
      return { status: 'refused', error: { type: 'budget_exhausted', message: 'The model call budget is exhausted.' } }
    }
    const started = Date.now()
    try {
      const sent = await this.sender.send(intended, {
        system: request.system,
        user: request.user,
        maxTokens: request.maxOutputTokens,
        ...(request.tool ? { tool: request.tool } : {}),
      })
      const raw = { ...sent, ...normalizeServed(sent.servedModelId, sent.servedSource) }
      const latencyMs = raw.latencyMs ?? Date.now() - started
      const costUsd =
        raw.inputTokens === null || raw.outputTokens === null
          ? null
          : estimateCost('bedrock', request.tier, raw.inputTokens, raw.outputTokens)
      if (raw.stopReason === 'max_tokens') {
        await recordModelCall(this.sql, {
          traceId: request.traceId,
          provider: 'bedrock',
          tier: request.tier,
          intendedModelId: intended,
          servedModelId: raw.servedModelId,
          inputTokens: raw.inputTokens,
          outputTokens: raw.outputTokens,
          latencyMs,
          costUsd,
          status: 'truncated',
          stopReason: raw.stopReason,
          errorType: 'truncated',
          purpose: request.purpose,
        })
        return { status: 'truncated', error: { type: 'truncated', message: 'The model hit the output token cap.' } }
      }
      if (raw.stopReason === 'content_filtered' || raw.stopReason === 'guardrail_intervened') {
        await recordModelCall(this.sql, {
          traceId: request.traceId,
          provider: 'bedrock',
          tier: request.tier,
          intendedModelId: intended,
          servedModelId: raw.servedModelId,
          inputTokens: raw.inputTokens,
          outputTokens: raw.outputTokens,
          latencyMs,
          costUsd,
          status: 'refused',
          stopReason: raw.stopReason,
          errorType: 'refused',
          purpose: request.purpose,
        })
        return { status: 'refused', error: { type: 'model_refused', message: 'The model refused the request.' } }
      }
      const callId = await recordModelCall(this.sql, {
        traceId: request.traceId,
        provider: 'bedrock',
        tier: request.tier,
        intendedModelId: intended,
        servedModelId: raw.servedModelId,
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        latencyMs,
        costUsd,
        status: 'ok',
        stopReason: raw.stopReason,
        errorType: null,
        purpose: request.purpose,
      })
      const text = raw.text || (raw.toolInput !== null ? JSON.stringify(raw.toolInput) : '')
      return {
        status: 'ok',
        data: {
          text,
          toolInput: raw.toolInput,
          intendedModelId: intended,
          servedModelId: raw.servedModelId,
          servedSource: raw.servedSource,
          provider: 'bedrock',
          inputTokens: raw.inputTokens,
          outputTokens: raw.outputTokens,
          latencyMs,
          costUsd,
          callId,
          stopReason: raw.stopReason,
        },
      }
    } catch (error) {
      await recordModelCall(this.sql, {
        traceId: request.traceId,
        provider: 'bedrock',
        tier: request.tier,
        intendedModelId: intended,
        servedModelId: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Date.now() - started,
        costUsd: null,
        status: 'unavailable',
        stopReason: null,
        errorType: providerErrorName(error),
        purpose: request.purpose,
      })
      return {
        status: 'unavailable',
        error: { type: 'model_unavailable', message: 'The model gateway did not complete the call.' },
      }
    }
  }
}

export interface ServedProbe {
  auth_mode: string
  intended: string | null
  served: string | null
  served_source: ServedSource
}

export type ServedProbeResult =
  | { ok: true; probe: ServedProbe }
  | { ok: false; reason: 'budget_exhausted' | 'failed'; errorType: string }

/**
 * One 1-token Haiku call through BedrockModelClient: the 'llm' budget is charged first and a
 * model_calls row (purpose 'health') is written. Ids only; the prompt is the word `ok`, not a clinical note.
 */
export async function probeServedModel(
  sql: Sql,
  intended: string | undefined,
  authMode: string,
  sender: BedrockSender,
  traceId: string,
): Promise<ServedProbeResult> {
  // A 1-token reply usually stops on max_tokens, which the client reports as truncated without data,
  // so the served fields are captured from the sender's return instead.
  let seen: BedrockRaw | null = null
  const capturing: BedrockSender = {
    async send(modelId, input) {
      seen = await sender.send(modelId, input)
      return seen
    },
  }
  const outcome = await new BedrockModelClient(sql, capturing, { haiku: intended, sonnet: undefined, opus: undefined }).complete({
    tier: 'haiku',
    system: 'Reply with one word.',
    user: 'ok',
    maxOutputTokens: 1,
    traceId,
    purpose: 'health',
  })
  if (outcome.status === 'ok' || outcome.status === 'truncated') {
    const raw = seen as BedrockRaw | null
    const { servedModelId: served, servedSource } = normalizeServed(raw?.servedModelId, raw?.servedSource)
    return {
      ok: true,
      probe: {
        auth_mode: authMode,
        intended: intended ?? null,
        served,
        served_source: servedSource,
      },
    }
  }
  const errorType = 'error' in outcome ? outcome.error.type : 'failed'
  return { ok: false, reason: errorType === 'budget_exhausted' ? 'budget_exhausted' : 'failed', errorType }
}
