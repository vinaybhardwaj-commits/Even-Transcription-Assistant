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
import { routeTranscribeKind } from "@/lib/jobs/kinds/route-transcribe";
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
  // `status` sits at the TOP LEVEL of the reply (job_verdict()'s returned tuple, router_server.py
  // 765-781, written to job["status"]). `outcome` is NEVER a sibling of `segmentation` — it lives
  // INSIDE it (job_verdict()'s returned dict). A fixture that puts `outcome` beside `segmentation`
  // instead of in it tests the reply's mirror image, not the reply router_server.py actually sends.
  status: "silent_skipped",
  segmentation: {
    method: "fixed-window-vad-empty",
    methods: { "fixed-window-vad-empty": 5 },
    windows_total: 5,
    windows_skipped: 5,
    n_engine_segments: 0,
    n_segments: 0,
    n_skipped_silent: 30,
    outcome: "no_engine",
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
      transcript_native: "some real speech",
      segments: [{ text: "some real speech" }],
      segmentation: { method: "mixed", windows_total: 5, windows_skipped: 4, n_engine_segments: 1, outcome: "engine_text" },
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
    const { status, segmentation, ...preFix } = jobReply();
    void status; void segmentation;
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

  it("F1 regression: outcome is read from segmentation, never from a key beside it", async () => {
    // The real router NEVER sends a top-level `outcome` -- this one contradicts segmentation on
    // purpose so a reversion to reading the top level fails this assertion instead of silently
    // passing again.
    stubJobFetch(jobReply({
      status: "ok",
      outcome: "no_engine",
      segmentation: { method: "mixed", windows_total: 5, windows_skipped: 0, n_engine_segments: 5, outcome: "engine_text" },
    }));
    const result = doneResult(await routeAdapter.poll!("j1"));
    expect(result.routerOutcome?.outcome).toBe("engine_text");
    expect(result.routerOutcome?.outcome).not.toBe("no_engine");
  });

  it("F2 regression: a known status with no known outcome falls back to chars === 0, never to not-silent", async () => {
    // `segmentation` carries a real `n_engine_segments` (so `engines_skipped` is knowable from
    // `status` alone) but NO `outcome` key at all -- the shape an older or partial reply has. The
    // transcript is empty, so the pre-merge rule (`chars === 0`) says this window WAS silent.
    // Collapsing "outcome unknown" into "not silent" (the F2 bug) would report `false` here.
    stubJobFetch(jobReply({
      status: "ok",
      segmentation: { method: "silero-vad", n_engine_segments: 3, n_segments: 0 },
    }));
    const out = await routeTranscribeKind.run({ job: {} as never, step: "poll", args: {}, progress: { router_job_id: "j1", audio_seconds: 30 }, runner: "r1" });
    expect(out.kind).toBe("done");
    expect((out as { result: Record<string, unknown> }).result.silent_window).toBe(true);
  });
});

describe("reading it cold: the tape separates a window that reached an engine from one that never did", () => {
  it("skipped / ran / unknown are three different answers on the row, through assembleTape itself", async () => {
    // Asserting against the REAL assembleTape output (lib/room-day/admin.ts), not a copy of its
    // ternary inlined here — a copy proves nothing about the 17 lines that file actually changed.
    const { assembleTape, SLOT_MS } = await import("@/lib/room-day/admin");
    const win = {
      id: "bw_1", session_id: "bs_1", room_day_id: "rd_1",
      start_ms: 0, end_ms: SLOT_MS, source_mic: "primary", grid_aligned: true,
      state: "transcribed" as const, closed_at: null,
      auto_drain_refused_at: null, auto_drain_refused_reason: null,
    };
    const baseInput = {
      room: { id: "room_1", name: "R", slug: "r" },
      ist_date: "2026-09-19",
      roomDay: { id: "rd_1", doctor_id: null, started_at: null, ended_at: null },
      spanStartMs: 0, spanEndMs: SLOT_MS,
      windows: [win],
      diarizeRows: [] as never[], turnRows: [] as never[], repeatRunRows: [] as never[],
      emotionWindowRows: [] as never[], spanEmotionRows: [] as never[],
      clinicianNames: {}, emotion: { compute_enabled: false, surface_enabled: false },
      nowMs: SLOT_MS * 1000, autoDrainMaxAgeHours: 6,
    };
    const cases = [
      {
        router: { status: "silent_skipped", segmentation: { outcome: "no_engine", windows_total: 5, windows_skipped: 5 } },
        expect: "skipped", windows_total: 5, windows_skipped: 5,
      },
      {
        router: { status: "ok", segmentation: { outcome: "engine_no_text" } },
        expect: "ran", windows_total: null, windows_skipped: null,
      },
      { router: undefined, expect: "unknown", windows_total: null, windows_skipped: null },
    ] as const;
    for (const c of cases) {
      const metrics = buildRouteMetrics([], { audio_seconds: 900 }, c.router);
      const tape = assembleTape({
        ...baseInput,
        transcriptRows: [{ window_id: "bw_1", engine: "route", error: null, latency_ms: 100, transcript_original: "", metrics_json: metrics }],
      });
      const slot = tape.slots[0]!;
      if (slot.kind !== "window") throw new Error("expected a window slot");
      expect(slot.window.transcript?.engines, `router=${JSON.stringify(c.router)}`).toBe(c.expect);
      // F5: partial starvation survives onto the tape rather than being read and dropped.
      expect(slot.window.transcript?.windows_total).toBe(c.windows_total);
      expect(slot.window.transcript?.windows_skipped).toBe(c.windows_skipped);
    }
  });
});
