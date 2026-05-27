/**
 * Embedding helper for the KB retrieval path.
 *
 * Uses nomic-embed-text on the Mac Mini Ollama. POSTs directly to the
 * /embeddings endpoint (the OLLAMA_BASE_URL env var already includes
 * /v1 — verified Sprint 1.F.6 H2). No OpenAI SDK dep.
 *
 * Returns the embedding vector (typically 768-dim for nomic).
 */

const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const EMBED_TIMEOUT_MS = 15_000;

export type EmbedResult =
  | { ok: true; vector: number[]; latency_ms: number; model: string }
  | { ok: false; error: string; latency_ms: number };

export async function embedQuery(
  text: string,
  opts: { signal?: AbortSignal } = {},
): Promise<EmbedResult> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) return { ok: false, error: "OLLAMA_BASE_URL not set", latency_ms: 0 };
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "empty_text", latency_ms: 0 };
  }

  const url = `${base.replace(/\/+$/, "")}/embeddings`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
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
        model: EMBED_MODEL,
        input: trimmed,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `http_${res.status}: ${txt.slice(0, 120)}`, latency_ms };
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      return { ok: false, error: "no_embedding_in_response", latency_ms };
    }
    return { ok: true, vector: vec, latency_ms, model: EMBED_MODEL };
  } catch (e: unknown) {
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;
    if (controller.signal.aborted) {
      return { ok: false, error: `timeout_${EMBED_TIMEOUT_MS}ms`, latency_ms };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 200), latency_ms };
  }
}

/** Format a JS number[] as a pgvector literal: "[0.123,0.456,...]" */
export function vectorLiteral(v: number[]): string {
  return "[" + v.map((x) => x.toFixed(7)).join(",") + "]";
}
