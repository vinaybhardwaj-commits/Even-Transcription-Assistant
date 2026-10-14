import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import type { Env } from '../config.js'
import type { Sql } from '../db/sql.js'
import { sha256 } from '../hash.js'
import { credentialProvider } from '../llm/aws.js'
import { chargeBudget, recordModelCall } from '../llm/ledger.js'
import { estimateCost } from '../llm/prices.js'
import type { StageOutcome } from '../outcome.js'
import { EMBEDDING_DIM } from './hits.js'

export interface Embedder {
  readonly modelId: string
  embed(texts: string[], purpose: 'document' | 'query', traceId: string): Promise<StageOutcome<number[][]>>
}

export function vectorLiteral(values: number[]): string {
  if (values.length !== EMBEDDING_DIM) {
    throw new Error('embedding dimensions')
  }
  const parts = values.map((value) => {
    if (!Number.isFinite(value)) throw new Error('embedding value')
    return value.toFixed(8)
  })
  return `[${parts.join(',')}]`
}

/** Deterministic bag-of-words embedding. Shared tokens raise cosine similarity. No network. */
export function fakeEmbed(text: string, dimensions = EMBEDDING_DIM): number[] {
  const vec = new Array<number>(dimensions).fill(0)
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const token of tokens) {
    const hash = sha256(token)
    const index = Number.parseInt(hash.slice(0, 8), 16) % dimensions
    const sign = Number.parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1
    vec[index] = (vec[index] ?? 0) + sign
  }
  let norm = 0
  for (const value of vec) norm += value * value
  norm = Math.sqrt(norm) || 1
  return vec.map((value) => value / norm)
}

export class FakeEmbedder implements Embedder {
  readonly modelId = 'fake.titan-embed-text-v2'

  constructor(private readonly sql: Sql) {}

  async embed(texts: string[], _purpose: 'document' | 'query', traceId: string): Promise<StageOutcome<number[][]>> {
    if (texts.length === 0) return { status: 'empty', reason: 'no_text' }
    const charged = await chargeBudget(this.sql, 'embed')
    if (!charged.ok) {
      return { status: 'unavailable', error: { type: 'budget_exhausted', message: 'The embed call budget is exhausted.' } }
    }
    await recordModelCall(this.sql, {
      traceId,
      provider: 'fake',
      tier: 'embed',
      intendedModelId: this.modelId,
      servedModelId: this.modelId,
      inputTokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
      outputTokens: 0,
      latencyMs: 0,
      costUsd: estimateCost('fake', 'embed', texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0), 0),
      status: 'ok',
      stopReason: null,
      errorType: null,
      purpose: 'evidence.embed',
    })
    return { status: 'ok', data: texts.map((text) => fakeEmbed(text)) }
  }
}

export class UnavailableEmbedder implements Embedder {
  readonly modelId = 'unconfigured'

  constructor(private readonly errorType: string) {}

  async embed(): Promise<StageOutcome<number[][]>> {
    return {
      status: 'unavailable',
      error: { type: this.errorType, message: 'The embedding model is not configured.' },
    }
  }
}

interface InvokeBody {
  body?: Uint8Array
}

export interface EmbedInvoker {
  invoke(modelId: string, payload: unknown): Promise<unknown>
}

export function sdkEmbedInvoker(region: string, env: Env): EmbedInvoker {
  const credentials = credentialProvider(env)
  const client = new BedrockRuntimeClient({
    region,
    ...(credentials ? { credentials } : {}),
  })
  return {
    async invoke(modelId, payload) {
      const response = await client.send(
        new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: new TextEncoder().encode(JSON.stringify(payload)),
        }),
      )
      return decodeInvoke(response)
    },
  }
}

function decodeInvoke(response: InvokeBody): unknown {
  if (!response.body) return {}
  return JSON.parse(new TextDecoder().decode(response.body)) as unknown
}

export class BedrockEmbedder implements Embedder {
  readonly modelId: string

  constructor(
    private readonly sql: Sql,
    private readonly invoker: EmbedInvoker,
    modelId: string,
    private readonly dimensions: number,
  ) {
    this.modelId = modelId
  }

  async embed(texts: string[], purpose: 'document' | 'query', traceId: string): Promise<StageOutcome<number[][]>> {
    if (texts.length === 0) return { status: 'empty', reason: 'no_text' }
    if (this.dimensions !== EMBEDDING_DIM) {
      return {
        status: 'unavailable',
        error: { type: 'embedding_dimensions', message: 'Embeddings are stored at 1024 dimensions.' },
      }
    }
    try {
      if (this.modelId.toLowerCase().includes('cohere')) {
        const vectors = await this.invokeCohere(texts, purpose, traceId)
        return vectors
      }
      const vectors: number[][] = []
      for (const text of texts) {
        const one = await this.invokeTitan(text, traceId)
        if (one.status !== 'ok') return one
        const row = one.data[0]
        if (!row) return { status: 'unavailable', error: { type: 'embedding_empty', message: 'The embedding response was empty.' } }
        vectors.push(row)
      }
      return { status: 'ok', data: vectors }
    } catch {
      return { status: 'unavailable', error: { type: 'model_unavailable', message: 'The embed call did not complete.' } }
    }
  }

  private async invokeTitan(text: string, traceId: string): Promise<StageOutcome<number[][]>> {
    const charged = await chargeBudget(this.sql, 'embed')
    if (!charged.ok) {
      return { status: 'unavailable', error: { type: 'budget_exhausted', message: 'The embed call budget is exhausted.' } }
    }
    try {
      const parsed = await this.invoker.invoke(this.modelId, {
        inputText: text,
        dimensions: this.dimensions,
        normalize: true,
      })
      const embedding = readTitan(parsed)
      if (!embedding) {
        await this.record(traceId, 'unavailable', 'embedding_empty', null)
        return { status: 'unavailable', error: { type: 'embedding_empty', message: 'The embedding response was empty.' } }
      }
      await this.record(traceId, 'ok', null, titanTokens(parsed))
      return { status: 'ok', data: [embedding] }
    } catch {
      await this.record(traceId, 'unavailable', 'transport', null)
      return { status: 'unavailable', error: { type: 'model_unavailable', message: 'The embed call did not complete.' } }
    }
  }

  private async invokeCohere(texts: string[], purpose: 'document' | 'query', traceId: string): Promise<StageOutcome<number[][]>> {
    const charged = await chargeBudget(this.sql, 'embed')
    if (!charged.ok) {
      return { status: 'unavailable', error: { type: 'budget_exhausted', message: 'The embed call budget is exhausted.' } }
    }
    try {
      const parsed = await this.invoker.invoke(this.modelId, {
        texts,
        input_type: purpose === 'query' ? 'search_query' : 'search_document',
        embedding_types: ['float'],
      })
      const embeddings = readCohere(parsed)
      if (!embeddings || embeddings.length !== texts.length) {
        await this.record(traceId, 'unavailable', 'embedding_empty', null)
        return { status: 'unavailable', error: { type: 'embedding_empty', message: 'The embedding response was empty.' } }
      }
      await this.record(traceId, 'ok', null, null)
      return { status: 'ok', data: embeddings }
    } catch {
      await this.record(traceId, 'unavailable', 'transport', null)
      return { status: 'unavailable', error: { type: 'model_unavailable', message: 'The embed call did not complete.' } }
    }
  }

  private async record(traceId: string, status: 'ok' | 'unavailable', errorType: string | null, inputTokens: number | null): Promise<void> {
    await recordModelCall(this.sql, {
      traceId,
      provider: 'bedrock',
      tier: 'embed',
      intendedModelId: this.modelId,
      servedModelId: status === 'ok' ? this.modelId : null,
      inputTokens,
      outputTokens: 0,
      latencyMs: null,
      costUsd: inputTokens === null ? null : estimateCost('bedrock', 'embed', inputTokens, 0),
      status,
      stopReason: null,
      errorType,
      purpose: 'evidence.embed',
    })
  }
}

function readTitan(parsed: unknown): number[] | null {
  if (!parsed || typeof parsed !== 'object' || !('embedding' in parsed)) return null
  const embedding = (parsed as { embedding?: unknown }).embedding
  return normalizeVector(embedding)
}

function titanTokens(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object' || !('inputTextTokenCount' in parsed)) return null
  const count = (parsed as { inputTextTokenCount?: unknown }).inputTextTokenCount
  return typeof count === 'number' ? count : null
}

function readCohere(parsed: unknown): number[][] | null {
  if (!parsed || typeof parsed !== 'object' || !('embeddings' in parsed)) return null
  const embeddings = (parsed as { embeddings?: unknown }).embeddings
  if (Array.isArray(embeddings) && embeddings.every((row) => Array.isArray(row))) {
    const vectors = embeddings.map((row) => normalizeVector(row))
    return vectors.every((row): row is number[] => row !== null) ? vectors : null
  }
  if (embeddings && typeof embeddings === 'object' && 'float' in embeddings) {
    const rows = (embeddings as { float?: unknown }).float
    if (!Array.isArray(rows)) return null
    const vectors = rows.map((row) => normalizeVector(row))
    return vectors.every((row): row is number[] => row !== null) ? vectors : null
  }
  return null
}

function normalizeVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIM) return null
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item))) return null
  return value
}

export function buildEmbedder(sql: Sql, env: Env): Embedder {
  if (env.NEWCAT_EMBED === 'fake') return new FakeEmbedder(sql)
  if (!env.BEDROCK_REGION) return new UnavailableEmbedder('region_not_configured')
  return new BedrockEmbedder(sql, sdkEmbedInvoker(env.BEDROCK_REGION, env), env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSIONS)
}
