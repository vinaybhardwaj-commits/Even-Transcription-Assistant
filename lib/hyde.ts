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
 * Model: llama3.1:8b — runs on every CDMSS pass so it has to be
 * cheap. ~500-1500ms warm on the Mac Mini.
 */

const HYDE_MODEL = process.env.HYDE_MODEL || "llama3.1:8b";
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
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) {
    return { expanded: question, original: question, latency_ms: 0, ok: false };
  }
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), HYDE_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LLM_API_KEY ?? "ollama"}`,
      },
      body: JSON.stringify({
        model: HYDE_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: question },
        ],
        temperature: HYDE_TEMPERATURE,
        max_tokens: HYDE_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(tid);
    if (!res.ok) {
      return {
        expanded: question,
        original: question,
        latency_ms: Date.now() - t0,
        ok: false,
      };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const txt = (json.choices?.[0]?.message?.content ?? "").trim();
    // Belt + suspenders: always retrieve the ORIGINAL question's terms too
    const expanded = txt ? `${question}\n\n${txt}` : question;
    return { expanded, original: question, latency_ms: Date.now() - t0, ok: true };
  } catch {
    clearTimeout(tid);
    return {
      expanded: question,
      original: question,
      latency_ms: Date.now() - t0,
      ok: false,
    };
  }
}
