/**
 * lib/lab-v2/pricing.ts — the (provider, model) → price table and its version
 * (LAB-MCP-V2-PRD-v1.0 §6.3).
 *
 * Prices are MICROUSD PER MILLION TOKENS, so the arithmetic that turns a usage record
 * into a cost is integer-only: microusd = tokens * rate / 1_000_000, floored. Budgets
 * are bigint microusd columns and the reservation invariant is an integer comparison —
 * no float ever touches a budget row, because a float that rounds the wrong way at the
 * cap is a real overspend.
 *
 * RATES ARE COPIED, NOT INVENTED. Every row below is the verified rate already carried
 * in data/llm-pricing.json (Bedrock Claude verified 7 Aug 2026 against the Anthropic
 * pricing table at global-endpoint rates; OpenRouter Qwen 19 Jul 2026; Vertex Gemini
 * 1 Jul 2026), converted USD-per-million → microusd-per-million by ×1e6. That file
 * stays the production cost tracker's source; this one is the lab's, because the lab
 * needs a (provider, model) key while the tracker matches on a substring of a logged
 * model name, and a substring matcher must never decide what a research budget spends.
 *
 * ⚠️ BUMP PRICING_VERSION WHENEVER A ROW CHANGES. `calls.pricing_version` records which
 * table priced each call, so a later reconciliation can tell a rate change from a usage
 * change. A silent edit makes every historical cost unauditable.
 */
import type { Provider } from './contracts';

export const PRICING_VERSION = 'lab-v2-pricing/1.0.0';

export interface PriceRow {
  /** Microusd per 1M input tokens. */
  inputPerMTokens: number;
  /** Microusd per 1M output tokens. */
  outputPerMTokens: number;
  label: string;
}

const USD_PER_M = (usd: number) => Math.round(usd * 1_000_000);

/**
 * Exact-key table. A model absent here is NOT priced by guesswork — `priceFor` returns
 * null and the gateway treats the call's cost as unknown, which is the honest state and
 * the one the budget invariant already models. Silently pricing an unknown model at a
 * neighbour's rate is how a cap stops meaning anything.
 */
export const PRICES: Readonly<Record<string, PriceRow>> = Object.freeze({
  // Bedrock — global cross-region inference profiles (the only ids lib/bedrock.ts accepts).
  'bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0': { inputPerMTokens: USD_PER_M(1.0), outputPerMTokens: USD_PER_M(5.0), label: 'Claude Haiku 4.5 (Bedrock)' },
  'bedrock:global.anthropic.claude-sonnet-4-6': { inputPerMTokens: USD_PER_M(3.0), outputPerMTokens: USD_PER_M(15.0), label: 'Claude Sonnet 4.6 (Bedrock)' },
  'bedrock:global.anthropic.claude-opus-4-6-v1': { inputPerMTokens: USD_PER_M(5.0), outputPerMTokens: USD_PER_M(25.0), label: 'Claude Opus 4.6 (Bedrock)' },
  // OpenRouter.
  'openrouter:qwen/qwen3-32b': { inputPerMTokens: USD_PER_M(0.08), outputPerMTokens: USD_PER_M(0.28), label: 'Qwen3 32B (OpenRouter)' },
  'openrouter:qwen/qwen3-30b-a3b': { inputPerMTokens: USD_PER_M(0.10), outputPerMTokens: USD_PER_M(0.30), label: 'Qwen3 30B-A3B (OpenRouter)' },
  'openrouter:google/gemini-2.5-pro': { inputPerMTokens: USD_PER_M(1.25), outputPerMTokens: USD_PER_M(10.0), label: 'Gemini 2.5 Pro (OpenRouter)' },
  'openrouter:google/gemini-2.5-flash': { inputPerMTokens: USD_PER_M(0.30), outputPerMTokens: USD_PER_M(2.50), label: 'Gemini 2.5 Flash (OpenRouter)' },
  // Vertex (direct).
  'vertex:gemini-2.5-pro': { inputPerMTokens: USD_PER_M(1.25), outputPerMTokens: USD_PER_M(10.0), label: 'Gemini 2.5 Pro (Vertex)' },
  'vertex:gemini-2.5-flash': { inputPerMTokens: USD_PER_M(0.30), outputPerMTokens: USD_PER_M(2.50), label: 'Gemini 2.5 Flash (Vertex)' },
  // Local execution is free by definition (§6.3); it reports compute seconds instead.
  'ollama:*': { inputPerMTokens: 0, outputPerMTokens: 0, label: 'local (ollama)' },
});

export function priceKey(provider: Provider, model: string): string {
  return provider === 'ollama' ? 'ollama:*' : `${provider}:${model}`;
}

export function priceFor(provider: Provider, model: string): PriceRow | null {
  return PRICES[priceKey(provider, model)] ?? null;
}

/** The models model_capabilities advertises per provider (§6.1). */
export function modelsFor(provider: Provider): string[] {
  if (provider === 'ollama') return ['*'];
  const prefix = `${provider}:`;
  return Object.keys(PRICES).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** True when this exact (provider, model) is priced — experiment_create's gate (§6.1). */
export function isSupportedModel(provider: Provider, model: string): boolean {
  return priceFor(provider, model) !== null;
}

/**
 * Integer cost of one call. Floor, not round: a half-microusd rounded up across
 * thousands of calls is a budget that reports more spent than was spent, and rounded
 * down is a cap that leaks. Floor is the conventional, defensible direction and it is
 * applied identically to both legs.
 */
export function costMicrousd(provider: Provider, model: string, inputTokens: number, outputTokens: number): number | null {
  const row = priceFor(provider, model);
  if (!row) return null;
  const inCost = Math.floor((inputTokens * row.inputPerMTokens) / 1_000_000);
  const outCost = Math.floor((outputTokens * row.outputPerMTokens) / 1_000_000);
  return inCost + outCost;
}
