import type { StageOutcome } from '../outcome.js'

export type ModelTier = 'haiku' | 'sonnet' | 'opus'

/** Where a served model id came from. `unverified` means the provider did not say. */
export type ServedSource = 'response' | 'inference_profile' | 'unverified'

/** Legacy placeholder for an unverified served model. `servedModelId` is now null in that case; the ledger stores null too. */
export const UNVERIFIED_SERVED = 'unverified'

/** Per-agent extraction tier and its single escalation. audit.note uses AUDIT_NOTE_EXTRACT. */
export interface ExtractTierConfig {
  tier: ModelTier
  escalateTo: ModelTier | null
  maxRetries: 1
}

export const AUDIT_NOTE_EXTRACT: ExtractTierConfig = { tier: 'haiku', escalateTo: 'sonnet', maxRetries: 1 }

export interface ModelToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ModelRequest {
  tier: ModelTier
  system: string
  user: string
  maxOutputTokens: number
  traceId: string
  purpose: string
  tool?: ModelToolSpec
}

export interface ModelCompletion {
  text: string
  intendedModelId: string
  /** The served id, or null when the provider did not say. Never the intended id unless the provider said so. */
  servedModelId: string | null
  /** Set by the Bedrock client. Absent on the fake client. */
  servedSource?: ServedSource
  provider: 'bedrock' | 'fake'
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number
  costUsd: number | null
  callId: string
  stopReason: string | null
  /** Set when the model returned a Converse toolUse input. Null means parse `text`. */
  toolInput: unknown | null
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<StageOutcome<ModelCompletion>>
}
