/**
 * Slice C1 — the long transport: route_transcribe, and the metrics the tripwires read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const R2 = vi.hoisted(() => ({ head: { size: 10 } as { size: number | null } | null, url: "", ttl: 0, throws: false }));
const ROUTER = vi.hoisted(() => ({ submits: [] as string[], sub: {} as Record<string, unknown>, states: [] as Record<string, unknown>[] }));

vi.mock("@/lib/r2", () => ({
  headObject: async () => R2.head,
  signGetUrl: async (o: { key: string; expiresInSeconds?: number }) => {
    if (R2.throws) throw new Error("kms down");
    R2.ttl = o.expiresInSeconds ?? 0;
    return (R2.url = `https://r2.example/${o.key}?exp=${R2.ttl}`);
  },
}));
vi.mock("@/lib/stt/eta-router", () => ({
  submitRouteJob: async (url: string) => { ROUTER.submits.push(url); return ROUTER.sub; },
  pollRouteJob: async () => ROUTER.states.shift() ?? { ok: true, state: "running" },
}));

const TIMELINE = [
  { start_s: 0, end_s: 10, lang: "en", engine: "whisper", chars: 100 },
  { start_s: 10, end_s: 25, lang: "kn", engine: "indicconformer", chars: 50 },
  { start_s: 25, end_s: 30, lang: "kn", engine: "indicconformer", chars: 25 },
];

const ctx = (step: string, args: Record<string, unknown>, progress: Record<string, unknown> = {}) =>
  ({ job: {} as never, step, args, progress, runner: "r1" });

describe("C1 — submit", () => {
  beforeEach(() => { R2.head = { size: 10 }; R2.throws = false; ROUTER.submits = []; ROUTER.sub = { ok: true, job_id: "abc123" }; ROUTER.states = []; });

  it("presigns ONE object with a TTL of at least ten minutes and persists the id", async () => {
    const { routeTranscribeKind, TTL_FLOOR_S } = await import("@/lib/jobs/kinds/route-transcribe");
    const out = await routeTranscribeKind.run(ctx("submit", { clip_key: "clips/a.webm", translate: false }));
    expect(out.kind).toBe("next");
    expect(R2.ttl).toBeGreaterThanOrEqual(TTL_FLOOR_S);
    expect(ROUTER.submits).toEqual([R2.url]);
    expect((out as { progress: Record<string, unknown> }).progress.router_job_id).toBe("abc123");
  });

  it("TTL is at least twice the expected job duration for a long clip", async () => {
    const { routeTranscribeKind, presignTtlSeconds, REALTIME_MULTIPLIER } = await import("@/lib/jobs/kinds/route-transcribe");
    const fifteenMin = 15 * 60_000;
    await routeTranscribeKind.run(ctx("submit", { clip_key: "clips/a.webm", translate: false, duration_ms: fifteenMin }));
    expect(R2.ttl).toBe(presignTtlSeconds(fifteenMin));
    expect(R2.ttl, "2x an expectation of 3x realtime on 900 s").toBe(900 * REALTIME_MULTIPLIER * 2);
  });

  it("a missing clip fails BEFORE a URL is minted", async () => {
    const { routeTranscribeKind } = await import("@/lib/jobs/kinds/route-transcribe");
    R2.head = null;
    const out = await routeTranscribeKind.run(ctx("submit", { clip_key: "clips/gone.webm", translate: false }));
    expect(out.kind).toBe("fail");
    expect((out as { error: string }).error).toContain("clip_missing_in_r2");
    expect(ROUTER.submits, "no URL, no submit").toHaveLength(0);
  });

  it("a presigner that throws is its own code, and no job is submitted", async () => {
    const { routeTranscribeKind } = await import("@/lib/jobs/kinds/route-transcribe");
    R2.throws = true;
    const out = await routeTranscribeKind.run(ctx("submit", { clip_key: "clips/a.webm", translate: false }));
    expect((out as { error: string }).error).toBe("presign_failed");
    expect(ROUTER.submits, "a URL that was never minted cannot be handed out").toHaveLength(0);
  });

  it("branches on `ok`, not on transport: ok:false with no job_id is a named failure", async () => {
    const { routeTranscribeKind } = await import("@/lib/jobs/kinds/route-transcribe");
    ROUTER.sub = { ok: false, error: "audio_url required — /var/folders/secret.webm" };
    const out = await routeTranscribeKind.run(ctx("submit", { clip_key: "clips/a.webm", translate: false }));
    expect((out as { error: string }).error, "the router's prose never reaches the row").toBe("route_submit_failed");
  });

  it("an ok:true with NO job_id is still a failure", async () => {
    const { routeTranscribeKind } = await import("@/lib/jobs/kinds/route-transcribe");
    ROUTER.sub = { ok: true };
    const out = await routeTranscribeKind.run(ctx("submit", { clip_key: "clips/a.webm", translate: false }));
    expect(out.kind).toBe("fail");
  });
});

describe("C1 — poll", () => {
  beforeEach(() => { ROUTER.states = []; });

  it("a job that finishes in the first claim returns POINTERS AND COUNTS, never text", async () => {
    const { routeTranscribeKind } = await import("@/lib/jobs/kinds/route-transcribe");
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "PATIENT SAID SOMETHING PRIVATE", language_timeline: TIMELINE, dominant_language: "kn", sec: 40 }];
    const out = await routeTranscribeKind.run(ctx("poll", {}, { router_job_id: "abc123", clip_key: "clips/a.webm", audio_seconds: 30 }));
    expect(out.kind).toBe("done");
    const r = (out as { result: Record<string, unknown> }).result;
    expect(JSON.stringify(r), "no transcript text in the result").not.toContain("PRIVATE");
    expect(r.chars).toBe(30);
    expect(r.span_count).toBe(3);
    expect(r.engine_mix).toEqual({ whisper: 1, indicconformer: 2 });
    expect(r.language_mix).toEqual({ en: 1, kn: 2 });
    expect(r.chars_per_audio_second).toBe(1);
  });

  it("a still-running job hands the row back to the QUEUE — it never outlives its lease", async () => {
    const { routeTranscribeKind, POLL_BUDGET_MS } = await import("@/lib/jobs/kinds/route-transcribe");
    const { MAX_STEP_MS } = await import("@/lib/jobs/types");
    expect(POLL_BUDGET_MS, "one claim's polling must fit inside a step").toBeLessThan(MAX_STEP_MS);
    vi.useFakeTimers();
    ROUTER.states = Array.from({ length: 200 }, () => ({ ok: true, state: "running", progress: { done: 1, total: 5 } }));
    const p = routeTranscribeKind.run(ctx("poll", {}, { router_job_id: "abc123" }));
    await vi.advanceTimersByTimeAsync(POLL_BUDGET_MS + 10_000);
    const out = await p;
    vi.useRealTimers();
    expect(out.kind).toBe("next");
    const prog = (out as { progress: Record<string, unknown> }).progress;
    expect(prog.router_job_id, "the SAME id — a later claim polls, it never resubmits").toBe("abc123");
    expect(prog.last_state).toBe("running");
  });

  it("a failed router job is a named code, and the router's prose stays in the log", async () => {
    const { routeTranscribeKind } = await import("@/lib/jobs/kinds/route-transcribe");
    ROUTER.states = [{ ok: false, state: "failed", error: "RuntimeError('/tmp/patient-audio.webm')" }];
    const out = await routeTranscribeKind.run(ctx("poll", {}, { router_job_id: "abc123" }));
    expect((out as { error: string }).error).toBe("route_job_failed");
  });

  it("an expired job id is its OWN code — unknown and failed are different places to look", async () => {
    const { routeTranscribeKind } = await import("@/lib/jobs/kinds/route-transcribe");
    ROUTER.states = [{ ok: false, error: "unknown job_id" }];
    const out = await routeTranscribeKind.run(ctx("poll", {}, { router_job_id: "gone" }));
    expect((out as { error: string }).error).toBe("route_job_unknown");
  });

  it("a quiet window is a SUCCESS with zero chars, as on the whisper path", async () => {
    const { routeTranscribeKind } = await import("@/lib/jobs/kinds/route-transcribe");
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "", language_timeline: [] }];
    const out = await routeTranscribeKind.run(ctx("poll", {}, { router_job_id: "abc", audio_seconds: 30 }));
    expect(out.kind).toBe("done");
    expect((out as { result: Record<string, unknown> }).result.silent_window).toBe(true);
  });
});

describe("C1 — the metrics builder", () => {
  it("drops a span that is not an object, and one with no bounds", async () => {
    const { buildRouteMetrics } = await import("@/lib/stt/route-run");
    const m = buildRouteMetrics([TIMELINE[0], null, "x", { lang: "en" }, [1]]) as { language_timeline: { span_count: number } };
    expect(m.language_timeline.span_count).toBe(1);
  });

  it("DROPS an unexpected field — a span must not start carrying text", async () => {
    const { buildRouteMetrics } = await import("@/lib/stt/route-run");
    const m = buildRouteMetrics([{ ...TIMELINE[0], text: "PATIENT SAID SOMETHING PRIVATE" }]) as { language_timeline: { spans: unknown[] } };
    expect(JSON.stringify(m.language_timeline.spans)).not.toContain("PRIVATE");
    expect(Object.keys(m.language_timeline.spans[0] as object).sort()).toEqual(["chars", "end_s", "engine", "lang", "start_s"]);
  });

  it("copies every value unchanged — verbatim means verbatim", async () => {
    const { buildRouteMetrics } = await import("@/lib/stt/route-run");
    const m = buildRouteMetrics(TIMELINE) as { language_timeline: { spans: unknown[] } };
    expect(m.language_timeline.spans[1]).toEqual(TIMELINE[1]);
  });

  it("lands under ONE top-level key — metrics_json is merged with || by several writers", async () => {
    const { buildRouteMetrics, ROUTE_TIMELINE_KEY } = await import("@/lib/stt/route-run");
    expect(Object.keys(buildRouteMetrics(TIMELINE))).toEqual([ROUTE_TIMELINE_KEY]);
  });

  it("yield is NULL with no audio to divide by, and 0 for real audio with no words", async () => {
    const { charsPerAudioSecond } = await import("@/lib/stt/route-run");
    expect(charsPerAudioSecond(0, null)).toBeNull();
    expect(charsPerAudioSecond(100, 0)).toBeNull();
    expect(charsPerAudioSecond(0, 30), "a genuinely silent window yields 0, and that is a fact").toBe(0);
    expect(charsPerAudioSecond(150, 30)).toBe(5);
  });

  it("an unknown engine or language is counted, not silently dropped", async () => {
    const { buildRouteMetrics } = await import("@/lib/stt/route-run");
    const m = buildRouteMetrics([{ start_s: 0, end_s: 5, chars: 3 }]) as { language_timeline: { engine_mix: Record<string, number>; language_mix: Record<string, number> } };
    expect(m.language_timeline.engine_mix).toEqual({ unknown: 1 });
    expect(m.language_timeline.language_mix).toEqual({ unknown: 1 });
  });
});
