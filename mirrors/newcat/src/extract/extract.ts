import { validateModel } from '../facts/validate.js'
import type { ClinicalState } from '../facts/schema.js'
import type { ModelClient, ModelCompletion } from '../llm/types.js'
import type { ValidationIssue } from '../outcome.js'
import { EXTRACT_MAX_OUTPUT_TOKENS, extractionSystem, extractionTool, extractUser } from './prompt.js'
import { parseModelJson } from './parse.js'
import { redactModelInput } from './redact.js'

export type ExtractResult =
  | { status: 'ok'; state: ClinicalState; callIds: string[]; servedModels: string[] }
  | {
      status: 'extraction_failed'
      errors: ValidationIssue[]
      callIds: string[]
      servedModels: string[]
      modelInput: unknown
    }
  | {
      status: 'unavailable' | 'truncated' | 'refused' | 'failed'
      error: { type: string; message: string }
      callIds: string[]
      servedModels: string[]
    }

function fromModel(
  outcome: Exclude<ExtractResult, { status: 'ok' | 'extraction_failed' }> | { status: string; error?: { type: string; message: string } },
  callIds: string[],
  servedModels: string[],
): ExtractResult {
  if (outcome.status === 'unavailable' || outcome.status === 'truncated' || outcome.status === 'refused' || outcome.status === 'failed') {
    return {
      status: outcome.status,
      error: outcome.error ?? { type: outcome.status, message: 'The model call failed.' },
      callIds,
      servedModels,
    }
  }
  return {
    status: 'failed',
    error: { type: 'unexpected_model_status', message: 'The model client returned an unexpected status.' },
    callIds,
    servedModels,
  }
}

export function readFacts(
  completion: { text: string; toolInput: unknown | null },
  body: string,
): { ok: true; state: ClinicalState } | { ok: false; errors: ValidationIssue[] } {
  try {
    const raw = completion.toolInput !== null ? completion.toolInput : parseModelJson(completion.text)
    return validateModel(raw, body)
  } catch {
    return { ok: false, errors: [{ code: 'schema', path: '', message: 'model output was not valid JSON' }] }
  }
}

/**
 * Haiku extracts. One Sonnet re-run follows a validation failure.
 * Provider failures and truncation are returned as themselves and are not escalated.
 */
export async function extractFacts(models: ModelClient, body: string, traceId: string): Promise<ExtractResult> {
  const user = extractUser(body)
  const system = extractionSystem()
  const tool = extractionTool()
  const haiku = await models.complete({
    tier: 'haiku',
    system,
    user,
    maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
    traceId,
    purpose: 'extract',
    tool,
  })
  if (haiku.status !== 'ok') return fromModel(haiku, [], [])
  const first = readFacts(haiku.data, body)
  if (first.ok) {
    return { status: 'ok', state: first.state, callIds: [haiku.data.callId], servedModels: servedIds(haiku.data) }
  }
  const sonnet = await models.complete({
    tier: 'sonnet',
    system,
    user,
    maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
    traceId,
    purpose: 'extract_escalation',
    tool,
  })
  if (sonnet.status !== 'ok') return fromModel(sonnet, [haiku.data.callId], servedIds(haiku.data))
  const second = readFacts(sonnet.data, body)
  const callIds = [haiku.data.callId, sonnet.data.callId]
  const servedModels = servedIds(haiku.data, sonnet.data)
  if (!second.ok) {
    return {
      status: 'extraction_failed',
      errors: second.errors,
      callIds,
      servedModels,
      modelInput: { haiku: tracedInput(haiku.data), sonnet: tracedInput(sonnet.data) },
    }
  }
  return { status: 'ok', state: second.state, callIds, servedModels }
}

/** Served ids the provider reported; unverified (null) calls are left out. */
function servedIds(...completions: ModelCompletion[]): string[] {
  return completions.flatMap((completion) => (completion.servedModelId === null ? [] : [completion.servedModelId]))
}

function tracedInput(completion: ModelCompletion): unknown {
  return {
    tool_input: completion.toolInput === null ? null : redactModelInput(completion.toolInput),
    text_chars: completion.text.length,
  }
}
