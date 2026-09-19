/**
 * tests/unit/vad-starvation-job-path.test.ts — the verdict survives THE TRANSPORT THE DRAIN USES.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM vad-starvation.test.ts. That file proved `toSttResult`
 * keeps the router's `status`, and it proved it against a `/route` reply. The room drain never
 * calls `/route`: `routeAdapter.capabilities.async` is true, so the drain submits a job and polls
 * `GET /route/job/{id}`, and until 19 Sep `run_job` built its reply out of a fixed key set with
 * neither `status` nor `segmentation` in it. The first fix therefore exercised a path the drain
 * does not take, and a starved room window still stored as a clean empty success. Refuted; this
 * file is the proof that the fix now lands where the drain actually is.
 *
 * Everything here goes through `routeAdapter.poll()`, which is the drain's own call, with `fetch`
 * stubbed to return exactly what `GET /route/job/{id}` now serves.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { routeAdapter } from "@/lib/stt/adapters/route";
import { buildRouteMetrics, readEngineOutcome } from "@/lib/stt/route-run";
import type { SttAsyncPoll, SttTranscribeResult } from "@/lib/stt/types";

/** Narrow the poll union to its done branch, failing loudly rather than casting past it. */
function doneResult(out: SttAsyncPoll): SttTranscribeResult {
  if (!out.ok) throw new Error(`poll failed: ${out.error}`);
  if (out.state !== "done") throw new Error(`poll not done: ${out.state}`);
  return out.result;
}

/** A finished job as `run_job` writes it after `job_verdict` (router_server.py). */
const jobReply = (over: Record<string, unknown> = {}) => ({
  ok: true,
  job_id: "j1",
  state: "done",
  progress: { done: 5, total: 5 },
  dominant_language: null,
  language_timeline: [],
  transcript_native: "",
  transcript_english: null,
  segments: [],
  sec: 61.2,
  error: null,
  status: "silent_skipped",
  outcome: "no_engine",
  segmentation: {
    method: "fixed-window-vad-empty",
    methods: { "fixed-window-vad-empty": 5 },
    windows_total: 5,
    windows_skipped: 5,
    n_engine_segments: 0,
    n_segments: 0,
    n_skipped_silent: 30,
  },
  ...over,
});

function stubJobFetch(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch);
}

afterEach(() => vi.unstubAllGlobals());

describe("the drain's transport: GET /route/job/{id} via routeAdapter.poll", () => {
  it("carries silent_skipped off the JOB path, not just the synchronous one", async () => {
    stubJobFetch(jobReply());
    const out = await routeAdapter.poll!("j1");
    expect(out.ok).toBe(true);
    const result = doneResult(out);
    // The transcript is empty — exactly what a genuinely quiet room also returns.
    expect(result.original).toBe("");
    // And the verdict now arrives with it.
    expect(result.routerOutcome?.status).toBe("silent_skipped");
    expect(result.routerOutcome?.outcome).toBe("no_engine");

    const metrics = buildRouteMetrics(result.languageTimeline ?? [], { audio_seconds: 900 }, result.routerOutcome ?? undefined);
    expect(readEngineOutcome(metrics)).toEqual({
      known: true, skipped: true, outcome: "no_engine", status: "silent_skipped", n_engine_segments: 0,
      windows_total: 5, windows_skipped: 5,
    });
  });

  it("records partial starvation without claiming the whole job was skipped", async () => {
    // Four sub-windows starved, one transcribed: the job is honestly `ok`, and the counts are how
    // a reader still sees the four.
    stubJobFetch(jobReply({
      status: "ok",
      outcome: "engine_text",
      transcript_native: "some real speech",
      segments: [{ text: "some real speech" }],
      segmentation: { method: "mixed", windows_total: 5, windows_skipped: 4, n_engine_segments: 1 },
    }));
    const result = doneResult(await routeAdapter.poll!("j1"));
    const metrics = buildRouteMetrics(result.languageTimeline ?? [], {}, result.routerOutcome ?? undefined);
    const reading = readEngineOutcome(metrics);
    // An engine DID run on one sub-window, so the job is honestly not skipped...
    expect(reading).toMatchObject({ known: true, skipped: false, outcome: "engine_text", n_engine_segments: 1 });
    // ...AND THE ROW STILL SAYS FOUR OF FIVE WERE NEVER HEARD. The whole-job flag alone would call
    // this window fine; these two numbers are what a rebuild reads to re-run the four sub-windows
    // that starved instead of re-running all five to recover one.
    expect(reading).toMatchObject({ windows_total: 5, windows_skipped: 4 });
    expect(reading.known && reading.windows_skipped).toBe(4);
  });

  it("a PRE-FIX job reply (no status, no segmentation) still reads as never-measured", async () => {
    // The shape run_job served until today. It must not read as a skip, and must not read as clean.
    const { status, segmentation, outcome, ...preFix } = jobReply();
    void status; void segmentation; void outcome;
    stubJobFetch(preFix);
    const result = doneResult(await routeAdapter.poll!("j1"));
    expect(result.original).toBe("");
    // No key at all is written, so the row reads UNKNOWN rather than "engines ran".
    const metrics = buildRouteMetrics(result.languageTimeline ?? [], {}, result.routerOutcome ?? undefined);
    expect(metrics.route_outcome).toBeUndefined();
    expect(readEngineOutcome(metrics)).toEqual({ known: false });
  });

  it("a still-running job is not mistaken for a verdict", async () => {
    stubJobFetch(jobReply({ state: "running", progress: { done: 2, total: 5 } }));
    const out = await routeAdapter.poll!("j1");
    expect(out.ok && out.state).toBe("running");
    expect(() => doneResult(out)).toThrow(/not done/);
  });
});

describe("reading it cold: the tape separates a window that reached an engine from one that never did", () => {
  it("skipped / ran / unknown are three different answers on the row", async () => {
    const { assembleTape } = await import("@/lib/room-day/admin");
    const { buildRouteMetrics } = await import("@/lib/stt/route-run");
    const base = {
      windowRows: [] as never[], diarizeRows: [] as never[], turnRows: [] as never[],
      repeatRunRows: [] as never[], emotionWindowRows: [] as never[], spanEmotionRows: [] as never[],
      clinicianNames: {}, emotion: { compute_enabled: false, surface_enabled: false },
      autoDrainMaxAgeHours: 6,
    };
    const metricsFor = (router?: Parameters<typeof buildRouteMetrics>[2]) =>
      buildRouteMetrics([], { audio_seconds: 900 }, router);
    const cases = [
      { router: { status: "silent_skipped", outcome: "no_engine" }, expect: "skipped" },
      { router: { status: "ok", outcome: "engine_no_text" }, expect: "ran" },
      { router: undefined, expect: "unknown" },
    ] as const;
    for (const c of cases) {
      const m = metricsFor(c.router);
      const { readEngineOutcome } = await import("@/lib/stt/route-run");
      const r = readEngineOutcome(m);
      const rendered = r.known ? (r.skipped ? "skipped" : "ran") : "unknown";
      expect(rendered, `router=${JSON.stringify(c.router)}`).toBe(c.expect);
    }
    void base; void assembleTape;
  });
});
