/**
 * Slice C1 step 2 — the `route` adapter.
 *
 * The point of contact worth testing is the TRANSPORT DECISION and the mapping, not the fetch:
 * the adapter refuses audio it knows is too long for a synchronous call rather than starting one
 * it cannot finish, and it carries the router's per-span timeline through verbatim.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ROUTER = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, reply: {} as Record<string, unknown> }));

vi.mock("@/lib/stt/eta-router", () => ({
  routeTranscribe: async (_a: unknown, contentType: string, opts: Record<string, unknown>) => {
    ROUTER.calls.push({ contentType, ...opts });
    return ROUTER.reply;
  },
}));

const TIMELINE = [
  { start_s: 0.3, end_s: 10.6, lang: "en", engine: "whisper", chars: 109 },
  { start_s: 10.6, end_s: 21.0, lang: "kn", engine: "indicconformer", chars: 64 },
];

describe("C1 step 2 — transport by duration", () => {
  beforeEach(() => {
    ROUTER.calls = [];
    ROUTER.reply = { ok: true, transcript_native: "abc", transcript_english: "abc-en", dominant_language: "kn", language_timeline: TIMELINE };
  });

  it("a stated duration ABOVE the sync ceiling is refused WITHOUT calling the router", async () => {
    const { routeAdapter, ROUTE_SYNC_MAX_MS, ROUTE_TOO_LONG_FOR_SYNC } = await import("@/lib/stt/adapters/route");
    const out = await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm", durationMs: ROUTE_SYNC_MAX_MS + 1 });
    expect(out.error, "a named refusal, not a timeout").toContain(ROUTE_TOO_LONG_FOR_SYNC);
    expect(out.original).toBeNull();
    expect(ROUTER.calls, "it must not start a call it cannot finish").toHaveLength(0);
  });

  it("a room window (15 minutes) is refused by that rule — the drain's real case", async () => {
    const { routeAdapter, ROUTE_TOO_LONG_FOR_SYNC } = await import("@/lib/stt/adapters/route");
    const out = await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm", durationMs: 15 * 60_000 });
    expect(out.error).toContain(ROUTE_TOO_LONG_FOR_SYNC);
    expect(out.error, "the refusal states the numbers so an operator need not look them up").toContain("900s");
    expect(ROUTER.calls).toHaveLength(0);
  });

  it("at or below the ceiling it calls the router synchronously", async () => {
    const { routeAdapter, ROUTE_SYNC_MAX_MS } = await import("@/lib/stt/adapters/route");
    const out = await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm", durationMs: ROUTE_SYNC_MAX_MS });
    expect(ROUTER.calls, "the ceiling is inclusive — exactly 30 s still goes sync").toHaveLength(1);
    expect(out.error).toBeNull();
  });

  it("an UNKNOWN duration is not a refusal — byte length is not a duration", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    const out = await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm" });
    expect(ROUTER.calls).toHaveLength(1);
    expect(out.error).toBeNull();
  });
});

describe("C1 step 2 — the mapping", () => {
  beforeEach(() => { ROUTER.calls = []; });

  it("carries language_timeline through VERBATIM, same identity, nothing rebuilt", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    ROUTER.reply = { ok: true, transcript_native: "x", dominant_language: "kn", language_timeline: TIMELINE };
    const out = await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm" });
    expect(out.languageTimeline).toEqual(TIMELINE);
    expect(out.languageTimeline![0]).toBe(TIMELINE[0]);
  });

  it("engineVersion stays NULL — the router reports a MAP, and one of them is not the run's engine", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    ROUTER.reply = { ok: true, transcript_native: "x", engine_versions: { whisper: "large-v3-turbo", indicconformer: "600M" } };
    const out = await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm" });
    expect(out.engineVersion, "captioning a multi-engine run with one engine is the label bug").toBeNull();
  });

  it("branches on `ok`, never on transport: ok:false is an error even when the call returned", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    ROUTER.reply = { ok: false, error: "router exploded", transcript_native: "leftovers" };
    const out = await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm" });
    expect(out.error).toContain("router exploded");
    expect(out.original, "a failed call contributes no text").toBeNull();
    expect(out.languageTimeline).toBeNull();
  });

  it("a missing language_timeline is null, not an invented empty array", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    ROUTER.reply = { ok: true, transcript_native: "x" };
    const out = await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm" });
    expect(out.languageTimeline).toBeNull();
  });

  it("translate is asked for ONLY in translate mode — an Ollama call per span is not free", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    ROUTER.reply = { ok: true, transcript_native: "x" };
    await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm", mode: "transcribe" });
    await routeAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm", mode: "translate" });
    expect(ROUTER.calls.map((c) => c.translate)).toEqual([false, true]);
  });
});

describe("C1b — health has the same base URL as transcribe", () => {
  it("with ETA_ROUTER_URL unset it still probes the literal default, like indicconformer", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    vi.stubEnv("ETA_ROUTER_URL", "");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { seen.push(String(u)); return new Response("{}", { status: 500 }); });
    const h = await routeAdapter.health();
    expect(seen, "no env, but still a real probe — not a not-configured refusal").toHaveLength(1);
    expect(seen[0]).toMatch(/^https:\/\/.+\/health$/);
    expect(h.ok, "a body with no ok:true is not a healthy router").toBe(false);
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  it("ETA_ROUTER_URL overrides it, and a trailing slash does not double up", async () => {
    const { routeAdapter } = await import("@/lib/stt/adapters/route");
    vi.stubEnv("ETA_ROUTER_URL", "https://router.test/");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { seen.push(String(u)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); });
    const h = await routeAdapter.health();
    expect(seen[0]).toBe("https://router.test/health");
    expect(h.ok).toBe(true);
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
});

describe("C1 step 2 — registration and capabilities", () => {
  it("is reachable through adapterFor, like every other engine", async () => {
    const { adapterFor } = await import("@/lib/stt/registry");
    expect(adapterFor("route")?.key).toBe("route");
  });

  it("DECLARES the room stage, unlike the engine it replaces", async () => {
    const { adapterFor } = await import("@/lib/stt/registry");
    expect(adapterFor("route")!.capabilities.stages).toContain("room");
    // CORRECTION to the research doc, which reported that sarvam "does not declare room". That is
    // true of its stt_engine.capabilities_json ROW in the database; the CODE adapter does declare
    // it. The inconsistency is therefore DB-side and invisible from here — which changes nothing
    // about the ruling, because resolveRouting reads neither: it checks `enabled` and adapter
    // existence only (routing.ts:24-27). Pinned so the next reader is not misled by either claim.
    expect(adapterFor("sarvam")!.capabilities.stages, "the CODE adapter declares room").toContain("room");
  });
});
