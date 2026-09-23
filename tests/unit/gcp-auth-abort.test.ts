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
  // NOT an async function: an async wrapper around a manually-constructed `new Promise` adds an
  // extra microtask hop to unwrap it, and under fake timers that gap can make a rejection that
  // fires synchronously inside a timer callback look briefly unhandled to Node's detector before
  // the chain finishes propagating it — a real false positive this file hit once. A plain function
  // returning the Promise directly has no such gap.
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
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
    // Round-3 fix: getVertexAccessToken now ALWAYS builds its own internal AbortController (the
    // same pattern openaiChat/openrouterChat already use), so `lastSignal` is never undefined any
    // more even with no external `signal` passed — the short explicit timeoutMs here only avoids a
    // real dangling MINT_TIMEOUT_MS (10 s) timer in this test process. The thing under test is that
    // omitting `signal` does not change behaviour.
    const p = getVertexAccessToken(undefined, 50).then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // genuinely still in flight — nothing invisibly cancelled it early
    expect(lastSignal).toBeInstanceOf(AbortSignal);
    expect(lastSignal?.aborted).toBe(false);
    // Drain the internal 50ms REAL timer fully within this test's own scope. Left dangling, it
    // fires later, during a DIFFERENT (fake-timer) test in this file, and its rejection — though it
    // has a handler here — races Vitest's own bookkeeping closely enough to be flagged as an
    // "unhandled error" once. Waiting it out here removes the race rather than arguing with it.
    await p;
    expect(settled).toBe(true);
  }, 5_000);

  it("a resolved (unaborted) call still works normally, with an internal signal that was never aborted", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      lastSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ access_token: "fixture-token-not-a-secret", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const { getVertexAccessToken } = await loadFresh();
    const controller = new AbortController();
    const token = await getVertexAccessToken(controller.signal);
    expect(token).toBe("fixture-token-not-a-secret");
    // Not the literal external object — an internal controller mediates it (same as
    // openaiChat/openrouterChat); "aborting the caller's signal..." above already proves that
    // external abort genuinely propagates to this internal one.
    expect(lastSignal).toBeInstanceOf(AbortSignal);
    expect(lastSignal?.aborted).toBe(false);
  }, 5_000);
});

describe("getVertexAccessToken(signal, timeoutMs) — its OWN timeout, independent of any external signal", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("aborts on its own timeoutMs even with no external signal at all (round-3 fix: the mint used to have no timer of its own)", async () => {
    const { getVertexAccessToken } = await loadFresh();
    const p = getVertexAccessToken(undefined, 5_000);
    // A handler attached NOW, before advancing time — the abort (and so the rejection) happens
    // synchronously inside advanceTimersByTimeAsync, below, which is BEFORE `rejects.toThrow()`
    // would otherwise attach the first one; Node's detector can flag that gap as unhandled even
    // though the real assertion, a line later, does fully observe it. The no-op here only closes
    // that window — it asserts nothing on its own.
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(5_050);
    await expect(p).rejects.toThrow();
  }, 5_000);

  it("a generous timeoutMs does not fire early: still pending well before its own budget elapses", async () => {
    const { getVertexAccessToken } = await loadFresh();
    let settled = false;
    getVertexAccessToken(undefined, 5_000).then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(false);
  }, 5_000);

  it("round-4/5 P7 (ETA-Refuter, on 1686171): with NO timeoutMs at all, the default is MINT_TIMEOUT_MS itself — pins the SOURCE's own default rather than a restated number, so a revert to the old, separate 30s literal this commit removed is caught", async () => {
    const { getVertexAccessToken, MINT_TIMEOUT_MS } = await loadFresh();
    let settled = false;
    // Both handlers on the same line the promise is created: this already fully observes a
    // rejection, so there is no unhandled-rejection window to close with a separate no-op catch.
    getVertexAccessToken(undefined, undefined).then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS - 100);
    expect(settled).toBe(false); // not fired too early
    // Past MINT_TIMEOUT_MS but well short of the 30_000 literal this ruling removed — a revert to
    // `timeoutMs ?? 30_000` would still be pending here; only the real default fires by now.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(true);
  }, 5_000);
});

describe("round-4/5 P3/P4 (ETA-Refuter, on 1686171): the calibration log actually fires, with a stable key and a real number", () => {
  // The log is not a debug aid — it is the entire mechanism by which MINT_TIMEOUT_MS's PROVISIONAL
  // comment ever gets replaced with a calibrated number. A value-only test (does getVertexAccessToken
  // resolve?) cannot see whether the log fired, whether its tag drifted, or whether its payload is
  // still a usable number — all three fail silently, so nothing else would ever notice.
  it("logs '[gcp-auth] mint_elapsed_ms' with a finite, non-negative number on a real (non-cached) mint", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      lastSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ access_token: "fixture-token-not-a-secret", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { getVertexAccessToken } = await loadFresh();
    await getVertexAccessToken(undefined, 5_000);
    expect(logSpy).toHaveBeenCalledWith("[gcp-auth] mint_elapsed_ms", expect.any(Number));
    const logged = logSpy.mock.calls.find((c) => c[0] === "[gcp-auth] mint_elapsed_ms")?.[1] as number;
    expect(Number.isFinite(logged)).toBe(true);
    expect(logged).toBeGreaterThanOrEqual(0);
    logSpy.mockRestore();
  }, 5_000);
});

describe("round-4 W7 (ETA-Refuter mutation-coverage gap, promoted to a test by Fable's ruling, 23 Sep): finally{} really clears the timer it started", () => {
  // Not a bug fix — the code was already right. Nothing here previously PROVED that dropping
  // `clearTimeout(tid)` from the `finally` block would be caught: every other test only observes
  // getVertexAccessToken's resolved/rejected VALUE, which is identical whether or not the timer is
  // cleared (it only matters for whether a stray `controller.abort()` fires uselessly later, after
  // the call has already settled — invisible to a value-only assertion). Spying on setTimeout lets
  // an assertion reach the exact timer id clearTimeout is supposed to receive.
  it("clears the timer it started, on the SUCCESS path", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      lastSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ access_token: "fixture-token-not-a-secret", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { getVertexAccessToken } = await loadFresh();
    await getVertexAccessToken(undefined, 5_000);
    const tid = setTimeoutSpy.mock.results[0]?.value;
    expect(tid).toBeDefined();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(tid);
  }, 5_000);

  it("clears the timer it started, on the FAILURE path too — finally runs on a throw, not only on success", async () => {
    globalThis.fetch = (async () => { throw new Error("network exploded"); }) as unknown as typeof fetch;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { getVertexAccessToken } = await loadFresh();
    await expect(getVertexAccessToken(undefined, 5_000)).rejects.toThrow();
    const tid = setTimeoutSpy.mock.results[0]?.value;
    expect(tid).toBeDefined();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(tid);
  }, 5_000);
});
