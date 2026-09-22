/**
 * Hypothetical Document Embeddings (HyDE).
 *
 * Pre-retrieval query rewriter — turns the user's question into a
 * textbook-style paragraph that embeds more like the chunks we're
 * trying to retrieve. Substantially improves recall on terse or
 * acronym-heavy clinical questions.
 *
 * Returns the EXPANDED query (or the original on failure). Caller
 * concatenates with the original to keep both lexical-and-semantic
 * signals in the embedding.
 *
 * Model: routedChat (cds surface, flash tier) — Vertex Gemini, then OpenRouter. It runs on every
 * CDMSS pass, so it stays on the cheap tier. It used to call llama3.1:8b on the Mini's Ollama
 * directly; no local chat model remains in ETA.
 */

import { routedChat } from "@/lib/llm/gemini";

const HYDE_TIMEOUT_MS = 10_000;
const HYDE_TEMPERATURE = 0.1;
const HYDE_MAX_TOKENS = 220;

const SYSTEM = `You are a medical query rewriter. Rewrite the user's clinical question into a single dense paragraph (40-80 words) that:
- Expands medical acronyms (HFrEF → heart failure with reduced ejection fraction; COPD → chronic obstructive pulmonary disease; ACS → acute coronary syndrome)
- Uses precise clinical terminology and likely textbook phrasing
- Includes relevant adjacent terms (pathophysiology, diagnostic criteria, first-line management)
- Reads like a textbook excerpt that would directly answer the question — NOT like a question

Return only the paragraph. No preamble, no explanation, no quotes.`;

export async function expandQuery(
  question: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ expanded: string; original: string; latency_ms: number; ok: boolean }> {
  const rc = await routedChat({
    surface: "cds", tier: "flash",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: question },
    ],
    temperature: HYDE_TEMPERATURE, maxTokens: HYDE_MAX_TOKENS, timeoutMs: HYDE_TIMEOUT_MS, signal: opts.signal,
  });
  // Unchanged contract: on any failure, retrieve on the original question alone.
  if (!rc.ok) return { expanded: question, original: question, latency_ms: rc.latency_ms, ok: false };
  const txt = rc.content.trim();
  // Belt + suspenders: always retrieve the ORIGINAL question's terms too
  const expanded = txt ? `${question}\n\n${txt}` : question;
  return { expanded, original: question, latency_ms: rc.latency_ms, ok: true };
}
