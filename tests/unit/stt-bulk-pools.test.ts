/**
 * STT-STACK-PARITY 2(b) (Fable, 24 Sep) — IndicConformer and the router on the service pools.
 *
 * Until this, a bulk room window reached the twins for whisper and the MINI for IndicConformer and the router,
 * because neither had a _BULK_URLS list. These pin: bulk work goes ONLY to the bulk list; live work and the
 * no-env case are exactly what they were; failover happens on "down" (unreachable, 5xx) and never on a
 * 4xx or on the endpoint's own timeout; a router job is polled on the router that accepted it; and served_by
 * is recorded, only when a pool is configured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { poolConfigProblems, poolConfigured, poolEndpoints, resetBreakers, withPoolContext } from "@/lib/service-pool";
import { routeTranscribe, submitRouteJob, pollRouteJob, ROUTER_DEFAULT_URL } from "@/lib/stt/eta-router";
import { routeAdapter } from "@/lib/stt/adapters/route";
import { indicconformerAdapter, INDICCONFORMER_DEFAULT_URL } from "@/lib/stt/adapters/indicconformer";

const VARS = [
  "ETA_ROUTER_URL", "ETA_ROUTER_URLS", "ETA_ROUTER_BULK_URLS",
  "INDICCONFORMER_BASE_URL", "INDICCONFORMER_BASE_URLS", "INDICCONFORMER_BULK_URLS",
  "POOL_BULK_FALLBACK_LIVE", "ETA_ROUTER_JOB",
];
const saved: Record<string, string | undefined> = {};
const calls: string[] = [];
type Reply = { status: number; body: unknown } | "throw" | "timeout" | "garbage200";
let route: (url: string) => Reply = () => ({ status: 200, body: {} });

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fakeFetch = async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input.toString();
  calls.push(url);
  const r = route(url);
  if (r === "throw") throw new TypeError("fetch failed");
  if (r === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  // A 200 whose body does not parse: res.json() throws a SyntaxError, as the real Response does.
  if (r === "garbage200") return { ok: true, status: 200, json: async () => JSON.parse("<html>"), text: async () => "<html>" } as unknown as Response;
  return reply(r.status, r.body);
};

const MINI_ROUTER = "https://route-mini.example";
const BOX_ROUTER = "https://route-box.example";
const L4_ROUTER = "https://route-l4.example";
const MINI_INDIC = "https://indic-mini.example";
const BOX_INDIC = "https://indic-box.example";
const L4_INDIC = "https://indic-l4.example";
const bulk = <T>(fn: () => Promise<T>) => withPoolContext({ bulk: true }, fn);
const live = <T>(fn: () => Promise<T>) => withPoolContext({ bulk: false }, fn);

beforeEach(() => {
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  calls.length = 0;
  route = () => ({ status: 200, body: {} });
  resetBreakers();
  vi.stubGlobal("fetch", fakeFetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the env", () => {
  it("indic and router are pool services with their own names, default off", () => {
    expect(poolEndpoints("router", { fallback: ROUTER_DEFAULT_URL }, {})).toEqual([ROUTER_DEFAULT_URL]);
    expect(poolEndpoints("indic", { fallback: INDICCONFORMER_DEFAULT_URL }, {})).toEqual([INDICCONFORMER_DEFAULT_URL]);
    expect(poolConfigured("router", { ETA_ROUTER_URL: MINI_ROUTER })).toBe(false);
    expect(poolConfigured("router", { ETA_ROUTER_BULK_URLS: BOX_ROUTER })).toBe(true);
    expect(poolConfigured("indic", { INDICCONFORMER_BULK_URLS: BOX_INDIC })).toBe(true);
  });
  it("bulk uses ONLY the bulk list; live never sees it", () => {
    const env = { ETA_ROUTER_URL: MINI_ROUTER, ETA_ROUTER_BULK_URLS: `${BOX_ROUTER}, ${L4_ROUTER}` };
    expect(poolEndpoints("router", { bulk: true }, env)).toEqual([BOX_ROUTER, L4_ROUTER]);
    expect(poolEndpoints("router", { bulk: false }, env)).toEqual([MINI_ROUTER]);
    const ienv = { INDICCONFORMER_BASE_URL: MINI_INDIC, INDICCONFORMER_BULK_URLS: BOX_INDIC };
    expect(poolEndpoints("indic", { bulk: true }, ienv)).toEqual([BOX_INDIC]);
    expect(poolEndpoints("indic", { bulk: false }, ienv)).toEqual([MINI_INDIC]);
  });
  it("a malformed entry is reported by name, never its value", () => {
    expect(poolConfigProblems({ ETA_ROUTER_BULK_URLS: "not a url" })).toContain("ETA_ROUTER_BULK_URLS");
    expect(poolConfigProblems({ INDICCONFORMER_BULK_URLS: "::" })).toContain("INDICCONFORMER_BULK_URLS");
  });
});

describe("router — submit", () => {
  it("NO-ENV IDENTITY: one POST to the default /route/job, and the answer has exactly the old shape", async () => {
    route = () => ({ status: 200, body: { job_id: "j1" } });
    const r = await submitRouteJob("https://r2.example/a");
    expect(calls).toEqual([`${ROUTER_DEFAULT_URL}/route/job`]);
    expect(r).toEqual({ ok: true, job_id: "j1" });
  });

  it("bulk: submits to the bulk twin and says which one holds the job", async () => {
    process.env.ETA_ROUTER_URL = MINI_ROUTER;
    process.env.ETA_ROUTER_BULK_URLS = `${BOX_ROUTER},${L4_ROUTER}`;
    route = () => ({ status: 200, body: { job_id: "j1" } });
    const { value, served_by } = await bulk(() => submitRouteJob("https://r2.example/a"));
    expect(calls).toEqual([`${BOX_ROUTER}/route/job`]);
    expect(value).toEqual({ ok: true, job_id: "j1", endpoint: BOX_ROUTER, served_by: BOX_ROUTER });
    expect(served_by, "recorded for the job's progress").toEqual({ router: BOX_ROUTER });
  });

  it("live work with a bulk list set still goes to the Mini, with nothing new in the answer but served_by", async () => {
    process.env.ETA_ROUTER_URL = MINI_ROUTER;
    process.env.ETA_ROUTER_BULK_URLS = BOX_ROUTER;
    route = () => ({ status: 200, body: { job_id: "j1" } });
    const { value } = await live(() => submitRouteJob("https://r2.example/a"));
    expect(calls).toEqual([`${MINI_ROUTER}/route/job`]);
    expect(value).toMatchObject({ ok: true, job_id: "j1", endpoint: MINI_ROUTER });
  });

  it("fails over when a twin is unreachable or answers 5xx — and the endpoint named is the one that took it", async () => {
    process.env.ETA_ROUTER_BULK_URLS = `${BOX_ROUTER},${L4_ROUTER},https://route-third.example`;
    route = (u) => (u.startsWith(BOX_ROUTER) ? "throw" : u.startsWith(L4_ROUTER) ? { status: 503, body: {} } : { status: 200, body: { job_id: "j3" } });
    const { value } = await bulk(() => submitRouteJob("https://r2.example/a"));
    expect(calls).toHaveLength(3);
    expect(value).toMatchObject({ ok: true, job_id: "j3", endpoint: "https://route-third.example" });
  });

  it("does NOT fail over on a 4xx, or on its own timeout (the router may have accepted the job)", async () => {
    process.env.ETA_ROUTER_BULK_URLS = `${BOX_ROUTER},${L4_ROUTER}`;
    route = () => ({ status: 422, body: {} });
    const a = await bulk(() => submitRouteJob("https://r2.example/a"));
    expect(calls).toEqual([`${BOX_ROUTER}/route/job`]);
    expect(a.value.ok).toBe(false);
    expect(a.value.endpoint, "a failed submit names no job holder").toBeUndefined();
    calls.length = 0; resetBreakers();
    route = () => "timeout";
    await bulk(() => submitRouteJob("https://r2.example/a"));
    expect(calls).toEqual([`${BOX_ROUTER}/route/job`]);
  });

  it("does NOT fail over on a 200 it cannot parse: that router answered, and may have ACCEPTED the job (Refuter F1)", async () => {
    process.env.ETA_ROUTER_BULK_URLS = `${BOX_ROUTER},${L4_ROUTER}`;
    route = () => "garbage200";
    const a = await bulk(() => submitRouteJob("https://r2.example/a"));
    expect(calls).toEqual([`${BOX_ROUTER}/route/job`]);
    expect(a.value.ok).toBe(false);
    calls.length = 0; resetBreakers();
    const b = await bulk(() => routeTranscribe(new Uint8Array([1])));
    expect(calls, "the sync call: the audio is not transcribed twice").toEqual([`${BOX_ROUTER}/route`]);
    expect(b.value.ok).toBe(false);
  });

  it("singleOnly ignores every pool list: a caller that cannot persist the endpoint submits where it polls", async () => {
    process.env.ETA_ROUTER_URL = MINI_ROUTER;
    process.env.ETA_ROUTER_URLS = `${BOX_ROUTER},${L4_ROUTER}`;
    process.env.ETA_ROUTER_BULK_URLS = BOX_ROUTER;
    route = () => ({ status: 200, body: { job_id: "j1" } });
    const { value } = await bulk(() => submitRouteJob("https://r2.example/a", { singleOnly: true }));
    expect(calls).toEqual([`${MINI_ROUTER}/route/job`]);
    expect(value).toEqual({ ok: true, job_id: "j1" });
  });
});

describe("router — poll is NEVER pooled", () => {
  it("goes to the endpoint it is given, even inside a bulk context with other lists set", async () => {
    process.env.ETA_ROUTER_URL = MINI_ROUTER;
    process.env.ETA_ROUTER_BULK_URLS = `${BOX_ROUTER},${L4_ROUTER}`;
    route = () => ({ status: 200, body: { ok: true, state: "running" } });
    await bulk(() => pollRouteJob("j1", L4_ROUTER));
    expect(calls).toEqual([`${L4_ROUTER}/route/job/j1`]);
  });
  it("with no endpoint, goes to the single URL — where every such job was submitted — never a bulk twin", async () => {
    process.env.ETA_ROUTER_URL = MINI_ROUTER;
    process.env.ETA_ROUTER_BULK_URLS = BOX_ROUTER;
    route = () => ({ status: 200, body: { ok: true, state: "running" } });
    await bulk(() => pollRouteJob("j1"));
    expect(calls).toEqual([`${MINI_ROUTER}/route/job/j1`]);
  });
  it("a down endpoint is reported, not retried elsewhere (another router would 404 a job it never had)", async () => {
    process.env.ETA_ROUTER_BULK_URLS = `${BOX_ROUTER},${L4_ROUTER}`;
    route = () => "throw";
    const st = await bulk(() => pollRouteJob("j1", BOX_ROUTER));
    expect(calls).toEqual([`${BOX_ROUTER}/route/job/j1`]);
    expect(st.value.ok).toBe(false);
  });
});

describe("router — the adapter carries the endpoint from submit to poll", () => {
  it("submit returns it only when pooled; poll sends it back", async () => {
    route = () => ({ status: 200, body: { job_id: "j1" } });
    expect(await routeAdapter.submit!({ audioUrl: "https://r2.example/a" })).toEqual({ ok: true, jobRef: "j1" });
    process.env.ETA_ROUTER_BULK_URLS = L4_ROUTER;
    const { value } = await bulk(() => routeAdapter.submit!({ audioUrl: "https://r2.example/a" }));
    expect(value).toEqual({ ok: true, jobRef: "j1", endpoint: L4_ROUTER });
    calls.length = 0;
    route = () => ({ status: 200, body: { ok: true, state: "queued" } });
    await routeAdapter.poll!("j1", { endpoint: L4_ROUTER });
    expect(calls).toEqual([`${L4_ROUTER}/route/job/j1`]);
  });
});

describe("router — the synchronous /route", () => {
  it("bulk goes to the twin; a down twin fails over; its own timeout does not", async () => {
    process.env.ETA_ROUTER_URL = MINI_ROUTER;
    process.env.ETA_ROUTER_BULK_URLS = `${BOX_ROUTER},${L4_ROUTER}`;
    route = (u) => (u.startsWith(BOX_ROUTER) ? { status: 502, body: {} } : { status: 200, body: { ok: true, transcript_native: "x" } });
    const a = await bulk(() => routeTranscribe(new Uint8Array([1])));
    expect(calls).toEqual([`${BOX_ROUTER}/route`, `${L4_ROUTER}/route`]);
    expect(a.value).toMatchObject({ ok: true, served_by: L4_ROUTER });
    calls.length = 0; resetBreakers();
    route = () => "timeout";
    await bulk(() => routeTranscribe(new Uint8Array([1])));
    expect(calls).toEqual([`${BOX_ROUTER}/route`]);
  });
  it("NO-ENV IDENTITY: one call to the default, answer returned untouched", async () => {
    route = () => ({ status: 200, body: { ok: true, transcript_native: "x" } });
    const r = await routeTranscribe(new Uint8Array([1]));
    expect(calls).toEqual([`${ROUTER_DEFAULT_URL}/route`]);
    expect(r).toEqual({ ok: true, transcript_native: "x" });
  });
});

describe("IndicConformer", () => {
  const OK = { status: 200, body: { text: "ನಮಸ್ಕಾರ", language: "kn" } };
  const call = () => indicconformerAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm", language: "kn" });

  it("NO-ENV IDENTITY: one call to the default /inference, same result shape (no served_by)", async () => {
    route = () => OK;
    const r = await call();
    expect(calls).toEqual([`${INDICCONFORMER_DEFAULT_URL}/inference`]);
    expect(r).toMatchObject({ original: "ನಮಸ್ಕಾರ", language: "kn", error: null });
    expect("served_by" in r).toBe(false);
  });

  it("bulk goes ONLY to the bulk twin and records served_by for the job; live stays on the Mini", async () => {
    process.env.INDICCONFORMER_BASE_URL = MINI_INDIC;
    process.env.INDICCONFORMER_BULK_URLS = `${BOX_INDIC},${L4_INDIC}`;
    route = () => OK;
    const b = await bulk(call);
    expect(calls).toEqual([`${BOX_INDIC}/inference`]);
    expect(b.served_by).toEqual({ indic: BOX_INDIC });
    calls.length = 0;
    const l = await live(call);
    expect(calls).toEqual([`${MINI_INDIC}/inference`]);
    expect(l.served_by, "the single URL alone is not a pool → recorded only because a bulk list is set").toEqual({ indic: MINI_INDIC });
  });

  it("fails over on unreachable/5xx; NOT on a 4xx or its own timeout", async () => {
    process.env.INDICCONFORMER_BULK_URLS = `${BOX_INDIC},${L4_INDIC}`;
    route = (u) => (u.startsWith(BOX_INDIC) ? "throw" : OK);
    expect((await bulk(call)).served_by).toEqual({ indic: L4_INDIC });
    calls.length = 0; resetBreakers();
    route = (u) => (u.startsWith(BOX_INDIC) ? { status: 503, body: {} } : OK);
    const five = await bulk(call);
    expect(calls).toEqual([`${BOX_INDIC}/inference`, `${L4_INDIC}/inference`]);
    expect(five.value.original).toBe("ನಮಸ್ಕಾರ");
    for (const bad of [{ status: 400, body: {} }, "timeout", "garbage200"] as const) {
      calls.length = 0; resetBreakers();
      route = () => bad;
      const r = await bulk(call);
      expect(calls).toEqual([`${BOX_INDIC}/inference`]);
      expect(r.value.error).toBeTruthy();
    }
  });

  it("a non-Indic language never calls any endpoint", async () => {
    process.env.INDICCONFORMER_BULK_URLS = BOX_INDIC;
    const r = await bulk(() => indicconformerAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm", language: "en" }));
    expect(calls).toEqual([]);
    expect(r.value.error).toBe("skipped_non_indic");
  });
});
