/**
 * The `route` engine's health probe.
 *
 * It used to GET `/health`. The router serves `/healthz`, `/route`, `/route/job` and
 * `/route/job/{id}`, so FastAPI answered 404 and production read `route_unhealthy_http_404` while
 * both room routing rows pointed at a router that was transcribing. The probe now does what the
 * whisper probe does: a real transcription POST of the half-second fixture, judged on the parsed
 * `ok`. These tests drive `runRouteProbe` with a recording fetch; no network.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Call = { url: string; method: string; form: FormData | null };

function fetcher(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit) => {
    const c = { url, method: String(init.method ?? "GET"), form: init.body instanceof FormData ? init.body : null };
    calls.push(c);
    return respond(c);
  };
  return { calls, impl };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fixture = async () => new Uint8Array([1, 2, 3]);

describe("route health probe — it transcribes, and reads the router's own verdict", () => {
  beforeEach(async () => { (await import("@/lib/stt/adapters/route")).__resetRouteProbeCache(); });

  it("POSTs the fixture to /route as routeTranscribe does, translation OFF — never GET /health", async () => {
    const { runRouteProbe } = await import("@/lib/stt/adapters/route");
    const f = fetcher(() => json(200, { ok: true, segments: [], engine_versions: {} }));
    const r = await runRouteProbe({ baseUrl: "https://router.test/", fetchImpl: f.impl, readFixture: fixture });
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://router.test/route");
    expect(f.calls[0]!.method).toBe("POST");
    expect(f.calls[0]!.form?.get("translate")).toBe("false");
    const file = f.calls[0]!.form?.get("file") as Blob | null;
    expect(file?.type).toBe("audio/webm");
    expect(file?.size).toBe(3);
  });

  it("THE PRODUCTION DEFECT: FastAPI's 404 — a JSON body that parses — is NOT healthy, and is named", async () => {
    const { runRouteProbe } = await import("@/lib/stt/adapters/route");
    const f = fetcher(() => json(404, { detail: "Not Found" }));
    const r = await runRouteProbe({ baseUrl: "https://router.test", fetchImpl: f.impl, readFixture: fixture });
    expect(r).toMatchObject({ ok: false, error: "route_probe_http_404" });
  });

  it("a 200 is not enough: ok:false from the router is unhealthy and carries the router's error", async () => {
    const { runRouteProbe } = await import("@/lib/stt/adapters/route");
    const f = fetcher(() => json(200, { ok: false, error: "indic engine unreachable" }));
    const r = await runRouteProbe({ baseUrl: "https://router.test", fetchImpl: f.impl, readFixture: fixture });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("route_probe_http_200: indic engine unreachable");
  });

  it("a non-JSON 200 (a proxy page) is unhealthy", async () => {
    const { runRouteProbe } = await import("@/lib/stt/adapters/route");
    const f = fetcher(() => new Response("<html>ok</html>", { status: 200 }));
    expect((await runRouteProbe({ baseUrl: "https://router.test", fetchImpl: f.impl, readFixture: fixture })).ok).toBe(false);
  });

  it("a hang is a NAMED timeout inside the budget, not a hung health route", async () => {
    const { runRouteProbe } = await import("@/lib/stt/adapters/route");
    const f = fetcher((c) => new Promise<Response>((_res, rej) => {
      void c;
      setTimeout(() => rej(Object.assign(new Error("aborted"), { name: "AbortError" })), 80);
    }));
    const r = await runRouteProbe({ baseUrl: "https://router.test", fetchImpl: f.impl, readFixture: fixture, budgetMs: 50 });
    expect(r).toMatchObject({ ok: false, error: "route_probe_timeout_50ms" });
  });

  it("a transport failure is named", async () => {
    const { runRouteProbe } = await import("@/lib/stt/adapters/route");
    const f = fetcher(() => { throw new TypeError("fetch failed"); });
    const r = await runRouteProbe({ baseUrl: "https://router.test", fetchImpl: f.impl, readFixture: fixture });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^route_probe_transport: fetch failed/);
  });

  it("at most ONE probe transcription per minute — the Mini is what is being observed", async () => {
    const { probeRouteTranscription, ROUTE_PROBE_CACHE_MS } = await import("@/lib/stt/adapters/route");
    let t = 1_000_000;
    const f = fetcher(() => json(200, { ok: true }));
    const opts = { baseUrl: "https://router.test", fetchImpl: f.impl, readFixture: fixture, now: () => t };
    expect((await probeRouteTranscription(opts)).cached).toBeUndefined();
    t += ROUTE_PROBE_CACHE_MS - 1;
    expect((await probeRouteTranscription(opts)).cached).toBe(true);
    expect(f.calls).toHaveLength(1);
    t += 2;
    await probeRouteTranscription(opts);
    expect(f.calls).toHaveLength(2);
  });

  it("the default fixture is the one the whisper probe ships, and it exists", async () => {
    const { WHISPER_PROBE_FIXTURE } = await import("@/lib/health/whisper-probe");
    expect(readFileSync(WHISPER_PROBE_FIXTURE).length).toBeGreaterThan(0);
  });
});
