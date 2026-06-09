import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * Loads public/sw.js into a sandboxed Service Worker global and returns the
 * registered event handlers. The SW is plain JS that calls
 * self.addEventListener('fetch'|'install'|'activate', ...); we capture those.
 */
function loadServiceWorker() {
  const swPath = fileURLToPath(new URL("../../public/sw.js", import.meta.url));
  const code = readFileSync(swPath, "utf8");
  const handlers: Record<string, (e: unknown) => void> = {};

  class FakeResponse {
    body: unknown; status: number;
    constructor(body?: unknown, init?: { status?: number }) { this.body = body; this.status = init?.status ?? 200; }
    static error() { return new FakeResponse(null, { status: 0 }); }
    clone() { return new FakeResponse(this.body, { status: this.status }); }
    get ok() { return this.status >= 200 && this.status < 300; }
    async text() { return ""; }
  }
  const fakeCache = { put: async () => {}, add: async () => {}, match: async () => undefined };
  const ctx: Record<string, unknown> = {
    self: {
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      registration: { unregister: async () => {} },
    },
    caches: { open: async () => fakeCache, keys: async () => [], match: async () => undefined, delete: async () => {} },
    fetch: async () => new FakeResponse("", { status: 200 }),
    Response: FakeResponse,
    URL,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return handlers;
}

function fakeFetchEvent(url: string, method: string, mode = "cors") {
  let responded: unknown = "__NOT_CALLED__";
  return {
    event: {
      request: { url, method, mode },
      respondWith: (v: unknown) => { responded = v; },
    },
    didRespond: () => responded !== "__NOT_CALLED__",
  };
}

describe("service worker fetch handler (B22 regression)", () => {
  let handlers: Record<string, (e: unknown) => void>;
  beforeEach(() => { handlers = loadServiceWorker(); });

  it("registers a fetch handler", () => {
    expect(typeof handlers.fetch).toBe("function");
  });

  it("does NOT intercept POST /process (the long NDJSON stream)", () => {
    const f = fakeFetchEvent("https://www.evenscribe.app/dr-x/api/encounters/enc_1/process", "POST");
    handlers.fetch(f.event);
    expect(f.didRespond()).toBe(false); // streamed POST must go straight to network
  });

  it("does NOT intercept POST /send or /note", () => {
    for (const path of ["/dr-x/api/encounters/enc_1/send", "/dr-x/api/encounters/enc_1/note"]) {
      const f = fakeFetchEvent("https://www.evenscribe.app" + path, "POST");
      handlers.fetch(f.event);
      expect(f.didRespond()).toBe(false);
    }
  });

  it("does NOT intercept PUT/DELETE either", () => {
    for (const m of ["PUT", "DELETE", "PATCH"]) {
      const f = fakeFetchEvent("https://www.evenscribe.app/dr-x/api/encounters/enc_1", m);
      handlers.fetch(f.event);
      expect(f.didRespond()).toBe(false);
    }
  });

  it("DOES intercept GET navigations (network-first page load)", () => {
    const f = fakeFetchEvent("https://www.evenscribe.app/dr-x/encounter/enc_1", "GET", "navigate");
    handlers.fetch(f.event);
    expect(f.didRespond()).toBe(true);
  });

  it("DOES intercept GET /api/ reads (offline-503 fallback for Library polling)", () => {
    const f = fakeFetchEvent("https://www.evenscribe.app/dr-x/api/encounters", "GET");
    handlers.fetch(f.event);
    expect(f.didRespond()).toBe(true);
  });

  it("never intercepts the killswitch or the SW itself", () => {
    for (const path of ["/sw.js", "/sw-killswitch.txt"]) {
      const f = fakeFetchEvent("https://www.evenscribe.app" + path, "GET");
      handlers.fetch(f.event);
      expect(f.didRespond()).toBe(false);
    }
  });
});
