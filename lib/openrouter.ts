/**
 * lib/openrouter.ts — one chat-completion call to OpenRouter, on the same contract as the router's
 * translate backend (`~/eta-router/router_server.py`, `openrouter_translate`).
 *
 * WHY IT EXISTS. qwen2.5:14b is retired (V, 22 Sep): 11.55 GB on a 24 GB Mini, reached from Vercel
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
 * THE DEADLINE BOUNDS THE WHOLE CALL (ETA-Refuter round 2, 22 Sep, D2). It used to clear its timer
 * in a `finally` right after `doFetch` resolved — which happens as soon as the RESPONSE HEADERS
 * arrive — so `res.json()` (reading the body) ran with no deadline at all: a server that sent
 * headers and then never closed the body would hang here until the platform's own ceiling killed
 * the step. The timer now stays armed for the entire function (one `try/finally` around the fetch
 * AND the body read), so aborting it also aborts an in-flight body read, and a slow-body failure
 * reads as a timeout rather than as a generic bad response.
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

export type OpenRouterMessage = { role: string; content: string };

/**
 * ONE client for every OpenRouter call in ETA — the Jev translator (system + user) and routedChat's
 * fallback (a full message list, JSON mode, a token cap). Whatever the caller passes, ZDR and
 * data_collection:"deny" are on the body; there is no parameter that turns them off.
 */
export async function openrouterChat(args: {
  model: string;
  /** Either `messages`, or `system` + `user`. `messages` wins when both are given. */
  messages?: OpenRouterMessage[];
  system?: string;
  user?: string;
  temperature?: number;
  responseJson?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Env;
  fetchImpl?: typeof fetch;
}): Promise<OpenRouterChatResult> {
  const env = args.env ?? process.env;
  const messages: OpenRouterMessage[] = args.messages ?? [
    { role: "system", content: args.system ?? "" },
    { role: "user", content: args.user ?? "" },
  ];
  const key = readOpenRouterKey(env);
  const url = (env.OPENROUTER_API_URL ?? "").trim() || OPENROUTER_DEFAULT_URL;
  const doFetch = args.fetchImpl ?? fetch;

  const controller = new AbortController();
  // D2: this timer must outlive the fetch call itself — it is cleared only in the `finally` below,
  // once the response body has been read one way or another.
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 60_000);
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else args.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const t0 = Date.now();
  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: args.model,
          temperature: args.temperature ?? 0,
          provider: { zdr: true, data_collection: "deny" },
          messages,
          ...(args.responseJson ? { response_format: { type: "json_object" } } : {}),
          ...(args.maxTokens ? { max_tokens: args.maxTokens } : {}),
        }),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (e) {
      // The exception CLASS only. Its message can describe the request, which carries the key.
      if (controller.signal.aborted) throw new OpenRouterError(args.signal?.aborted ? "openrouter_abort" : "openrouter_timeout");
      throw new OpenRouterError(`openrouter_unreachable:${(e as { name?: string } | null)?.name ?? "Error"}`);
    }

    if (res.status !== 200) throw new OpenRouterError(`openrouter_http_${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // D2: a body that never closes hits this SAME still-armed timer, which aborts the read — that
      // reads as a timeout, not as a generic bad response.
      if (controller.signal.aborted) throw new OpenRouterError(args.signal?.aborted ? "openrouter_abort" : "openrouter_timeout");
      throw new OpenRouterError("openrouter_bad_response");
    }
    const b = body as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
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
  } finally {
    clearTimeout(timer);
  }
}
