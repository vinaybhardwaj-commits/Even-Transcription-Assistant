/** List-price estimates from the 12 Oct 2026 redesign proposal. Not an invoice. */
const BEDROCK_PER_MILLION: Record<string, { input: number; output: number }> = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
}

const JEV_INPUT_PER_MILLION = 0.042
/** Public list price for Amazon Titan Text Embeddings V2. An estimate, not an invoice. */
const TITAN_EMBED_V2_PER_MILLION = 0.02

export function estimateCost(provider: 'bedrock' | 'typesafe' | 'fake', tier: string, inputTokens: number, outputTokens: number): number {
  if (tier === 'embed') {
    if (provider === 'fake') return 0
    return (inputTokens * TITAN_EMBED_V2_PER_MILLION) / 1_000_000
  }
  if (provider === 'typesafe' || tier === 'jev') {
    return (inputTokens * JEV_INPUT_PER_MILLION) / 1_000_000
  }
  const price = BEDROCK_PER_MILLION[tier]
  if (!price) return 0
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}
