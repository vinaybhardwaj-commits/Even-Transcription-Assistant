/**
 * lib/jev/worker/builders/tokens.ts — the token estimate and the state budget (PRD §2, "Token budget").
 *
 * State plus the longest question must stay under 32k tokens. Indic script runs about 0.7-0.9 tokens per character, English about 0.3-0.4, so a flat
 * character count is not enough: the estimate is by SCRIPT. PURE.
 */
export const STATE_TOKEN_BUDGET = 28_000;   // 32k less room for the longest question (~3k) and the answer scaffolding
const INDIC = /[ऀ-෿]/;           // Devanagari .. Sinhala: Hindi, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam
const WIDE = /[؀-ۿ぀-ヿ一-鿿가-힯]/;   // Arabic-script, CJK: denser than Latin, lighter than Indic

export function estimateTokens(text: string): number {
  let t = 0;
  for (const ch of text) {
    if (INDIC.test(ch)) t += 0.85;
    else if (WIDE.test(ch)) t += 0.6;
    else t += 0.35;
  }
  return Math.ceil(t);
}
export const overBudget = (text: string, budget = STATE_TOKEN_BUDGET): boolean => estimateTokens(text) > budget;
