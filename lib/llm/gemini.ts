/**
 * Gemini (Vertex AI) router — hybrid backend that takes the heavy LLM passes
 * (note generation, CDS reasoning, native-language analysis) OFF the Mac Mini and
 * onto Vertex Gemini, while LOCAL Ollama stays the default + the fallback.
 *
 * Mirrors the Even-CDMSS (CAT) pattern: Vertex's OpenAI-compatible endpoint, SA
 * access token, per-surface flags, soft-fail to Ollama. Embeddings stay on nomic
 * (the KB corpus is nomic-embedded). NO new npm deps — raw fetch + crypto.
 *
 * OFF by default: with no GCP_SA_KEY/GCP_PROJECT (geminiConfigured=false) every
 * call routes to Ollama exactly as before. Activate by setting the Vertex env
 * (GCP_SA_KEY, GCP_PROJECT, GCP_LOCATION) AND a flag: GEMINI_ALL=1, or per surface
 * GEMINI_NOTE=1 / GEMINI_CDS=1 / GEMINI_NATIVE=1.
 */
import { getVertexAccessToken } from "../gcp-auth";

const GCP_LOCATION = process.env.GCP_LOCATION || "asia-south1";
const GCP_PROJECT = process.env.GCP_PROJECT || "";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";
export const GEMINI_FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

export function geminiConfigured(): boolean {
  return Boolean(GCP_PROJECT && process.env.GCP_SA_KEY);
}

function vertexBaseURL(): string {
  const host = GCP_LOCATION === "global" ? "aiplatform.googleapis.com" : `${GCP_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1beta1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/endpoints/openapi`;
}
function vertexModelName(model: string): string {
  return model.startsWith("google/") ? model : `google/${model}`;
}

/** The Gemini model to use for `surface`, or undefined to stay on Ollama. */
export function pickGemini(surface: string, tier: "pro" | "flash" = "pro"): string | undefined {
  if (!geminiConfigured()) return undefined;
  const on = process.env.GEMINI_ALL === "1" || process.env[`GEMINI_${surface.toUpperCase()}`] === "1";
  if (!on) return undefined;
  return tier === "flash" ? GEMINI_FLASH_MODEL : GEMINI_MODEL;
}

type Msg = { role: string; content: string };
type ChatOut = { ok: boolean; content: string; error?: string; status?: number };

async function openaiChat(p: {
  url: string; authToken: string; model: string; messages: Msg[];
  temperature?: number; responseJson?: boolean; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal;
}): Promise<ChatOut> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), p.timeoutMs ?? 240_000);
  if (p.signal) {
    if (p.signal.aborted) controller.abort();
    else p.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const body: Record<string, unknown> = { model: p.model, messages: p.messages, temperature: p.temperature ?? 0, stream: false };
    if (p.responseJson) body.response_format = { type: "json_object" };
    if (p.maxTokens) body.max_tokens = p.maxTokens;
    const res = await fetch(`${p.url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.authToken}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) { const t = await res.text().catch(() => ""); return { ok: false, content: "", error: `http_${res.status}: ${t.slice(0, 160)}`, status: res.status }; }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = (j.choices?.[0]?.message?.content ?? "").trim();
    if (!content) return { ok: false, content: "", error: "empty_response", status: res.status };
    return { ok: true, content, status: res.status };
  } catch (e) {
    return { ok: false, content: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Gemini-only attempt for `surface` (no Ollama fallback inside). Returns null when
 * Gemini is off/unconfigured (caller keeps its existing local path), or a ChatOut
 * (ok/content or ok:false) when it tried. Used where the caller already has a local
 * fallback it wants to preserve verbatim (e.g. native analysis via qwenJson).
 */
export async function geminiChatIfOn(
  surface: string, tier: "pro" | "flash", messages: Msg[],
  opts: { temperature?: number; responseJson?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ChatOut | null> {
  const gModel = pickGemini(surface, tier);
  if (!gModel) return null;
  try {
    const token = await getVertexAccessToken();
    return await openaiChat({
      url: vertexBaseURL(), authToken: token, model: vertexModelName(gModel),
      messages, temperature: opts.temperature, responseJson: opts.responseJson,
      maxTokens: 8192, timeoutMs: opts.timeoutMs, signal: opts.signal,
    });
  } catch (e) {
    console.warn(`[llm] gemini (${surface}) threw: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    return { ok: false, content: "", error: "gemini_threw" };
  }
}

/**
 * Run a chat completion, preferring Gemini for `surface` when flagged+configured,
 * and ALWAYS soft-failing to local Ollama. Identical to the old direct Ollama
 * fetch when Gemini is off. Returns the assistant content + which provider ran.
 */
export async function routedChat(p: {
  surface: string; tier?: "pro" | "flash"; ollamaModel: string; messages: Msg[];
  temperature?: number; responseJson?: boolean; timeoutMs?: number; signal?: AbortSignal;
}): Promise<{ ok: boolean; content: string; error?: string; latency_ms: number; provider: string }> {
  const t0 = Date.now();
  const gModel = pickGemini(p.surface, p.tier ?? "pro");
  if (gModel) {
    try {
      const token = await getVertexAccessToken();
      const r = await openaiChat({
        url: vertexBaseURL(), authToken: token, model: vertexModelName(gModel),
        messages: p.messages, temperature: p.temperature, responseJson: p.responseJson,
        maxTokens: 8192, timeoutMs: p.timeoutMs, signal: p.signal,
      });
      if (r.ok) return { ok: true, content: r.content, latency_ms: Date.now() - t0, provider: `gemini:${gModel}` };
      console.warn(`[llm] gemini ${gModel} (${p.surface}) ${r.error ?? "empty"} -> ollama fallback`);
    } catch (e) {
      console.warn(`[llm] gemini (${p.surface}) threw -> ollama fallback: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    }
  }
  const base = process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL;
  if (!base) return { ok: false, content: "", error: "OLLAMA_BASE_URL not set", latency_ms: Date.now() - t0, provider: "none" };
  const r = await openaiChat({
    url: base, authToken: process.env.LLM_API_KEY ?? "ollama", model: p.ollamaModel,
    messages: p.messages, temperature: p.temperature, responseJson: p.responseJson,
    timeoutMs: p.timeoutMs, signal: p.signal,
  });
  return { ok: r.ok, content: r.content, error: r.error, latency_ms: Date.now() - t0, provider: "ollama" };
}
