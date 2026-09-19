/**
 * Night drain — what gets written, per ending. The app's own writers are mocked so the test sees exactly what the drain
 * hands them. What would break these: a row with no producer or no diarize_only flag, the service's message reaching
 * the row, a write on an abandoned window, a dry-run that writes, or a swallowed write failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";

const M = vi.hoisted(() => ({
  diarizeWindow: vi.fn(), loadClinicianCentroids: vi.fn(), recordDiarizeWindow: vi.fn(), repairStaleDiarizeSegments: vi.fn(), runDiarize: vi.fn(),
}));
vi.mock("@/lib/stt/diarize-window", () => ({ DIARIZE_BATCH_THRESHOLD: 0.65, ...M }));
vi.mock("@/lib/diarize", () => ({ runDiarize: M.runDiarize }));

import { diarizeAndRecord, recordFailedRow } from "@/lib/night-drain/record";
import type { WindowAudio } from "@/lib/night-drain/audio";
import type { ClaimedWindow } from "@/lib/night-drain/store";
import type { StageCtx } from "@/lib/night-drain/worker";

const W: ClaimedWindow = { id: "bw_1", session_id: "bs_1", room_day_id: "rd_1", start_ms: 1_000_000, end_ms: 1_900_000, source: "primary", is_retry: false };
const A: WindowAudio = { ok: true, clip: Buffer.from("clip"), seconds: 899.96, pieces: 4, bytes: 1_100_000, mcp_ms: 800, download_ms: 4200, join_ms: 3100 };
const ctx = (signal: AbortSignal = new AbortController().signal): StageCtx => ({ signal, phases: { mcp_ms: 800, download_ms: 4200, join_ms: 3100 } });
const SPEAKERS = [{ idx: 0, label: "a", type: "b" }, { idx: 1, label: "c", type: "d" }];
const SEGMENTS = [{ start_ms: 0, end_ms: 10, speaker_idx: 0, overlap: false }, { start_ms: 10, end_ms: 20, speaker_idx: 1, overlap: false }, { start_ms: 20, end_ms: 30, speaker_idx: 0, overlap: false }];
const okRes = (speakers = SPEAKERS) => ({ ok: true, outcome: {}, speakers, segments: SEGMENTS, timing: { queue_wait_ms: 2, wall_ms: 70_000, service_ms: 68_000 } });

beforeEach(() => {
  for (const f of Object.values(M)) f.mockReset();
  M.recordDiarizeWindow.mockResolvedValue(undefined);
  M.repairStaleDiarizeSegments.mockResolvedValue(false);
  M.loadClinicianCentroids.mockResolvedValue([]);
});

describe("night drain record: a successful window", () => {
  it("writes an ok row with no clip, the producer, diarize_only, every client timing key, and the phase times", async () => {
    M.diarizeWindow.mockResolvedValue(okRes());
    const r = await diarizeAndRecord(W, A, ctx(), "run", "mps");
    expect(r.outcome).toEqual({ kind: "recorded", state: "ok", speakers: 2, segments: 3 });
    expect(M.recordDiarizeWindow).toHaveBeenCalledTimes(1);
    const row = M.recordDiarizeWindow.mock.calls[0]![0];
    expect(row).toMatchObject({ windowId: "bw_1", roomDayId: "rd_1", state: "ok", error: null, clipR2Key: null, speakers: SPEAKERS, segments: SEGMENTS });
    expect(row.timing).toMatchObject({ queue_wait_ms: 2, wall_ms: 70_000, service_ms: 68_000, diarize_only: true });
    expect(row.timing.producer).toMatchObject({ host: os.hostname(), arch: os.arch(), platform: os.platform(), service_device: "mps", worker: "night-drain" });
    expect(row.timing.night_drain).toMatchObject({ phases: { mcp_ms: 800, download_ms: 4200, join_ms: 3100 }, audio: { pieces: 4, bytes: 1_100_000, seconds: 900, source: "primary" } });
    expect(row.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("calls the app's diarize with the window on the clock, the WebM clip production sends, and the abort signal", async () => {
    M.diarizeWindow.mockResolvedValue(okRes());
    const c = new AbortController();
    await diarizeAndRecord(W, A, ctx(c.signal), "run", null);
    const o = M.diarizeWindow.mock.calls[0]![0];
    expect(o).toMatchObject({ windowId: "bw_1", roomDayId: "rd_1", contentType: "audio/webm", window: { start: 1_000_000, end: 1_900_000 } });
    expect(o.audio).toBe(A.clip);
    expect(o.signal).toBe(c.signal);
    expect(o.runId).toBe(M.recordDiarizeWindow.mock.calls[0]![0].runId);      // one id per run, on the turns and on the row
  });

  it("records zero speakers as no_speakers", async () => {
    M.diarizeWindow.mockResolvedValue(okRes([]));
    const r = await diarizeAndRecord(W, A, ctx(), "run", "mps");
    expect(r.outcome).toEqual({ kind: "recorded", state: "no_speakers", speakers: 0, segments: 3 });
    expect(M.recordDiarizeWindow.mock.calls[0]![0].state).toBe("no_speakers");
  });

  it("runs the named stale-segment repair after a run that wrote turns, and never before the row", async () => {
    M.diarizeWindow.mockResolvedValue(okRes());
    const order: string[] = [];
    M.recordDiarizeWindow.mockImplementation(async () => { order.push("record"); });
    M.repairStaleDiarizeSegments.mockImplementation(async () => { order.push("repair"); return false; });
    await diarizeAndRecord(W, A, ctx(), "run", "mps");
    expect(order).toEqual(["record", "repair"]);
    expect(M.repairStaleDiarizeSegments.mock.calls[0]![0]).toMatchObject({ windowId: "bw_1", runState: "ok" });
  });
});

describe("night drain record: a failing window", () => {
  const fail = (error: string, retryable = false) => ({ ok: false, error, retryable, timing: { queue_wait_ms: 1, wall_ms: 5000, timed_out: error.startsWith("timeout") } });
  const cases: Array<[string, string]> = [
    ["timeout_300000ms", "diarize_timeout"], ["network: fetch failed", "diarize_network"],
    ["http_415: could not decode audio: Invalid data /Users/x/patient-audio.webm", "diarize_http_4xx"], ["http_500: Traceback (most recent call last) ...", "diarize_http_5xx"],
  ];
  it.each(cases)("%s → a failed row with the code %s and NOTHING of the service's message", async (error, code) => {
    M.diarizeWindow.mockResolvedValue(fail(error));
    const r = await diarizeAndRecord(W, A, ctx(), "run", "mps");
    expect(r.outcome).toEqual({ kind: "recorded", state: "failed", code });
    const row = M.recordDiarizeWindow.mock.calls[0]![0];
    expect(row).toMatchObject({ state: "failed", error: code, speakers: null, segments: null, clipR2Key: null });
    expect(JSON.stringify(row)).not.toMatch(/Traceback|patient|Users|Invalid data/);
    expect(row.timing).toMatchObject({ diarize_only: true, timed_out: error.startsWith("timeout") });
    expect(M.repairStaleDiarizeSegments).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the service was never reached (no diarize slot): the window stays eligible", async () => {
    M.diarizeWindow.mockResolvedValue(fail("diarize_busy_queue_wait_exceeded_120000ms", true));
    const r = await diarizeAndRecord(W, A, ctx(), "run", "mps");
    expect(r.outcome).toEqual({ kind: "deferred", code: "diarize_busy" });
    expect(M.recordDiarizeWindow).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the call was aborted", async () => {
    M.diarizeWindow.mockResolvedValue(fail("aborted", true));
    const r = await diarizeAndRecord(W, A, ctx(), "run", "mps");
    expect(r.outcome).toEqual({ kind: "abandoned", code: "stopped" });
    expect(M.recordDiarizeWindow).not.toHaveBeenCalled();
  });

  it("reports a missing DIARIZE_BASE_URL as fatal", async () => {
    M.diarizeWindow.mockResolvedValue(fail("diarize_base_url_missing"));
    expect((await diarizeAndRecord(W, A, ctx(), "run", null)).outcome).toEqual({ kind: "fatal", code: "diarize_base_url_missing" });
    expect(M.recordDiarizeWindow).not.toHaveBeenCalled();
  });

  it("a terminal row that cannot be written is DEFERRED, never reported as done", async () => {
    M.diarizeWindow.mockResolvedValue(okRes());
    M.recordDiarizeWindow.mockRejectedValue(new Error("connection terminated"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await diarizeAndRecord(W, A, ctx(), "run", "mps");
    warn.mockRestore();
    expect(r.outcome).toEqual({ kind: "deferred", code: "record_write_failed" });
    expect(M.repairStaleDiarizeSegments).not.toHaveBeenCalled();
  });

  it("a failed row that cannot be written is deferred too", async () => {
    M.diarizeWindow.mockResolvedValue(fail("timeout_300000ms"));
    M.recordDiarizeWindow.mockRejectedValue(new Error("nope"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await diarizeAndRecord(W, A, ctx(), "run", "mps")).outcome).toEqual({ kind: "deferred", code: "record_write_failed" });
    warn.mockRestore();
  });
});

describe("night drain record: failures before the service", () => {
  it("recordFailedRow writes a failed row with the code, a producer and diarize_only, and no clip", async () => {
    const o = await recordFailedRow(W, "chunk_gone", ctx(), "mps");
    expect(o).toEqual({ kind: "recorded", state: "failed", code: "chunk_gone" });
    const row = M.recordDiarizeWindow.mock.calls[0]![0];
    expect(row).toMatchObject({ windowId: "bw_1", roomDayId: "rd_1", state: "failed", error: "chunk_gone", speakers: null, segments: null, clipR2Key: null });
    expect(row.timing).toMatchObject({ diarize_only: true });
    expect(row.timing.producer.host).toBe(os.hostname());
    expect(row.timing.night_drain.phases).toMatchObject({ diarize_ms: null });
  });

  it("recordFailedRow defers when the write fails", async () => {
    M.recordDiarizeWindow.mockRejectedValue(new Error("down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await recordFailedRow(W, "audio_corrupt", ctx(), null)).toEqual({ kind: "deferred", code: "record_write_failed" });
    warn.mockRestore();
  });
});

describe("night drain record: dry-run writes nothing", () => {
  it("makes the /diarize call and returns counts, and touches no writer", async () => {
    M.loadClinicianCentroids.mockResolvedValue([{ clinician_id: "c" }]);
    M.runDiarize.mockResolvedValue({ ok: true, result: { speakers: SPEAKERS, transcript_segments: SEGMENTS }, timing: {} });
    const r = await diarizeAndRecord(W, A, ctx(), "dry-run", "mps");
    expect(r.outcome).toEqual({ kind: "recorded", state: "ok", speakers: 2, segments: 3 });
    expect(M.runDiarize).toHaveBeenCalledWith(A.clip, "audio/webm", expect.objectContaining({ encounterId: "bw_1", batchThreshold: 0.65, clinicianCentroids: [{ clinician_id: "c" }] }));
    expect(M.diarizeWindow).not.toHaveBeenCalled();
    expect(M.recordDiarizeWindow).not.toHaveBeenCalled();
    expect(M.repairStaleDiarizeSegments).not.toHaveBeenCalled();
  });

  it("maps a dry-run failure the same way, still writing nothing", async () => {
    M.runDiarize.mockResolvedValue({ ok: false, error: "timeout_300000ms", retryable: false, timing: {} });
    const r = await diarizeAndRecord(W, A, ctx(), "dry-run", "mps");
    expect(r.outcome).toEqual({ kind: "recorded", state: "failed", code: "diarize_timeout" });
    expect(M.recordDiarizeWindow).not.toHaveBeenCalled();
  });
});
