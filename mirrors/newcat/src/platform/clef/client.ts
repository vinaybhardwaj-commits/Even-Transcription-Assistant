import { createHash } from 'node:crypto'
import type { Sql } from '../../db/sql.js'
import { recordModelCall } from '../../llm/ledger.js'
import { budgetMaxFromEnv, chargeClef, ensureClefBudget, inputCostUsd } from './budget.js'
import {
  CLEF_QUESTION_SET,
  MODEL_ID,
  MODEL_NAME,
  STATE_TEXT,
  parseAnswers,
  questionsPayload,
  type ClefAnswers,
} from './questions.js'
import {
  ClefBudgetError,
  ClefConfigError,
  ClefDisabled,
  ClefError,
  ClefHttpError,
  ClefLimitError,
  ClefParseError,
  MAX_CLIPS,
  MAX_WAV_BYTES,
  inspectWav,
  wavDataUri,
} from './wav.js'

export const MAX_ATTEMPTS = 5
export type ClefMode = 'live' | 'fake' | 'off'

export interface ClefRequest {
  url: string
  headers: Record<string, string>
  body: ClefBody
}
export interface ClefBody {
  model: string
  state: string
  audio: string[]
  questions: ReturnType<typeof questionsPayload>
}
export interface ClefHttpResult {
  status: number
  headers: Record<string, string>
  body: string
}
/** A transport may throw on network failure; that counts as status 0 and is retried. */
export type ClefTransport = (request: ClefRequest) => Promise<ClefHttpResult>

/** Port of build_body. */
export function buildBody(wavs: Uint8Array[]): ClefBody {
  if (wavs.length < 1 || wavs.length > MAX_CLIPS) throw new ClefLimitError(`clef accepts 1 to ${MAX_CLIPS} audio clips per call`)
  return { model: MODEL_NAME, state: STATE_TEXT, audio: wavs.map(wavDataUri), questions: questionsPayload() }
}

export function runUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL_ID}`
}

export function backoffSeconds(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null && Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(30, retryAfter)
  return Math.min(16, 0.5 * 2 ** attempt)
}

function retryAfterSeconds(headers: Record<string, string>): number | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'retry-after' && v.trim() !== '') {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

/** Strips anything token- or audio-shaped from text that may reach an error message. */
export function scrub(text: string, secret?: string): string {
  let out = text.replace(/[\r\n]/g, ' ')
  if (secret) out = out.split(secret).join('[redacted]')
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, '[audio]')
  out = out.replace(/https?:\/\/\S+/gi, '[url]').replace(/[A-Za-z0-9+/=_-]{40,}/g, '[redacted]')
  return out.slice(0, 180)
}

function errorDetail(body: string, secret: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: unknown }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const first = parsed.errors[0] as { message?: unknown } | string
      return scrub(typeof first === 'string' ? first : String(first?.message ?? ''), secret)
    }
  } catch {
    /* not json */
  }
  return scrub(body, secret)
}

export function fetchTransport(fetchImpl: typeof fetch = fetch, timeoutMs = 60_000): ClefTransport {
  return async (request) => {
    const res = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => (headers[k] = v))
    return { status: res.status, headers, body: await res.text() }
  }
}

/** Offline transport for NEWCAT_CLEF=fake. Deterministic, no network, no audio kept. */
export function fakeTransport(): ClefTransport {
  return async (request) => {
    const h = createHash('sha256').update(request.body.audio.join('|')).digest()
    const dist = (b: number): Record<string, number> => {
      const raw = [1, 2, 3, 2, 1].map((w, i) => w + ((b >> i) & 1))
      const total = raw.reduce((a, c) => a + c, 0)
      return Object.fromEntries(raw.map((w, i) => [String(i), w / total]))
    }
    const noul = (i: number): { noul: number } => ({ noul: ((h[i] ?? 0) % 100) / 100 })
    const body = {
      success: true,
      result: {
        answers: {
          valence: { probabilities: dist(h[0] ?? 0) },
          arousal: { probabilities: dist(h[1] ?? 0) },
          anxious: noul(2),
          engaged: noul(3),
          one_patient: noul(4),
        },
        usage: { input_tokens: 100 * request.body.audio.length, output_tokens: 10 },
      },
    }
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }
}

export interface ClefResult {
  answers: ClefAnswers
  questionSetId: string
  questionSetSha: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  attempts: number
  clips: number
}

export interface ClefDeps {
  sql: Sql
  traceId: string
  /** Defaults to process.env; names read here: CF_ACCOUNT_ID, CF_WORKERS_AI_TOKEN, NEWCAT_CLEF, CLEF_BUDGET_MAX. */
  env?: Record<string, string | undefined>
  transport?: ClefTransport
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  purpose?: string
}

export function clefMode(env: Record<string, string | undefined>): ClefMode {
  const raw = (env.NEWCAT_CLEF ?? 'off').trim().toLowerCase()
  if (raw === 'live' || raw === 'fake' || raw === 'off') return raw
  throw new ClefConfigError('NEWCAT_CLEF must be live, fake or off')
}

export class ClefClient {
  private constructor(
    private readonly deps: ClefDeps,
    private readonly mode: Exclude<ClefMode, 'off'>,
    private readonly transport: ClefTransport,
    private readonly account: string,
    private readonly token: string,
  ) {}

  /** Throws ClefDisabled when NEWCAT_CLEF is off. Creates the 'clef' budget row when it is missing. */
  static async create(deps: ClefDeps): Promise<ClefClient> {
    const env = deps.env ?? process.env
    const mode = clefMode(env)
    if (mode === 'off') throw new ClefDisabled('Clef is off. Set NEWCAT_CLEF=live (or fake for offline runs).')
    let account = ''
    let token = ''
    if (mode === 'live') {
      account = (env.CF_ACCOUNT_ID ?? '').trim()
      if (!account || /[/\s]/.test(account)) throw new ClefConfigError('CF_ACCOUNT_ID is not a usable account id')
      token = (env.CF_WORKERS_AI_TOKEN ?? '').trim()
      if (!token) throw new ClefConfigError('CF_WORKERS_AI_TOKEN is unset')
    }
    await ensureClefBudget(deps.sql, budgetMaxFromEnv(env.CLEF_BUDGET_MAX))
    const transport = deps.transport ?? (mode === 'fake' ? fakeTransport() : fetchTransport(deps.fetchImpl))
    return new ClefClient(deps, mode, transport, account, token)
  }

  /**
   * Scores 1-4 WAV clips in one call. Limits are checked before the budget is charged and before any transport call.
   * Each attempt charges the 'clef' budget first and writes one model_calls row. Audio is not kept.
   */
  async score(wavs: Uint8Array[]): Promise<ClefResult> {
    if (wavs.length < 1 || wavs.length > MAX_CLIPS) throw new ClefLimitError(`clef accepts 1 to ${MAX_CLIPS} audio clips per call`)
    for (const wav of wavs) inspectWav(wav)
    const request: ClefRequest = {
      url: runUrl(this.account || 'fake'),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: buildBody(wavs),
    }
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await chargeClef(this.deps.sql)
      const started = Date.now()
      let result: ClefHttpResult
      try {
        result = await this.transport(request)
      } catch (cause) {
        const err = new ClefHttpError(0, scrub(cause instanceof Error ? cause.message : 'network error', this.token), attempt + 1)
        await this.record('unavailable', started, 0, 0, 'network')
        if (attempt + 1 === MAX_ATTEMPTS) throw err
        await sleep(backoffSeconds(attempt, null) * 1000)
        continue
      }
      if (result.status === 200) {
        try {
          const parsed = parseAnswers(JSON.parse(result.body) as unknown)
          const cost = inputCostUsd(parsed.inputTokens)
          await this.record('ok', started, parsed.inputTokens, parsed.outputTokens, null)
          return {
            answers: parsed.answers,
            questionSetId: CLEF_QUESTION_SET.id,
            questionSetSha: CLEF_QUESTION_SET.sha,
            model: MODEL_ID,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            costUsd: cost,
            attempts: attempt + 1,
            clips: wavs.length,
          }
        } catch (cause) {
          await this.record('failed', started, 0, 0, 'parse')
          if (cause instanceof ClefError) throw cause
          throw new ClefParseError('clef response was not json')
        }
      }
      const err = new ClefHttpError(result.status, errorDetail(result.body, this.token), attempt + 1)
      await this.record('failed', started, 0, 0, `http_${result.status}`)
      if (!err.retryable || attempt + 1 === MAX_ATTEMPTS) throw err
      await sleep(backoffSeconds(attempt, retryAfterSeconds(result.headers)) * 1000)
    }
    throw new ClefHttpError(0, 'clef retries exhausted', MAX_ATTEMPTS)
  }

  /**
   * Downloads short-TTL URLs, checks bounds, scores, and drops the bytes. URLs may carry tokens, so they are
   * never logged, never put in an error message and never returned.
   */
  async scoreUrls(urls: string[], fetchImpl: typeof fetch = this.deps.fetchImpl ?? fetch): Promise<ClefResult> {
    if (urls.length < 1 || urls.length > MAX_CLIPS) throw new ClefLimitError(`clef accepts 1 to ${MAX_CLIPS} audio clips per call`)
    const wavs: Uint8Array[] = []
    for (const url of urls) wavs.push(await downloadClip(url, fetchImpl))
    return this.score(wavs)
  }

  private async record(status: 'ok' | 'unavailable' | 'failed', started: number, input: number, output: number, errorType: string | null): Promise<void> {
    await recordModelCall(this.deps.sql, {
      traceId: this.deps.traceId,
      provider: this.mode === 'fake' ? 'fake' : 'typesafe',
      tier: 'clef',
      intendedModelId: MODEL_ID,
      servedModelId: null,
      inputTokens: input,
      outputTokens: output,
      latencyMs: Date.now() - started,
      costUsd: inputCostUsd(input),
      status,
      stopReason: null,
      errorType,
      purpose: this.deps.purpose ?? 'clef',
    })
  }
}

/** Reads at most MAX_WAV_BYTES + 1 bytes, then checks WAV bounds. Errors never carry the URL. */
export async function downloadClip(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  if (!/^https:\/\//i.test(url)) throw new ClefLimitError('clef clip url must be https')
  let res: Response
  try {
    res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  } catch {
    throw new ClefHttpError(0, 'clip download failed', 1)
  }
  if (!res.ok) throw new ClefHttpError(res.status, 'clip download failed', 1)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_WAV_BYTES) throw new ClefLimitError('clef clip exceeds 8 MiB')
  const reader = res.body?.getReader()
  if (!reader) throw new ClefHttpError(0, 'clip download failed', 1)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_WAV_BYTES) {
      await reader.cancel()
      throw new ClefLimitError('clef clip exceeds 8 MiB')
    }
    chunks.push(value)
  }
  const wav = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    wav.set(c, at)
    at += c.byteLength
  }
  inspectWav(wav)
  return wav
}

export interface ClefSupport {
  question_set_id: string
  question_set_sha: string
  model: string
  valence_expected: number
  valence_distribution: number[]
  arousal_expected: number
  arousal_distribution: number[]
  anxious: number
  engaged: number
  one_patient: number
}

/**
 * Supporting signal only. Returns a copy of `finding` whose only change is `support.clef`.
 * Nothing in the agent run path (rules, judge, abstention, action) imports this module or reads `support`.
 */
export function attachClef<F extends object>(finding: F, result: ClefResult): F & { support: { clef: ClefSupport } } {
  const prior = (finding as { support?: Record<string, unknown> }).support
  const clef: ClefSupport = {
    question_set_id: result.questionSetId,
    question_set_sha: result.questionSetSha,
    model: result.model,
    valence_expected: result.answers.valence.expected,
    valence_distribution: [...result.answers.valence.distribution],
    arousal_expected: result.answers.arousal.expected,
    arousal_distribution: [...result.answers.arousal.distribution],
    anxious: result.answers.anxious,
    engaged: result.answers.engaged,
    one_patient: result.answers.onePatient,
  }
  return { ...finding, support: { ...(prior ?? {}), clef } }
}

export { ClefBudgetError }
