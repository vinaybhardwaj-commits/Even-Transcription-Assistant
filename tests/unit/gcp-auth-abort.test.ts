/**
 * tests/unit/gcp-auth-abort.test.ts — getVertexAccessToken honours an AbortSignal on its OWN
 * token-exchange fetch (the follow-up the routedChat deadline review flagged: the deadline could
 * stop routedChat WAITING on this call, but could not cancel the network request itself).
 *
 * Every other test of gemini.ts mocks this module entirely, so none of them exercises the real
 * implementation. This file does: a fake global `fetch` that only settles when ITS OWN request's
 * AbortSignal fires — the same "genuinely hung, not erroring" shape used in
 * routed-chat-deadline.test.ts — proves the signal reaches the actual network call, not just a
 * wrapper around it.
 *
 * A throwaway RSA keypair (never used against a real Google endpoint; nothing here makes a real
 * network call) satisfies loadServiceAccount's signing step, which runs before any fetch and would
 * throw synchronously on a malformed key, hiding the thing under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
// no-identity-literals.test.ts's "email" rule exempts only example.com/.org/.net/.test exactly —
// a service-account-shaped domain (…iam.gserviceaccount.com) does not qualify even with "example."
// as its first label, so the fixture uses a plain exempted address instead.
const SA_KEY = JSON.stringify({ client_email: "test@example.com", private_key: privateKey, token_uri: "https://oauth2.example.test/token" });

const realFetch = globalThis.fetch;
let lastSignal: AbortSignal | undefined;
let savedKey: string | undefined;

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

beforeEach(() => {
  savedKey = process.env.GCP_SA_KEY;
  process.env.GCP_SA_KEY = SA_KEY;
  lastSignal = undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    lastSignal = init?.signal ?? undefined;
    // Settles ONLY on its own signal's abort — a genuinely hung endpoint, not one that errors.
    return new Promise<Response>((_resolve, reject) => {
      if (lastSignal?.aborted) { reject(abortError()); return; }
      lastSignal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }) as unknown as typeof fetch;
  vi.resetModules();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.GCP_SA_KEY; else process.env.GCP_SA_KEY = savedKey;
});

async function loadFresh() {
  return import("@/lib/gcp-auth");
}

describe("getVertexAccessToken(signal) — the fetch is actually cancelled, not just abandoned", () => {
  it("aborting the caller's signal aborts the in-flight token-exchange fetch and rejects promptly", async () => {
    const { getVertexAccessToken } = await loadFresh();
    const controller = new AbortController();
    const p = getVertexAccessToken(controller.signal);
    const t0 = Date.now();
    controller.abort();
    await expect(p).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(lastSignal?.aborted).toBe(true); // the REQUEST's own signal, proving it reached fetch()
  }, 5_000);

  it("an already-aborted signal rejects immediately, without ever waiting on the hung fetch", async () => {
    const { getVertexAccessToken } = await loadFresh();
    const controller = new AbortController();
    controller.abort();
    const t0 = Date.now();
    await expect(getVertexAccessToken(controller.signal)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(500);
  }, 5_000);

  it("no signal passed: fully backward compatible — still pending, not thrown, not aborted early", async () => {
    const { getVertexAccessToken } = await loadFresh();
    let settled = false;
    getVertexAccessToken().then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // genuinely still in flight — nothing invisibly cancelled it
    expect(lastSignal).toBeUndefined(); // fetch received no signal at all, exactly as before
  }, 5_000);

  it("a resolved (unaborted) call still works normally: the fetch call carries the caller's signal object", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      lastSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ access_token: "fixture-token-not-a-secret", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const { getVertexAccessToken } = await loadFresh();
    const controller = new AbortController();
    const token = await getVertexAccessToken(controller.signal);
    expect(token).toBe("fixture-token-not-a-secret");
    expect(lastSignal).toBe(controller.signal);
  }, 5_000);
});
