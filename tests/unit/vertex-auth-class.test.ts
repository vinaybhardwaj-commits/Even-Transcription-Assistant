// F3 + P03: auth failures are classed (permanent vs transient) and never leak exception text.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GcpAuthError } from "@/lib/gcp-auth";

const LEAK = "LEAKY-GOOGLE-AUTH-TEXT-private_key_id";
const mint: { err: unknown } = { err: null };
vi.mock("@/lib/gcp-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gcp-auth")>();
  return { ...actual, getVertexAccessToken: async () => { if (mint.err) throw mint.err; return "tok-fake"; } };
});

const KEYS = ["GCP_PROJECT", "GCP_SA_KEY", "GCP_LOCATION", "GCP_FALLBACK_LOCATION", "GEMINI_ALL", "LLM_FALLBACK_MODELS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GCP_PROJECT = "proj-test"; process.env.GCP_SA_KEY = "{}";
  mint.err = null; vi.resetModules();
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } vi.restoreAllMocks(); });

describe("F3 vertexChat auth classes", () => {
  it("permanent GcpAuthError -> vertex_auth_failed; transient/other -> vertex_auth_timeout", async () => {
    const g = await import("@/lib/llm/gemini");
    mint.err = new GcpAuthError("x (401)", true);
    await expect(g.vertexChat({ model: "gemini-2.5-flash", user: "u" })).rejects.toMatchObject({ code: "vertex_auth_failed" });
    mint.err = new GcpAuthError("x (503)", false);
    await expect(g.vertexChat({ model: "gemini-2.5-flash", user: "u" })).rejects.toMatchObject({ code: "vertex_auth_timeout" });
    mint.err = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(g.vertexChat({ model: "gemini-2.5-flash", user: "u" })).rejects.toMatchObject({ code: "vertex_auth_timeout" });
  });
  it("rubrics: permanent auth failure is llm_refused (no throw); a mint timeout throws llm_unavailable", async () => {
    const r = await import("@/lib/rubrics/llm");
    mint.err = new GcpAuthError("x (403)", true);
    const out = await r.askJson({ system: "s", user: "u", schema: { type: "object" } });
    expect(out).toMatchObject({ ok: false, reason: "llm_refused" });
    mint.err = new GcpAuthError("timeout", false);
    await expect(r.askJson({ system: "s", user: "u", schema: { type: "object" } })).rejects.toThrow("llm_unavailable: vertex_auth_timeout");
  });
});

describe("gcp-auth classification (real mint, fake fetch)", () => {
  it("token exchange 401/403 is permanent, 503 transient; unusable key is permanent", async () => {
    vi.doUnmock("@/lib/gcp-auth");
    vi.resetModules();
    const { generateKeyPairSync } = await import("crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.GCP_SA_KEY = JSON.stringify({ client_email: "sa-test-fake", private_key: pem });
    const real = globalThis.fetch;
    try {
      for (const [status, permanent] of [[401, true], [403, true], [400, true], [503, false], [429, false]] as const) {
        globalThis.fetch = (async () => new Response(LEAK, { status })) as unknown as typeof fetch;
        const a = await import("@/lib/gcp-auth");
        await expect(a.getVertexAccessToken()).rejects.toMatchObject({ name: "GcpAuthError", permanent });
      }
      process.env.GCP_SA_KEY = JSON.stringify({ client_email: "sa-test-fake", private_key: "not a key" });
      const a = await import("@/lib/gcp-auth");
      await expect(a.getVertexAccessToken()).rejects.toMatchObject({ permanent: true });
    } finally { globalThis.fetch = real; }
  });
});

describe("P03 no exception text reaches a log line or a response", () => {
  it("routedChat primary mint failure: logs the class name only; result carries closed codes", async () => {
    process.env.GEMINI_ALL = "1";
    mint.err = new Error(LEAK);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const g = await import("@/lib/llm/gemini");
    const r = await g.routedChat({ surface: "note", tier: "pro", messages: [{ role: "user", content: "ok" }] });
    expect(JSON.stringify(r)).not.toContain(LEAK);
    const all = [...warn.mock.calls, ...log.mock.calls].flat().map(String).join("\n");
    expect(all).not.toContain(LEAK);
    expect(all).toContain("Error");
  });
  it("geminiChatIfOn: same", async () => {
    process.env.GEMINI_ALL = "1";
    mint.err = new Error(LEAK);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = await import("@/lib/llm/gemini");
    const r = await g.geminiChatIfOn("note", "pro", [{ role: "user", content: "ok" }]);
    expect(JSON.stringify(r)).not.toContain(LEAK);
    expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain(LEAK);
  });
  it("a non-2xx response body is not logged by routedChat", async () => {
    process.env.GEMINI_ALL = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(LEAK, { status: 500 })) as unknown as typeof fetch;
    try {
      const g = await import("@/lib/llm/gemini");
      const r = await g.routedChat({ surface: "note", tier: "pro", messages: [{ role: "user", content: "ok" }] });
      expect(JSON.stringify(r)).not.toContain(LEAK);
      expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain(LEAK);
    } finally { globalThis.fetch = real; }
  });
});
