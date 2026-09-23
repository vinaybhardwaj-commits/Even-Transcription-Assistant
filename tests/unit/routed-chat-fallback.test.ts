/**
 * tests/unit/routed-chat-fallback.test.ts — the REAL routedChat: Vertex Gemini → OpenRouter, no Ollama.
 *
 * llm-provider-truth.test.ts mocks routedChat to test what its CALLERS do with the answer. This file
 * tests the router itself, faking only the network (`fetch`) and the Vertex token. It pins:
 *   • the chain order, and that Ollama is never contacted in any scenario;
 *   • the provider label comes from the call that answered (the model the RESPONSE reported);
 *   • every OpenRouter body carries ZDR + data_collection deny;
 *   • total failure is ok:false, provider 'none', with closed codes — never a fabricated answer.
 *
 * GCP_* is read at module load, so each case sets env and re-imports. Synthetic prompts only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Calibration follow-up (Fable's ruling, 23 Sep): MINT_TIMEOUT_MS now lives in lib/gcp-auth.ts and
// gemini.ts imports it from there (one mint budget, not two) — a mock of this module that omits it
// breaks routedChatDeadlineMs, which every routedChat/routedChatJson call in this file goes through.
vi.mock("@/lib/gcp-auth", () => ({ getVertexAccessToken: async () => "vertex-token-not-a-secret", MINT_TIMEOUT_MS: 10_000 }));

const FAKE_KEY = "sk-or-v1-FAKEKEY-must-never-appear-anywhere-0123456789abcdef";
const MSGS = [{ role: "system", content: "Reply with one word." }, { role: "user", content: "ok" }];

type Hit = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
let hits: Hit[] = [];
let script: Array<(url: string) => Response | Error> = [];
const realFetch = globalThis.fetch;
const ENV_KEYS = ["GCP_PROJECT", "GCP_SA_KEY", "GCP_LOCATION", "GEMINI_ALL", "GEMINI_NOTE", "OPENROUTER_API_KEY",
  "OPENROUTER_API_KEY_FILE", "OPENROUTER_API_URL", "LLM_FALLBACK_MODELS", "OLLAMA_BASE_URL", "LLM_BASE_URL"];
const saved: Record<string, string | undefined> = {};

const ok = (content: string, model?: string) =>
  new Response(JSON.stringify({ ...(model ? { model } : {}), choices: [{ message: { content } }] }), { status: 200 });
const isVertex = (u: string) => u.includes("aiplatform.googleapis.com");
const isOpenRouter = (u: string) => u.includes("openrouter.ai");

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
async function router() { return import("@/lib/llm/gemini"); }
const noOllama = () => expect(hits.filter((h) => /11434|ollama/i.test(h.url))).toEqual([]);

describe("the chain: Vertex Gemini first, then OpenRouter — never Ollama", () => {
  it("Gemini answers → provider gemini:<model>, OpenRouter never called", async () => {
    geminiOn();
    script = [() => ok("ok")];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: true, provider: "gemini:gemini-2.5-flash" });
    expect(hits.map((h) => isVertex(h.url))).toEqual([true]);
    noOllama();
  });

  it("Gemini fails → OpenRouter answers, labelled with the model the RESPONSE reported", async () => {
    geminiOn();
    script = [() => new Response("", { status: 500 }), () => ok("ok", "google/gemini-3.8-flash-001")];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: true, provider: "openrouter:google/gemini-3.8-flash-001" });
    expect(hits.map((h) => (isVertex(h.url) ? "vertex" : isOpenRouter(h.url) ? "openrouter" : h.url))).toEqual(["vertex", "openrouter"]);
    // D5: the OpenRouter fallback default moved to gemini-3.8-flash (V's choice, matching the router).
    // The Vertex primary model (asserted above as gemini-2.5-flash) is untouched by D5.
    expect(hits[1]!.body.model).toBe("google/gemini-3.8-flash");
    noOllama();
  });

  it("Gemini off for the surface → straight to OpenRouter, no Vertex call", async () => {
    script = [() => ok("ok", "google/gemini-3.8-flash")];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r.provider).toBe("openrouter:google/gemini-3.8-flash");
    expect(hits.every((h) => isOpenRouter(h.url))).toBe(true);
    noOllama();
  });

  it("the first OpenRouter model failing falls to llama-4-scout, in order", async () => {
    script = [() => new Response("", { status: 503 }), () => ok("ok", "meta-llama/llama-4-scout-17b")];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(hits.map((h) => h.body.model)).toEqual(["google/gemini-3.8-flash", "meta-llama/llama-4-scout"]);
    expect(r.provider).toBe("openrouter:meta-llama/llama-4-scout-17b");
    noOllama();
  });

  it("LLM_FALLBACK_MODELS overrides the chain", async () => {
    process.env.LLM_FALLBACK_MODELS = "x/one, y/two";
    const { llmFallbackModels, LLM_FALLBACK_DEFAULT } = await router();
    expect(llmFallbackModels()).toEqual(["x/one", "y/two"]);
    // D5 (ETA-Refuter round 2, 22 Sep): V's choice, matching the router — gemini-3.8-flash then
    // llama-4-scout. The Vertex primary (gemini-2.5-flash/pro above) is a separate, unchanged knob.
    expect(LLM_FALLBACK_DEFAULT).toEqual(["google/gemini-3.8-flash", "meta-llama/llama-4-scout"]);
    for (const m of LLM_FALLBACK_DEFAULT) expect(m).not.toMatch(/qwen|ollama/i);
  });
});

describe("total failure is honest", () => {
  it("everything failing → ok:false, provider 'none', closed codes, no content", async () => {
    geminiOn();
    script = [() => new Response("", { status: 500 }), () => new Response("", { status: 502 }), () => new Response("", { status: 503 })];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: false, content: "", provider: "none" });
    expect(r.error).toContain("gemini:http_500");
    expect(r.error).toContain("openrouter:google/gemini-3.8-flash=openrouter_http_502");
    expect(r.error).toContain("openrouter:meta-llama/llama-4-scout=openrouter_http_503");
    noOllama();
  });

  it("routedChatJson reports a parse failure as a failure, provider still named", async () => {
    script = [() => ok("this is not json", "google/gemini-3.8-flash")];
    const { routedChatJson } = await router();
    const r = await routedChatJson({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: false, json: null, error: "json_parse_failed", provider: "openrouter:google/gemini-3.8-flash" });
  });

  it("routedChatJson parses a good answer and sends JSON mode", async () => {
    script = [() => ok('{"a":1}', "google/gemini-3.8-flash")];
    const { routedChatJson } = await router();
    const r = await routedChatJson<{ a: number }>({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: true, json: { a: 1 } });
    expect(hits[0]!.body.response_format).toEqual({ type: "json_object" });
  });
});

describe("every OpenRouter call is ZDR, and the key stays in its header", () => {
  it("provider zdr + data_collection deny on every fallback body; messages passed through", async () => {
    script = [() => new Response("", { status: 503 }), () => ok("ok", "meta-llama/llama-4-scout")];
    const { routedChat } = await router();
    await routedChat({ surface: "note", tier: "flash", messages: MSGS, temperature: 0.2, maxTokens: 50 });
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.body.provider).toEqual({ zdr: true, data_collection: "deny" });
      expect(h.body.messages).toEqual(MSGS);
      expect(h.body.temperature).toBe(0.2);
      expect(h.body.max_tokens).toBe(50);
    }
  });

  it("the key is only ever in the Authorization header, and never in a log or an error", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
    geminiOn();
    // The key is planted where OpenRouter's own failure could echo it: a network error message.
    script = [() => new Error("vertex down"), () => new TypeError(`net ${FAKE_KEY}`), () => new Response("", { status: 401 })];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    const logged = spies.flatMap((s) => s.mock.calls).map((a) => JSON.stringify(a)).join("\n");
    spies.forEach((s) => s.mockRestore());
    const orHits = hits.filter((h) => isOpenRouter(h.url));
    for (const h of orHits) {
      expect(h.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(JSON.stringify(h.body)).not.toContain(FAKE_KEY);
    }
    expect(r.error ?? "").not.toContain(FAKE_KEY);
    expect(logged).not.toContain(FAKE_KEY);   // zero occurrences, not "few"
  });
});
