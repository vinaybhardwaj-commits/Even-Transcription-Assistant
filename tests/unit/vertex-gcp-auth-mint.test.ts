// gcp-auth classification with the REAL mint (fake fetch). Own file: it must not share a module
// registry with the mocked-mint tests in vertex-auth-class.test.ts (an unmock leaks across describes).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const LEAK = "LEAKY-GOOGLE-AUTH-TEXT-private_key_id";
const KEYS = ["GCP_PROJECT", "GCP_SA_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GCP_PROJECT = "proj-test"; vi.resetModules();
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } vi.restoreAllMocks(); });

describe("gcp-auth classification (real mint, fake fetch)", () => {
  it("token exchange 401/403 is permanent, 503 transient; unusable key is permanent", async () => {
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

describe("invalid-JSON GCP_SA_KEY (N16)", () => {
  it("is permanent in gcp-auth and surfaces as llm_refused from rubrics askJson, nothing sent", async () => {
    process.env.GCP_SA_KEY = "{this is not json";
    const real = globalThis.fetch;
    const sent: unknown[] = [];
    globalThis.fetch = (async (...a: unknown[]) => { sent.push(a); return new Response(LEAK, { status: 500 }); }) as unknown as typeof fetch;
    try {
      const a = await import("@/lib/gcp-auth");
      await expect(a.getVertexAccessToken()).rejects.toMatchObject({ name: "GcpAuthError", permanent: true });
      const r = await import("@/lib/rubrics/llm");
      const out = await r.askJson({ system: "s", user: "u", schema: { type: "object" } });
      expect(out).toMatchObject({ ok: false, reason: "llm_refused" });
      expect(JSON.stringify(out)).not.toContain(LEAK);
      expect(sent).toEqual([]);
    } finally { globalThis.fetch = real; }
  });
});
