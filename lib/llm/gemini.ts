/**
 * Gemini (Vertex AI) router — every ETA chat completion goes through here.
 *
 * ORDER: Vertex Gemini for the surface (when configured + flagged) → OpenRouter
 * (LLM_FALLBACK_MODELS, default google/gemini-2.5-flash then meta-llama/llama-4-scout).
 *
 * THERE IS NO OLLAMA IN ANY CHAIN (V, 22 Sep: qwen out of ETA entirely). qwen2.5:14b was the
 * local default and the fallback; it cost 11.55 GB on a 24 GB Mini and was reached from Vercel
 * through the Cloudflare tunnel. Embeddings still use nomic on Ollama — a separate concern, and
 * the KB corpus is nomic-768 — but nothing in this file talks to Ollama at all.
 *
 * THE PROVIDER COMES FROM THE CALL. routedChat returns `gemini:<model>` or
 * `openrouter:<model the RESPONSE reported>` — never a literal. In August this router swallowed
 * Gemini errors and served qwen for two months while traces said Gemini; scribe_llm_health now
 * reads this value verbatim and names a fallback on a Gemini-flagged surface `silent_fallback`.
 *
 * Vertex env: GCP_SA_KEY, GCP_PROJECT, GCP_LOCATION, and a flag — GEMINI_ALL=1 or GEMINI_<SURFACE>=1.
 * OpenRouter: OPENROUTER_API_KEY (Vercel) or OPENROUTER_API_KEY_FILE (the Mini); ZDR on every call
 * (lib/openrouter.ts — one client for all of ETA).
 */
import { getVertexAccessToken } from "../gcp-auth";
import { openrouterChat, OpenRouterError } from "../openrouter";

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

/** The Gemini model to use for `surface`, or undefined to go straight to the OpenRouter chain. */
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
 * Gemini-only attempt for `surface`. Returns null when Gemini is off/unconfigured, or a ChatOut when
 * it tried. For callers that are Gemini-ONLY BY DESIGN (fusion, live translate), which report
 * `off`/`error` rather than fall back. A caller that wants a fallback uses routedChat instead.
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

/** The OpenRouter fallback chain, in order. Only the env can change it; never Ollama. */
export const LLM_FALLBACK_DEFAULT = ["google/gemini-2.5-flash", "meta-llama/llama-4-scout"];
export function llmFallbackModels(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env.LLM_FALLBACK_MODELS ?? "").trim();
  const list = raw ? raw.split(",").map((m) => m.trim()).filter(Boolean) : LLM_FALLBACK_DEFAULT;
  return list;
}

/**
 * What routedChat will TRY FIRST for `surface`: a prediction, for labels shown BEFORE a call (a stage
 * "start" event, a health probe's configured model). The answer that counts is the `provider`
 * routedChat returns afterwards — record that, never this.
 */
export function firstRoute(surface: string, tier: "pro" | "flash" = "pro"): string {
  const g = pickGemini(surface, tier);
  return g ? `gemini:${g}` : `openrouter:${llmFallbackModels()[0]}`;
}

export type RoutedChatResult = { ok: boolean; content: string; error?: string; latency_ms: number; provider: string };

/**
 * Run a chat completion: Vertex Gemini for `surface` when flagged + configured, then the OpenRouter
 * chain. `provider` names whichever call answered — `gemini:<model>` or `openrouter:<model>` — and
 * `none` only when nothing did. A Gemini failure is logged by name before the fallback runs, so a
 * fallback is never silent in the logs either.
 */
export async function routedChat(p: {
  surface: string; tier?: "pro" | "flash"; messages: Msg[];
  temperature?: number; responseJson?: boolean; timeoutMs?: number; signal?: AbortSignal; maxTokens?: number;
}): Promise<RoutedChatResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  const gModel = pickGemini(p.surface, p.tier ?? "pro");
  if (gModel) {
    try {
      const token = await getVertexAccessToken();
      const r = await openaiChat({
        url: vertexBaseURL(), authToken: token, model: vertexModelName(gModel),
        messages: p.messages, temperature: p.temperature, responseJson: p.responseJson,
        maxTokens: p.maxTokens ?? 8192, timeoutMs: p.timeoutMs, signal: p.signal,
      });
      if (r.ok) return { ok: true, content: r.content, latency_ms: Date.now() - t0, provider: `gemini:${gModel}` };
      errors.push(`gemini:${r.status ? `http_${r.status}` : "failed"}`);
      console.warn(`[llm] gemini ${gModel} (${p.surface}) ${r.error ?? "empty"} -> openrouter fallback`);
    } catch (e) {
      errors.push("gemini:threw");
      console.warn(`[llm] gemini (${p.surface}) threw -> openrouter fallback: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    }
  }
  if (p.signal?.aborted) return { ok: false, content: "", error: "aborted", latency_ms: Date.now() - t0, provider: "none" };

  for (const model of llmFallbackModels()) {
    try {
      const r = await openrouterChat({
        model, messages: p.messages, temperature: p.temperature, responseJson: p.responseJson,
        maxTokens: p.maxTokens, timeoutMs: p.timeoutMs, signal: p.signal,
      });
      return { ok: true, content: r.content, latency_ms: Date.now() - t0, provider: `openrouter:${r.model}` };
    } catch (e) {
      // A closed code only (lib/openrouter.ts never puts a message, a header or the key in one).
      const code = e instanceof OpenRouterError ? e.code : "openrouter_error";
      errors.push(`openrouter:${model}=${code}`);
      if (p.signal?.aborted) break;
    }
  }
  return { ok: false, content: "", error: `all_failed: ${errors.join("; ")}`.slice(0, 300), latency_ms: Date.now() - t0, provider: "none" };
}

/**
 * routedChat in JSON mode, parsed. `json` is null when the call failed OR the content did not parse,
 * and `error` says which — a parse failure is not dressed up as an answer.
 */
export async function routedChatJson<T = unknown>(p: Parameters<typeof routedChat>[0]): Promise<{
  ok: boolean; json: T | null; provider: string; latency_ms: number; error?: string;
}> {
  const rc = await routedChat({ ...p, responseJson: true });
  if (!rc.ok) return { ok: false, json: null, provider: rc.provider, latency_ms: rc.latency_ms, error: rc.error };
  try {
    return { ok: true, json: JSON.parse(rc.content) as T, provider: rc.provider, latency_ms: rc.latency_ms };
  } catch {
    return { ok: false, json: null, provider: rc.provider, latency_ms: rc.latency_ms, error: "json_parse_failed" };
  }
}
