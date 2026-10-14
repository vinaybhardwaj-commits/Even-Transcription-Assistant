/**
 * lib/llm-cost-core.ts — LLM cost model CORE (pure).
 *
 * Turns logged token counts (trace_events.payload.usage) into rupees, using an editable price
 * table (data/llm-pricing.json, loaded + fx-overridden in the wired lib/llm-cost.ts). PURE +
 * dependency-free so it unit-tests under `node --experimental-strip-types`. All arithmetic here
 * is deterministic; the wired layer only supplies the SQL-summed tokens + the pricing object.
 *
 * Tiering: Gemini 2.5 Pro list price steps up above a 200k-token prompt. `hi` selects the high
 * tier — per call it's `inTok > hiThresholdTokens`; for pre-bucketed aggregates the SQL groups by
 * that boolean so the right rate is applied without losing tiering.
 */

export interface ModelPrice {
  match: string;              // substring matched (case-insensitive) against the logged model name
  label: string;
  inUsdPerM: number;          // USD per 1M input tokens
  outUsdPerM: number;         // USD per 1M output tokens
  hiThresholdTokens?: number; // prompt size above which the high tier applies
  hiInUsdPerM?: number;
  hiOutUsdPerM?: number;
}
export interface Pricing {
  fxUsdInr: number;
  models: ModelPrice[];
  fallback: Omit<ModelPrice, 'match'>;
}

/**
 * BILLABLE OUTPUT TOKENS — the one definition, shared by every writer and reader of a token count.
 *
 * Gemini 2.5 is a THINKING model: it bills reasoning ("thoughts") tokens at the OUTPUT rate, but
 * `completion_tokens` EXCLUDES them while `total_tokens` includes them. Measured on a real analyze
 * call: total 9,639 = prompt 4,489 + completion 2,716 + reasoning 2,434 — so counting `completion`
 * alone drops ~47% of billable output, and output is ~93% of the ₹ (Pro output is $10/M vs $1.25/M
 * in). That understatement is exactly what made S6 report ₹11.30/doc for a ₹34/doc pipeline.
 *
 * `total − prompt` recovers visible + thinking output. When `total` is absent (non-thinking models,
 * or a provider that omits it) this reduces to `completion`, so it never under- or over-counts.
 *
 * This mirrors, in TypeScript, the `OUT_TOK` SQL in lib/llm-cost.ts — which was already correct.
 * The rule now has ONE statement per language, and lib/__tests__/cost-accuracy.test.ts pins them
 * to each other so the column path and the payload path can never drift apart again.
 */
export function billableOutputTokens(u: {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
} | null | undefined): number {
  const prompt = Number(u?.prompt_tokens) || 0;
  const completion = Number(u?.completion_tokens) || 0;
  const total = Number(u?.total_tokens) || 0;
  return Math.max(completion, total - prompt, 0);
}

/** The price row whose `match` substring appears in the model name (else the fallback). */
export function priceFor(model: string, pricing: Pricing): Omit<ModelPrice, 'match'> {
  const m = (model || '').toLowerCase();
  return pricing.models.find((p) => m.includes(p.match.toLowerCase())) ?? pricing.fallback;
}

/** Input/output $/1M rates for a model at the base or high tier. */
export function ratesFor(model: string, hi: boolean, pricing: Pricing): { inRate: number; outRate: number; label: string } {
  const p = priceFor(model, pricing);
  const useHi = hi && p.hiInUsdPerM != null && p.hiOutUsdPerM != null;
  return { inRate: useHi ? (p.hiInUsdPerM as number) : p.inUsdPerM, outRate: useHi ? (p.hiOutUsdPerM as number) : p.outUsdPerM, label: p.label };
}

export function modelLabel(model: string, pricing: Pricing): string { return priceFor(model, pricing).label; }

/** ₹ cost for a token count at an explicit tier (used for SQL-bucketed aggregates). */
export function costInr(model: string, inTok: number, outTok: number, hi: boolean, pricing: Pricing): number {
  return costUsd(model, inTok, outTok, hi, pricing) * pricing.fxUsdInr;
}

/**
 * USD cost for a token count. The same arithmetic `costInr` performs, stopped one step earlier.
 *
 * Added for per-run backfill accounting (Bedrock PRD §4.3.7), whose `cost_usd` column is USD by
 * specification: Bedrock bills in dollars and a run's spend should be comparable to an AWS invoice
 * without an FX round-trip. `costInr` now composes from this, so the two can never disagree about
 * anything except the exchange rate.
 */
export function costUsd(model: string, inTok: number, outTok: number, hi: boolean, pricing: Pricing): number {
  const { inRate, outRate } = ratesFor(model, hi, pricing);
  return ((Number(inTok) || 0) * inRate + (Number(outTok) || 0) * outRate) / 1_000_000;
}

/** ₹ cost for a single call, choosing the tier from its own prompt size. */
export function perCallInr(model: string, inTok: number, outTok: number, pricing: Pricing): number {
  const p = priceFor(model, pricing);
  const hi = p.hiThresholdTokens != null && (Number(inTok) || 0) > p.hiThresholdTokens;
  return costInr(model, inTok, outTok, hi, pricing);
}

/** ₹ with Indian grouping; compact for large sums. `paise` keeps 2dp for tiny per-call amounts. */
export function fmtInr(n: number, opts: { paise?: boolean } = {}): string {
  const v = Number(n) || 0;
  if (opts.paise && v < 100) return `₹${v.toFixed(2)}`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}
