/**
 * tests/unit/routed-chat-fallback.test.ts — the REAL routedChat: Vertex Gemini → a second Vertex model/region, no OpenRouter, no Ollama.
 *
 * llm-provider-truth.test.ts mocks routedChat to test what its CALLERS do with the answer. This file
 * tests the router itself, faking only the network (`fetch`) and the Vertex token. It pins:
 *   • the chain order, and that Ollama is never contacted in any scenario;
 *   • the provider label names the target that answered (`gemini:<model>@<region>` for a fallback stage);
 *   • no request ever goes to OpenRouter, and no OpenRouter key is read;
 *   • total failure is ok:false, provider 'none', with closed codes — never a fabricated answer.
 *
 * GCP_* is read at module load, so each case sets env and re-imports. Synthetic prompts only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Calibration follow-up (Fable's ruling, 23 Sep): MINT_TIMEOUT_MS now lives in lib/gcp-auth.ts and
// gemini.ts imports it from there (one mint budget, not two) — a mock of this module that omits it
// breaks routedChatDeadlineMs, which every routedChat/routedChatJson call in this file goes through.
// ETA-Refuter (P6, on 1686171): restating the constant as a literal here un-pins it from the real
// source — a mutation to the actual MINT_TIMEOUT_MS in lib/gcp-auth.ts would never be caught.
// importOriginal lets the real constant flow through while only getVertexAccessToken is replaced.
vi.mock("@/lib/gcp-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gcp-auth")>();
  return { ...actual, getVertexAccessToken: async () => "vertex-token-not-a-secret" };
});

const FAKE_KEY = "sk-or-v1-FAKEKEY-must-never-appear-anywhere-0123456789abcdef"; // planted in the env: nothing may use or echo it
const MSGS = [{ role: "system", content: "Reply with one word." }, { role: "user", content: "ok" }];

type Hit = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
let hits: Hit[] = [];
let script: Array<(url: string) => Response | Error> = [];
const realFetch = globalThis.fetch;
const ENV_KEYS = ["GCP_PROJECT", "GCP_SA_KEY", "GCP_LOCATION", "GEMINI_ALL", "GEMINI_NOTE", "GCP_FALLBACK_LOCATION", "OPENROUTER_API_KEY",
  "OPENROUTER_API_KEY_FILE", "OPENROUTER_API_URL", "LLM_FALLBACK_MODELS", "OLLAMA_BASE_URL", "LLM_BASE_URL"];
const saved: Record<string, string | undefined> = {};

const ok = (content: string, model?: string) =>
  new Response(JSON.stringify({ ...(model ? { model } : {}), choices: [{ message: { content } }] }), { status: 200 });
const isVertex = (u: string) => u.includes("aiplatform.googleapis.com");
const isOpenRouter = (u: string) => u.includes("openrouter.ai");
const region = (u: string) => /^https:\/\/(?:([a-z0-9-]+)-)?aiplatform\.googleapis\.com/.exec(u)?.[1] ?? "global";

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.OPENROUTER_API_KEY = FAKE_KEY;
  // an Ollama base IS set: if any path still used it, the fetch spy below would see the call
  process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
  process.env.LLM_BASE_URL = "http://localhost:11434/v1";
  hits = []; script = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    hits.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")), headers: (init.headers ?? {}) as Record<string, string> });
    const step = script.shift();
    if (!step) throw new Error(`unscripted fetch to ${url}`);
    const r = step(String(url));
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  vi.resetModules();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function geminiOn() {
  process.env.GCP_PROJECT = "proj";
  process.env.GCP_SA_KEY = "{}";
  process.env.GCP_LOCATION = "global";
  process.env.GEMINI_ALL = "1";
}
function configuredOnly() {
  process.env.GCP_PROJECT = "proj";
  process.env.GCP_SA_KEY = "{}";
  process.env.GCP_LOCATION = "asia-south1"; // configured, surface NOT flagged
}
async function router() { return import("@/lib/llm/gemini"); }
const noOllama = () => expect(hits.filter((h) => /11434|ollama/i.test(h.url))).toEqual([]);

describe("the chain: Vertex Gemini first, then a second Vertex model/region — never OpenRouter, never Ollama", () => {
  it("Gemini answers → provider gemini:<model>, no second call", async () => {
    geminiOn();
    script = [() => ok("ok")];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: true, provider: "gemini:gemini-2.5-flash" });
    expect(hits).toHaveLength(1);
    noOllama();
  });

  it("primary fails → the Vertex fallback answers, labelled gemini:<model>@<region> from the target actually called", async () => {
    geminiOn();
    process.env.GCP_FALLBACK_LOCATION = "us-central1";
    script = [() => new Response("", { status: 500 }), () => ok("ok", "ignored-response-model")];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    // the primary is gemini-2.5-flash@global; the first fallback is the same model in ANOTHER region
    expect(r).toMatchObject({ ok: true, provider: "gemini:gemini-2.5-flash@us-central1" });
    expect(hits.map((h) => isVertex(h.url))).toEqual([true, true]);
    expect(hits.map((h) => region(h.url))).toEqual(["global", "us-central1"]);
    expect(hits[1]!.body.model).toBe("google/gemini-2.5-flash");
    expect(hits.some((h) => isOpenRouter(h.url))).toBe(false);
    noOllama();
  });

  it("a fallback that equals the failed primary (same model, same region) is not re-asked", async () => {
    geminiOn(); // primary gemini-2.5-flash@global; default fallback region = GCP_LOCATION = global
    script = [() => new Response("", { status: 500 }), () => ok("ok")];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(hits.map((h) => h.body.model)).toEqual(["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"]);
    expect(r.provider).toBe("gemini:gemini-2.5-flash-lite@global");
  });

  it("Gemini off for the surface (but Vertex configured) → straight to the Vertex fallback, labelled with its region", async () => {
    configuredOnly();
    script = [() => ok("ok")];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r.provider).toBe("gemini:gemini-2.5-flash@asia-south1");
    expect(hits.every((h) => isVertex(h.url))).toBe(true);
    noOllama();
  });

  it("Vertex not configured at all → ok:false, provider none, vertex_not_configured; no network call", async () => {
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: false, content: "", provider: "none", error: "all_failed: vertex_not_configured" });
    expect(hits).toEqual([]);
  });

  it("the first fallback failing falls to the second, in order", async () => {
    configuredOnly();
    script = [() => new Response("", { status: 503 }), () => ok("ok")];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(hits.map((h) => h.body.model)).toEqual(["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"]);
    expect(r.provider).toBe("gemini:gemini-2.5-flash-lite@asia-south1");
    noOllama();
  });

  it("LLM_FALLBACK_MODELS overrides the chain, entries are model[@region], and an old OpenRouter slug is dropped", async () => {
    process.env.LLM_FALLBACK_MODELS = "gemini-x@eu-west4, meta-llama/llama-4-scout, google/gemini-y";
    process.env.GCP_LOCATION = "asia-south1";
    const { llmFallbackModels, LLM_FALLBACK_DEFAULT } = await router();
    expect(llmFallbackModels()).toEqual(["gemini-x@eu-west4", "gemini-y@asia-south1"]);
    expect(LLM_FALLBACK_DEFAULT).toEqual(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
    for (const m of LLM_FALLBACK_DEFAULT) expect(m).not.toMatch(/qwen|ollama|\//i);
    process.env.LLM_FALLBACK_MODELS = "meta-llama/llama-4-scout"; // only a stale slug → the default, not an empty chain
    expect(llmFallbackModels()).toEqual(["gemini-2.5-flash@asia-south1", "gemini-2.5-flash-lite@asia-south1"]);
  });
});

describe("total failure is honest", () => {
  it("everything failing → ok:false, provider 'none', closed codes naming each target, no content", async () => {
    geminiOn();
    process.env.GCP_FALLBACK_LOCATION = "us-central1";
    script = [() => new Response("", { status: 500 }), () => new Response("", { status: 502 }), () => new Response("", { status: 503 })];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: false, content: "", provider: "none" });
    expect(r.error).toContain("gemini:http_500");
    expect(r.error).toContain("gemini:gemini-2.5-flash@us-central1=http_502");
    expect(r.error).toContain("gemini:gemini-2.5-flash-lite@us-central1=http_503");
    noOllama();
  });

  it("routedChatJson reports a parse failure as a failure, provider still named", async () => {
    configuredOnly();
    script = [() => ok("this is not json")];
    const { routedChatJson } = await router();
    const r = await routedChatJson({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: false, json: null, error: "json_parse_failed", provider: "gemini:gemini-2.5-flash@asia-south1" });
  });

  it("routedChatJson parses a good answer and sends JSON mode", async () => {
    configuredOnly();
    script = [() => ok('{"a":1}')];
    const { routedChatJson } = await router();
    const r = await routedChatJson<{ a: number }>({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: true, json: { a: 1 } });
    expect(hits[0]!.body.response_format).toEqual({ type: "json_object" });
  });
});

describe("no OpenRouter anywhere: no request, no key use, no key in a log or an error", () => {
  it("messages/temperature/max_tokens pass through to the fallback body, which has no OpenRouter provider block", async () => {
    configuredOnly();
    script = [() => new Response("", { status: 503 }), () => ok("ok")];
    const { routedChat } = await router();
    await routedChat({ surface: "note", tier: "flash", messages: MSGS, temperature: 0.2, maxTokens: 50 });
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.body.provider).toBeUndefined();
      expect(h.body.messages).toEqual(MSGS);
      expect(h.body.temperature).toBe(0.2);
      expect(h.body.max_tokens).toBe(50);
    }
  });

  it("an OpenRouter key in the environment is never sent anywhere, and never in a log or an error", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
    geminiOn();
    script = [() => new Error("vertex down"), () => new TypeError(`net ${FAKE_KEY}`), () => new Response("", { status: 401 })];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    const logged = spies.flatMap((s) => s.mock.calls).map((a) => JSON.stringify(a)).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(hits.filter((h) => isOpenRouter(h.url))).toEqual([]);
    for (const h of hits) expect(JSON.stringify(h)).not.toContain(FAKE_KEY);
    expect(r.error ?? "").not.toContain(FAKE_KEY);
    expect(logged).not.toContain(FAKE_KEY);
  });
});

describe("vertexChat — the direct door for callers with their own chain", () => {
  it("answers with the label of the target called; closed VertexError codes on failure", async () => {
    configuredOnly();
    const { vertexChat, VertexError } = await router();
    script = [() => ok("hello", "whatever-the-response-says")];
    const r = await vertexChat({ model: "google/gemini-2.5-flash-lite", region: "us-central1", system: "s", user: "u" });
    expect(r).toMatchObject({ content: "hello", model: "gemini:gemini-2.5-flash-lite@us-central1" });
    expect(region(hits[0]!.url)).toBe("us-central1");
    script = [() => new Response("", { status: 429 })];
    await expect(vertexChat({ model: "m", user: "u" })).rejects.toMatchObject({ code: "vertex_http_429" });
    script = [() => new Response(JSON.stringify({ choices: [{ message: { content: "  " } }] }), { status: 200 })];
    await expect(vertexChat({ model: "m", user: "u" })).rejects.toMatchObject({ code: "vertex_empty" });
    script = [() => new TypeError("socket")];
    await expect(vertexChat({ model: "m", user: "u" })).rejects.toBeInstanceOf(VertexError);
    script = [() => new TypeError("socket")];
    await expect(vertexChat({ model: "m", user: "u" })).rejects.toMatchObject({ code: "vertex_unreachable" });
    await expect(vertexChat({ model: "meta-llama/llama-4-scout", user: "u" })).rejects.toMatchObject({ code: "vertex_bad_model" });
  });

  it("not configured → vertex_not_configured before any network", async () => {
    const { vertexChat } = await router();
    await expect(vertexChat({ model: "m", user: "u" })).rejects.toMatchObject({ code: "vertex_not_configured" });
    expect(hits).toEqual([]);
  });
});
