// Opus refuter scratch tests (never committed). Synthetic prompts, fake token, fetch faked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mint = { n: 0, fail: false };
vi.mock("@/lib/gcp-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gcp-auth")>();
  return { ...actual, getVertexAccessToken: async () => { mint.n++; if (mint.fail) throw new Error("mint boom"); return "tok-fake"; } };
});

const MSGS = [{ role: "user", content: "ok" }];
let hits: string[] = [];
let script: Array<() => Response> = [];
const realFetch = globalThis.fetch;
const KEYS = ["GCP_PROJECT", "GCP_SA_KEY", "GCP_LOCATION", "GCP_FALLBACK_LOCATION", "GEMINI_ALL", "LLM_FALLBACK_MODELS", "GEMINI_FLASH_MODEL"];
const saved: Record<string, string | undefined> = {};
const ok = (c: string) => new Response(JSON.stringify({ choices: [{ message: { content: c } }] }), { status: 200 });

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GCP_PROJECT = "proj-test"; process.env.GCP_SA_KEY = "{}"; process.env.GCP_LOCATION = "asia-south1";
  mint.n = 0; mint.fail = false; hits = []; script = [];
  globalThis.fetch = (async (u: string) => { hits.push(String(u)); const s = script.shift(); if (!s) throw new Error("unscripted"); return s(); }) as unknown as typeof fetch;
  vi.resetModules();
});
afterEach(() => { globalThis.fetch = realFetch; for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("oref: env parsing", () => {
  it("T1 a google/ OpenRouter slug is NOT dropped: it is stripped and sent to Vertex", async () => {
    const g = await import("@/lib/llm/gemini");
    expect(g.parseVertexTargets("google/gemini-3.8-flash,meta-llama/llama-4-scout", "asia-south1"))
      .toEqual([{ model: "gemini-3.8-flash", region: "asia-south1" }]);
  });
  it("T2 (F1) an invalid GCP_FALLBACK_LOCATION falls back to GCP_LOCATION; the chain is never empty", async () => {
    const g = await import("@/lib/llm/gemini");
    for (const bad of ["Asia-South1", "asia_south1"]) {
      const t = g.llmFallbackTargets({ GCP_FALLBACK_LOCATION: bad, GCP_LOCATION: "us-central1" });
      expect(t).toEqual([{ model: "gemini-2.5-flash", region: "us-central1" }, { model: "gemini-2.5-flash-lite", region: "us-central1" }]);
    }
    // both invalid: the built-in default region
    expect(g.llmFallbackTargets({ GCP_FALLBACK_LOCATION: "Bad", GCP_LOCATION: "also_bad" })[0]).toEqual({ model: "gemini-2.5-flash", region: "asia-south1" });
    expect(g.parseVertexTargets("gemini-2.5-flash@Bad_Region", "asia-south1")).toEqual([{ model: "gemini-2.5-flash", region: "asia-south1" }]);
    expect(g.parseVertexTargets("gemini-2.5-flash", "NOPE")).toEqual([{ model: "gemini-2.5-flash", region: "asia-south1" }]);
    expect(g.vertexConfigWarnings.invalid_region).toBeGreaterThanOrEqual(5);
  });
  it("T3 (F1) firstRoute on an unflagged surface with a bad fallback region still answers", async () => {
    process.env.GCP_FALLBACK_LOCATION = "asia_south1";
    const g = await import("@/lib/llm/gemini");
    expect(g.firstRoute("note", "flash")).toBe("gemini:gemini-2.5-flash@asia-south1");
  });
  it("T4 (F1) translateToEnglish 'never throws' — with a bad fallback region it still translates", async () => {
    const t = await import("@/lib/jev/translate");
    const seen: Array<string | undefined> = [];
    const r = await t.translateToEnglish("मुझे बुखार है", "hi", { env: { GCP_FALLBACK_LOCATION: "Asia-South1" }, chat: async (a) => { seen.push(a.region); return { content: "I have a fever", model: "m", latency_ms: 1 }; } });
    expect(r.status).toBe("ok");
    expect(seen[0]).toBe("asia-south1");
  });
  it("T5 (F1) routedChat with a bad fallback region still tries the stages", async () => {
    process.env.GCP_FALLBACK_LOCATION = "Asia-South1";
    const g = await import("@/lib/llm/gemini");
    script = [() => ok("fine")];
    const r = await g.routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r.ok).toBe(true);
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("asia-south1-aiplatform");
  });
  it("T5b (F1) rubrics askJson does not throw TypeError with a bad fallback region", async () => {
    const r = await import("@/lib/rubrics/llm");
    const seen: Array<string | undefined> = [];
    r.setRubricChatForTests(async (a) => { seen.push(a.region); return { content: "{}", model: "m", latency_ms: 1 }; });
    try {
      const out = await r.askJson({ system: "s", user: "u", schema: { type: "object" }, env: { GCP_FALLBACK_LOCATION: "asia_south1" } });
      expect(out.ok).toBe(true);
      expect(seen[0]).toBe("asia-south1");
    } finally { r.setRubricChatForTests(null); }
  });
  it("T5c (F1) vertexChat with a bad env region uses a valid one", async () => {
    const g = await import("@/lib/llm/gemini");
    script = [() => ok("fine")];
    await g.vertexChat({ model: "gemini-2.5-flash", user: "u", env: { GCP_FALLBACK_LOCATION: "asia_south1" } });
    expect(hits[0]).toContain("asia-south1-aiplatform");
  });
  it("T5d (F1) cdmss-pipeline / health / selftest path: firstRoute never throws for any bad region", async () => {
    const g = await import("@/lib/llm/gemini");
    for (const bad of ["", "ASIA", "a b", "x/y", "1"]) {
      process.env.GCP_FALLBACK_LOCATION = bad;
      expect(() => g.firstRoute("cds", "pro")).not.toThrow();
      expect(() => g.firstRoute("hyde", "flash")).not.toThrow();
    }
  });
  it("T5e (F2) old env slugs: google/<m> is mapped and sent (logged once); other slugs dropped with a counted warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const g = await import("@/lib/llm/gemini");
      const raw = "google/gemini-3.8-flash,meta-llama/llama-4-scout,openai/gpt-x,foo:free";
      expect(g.parseVertexTargets(raw, "asia-south1")).toEqual([{ model: "gemini-3.8-flash", region: "asia-south1" }]);
      expect(g.vertexConfigWarnings.mapped_google_slug).toBe(1);
      expect(g.vertexConfigWarnings.dropped_slug).toBe(3);
      g.parseVertexTargets(raw, "asia-south1");
      expect(g.vertexConfigWarnings.mapped_google_slug).toBe(2); // counted every time
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes("mapped_google_slug")).length).toBe(1); // logged once
      expect(lines.filter((l) => l.includes("dropped_slug: meta-llama/llama-4-scout")).length).toBe(1);
      expect(lines.some((l) => l.includes("dropped_slug: openai/gpt-x"))).toBe(true);
    } finally { warn.mockRestore(); }
  });
});

describe("oref: routedChat chain", () => {
  it("T6 flash surface: fallback equal to the failed primary is skipped; only flash-lite runs", async () => {
    process.env.GEMINI_ALL = "1";
    const g = await import("@/lib/llm/gemini");
    script = [() => new Response("x", { status: 503 }), () => ok("fine")];
    const r = await g.routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r.provider).toBe("gemini:gemini-2.5-flash-lite@asia-south1");
    expect(hits.length).toBe(2);
    expect(mint.n).toBe(1);
  });
  it("T7 same model in a different fallback region is NOT skipped", async () => {
    process.env.GEMINI_ALL = "1"; process.env.GCP_FALLBACK_LOCATION = "us-central1";
    const g = await import("@/lib/llm/gemini");
    script = [() => new Response("x", { status: 503 }), () => ok("fine")];
    const r = await g.routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r.provider).toBe("gemini:gemini-2.5-flash@us-central1");
    expect(hits[1]).toContain("https://us-central1-aiplatform.googleapis.com/v1beta1/projects/proj-test/locations/us-central1/");
  });
  it("T8 a primary mint failure stops the chain: no fallback fetch, one mint", async () => {
    process.env.GEMINI_ALL = "1"; mint.fail = true;
    const g = await import("@/lib/llm/gemini");
    const r = await g.routedChat({ surface: "note", tier: "pro", messages: MSGS });
    expect(r).toMatchObject({ ok: false, provider: "none", error: "all_failed: gemini:threw" });
    expect(hits).toEqual([]); expect(mint.n).toBe(1);
  });
  it("T9 unflagged surface + mint failure: each fallback stage re-mints", async () => {
    mint.fail = true;
    const g = await import("@/lib/llm/gemini");
    const r = await g.routedChat({ surface: "note", tier: "pro", messages: MSGS });
    expect(r.error).toBe("all_failed: gemini:gemini-2.5-flash@asia-south1=threw; gemini:gemini-2.5-flash-lite@asia-south1=threw");
    expect(mint.n).toBe(2);
  });
  it("T10 both-fail: closed codes only, no response text", async () => {
    process.env.GEMINI_ALL = "1";
    const g = await import("@/lib/llm/gemini");
    script = [() => new Response("SECRETBODY", { status: 500 }), () => new Response("SECRETBODY", { status: 429 }), () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })];
    const r = await g.routedChat({ surface: "note", tier: "pro", messages: MSGS });
    expect(r.error).toBe("all_failed: gemini:http_500; gemini:gemini-2.5-flash@asia-south1=http_429; gemini:gemini-2.5-flash-lite@asia-south1=empty");
    expect(r.error).not.toContain("SECRETBODY");
  });
  it("T11 caller abort during the primary is `aborted`, not deadline", async () => {
    process.env.GEMINI_ALL = "1";
    const g = await import("@/lib/llm/gemini");
    const ac = new AbortController();
    globalThis.fetch = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      setTimeout(() => ac.abort(), 5);
    })) as unknown as typeof fetch;
    const r = await g.routedChat({ surface: "note", tier: "pro", messages: MSGS, signal: ac.signal });
    expect(r.error).toBe("aborted");
  });
  it("T12 vertexChat codes: 404 -> vertex_http_404; abort-by-timeout -> vertex_timeout", async () => {
    const g = await import("@/lib/llm/gemini");
    script = [() => new Response("x", { status: 404 })];
    await expect(g.vertexChat({ model: "gemini-2.5-flash", user: "u" })).rejects.toMatchObject({ code: "vertex_http_404" });
    globalThis.fetch = ((_u: string, init: RequestInit) => new Promise((_r, rej) => {
      init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    })) as unknown as typeof fetch;
    await expect(g.vertexChat({ model: "gemini-2.5-flash", user: "u", timeoutMs: 20 })).rejects.toMatchObject({ code: "vertex_timeout" });
  });
});
