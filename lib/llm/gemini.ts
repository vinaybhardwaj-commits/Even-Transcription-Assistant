/**
 * Gemini (Vertex AI) router — hybrid backend that takes the heavy LLM passes
 * (note generation, CDS reasoning, native-language analysis) OFF the Mac Mini and
 * onto Vertex Gemini, with OpenRouter as the fallback.
 *
 * Mirrors the Even-CDMSS (CAT) pattern: Vertex's OpenAI-compatible endpoint, SA
 * access token, per-surface flags, soft-fail to OpenRouter. Embeddings stay on nomic
 * via Ollama (the KB corpus is nomic-embedded) — that is a separate concern from this
 * file and untouched by it. NO new npm deps — raw fetch + crypto.
 *
 * OFF QWEN (V, 22 Sep). The retired 14B local model was 11.55 GB on a 24 GB Mini, reached from
 * Vercel through the Cloudflare tunnel. `routedChat`'s fallback used to be local Ollama;
 * it is now OpenRouter, on the same ZDR + data_collection:"deny" contract as the Jev
 * translate path (`lib/openrouter.ts`) — reused here, not duplicated. There is no Ollama
 * fallback left anywhere in this file.
 *
 * OFF by default: with no GCP_SA_KEY/GCP_PROJECT (geminiConfigured=false) every
 * `routedChat` call goes straight to OpenRouter exactly as it does on a Gemini failure.
 * Activate Gemini by setting the Vertex env (GCP_SA_KEY, GCP_PROJECT, GCP_LOCATION) AND
 * a flag: GEMINI_ALL=1, or per surface GEMINI_NOTE=1 / GEMINI_CDS=1 / GEMINI_NATIVE=1.
 */
import { getVertexAccessToken } from "../gcp-auth";
import { openrouterChat, OpenRouterError } from "../openrouter";

const GCP_LOCATION = process.env.GCP_LOCATION || "asia-south1";
const GCP_PROJECT = process.env.GCP_PROJECT || "";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";
export const GEMINI_FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

/** OpenRouter fallback chain, tried in order, first success wins. Env-overridable, comma list. */
export const ROUTED_CHAT_FALLBACK_DEFAULT = "google/gemini-2.5-flash,meta-llama/llama-4-scout";

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

type Env = Record<string, string | undefined>;

/** The OpenRouter models to try, in order. Default only when the env var is absent/empty. */
function routedChatFallbackChain(env: Env = process.env): string[] {
  const raw = env.ROUTED_CHAT_FALLBACK;
  const list = (raw === undefined || raw.trim() === "" ? ROUTED_CHAT_FALLBACK_DEFAULT : raw)
    .split(",").map((m) => m.trim()).filter(Boolean);
  return list.length > 0 ? list : ROUTED_CHAT_FALLBACK_DEFAULT.split(",");
}

/** The Gemini model to use for `surface`, or undefined to go straight to OpenRouter. */
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

/** A closed code for an OpenRouter failure inside routedChat's fallback loop. */
function openrouterCodeFor(e: unknown): string {
  if (e instanceof OpenRouterError) return e.code;
  if ((e as { name?: unknown } | null)?.name === "AbortError") return "openrouter_abort";
  return "openrouter_error";
}

/** Split routedChat's `messages` into openrouterChat's single system/user shape. Every current
 *  caller sends exactly one system + one user message; a caller that sent more (or none) still
 *  gets a sane result: all system-role content joined, all non-system content joined after it. */
function toSystemUser(messages: Msg[]): { system: string; user: string } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
  return { system, user };
}

/**
 * Gemini-only attempt for `surface` (no fallback inside). Returns null when Gemini is
 * off/unconfigured (caller keeps its existing local path), or a ChatOut (ok/content or
 * ok:false) when it tried. Used where the caller already has its own fallback it wants to
 * preserve verbatim (e.g. `lib/stt/fuse-transcript.ts`, the translate-live route).
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
 * Run a chat completion, preferring Gemini for `surface` when flagged+configured, and
 * ALWAYS soft-failing to OpenRouter (`google/gemini-2.5-flash`, then
 * `meta-llama/llama-4-scout`, under ZDR + data_collection:"deny" — `lib/openrouter.ts`,
 * the same client the Jev translate path uses; there is no second OpenRouter client).
 * There is no Ollama fallback: the local 14B model is retired (22 Sep). Returns the assistant
 * content + which provider ran — `gemini:<model>` or `openrouter:<model>` (the model the
 * RESPONSE reported), never a guess.
 */
export async function routedChat(p: {
  surface: string; tier?: "pro" | "flash"; messages: Msg[];
  temperature?: number; responseJson?: boolean; timeoutMs?: number; signal?: AbortSignal; maxTokens?: number;
}): Promise<{ ok: boolean; content: string; error?: string; latency_ms: number; provider: string }> {
  const t0 = Date.now();
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
      console.warn(`[llm] gemini ${gModel} (${p.surface}) ${r.error ?? "empty"} -> openrouter fallback`);
    } catch (e) {
      console.warn(`[llm] gemini (${p.surface}) threw -> openrouter fallback: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    }
  }

  const { system, user } = toSystemUser(p.messages);
  const codes: string[] = [];
  for (const model of routedChatFallbackChain()) {
    try {
      const r = await openrouterChat({
        model, system, user,
        timeoutMs: p.timeoutMs, signal: p.signal,
        responseJson: p.responseJson, maxTokens: p.maxTokens,
      });
      return { ok: true, content: r.content, latency_ms: Date.now() - t0, provider: `openrouter:${r.model}` };
    } catch (e) {
      codes.push(openrouterCodeFor(e));
    }
  }
  const distinct = [...new Set(codes)];
  const error = distinct.length === 0 ? "no_fallback_models" : distinct.length === 1 ? distinct[0] : `all_failed:${distinct.join(",")}`.slice(0, 200);
  return { ok: false, content: "", error, latency_ms: Date.now() - t0, provider: "none" };
}
