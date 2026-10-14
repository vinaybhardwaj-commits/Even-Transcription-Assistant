/**
 * lib/bedrock-core.ts — PURE core for the Bedrock transport (Bedrock PRD §4.1, 7 Aug 2026).
 *
 * No AWS SDK, no crypto, no env, no network. Everything here is a total function over plain data:
 * the ID-token claim shape, the credential-freshness decision, and the two directions of the
 * Converse mapping. lib/bedrock.ts is the impure shell that mints tokens and calls AWS.
 *
 * The split is the repo's `*-core.ts` pattern and it is load-bearing here for one specific reason:
 * the credential refresh is the piece we CANNOT exercise in CI (it needs a warm Vercel instance and
 * 61 minutes), so the DECISION it turns on has to be provable without a network. `credentialsUsable`
 * is that decision, and it is tested against fake expirations.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The model catalogue
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE ONLY THREE MODEL IDS S1 ACCEPTS (kickoff §"Model IDs"), with their display labels.
 *
 * The `global.` prefix names a CROSS-REGION (global) inference profile. That is a pricing fact as
 * well as a routing one: Bedrock's global endpoints carry the standard per-token rate, while
 * REGIONAL endpoints add a 10% premium (Anthropic pricing docs, "Regional and multi-region endpoint
 * pricing for Claude 4.5 models and beyond", read 7 Aug 2026). data/llm-pricing.json prices these
 * at the global rate, so a regional profile id (`apac.anthropic.…`) would be metered 10% light.
 *
 * ⚠️ AN UNLISTED ID IS REFUSED, NOT PASSED THROUGH (see `assertKnownBedrockModel`). A model with no
 * row in data/llm-pricing.json falls through to the Gemini fallback price and would be metered at
 * someone else's rate — an unattributable cost row is the same defect class as an unattributable
 * audit row. Adding a model is two lines: this table and a pricing row.
 */
export const BEDROCK_MODELS: Readonly<Record<string, string>> = Object.freeze({
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': 'Haiku 4.5',
  'global.anthropic.claude-sonnet-4-6': 'Sonnet 4.6',
  'global.anthropic.claude-opus-4-6-v1': 'Opus 4.6',
});

/** The display label for a Bedrock model id, or null when the id is not one of the three. */
export function bedrockModelLabel(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  return BEDROCK_MODELS[modelId] ?? null;
}

export function isKnownBedrockModel(modelId: string | null | undefined): boolean {
  return bedrockModelLabel(modelId) !== null;
}

/** Refuse an unlisted model LOUDLY, naming the three that exist. Never falls back. */
export function assertKnownBedrockModel(modelId: string): void {
  if (isKnownBedrockModel(modelId)) return;
  throw new Error(
    `bedrock: unknown model '${modelId}' — S1 serves only ${Object.keys(BEDROCK_MODELS).join(', ')}. ` +
    `Never falls back. Add the id to BEDROCK_MODELS *and* a pricing row in data/llm-pricing.json first.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The four env vars a Bedrock call needs. `GCP_SA_KEY` is the only secret; the other three are not. */
export const BEDROCK_ENV_VARS = ['GCP_SA_KEY', 'BEDROCK_REGION', 'BEDROCK_ROLE_ARN', 'BEDROCK_OIDC_AUDIENCE'] as const;

/**
 * Configuration probe, same shape as `geminiConfigured()`: all four present ⇒ true.
 *
 * ⚠️ `BEDROCK_REGION`, DELIBERATELY NOT `AWS_REGION`. Vercel's runtime sets `AWS_REGION` itself, so
 * gating on it would read as half-configured on every deploy. (The same note stood on the
 * BEDROCK_API_KEY stub this replaced — `BEDROCK_API_KEY` is dead: there is no AWS secret.)
 */
export function bedrockConfiguredFrom(env: Record<string, string | undefined>): boolean {
  return BEDROCK_ENV_VARS.every((k) => Boolean(env[k]));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Leg 1 — the Google ID token
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// ⚠️ NOTHING PURE LIVES HERE ANY MORE, AND THAT IS THE FIX (7 Aug 2026).
//
// This section used to hold `idTokenClaims` — the JWT-bearer assertion shape (`target_audience` in
// place of `scope`), tested to the letter. The shape was correct and the flow was wrong: Google's
// token endpoint answers HTTP 400 `invalid_scope` for a numeric AWS audience, reproduced live
// against the real service-account key. A pure function cannot catch that; only a live call can,
// and the unit test that pinned the claim shape was quietly asserting the correctness of a request
// that could never succeed.
//
// The mint is now two network steps with no interesting local arithmetic (access token →
// IAM Credentials `:generateIdToken`), so it lives entirely in lib/gcp-auth.ts and is pinned by
// request-shape assertions rather than by a value-returning helper. See `getGcpIdToken` there.

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Leg 2 — the STS credential cache
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Absolute expiry. The AWS SDK auto-refreshes any provider that returns one. */
  expiration: Date;
}

/** The same 5-minute skew `getVertexAccessToken` uses. One rule, three token caches. */
export const CREDENTIAL_REFRESH_SKEW_MS = 5 * 60_000;

/**
 * THE REFRESH DECISION, stated as a function so it can be tested without a network or a warm
 * instance. True ⇒ the cached credentials are still usable; false ⇒ mint a new set.
 *
 * Verification 8 ("two calls 61 minutes apart on one warm instance succeed") is exactly this
 * function returning false on the second call: STS hands back a 60-minute credential, so at
 * t+61min the cache is expired and `expiration - skew > now` is false for any positive skew.
 * Anything unparseable (null expiry, NaN date) is treated as UNUSABLE — a credential we cannot
 * date is one we must not reuse.
 */
export function credentialsUsable(
  cred: { expiration?: Date | string | number | null } | null | undefined,
  nowMs: number,
  skewMs: number = CREDENTIAL_REFRESH_SKEW_MS,
): boolean {
  if (!cred || cred.expiration == null) return false;
  const t = cred.expiration instanceof Date ? cred.expiration.getTime() : new Date(cred.expiration).getTime();
  if (!Number.isFinite(t)) return false;
  return t - skewMs > nowMs;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Leg 3 — the Converse mapping, both directions
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ChatMessage { role?: string; content?: unknown }
export interface ChatParams {
  model?: string;
  messages?: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [k: string]: unknown;
}

/**
 * OUTPUT FLOOR for a Bedrock call (7 Aug 2026, measured).
 *
 * ⚠️ BEDROCK WAS THE ONLY CLOUD PROVIDER GETTING THE MINI'S CAP RAW. Both other cloud paths already
 * rewrite the caller's ceiling before it goes out — `baseMax + 8192` in lib/trace.ts and lib/llm.ts
 * — because a cap tuned for qwen (700–800 tokens on the critique legs) does not fit a frontier
 * model's output. This transport passed it straight through, so the caps stayed mini-sized and only
 * on Bedrock.
 *
 * What that cost, live: an ask `critique` leg (max_tokens 800) came back HTTP 200
 * `finish_reason=length` at ~2,900 characters, three times. The JSON critique never closed, so it
 * never parsed, so the run recorded ZERO issues — an un-critiqued answer that reads exactly like a
 * clean one. The critic was not lenient; it never finished a sentence.
 *
 * A FLOOR, not an addend, and that difference is the point. Gemini's `+8192` exists because a
 * thinking model spends output budget on hidden reasoning BEFORE the answer, so it needs headroom
 * proportional to nothing the caller can see. Claude on Converse (no extended thinking here) spends
 * none — it simply writes longer prose than a 7B model. So the fix is "never less than enough to
 * finish", while a caller that deliberately asks for MORE keeps its own number.
 *
 * 4096 is sized from the observed truncation (~800 tokens produced ~2,900 chars of an unfinished
 * critique): comfortably more than double the point of failure, and bounded in cost by actual
 * generation — an unused ceiling is free.
 */
export const BEDROCK_MIN_MAX_TOKENS = 4096;

export interface ConverseInput {
  modelId: string;
  system?: Array<{ text: string }>;
  messages: Array<{ role: 'user' | 'assistant'; content: Array<{ text: string }> }>;
  inferenceConfig?: { maxTokens?: number; temperature?: number };
}

/** Flatten a message `content` to text. Strings pass through; OpenAI part arrays are joined. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : typeof (p as { text?: unknown })?.text === 'string' ? String((p as { text: string }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

/**
 * OpenAI-style chat params → Converse input.
 *
 *   system messages          → `system: [{ text }]`   (in order, kept as separate blocks)
 *   user / assistant         → `messages: [{ role, content: [{ text }] }]`
 *   max_tokens / temperature → `inferenceConfig`
 *
 * ⚠️ CONSECUTIVE SAME-ROLE TURNS ARE MERGED. Converse rejects them; the OpenAI shape allows them,
 * and the repo's audit prompts do emit them. Merging is the only lossless mapping — dropping one
 * would silently change the prompt, and a prompt that differs from what the call site wrote is the
 * failure mode this whole build exists to prevent.
 *
 * ⚠️ Ollama-only params (`options`, `keep_alive`) and `stream` are DROPPED, exactly as the Vertex
 * and OpenRouter branches drop them. Streaming is handled by the caller (see `singleChunkStream`);
 * Converse itself is a single-shot call.
 *
 * NOT NORMALISED: a conversation that opens with an assistant turn. Bedrock refuses it, and that
 * refusal is the correct, loud outcome — inventing a user turn would put words in the prompt.
 */
export function toConverseInput(params: ChatParams, modelId: string): ConverseInput {
  const system: Array<{ text: string }> = [];
  const messages: ConverseInput['messages'] = [];
  for (const m of params.messages ?? []) {
    const text = messageText(m?.content);
    const role = String(m?.role ?? 'user').toLowerCase();
    if (role === 'system' || role === 'developer') {
      if (text) system.push({ text });
      continue;
    }
    const mapped: 'user' | 'assistant' = role === 'assistant' ? 'assistant' : 'user';
    const last = messages[messages.length - 1];
    if (last && last.role === mapped) last.content.push({ text });
    else messages.push({ role: mapped, content: [{ text }] });
  }

  const inferenceConfig: { maxTokens?: number; temperature?: number } = {};
  const maxTokens = Number(params.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    inferenceConfig.maxTokens = Math.max(Math.floor(maxTokens), BEDROCK_MIN_MAX_TOKENS);
  }
  const temperature = Number(params.temperature);
  if (Number.isFinite(temperature)) inferenceConfig.temperature = temperature;

  return {
    modelId,
    ...(system.length ? { system } : {}),
    messages,
    ...(Object.keys(inferenceConfig).length ? { inferenceConfig } : {}),
  };
}

/**
 * Converse `stopReason` → OpenAI `finish_reason`.
 *
 * ⚠️ THIS MAPPING IS LOAD-BEARING, NOT COSMETIC. `classifyProviderResponse` (lib/provider-error-core.ts)
 * treats any finish_reason outside USABLE_FINISH_REASONS as a defect and the shared retry loop then
 * throws a ProviderResponseError. Leaving Bedrock's native `end_turn` unmapped would make EVERY
 * successful Bedrock call look like a failed one.
 */
export function mapStopReason(stopReason: unknown): string {
  switch (String(stopReason ?? '').toLowerCase()) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'content_filter';
    case '':
      return 'stop';   // absent ⇒ the call completed; content is the real signal (see classifyProviderResponse)
    default:
      return String(stopReason).toLowerCase();
  }
}

export interface ConverseOutput {
  output?: { message?: { role?: string; content?: Array<{ text?: string }> } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/** The OpenAI-shaped completion every caller in this repo already knows how to read. */
export interface ChatCompletionLike {
  id: string;
  model: string;
  provider: 'bedrock';
  choices: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Converse response → the OpenAI chat-completion shape.
 *
 * WHY MAP AT ALL. Every consumer downstream of `tracedChat` — the response logger, the cost
 * tracker's `payload.usage.{prompt,completion,total}_tokens`, `billableOutputTokens`,
 * `classifyProviderResponse`, and every call site's `choices[0].message.content` — speaks this
 * shape. Mapping once here is what makes "add a provider" a transport change and not a
 * fifty-call-site change.
 *
 * `total_tokens` is `inputTokens + outputTokens` when Converse omits its own total, so
 * `billableOutputTokens` (max(completion, total − prompt)) reduces to `outputTokens` exactly.
 */
export function fromConverseOutput(res: ConverseOutput, modelId: string): ChatCompletionLike {
  const parts = res?.output?.message?.content ?? [];
  const content = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  const inTok = Number(res?.usage?.inputTokens) || 0;
  const outTok = Number(res?.usage?.outputTokens) || 0;
  const total = Number(res?.usage?.totalTokens);
  return {
    id: `bedrock-${modelId}`,
    model: modelId,
    provider: 'bedrock',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: mapStopReason(res?.stopReason) }],
    usage: {
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: Number.isFinite(total) && total > 0 ? total : inTok + outTok,
    },
  };
}

/**
 * A `stream: true` caller's contract, satisfied from a single-shot Converse call.
 *
 * WHY THIS EXISTS. `/api/ask` and `/api/ddx` — the two routes the lab MCP drives, i.e. the two
 * routes verification 2 runs on — iterate their result with `for await`. Handing them a plain
 * object throws "is not async iterable" and `lab_ask` fails on a Bedrock model. The alternative
 * (ConverseStream) is a second transport with its own error surface; S1 does not need it.
 *
 * WHAT IT IS NOT: real streaming. The whole answer arrives in one chunk after the full call, so
 * time-to-first-token equals time-to-last-token. Everything downstream (token accumulation, the
 * NDJSON emit loop, logStreamComplete) works unchanged. `usage` rides a final chunk with empty
 * choices, exactly as Vertex's `include_usage` chunk does, so a stream-usage reader sees it.
 */
export async function* singleChunkStream(c: ChatCompletionLike): AsyncGenerator<unknown> {
  yield {
    id: c.id,
    model: c.model,
    provider: c.provider,
    choices: [{ index: 0, delta: { role: 'assistant', content: c.choices[0]?.message?.content ?? '' }, finish_reason: c.choices[0]?.finish_reason ?? 'stop' }],
  };
  yield { id: c.id, model: c.model, provider: c.provider, choices: [], usage: c.usage };
}
