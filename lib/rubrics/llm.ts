/**
 * lib/rubrics/llm.ts — S7-1: the llm_zdr engine's one door to a model. It goes through Vertex Gemini (lib/llm/gemini.ts `vertexChat`, V's order of 23 Oct: OpenRouter -> Vertex), and adds no vendor, no key and no env name beyond the GCP_* ones routedChat already uses:
 *   - auth: GCP_SA_KEY + GCP_PROJECT (lib/gcp-auth.ts); region GCP_FALLBACK_LOCATION, else GCP_LOCATION;
 *   - model: the FIRST entry of lib/llm/gemini.ts llmFallbackTargets() — env LLM_FALLBACK_MODELS, else gemini-2.5-flash. There is NO fallback model in this module: the other entries of that list are
 *     never used here; a bad answer is retried ONCE on the same model, then the unit fails, and an outage throws so the runner retries the step.
 * temperature 0, JSON mode, the answer validated against the rubric's output schema. Every failure is a CLOSED CODE; no model output or transcript is ever in a code or a log line.
 * A transient infrastructure failure (timeout, 408, 429, 5xx, unreachable, an empty model response) THROWS (the runner retries the step, as for a database error); a missing key or a refusal by the provider (4xx) is a failed unit.
 */
import { vertexChat, VertexError, llmFallbackTargets, type VertexChatResult } from "@/lib/llm/gemini";
import { AsyncLocalStorage } from "node:async_hooks";
import { validateAgainst } from "./schema";

/**
 * G80: every model attempt (a failed transient one too: it may have been billed) is tallied in the store of the nearest `countingCalls`, so a unit that THROWS mid-way (llm_unavailable) still tells the
 * step how many calls it made. The error leaves with `tallied_calls`; the step adds them to progress.llm_calls before the runner records the failure.
 */
const tally = new AsyncLocalStorage<{ n: number }>();
export async function countingCalls<T>(fn: () => Promise<T>): Promise<T> {
  const store = { n: 0 };
  try {
    return await tally.run(store, fn);
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { tallied_calls: store.n });
  }
}
export const talliedCalls = (e: unknown): number => {
  const n = (e as { tallied_calls?: unknown } | null)?.tallied_calls;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

export type ChatFn = (args: Parameters<typeof vertexChat>[0]) => Promise<VertexChatResult>;
let chatOverride: ChatFn | null = null;
/** Test hook: a fake model client (no network, no key). */
export function setRubricChatForTests(fn: ChatFn | null): void {
  chatOverride = fn;
}

export const LLM_CALL_TIMEOUT_MS = 40_000;
export const LLM_MAX_TOKENS = 4000;

export type LlmOutcome =
  | { ok: true; value: Record<string, unknown>; model: string; attempts: number; latency_ms: number }
  | { ok: false; reason: "llm_invalid_json" | "llm_schema_invalid" | "llm_not_configured" | "llm_refused"; model: string | null; attempts: number };

const TRANSIENT = /^(vertex_timeout|vertex_unreachable|vertex_auth_failed|vertex_http_(408|429|5\d\d)|vertex_abort|vertex_empty)/;

/** Parse the model's text as a JSON object; tolerate a markdown fence around it. Returns null when it is not an object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One scored answer: ask, parse, validate; ONE retry (the same model) on invalid JSON or a schema violation, then a failed outcome. `extraValidate` returns more problems (cross-field rules).
 */
export async function askJson(args: { system: string; user: string; schema: Record<string, unknown>; extraValidate?: (v: Record<string, unknown>) => string[]; env?: Record<string, string | undefined> }): Promise<LlmOutcome> {
  const chat: ChatFn = chatOverride ?? vertexChat;
  const target = llmFallbackTargets(args.env ?? process.env)[0]!;
  const model = target.model;
  let attempts = 0;
  let last: "llm_invalid_json" | "llm_schema_invalid" = "llm_invalid_json";
  for (let i = 0; i < 2; i++) {
    attempts += 1;
    const store = tally.getStore();
    if (store) store.n += 1;
    let res: VertexChatResult;
    try {
      res = await chat({
        model, region: target.region, system: args.system,
        user: i === 0 ? args.user : `${args.user}\n\nYour previous answer was not valid JSON for the required schema. Answer again with ONLY the JSON object.`,
        temperature: 0, responseJson: true, maxTokens: LLM_MAX_TOKENS, timeoutMs: LLM_CALL_TIMEOUT_MS, ...(args.env ? { env: args.env } : {}),
      });
    } catch (e) {
      const code = e instanceof VertexError ? e.code : "vertex_error";
      if (code === "vertex_not_configured") return { ok: false, reason: "llm_not_configured", model, attempts };
      if (TRANSIENT.test(code)) throw new Error(`llm_unavailable: ${code}`); // retried by the runner, like a database error
      return { ok: false, reason: "llm_refused", model, attempts };
    }
    const obj = parseJsonObject(res.content);
    if (!obj) { last = "llm_invalid_json"; continue; }
    const problems = [...validateAgainst(args.schema, obj), ...(args.extraValidate?.(obj) ?? [])];
    if (problems.length > 0) { last = "llm_schema_invalid"; continue; }
    return { ok: true, value: obj, model: res.model, attempts, latency_ms: res.latency_ms };
  }
  return { ok: false, reason: last, model, attempts };
}
