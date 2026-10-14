import type { Sql } from '../db/sql.js'
import type { StageOutcome } from '../outcome.js'
import { chargeBudget, recordModelCall } from './ledger.js'
import { estimateCost } from './prices.js'
import { scriptedModelPayload } from './scripted-note.js'
import type { ModelClient, ModelCompletion, ModelRequest, ModelTier } from './types.js'

export const FAKE_MODEL_IDS: Record<ModelTier, string> = {
  haiku: 'fake.anthropic.claude-haiku-4-5',
  sonnet: 'fake.anthropic.claude-sonnet-4-6',
  opus: 'fake.anthropic.claude-opus-4-6',
}

export type FakeReply =
  | { kind: 'text'; text: string; toolInput?: unknown }
  | { kind: 'truncated'; text: string }
  | { kind: 'throw' }

function noteBody(user: string): string | null {
  const match = /NOTE_BODY_START\n([\s\S]*?)\nNOTE_BODY_END/.exec(user)
  return match?.[1] ?? null
}

export class FakeModelClient implements ModelClient {
  constructor(
    private readonly sql: Sql,
    private readonly respond?: (request: ModelRequest) => FakeReply,
  ) {}

  async complete(request: ModelRequest): Promise<StageOutcome<ModelCompletion>> {
    const intended = FAKE_MODEL_IDS[request.tier]
    const charged = await chargeBudget(this.sql, 'llm')
    if (!charged.ok) {
      return {
        status: 'refused',
        error: { type: 'budget_exhausted', message: 'The model call budget is exhausted.' },
      }
    }
    const started = Date.now()
    try {
      const reply = this.respond ? this.respond(request) : this.defaultReply(request)
      if (reply.kind === 'throw') throw new Error('fake transport failure')
      const latencyMs = Date.now() - started
      const inputTokens = Math.ceil((request.system.length + request.user.length) / 4)
      const outputTokens = Math.ceil(reply.text.length / 4)
      const costUsd = estimateCost('fake', request.tier, inputTokens, outputTokens)
      if (reply.kind === 'truncated') {
        const callId = await recordModelCall(this.sql, {
          traceId: request.traceId,
          provider: 'fake',
          tier: request.tier,
          intendedModelId: intended,
          servedModelId: intended,
          inputTokens,
          outputTokens,
          latencyMs,
          costUsd,
          status: 'truncated',
          stopReason: 'max_tokens',
          errorType: 'truncated',
          purpose: request.purpose,
        })
        return {
          status: 'truncated',
          error: { type: 'truncated', message: 'The model hit the output token cap.' },
          // call id is on the ledger; the outcome stays typed truncated
          ...(callId ? {} : {}),
        }
      }
      const callId = await recordModelCall(this.sql, {
        traceId: request.traceId,
        provider: 'fake',
        tier: request.tier,
        intendedModelId: intended,
        servedModelId: intended,
        inputTokens,
        outputTokens,
        latencyMs,
        costUsd,
        status: 'ok',
        stopReason: 'end_turn',
        errorType: null,
        purpose: request.purpose,
      })
      return {
        status: 'ok',
        data: {
          text: reply.text,
          toolInput: reply.toolInput ?? null,
          intendedModelId: intended,
          servedModelId: intended,
          provider: 'fake',
          inputTokens,
          outputTokens,
          latencyMs,
          costUsd,
          callId,
          stopReason: 'end_turn',
        },
      }
    } catch {
      await recordModelCall(this.sql, {
        traceId: request.traceId,
        provider: 'fake',
        tier: request.tier,
        intendedModelId: intended,
        servedModelId: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Date.now() - started,
        costUsd: null,
        status: 'unavailable',
        stopReason: null,
        errorType: 'transport',
        purpose: request.purpose,
      })
      return {
        status: 'unavailable',
        error: { type: 'model_unavailable', message: 'The model gateway did not complete the call.' },
      }
    }
  }

  private defaultReply(request: ModelRequest): FakeReply {
    const body = noteBody(request.user)
    if (!body) return { kind: 'text', text: 'NOT_JSON' }
    try {
      return { kind: 'text', text: JSON.stringify(scriptedModelPayload(body)) }
    } catch {
      return { kind: 'text', text: 'NOT_JSON' }
    }
  }
}
