import { GoogleAuth } from 'google-auth-library'
import { z } from 'zod'
import type { Sql } from '../db/sql.js'
import { JudgeUnavailable } from '../platform/agent/judge-port.js'
import { isAllowedGeminiModel } from './allowlist.js'
import { parseServiceAccountKey } from './gcp-federation.js'
import { chargeBudget, recordModelCall, setBudgetMax, type ModelCallDraft } from './ledger.js'

export const GEMINI_BUDGET_ID = 'gemini'
export const DEFAULT_GEMINI_BUDGET_MAX = 1000
export const GEMINI_TIMEOUT_MS = 60_000
const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'
/** Pro thinks before it answers and thinking counts against this cap (CDMSS lib/llm.ts: "+8192 headroom"). */
const MAX_OUTPUT_TOKENS = 8192

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const SERVED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

export interface GeminiConfig {
  project: string
  location: string
  /** Service-account JSON, raw or base64. Never log it. */
  keyJson: string
  model: string
  budgetMax: number
}

/** The slice of Env the client reads. */
export interface GeminiEnv {
  VERTEX_PROJECT?: string | undefined
  VERTEX_LOCATION?: string | undefined
  VERTEX_SA_KEY_JSON?: string | undefined
  GEMINI_MODEL?: string | undefined
  GEMINI_BUDGET_MAX: number
}

/** Null unless every piece is present and the model id is on the exact-id allowlist. */
export function geminiConfig(env: GeminiEnv): GeminiConfig | null {
  const { VERTEX_PROJECT: project, VERTEX_LOCATION: location, VERTEX_SA_KEY_JSON: keyJson, GEMINI_MODEL: model } = env
  if (!project || !location || !keyJson || !model) return null
  if (!SAFE_SEGMENT.test(project) || !SAFE_SEGMENT.test(location) || !SAFE_SEGMENT.test(model)) return null
  if (location.toLowerCase() === 'global') return null
  if (!isAllowedGeminiModel(model)) return null
  return { project, location, keyJson, model, budgetMax: env.GEMINI_BUDGET_MAX }
}

/** Regional host `{location}-aiplatform.googleapis.com` only: there is no `global` branch, so state cannot leave the pinned region. */
export function generateContentUrl(config: Pick<GeminiConfig, 'project' | 'location' | 'model'>): string {
  return `https://${config.location}-aiplatform.googleapis.com/v1/projects/${config.project}/locations/${config.location}/publishers/google/models/${config.model}:generateContent`
}

/** INFERRED request body for Vertex `generateContent` (REST, v1). */
export interface GeminiBody {
  systemInstruction: { parts: Array<{ text: string }> }
  contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>
  generationConfig: {
    temperature: number
    maxOutputTokens: number
    responseMimeType: 'application/json'
    responseSchema: typeof ANSWER_SCHEMA
  }
}

/** Strict answer schema sent as `generationConfig.responseSchema` (INFERRED: OpenAPI-subset field names). */
export const ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: { p_yes: { type: 'NUMBER', minimum: 0, maximum: 1 } },
  required: ['p_yes'],
} as const

const Answer = z.object({ p_yes: z.number().finite().min(0).max(1) }).strict()

export interface GeminiRequest {
  url: string
  body: GeminiBody
  timeoutMs: number
}
/** The parsed JSON of the HTTP response; the sender throws on a non-2xx status or a network failure. */
export type GeminiSender = (request: GeminiRequest) => Promise<unknown>

export class GeminiHttpError extends Error {
  constructor(readonly status: number) {
    super('Vertex returned an error status.')
    this.name = 'GeminiHttpError'
  }
}

/** Rejects with a TimeoutError after `ms`; the timer is always cleared. The raced work is left to finish on its own (nothing is closed here). */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('deadline'), { name: 'TimeoutError' })), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Default sender: service-account bearer token, one POST, no retry. Error text from Google is never kept.
 * One deadline covers the whole call, token fetch included (google-auth-library sets no timeout and retries POSTs).
 */
export function vertexSender(keyJson: string, fetchImpl: typeof fetch = fetch, tokenSource?: () => Promise<string | null | undefined>): GeminiSender {
  const getToken =
    tokenSource ??
    (() => {
      const auth = new GoogleAuth({ credentials: parseServiceAccountKey(keyJson), scopes: [CLOUD_PLATFORM] })
      return auth.getAccessToken()
    })
  return (request) => {
    const controller = new AbortController()
    const run = async (): Promise<unknown> => {
      const token = await getToken()
      if (!token) throw new Error('no_token')
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      })
      if (!response.ok) throw new GeminiHttpError(response.status)
      return (await response.json()) as unknown
    }
    const work = run()
    work.catch(() => undefined)
    return withDeadline(work, request.timeoutMs).catch((error: unknown) => {
      controller.abort()
      throw error
    })
  }
}

/**
 * INFERRED response shape (Vertex GenerateContentResponse, REST):
 * `candidates[].content.parts[].text`, `candidates[].finishReason`, `promptFeedback.blockReason`,
 * `usageMetadata.promptTokenCount` / `candidatesTokenCount`, and `modelVersion` (the served model).
 */
const Response = z
  .object({
    candidates: z
      .array(
        z
          .object({
            finishReason: z.string().optional(),
            content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() }).passthrough()).optional() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
    promptFeedback: z.object({ blockReason: z.string().optional() }).passthrough().optional(),
    usageMetadata: z.object({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional(), thoughtsTokenCount: z.number().optional() }).passthrough().optional(),
    modelVersion: z.string().optional(),
  })
  .passthrough()

function outputTokens(usage: { candidatesTokenCount?: number | undefined; thoughtsTokenCount?: number | undefined } | undefined): number | null {
  if (usage?.candidatesTokenCount === undefined && usage?.thoughtsTokenCount === undefined) return null
  return (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
}

export interface GeminiAnswer {
  p_yes: number
  /** From the response `modelVersion` field. Null = unverified. Never the intended id. */
  servedModelId: string | null
}

export interface GeminiAsk {
  system: string
  user: string
  traceId: string
  purpose: string
}

/** Creates the 'gemini' row when absent, then sets its max. An existing row is left alone (operator edits survive). */
export async function ensureGeminiBudget(sql: Sql, maxCalls: number): Promise<void> {
  const rows = await sql.query<{ id: string }>('insert into call_budgets (id, calls_used, max_calls) values ($1, 0, $2) on conflict (id) do nothing returning id', [
    GEMINI_BUDGET_ID,
    maxCalls,
  ])
  if (rows.rows.length === 0) return
  await setBudgetMax(sql, GEMINI_BUDGET_ID, maxCalls)
}

export class GeminiClient {
  constructor(
    private readonly sql: Sql,
    private readonly config: GeminiConfig,
    private readonly send: GeminiSender,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Charges the budget first, then makes one call. Every failure is a code-only JudgeUnavailable:
   * no retry, no other model. Nothing here logs; no provider text, state or key reaches an error.
   */
  async ask(input: GeminiAsk): Promise<GeminiAnswer> {
    await ensureGeminiBudget(this.sql, this.config.budgetMax)
    const charge = await chargeBudget(this.sql, GEMINI_BUDGET_ID)
    if (!charge.ok) throw new JudgeUnavailable('budget_exhausted')

    const started = this.now()
    const draft = (patch: Partial<ModelCallDraft>): ModelCallDraft => ({
      traceId: input.traceId,
      provider: 'vertex',
      tier: 'second_judge',
      intendedModelId: this.config.model,
      servedModelId: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: Math.max(0, Math.round(this.now() - started)),
      costUsd: null,
      status: 'failed',
      stopReason: null,
      errorType: null,
      purpose: input.purpose,
      ...patch,
    })
    const fail = async (status: ModelCallDraft['status'], errorType: string, stopReason: string | null = null, extra: Partial<ModelCallDraft> = {}): Promise<never> => {
      await recordModelCall(this.sql, draft({ status, errorType, stopReason, ...extra })).catch(() => undefined)
      throw new JudgeUnavailable(errorType)
    }

    let raw: unknown
    try {
      raw = await this.send({
        url: generateContentUrl(this.config),
        timeoutMs: GEMINI_TIMEOUT_MS,
        body: {
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: 'user', parts: [{ text: input.user }] }],
          generationConfig: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS, responseMimeType: 'application/json', responseSchema: ANSWER_SCHEMA },
        },
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const code = error instanceof GeminiHttpError ? `http_${error.status}` : name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport_error'
      return fail('unavailable', code)
    }

    const parsed = Response.safeParse(raw)
    if (!parsed.success) return fail('failed', 'invalid_response')
    const body = parsed.data
    const served = body.modelVersion && SERVED_ID.test(body.modelVersion) ? body.modelVersion : null
    const usage = {
      servedModelId: served,
      inputTokens: body.usageMetadata?.promptTokenCount ?? null,
      // Thinking tokens are billed as output (`thoughtsTokenCount`, VERIFIED field), so the ledger counts them.
      outputTokens: outputTokens(body.usageMetadata),
    }
    if (body.promptFeedback?.blockReason) return fail('refused', 'blocked', body.promptFeedback.blockReason.slice(0, 40), usage)
    const candidate = body.candidates?.[0]
    const finish = candidate?.finishReason
    if (!candidate || finish === undefined) return fail('failed', 'no_candidate', null, usage)
    if (finish === 'MAX_TOKENS') return fail('truncated', 'truncated', finish, usage)
    if (finish !== 'STOP') return fail('refused', 'not_stopped', finish.slice(0, 40), usage)
    const text = (candidate.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
    let answer: z.infer<typeof Answer>
    try {
      answer = Answer.parse(JSON.parse(text))
    } catch {
      return fail('failed', 'schema_failure', finish, usage)
    }
    await recordModelCall(this.sql, draft({ status: 'ok', stopReason: finish, ...usage }))
    return { p_yes: answer.p_yes, servedModelId: served }
  }
}
