import type { ModelTier } from './types.js'

/**
 * Code-side allowlist for the pinned ids in BEDROCK_MODEL_HAIKU, _SONNET and _OPUS.
 * An id is allowed when it is an Anthropic foundation-model id or inference-profile id
 * (optionally behind a geo prefix, or as an ARN) whose family word, taken as a whole token,
 * is the tier's family and no other family's. Versions are not pinned by the family check:
 * the env var pins the version, this list pins the provider and family.
 * Foundation-model ARNs carry an empty account field; inference-profile ARNs carry a 12-digit account.
 */
const GEO = '(?:(?:us|eu|apac|jp|au|ca|global|us-gov)\\.)?'
const ARN =
  '(?:arn:aws[a-z-]*:bedrock:[a-z0-9-]*:(?:\\d{12}:(?:inference-profile|foundation-model)|:foundation-model)/)?'
const PROVIDER = new RegExp(`^${ARN}${GEO}anthropic\\.([a-z0-9.:_-]+)$`)
const TOKEN_SPLIT = /[.:_-]/

const FAMILIES: readonly ModelTier[] = ['haiku', 'sonnet', 'opus']

/**
 * Exact pinned ids per tier. Empty until gating-lead supplies the production ids.
 * When a tier's list is non-empty, only those ids (exact match, after trim) are allowed for that tier.
 */
export const PINNED_MODEL_IDS: Record<ModelTier, readonly string[]> = {
  haiku: [],
  sonnet: [],
  opus: [],
}

export function isAllowedModelId(tier: ModelTier, id: string, pinned: Record<ModelTier, readonly string[]> = PINNED_MODEL_IDS): boolean {
  const trimmed = id.trim()
  const exact = pinned[tier]
  if (exact.length > 0) return exact.includes(trimmed)
  const match = PROVIDER.exec(trimmed)
  if (!match?.[1]) return false
  const tokens = new Set(match[1].split(TOKEN_SPLIT))
  const present = FAMILIES.filter((family) => tokens.has(family))
  return present.length === 1 && present[0] === tier
}

const CLAUDE_5 = /(?:^|[./])anthropic\.claude-(?:sonnet|opus|haiku|fable)-5(?:[-.:]|$)/

/**
 * Bedrock rejects `temperature` for Claude 5 family models (ValidationException 400,
 * "`temperature` is deprecated for this model."). False for those ids under any geo prefix or ARN, true otherwise.
 */
export function acceptsTemperature(modelId: string): boolean {
  return !CLAUDE_5.test(modelId.trim())
}

const CLAUDE_5_5 = /(?:^|[./])anthropic\.claude-(?:sonnet|opus|haiku|fable)-5-5(?:[-.:]|$)/

/**
 * Bedrock rejects a forced toolChoice (type "tool" or "any") for Claude 5.5 Sonnet and Opus; Haiku 5.5 accepts it,
 * but the whole 5.5 family defaults to `auto` (newcat-orch ruling). False for 5.5 ids under any geo prefix or ARN.
 */
export function supportsForcedToolChoice(modelId: string): boolean {
  return !CLAUDE_5_5.test(modelId.trim())
}

/** Names of the env vars whose id is set but not allowed. Ids are never echoed. */
export function disallowedModelEnv(
  ids: Record<ModelTier, string | undefined>,
  pinned: Record<ModelTier, readonly string[]> = PINNED_MODEL_IDS,
): string[] {
  const names: Record<ModelTier, string> = {
    haiku: 'BEDROCK_MODEL_HAIKU',
    sonnet: 'BEDROCK_MODEL_SONNET',
    opus: 'BEDROCK_MODEL_OPUS',
  }
  const out: string[] = []
  for (const tier of ['haiku', 'sonnet', 'opus'] as const) {
    const id = ids[tier]
    if (id && !isAllowedModelId(tier, id, pinned)) out.push(`${names[tier]} (not in allowlist)`)
  }
  return out
}

/**
 * Exact pinned ids for GEMINI_MODEL (Vertex publisher model ids, no `google/` prefix).
 * INFERRED: 'gemini-2.5-pro' is CDMSS's code default (lib/llm.ts GEMINI_MODEL); replace with the value
 * gating-lead reads from CDMSS production when it is reported.
 */
export const GEMINI_PINNED: readonly string[] = ['gemini-2.5-pro']

export function isAllowedGeminiModel(id: string, pinned: readonly string[] = GEMINI_PINNED): boolean {
  return pinned.includes(id.trim())
}
