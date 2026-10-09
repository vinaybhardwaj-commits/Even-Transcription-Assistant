/**
 * lib/openrouter.ts — one chat-completion call to OpenRouter, on the same contract as the router's
 * translate backend (`~/eta-router/router_server.py`, `openrouter_translate`).
 *
 * WHY IT EXISTS. The retired local 14B model (V, 22 Sep) was 11.55 GB on a 24 GB Mini, reached from Vercel
 * through the Cloudflare tunnel, and reloaded every time something here called it. OpenRouter is
 * approved for patient text on the special account, under ZERO DATA RETENTION — so every body this
 * module sends carries `provider: { zdr: true, data_collection: "deny" }`, and there is no way to
 * call it without them.
 *
 * THE KEY. `OPENROUTER_API_KEY` (Vercel), else the file `OPENROUTER_API_KEY_FILE` names (the Mini).
 * Read at CALL time, never cached, sent only in the Authorization header. It never appears in a
 * log line, an error, or argv: every failure is an `OpenRouterError` whose message is a SHORT CODE
 * built from a status number or an exception class — never an exception's message, because a fetch
 * error can carry the request, and the request carries the key.
 *
 * THE LABEL. `model` in the result is the string the RESPONSE reported, so a caller records the
 * model that actually answered rather than the one it asked for.
 *
 * ONE CLIENT, NOT TWO (22 Sep, qwen-out). `routedChat`'s Gemini→Ollama fallback in
 * lib/llm/gemini.ts now falls to OpenRouter through this same function — `responseJson` and
 * `maxTokens` below exist for that caller, which needs JSON mode and a token ceiling the way the
 * Jev translate path never did. Neither changes the ZDR/data_collection body, and both are no-ops
 * when omitted, so the Jev call above is unaffected.
 */
import { readFileSync } from "node:fs";

export const OPENROUTER_DEFAULT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** A failure with a closed code. Safe to store on a row and to log. */
export class OpenRouterError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "OpenRouterError";
    this.code = code;
  }
}

export type OpenRouterChatResult = { content: string; model: string; latency_ms: number };

type Env = Record<string, string | undefined>;

/** The key, from env or from a file. Throws a coded error; never returns or logs anything else. */
export function readOpenRouterKey(env: Env = process.env, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): string {
  const direct = (env.OPENROUTER_API_KEY ?? "").trim();
  if (direct) return direct;
  const path = (env.OPENROUTER_API_KEY_FILE ?? "").trim();
  if (!path) throw new OpenRouterError("openrouter_no_key");
  let key: string;
  try {
    key = readFile(path).trim();
  } catch {
    throw new OpenRouterError("openrouter_key_unreadable");
  }
  if (!key) throw new OpenRouterError("openrouter_key_empty");
  return key;
}

export async function openrouterChat(args: {
  model: string;
  system: string;
  user: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Env;
  fetchImpl?: typeof fetch;
  /** JSON mode (`response_format: { type: "json_object" }`). Omitted/false = unchanged behaviour. */
  responseJson?: boolean;
  /** A ceiling, not a spend — omitted leaves the request exactly as it was before this field existed. */
  maxTokens?: number;
}): Promise<OpenRouterChatResult> {
  const env = args.env ?? process.env;
  const key = readOpenRouterKey(env);
  const url = (env.OPENROUTER_API_URL ?? "").trim() || OPENROUTER_DEFAULT_URL;
  const doFetch = args.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 60_000);
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else args.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const body: Record<string, unknown> = {
    model: args.model,
    temperature: 0,
    provider: { zdr: true, data_collection: "deny" },
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
  };
  if (args.responseJson) body.response_format = { type: "json_object" };
  if (args.maxTokens) body.max_tokens = args.maxTokens;

  const t0 = Date.now();
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (e) {
    // The exception CLASS only. Its message can describe the request, which carries the key.
    if (controller.signal.aborted) throw new OpenRouterError(args.signal?.aborted ? "openrouter_abort" : "openrouter_timeout");
    throw new OpenRouterError(`openrouter_unreachable:${(e as { name?: string } | null)?.name ?? "Error"}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status !== 200) throw new OpenRouterError(`openrouter_http_${res.status}`);

  let responseBody: unknown;
  try {
    responseBody = await res.json();
  } catch {
    throw new OpenRouterError("openrouter_bad_response");
  }
  const b = responseBody as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
  const content = b?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new OpenRouterError("openrouter_bad_response");
  if (!content.trim()) throw new OpenRouterError("openrouter_empty");
  return {
    content: content.trim(),
    // What the RESPONSE says answered. The requested id is the fallback only for a response that
    // omits the field — the same rule as the router.
    model: typeof b.model === "string" && b.model ? b.model : args.model,
    latency_ms: Date.now() - t0,
  };
}
