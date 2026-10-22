/** Spine S4 R2: tests ported from the Opus refute (oref-s4), killing mutants B1 (timeout), B2 (single-flight), B7 (memo boundary), T12. Synthetic ids only. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const M = vi.hoisted(() => ({ kind: { value: "admin" as string }, hang: { value: false }, fail: { value: false } }));
vi.mock("@/lib/db", () => ({ sql: ((t: unknown) => {
  const s = typeof t === "string" ? t : "";
  if (/spine_/.test(s)) return M.hang.value ? new Promise(() => {}) : M.fail.value ? Promise.reject(new Error('relation "spine_signal" does not exist')) : Promise.resolve([]);
  return Promise.resolve([]);
}) as unknown }));
vi.mock("@/lib/rooms-live/guard", () => ({ roomsLiveGuard: async () => ({ ok: true, kind: M.kind.value }) }));
vi.mock("@/lib/rooms-live/claims", () => ({ realClaimsPort: () => ({}) }));
vi.mock("@/lib/rooms-live/snapshot", () => ({ getSnapshot: async () => ({ generated_at: "x", degraded: [], rooms: [{ room_id: "room_a", z: 1 }, { room_id: "room_b" }] }) }));
vi.mock("@/lib/micguard-read", () => ({ readMicGuard: async () => ({ byRoom: { room_a: "ok" } }) }));
vi.mock("@/lib/jev/worker/coverage-view", () => ({ coverageOrNull: async () => ({ c: 1 }) }));
import * as P from "@/lib/spine/pipeline-view";
const view = (n: number): P.PipelineView => ({ ist_date: "2026-10-19", rooms: { room_a: { signals: { pulse: n }, encounters: { candidate: 0, confirmed: n, confirmed_single_proxy: 0, rejected: 0, merged: 0, ambiguous: 0, multi_machine: 0, pulse_overlap: 0, clamped: 0, clamp_failed: 0, covered_by_pulse: 0 }, stages: {}, oldest_queued_age_s: null } } });
beforeEach(() => { P.__resetPipelineMemoForTests(); M.hang.value = false; M.fail.value = false; vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("pipelineOrNull: single-flight, memo boundary, timeout (refute B1/B2/B7)", () => {
  it("single-flight: 6 concurrent callers share one read", async () => {
    let r!: (v: P.PipelineView) => void; const read = vi.fn(() => new Promise<P.PipelineView>((res) => { r = res; }));
    const ps = Array.from({ length: 6 }, () => P.pipelineOrNull("2026-10-19", { read }));
    await Promise.resolve(); await Promise.resolve(); r(view(4));
    const out = await Promise.all(ps);
    expect(read).toHaveBeenCalledTimes(1); expect(out.every((o) => o?.rooms.room_a.signals.pulse === 4)).toBe(true);
  });
  it("concurrent failure: all null, one read, next call reads again", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(view(1));
    const out = await Promise.all([1, 2, 3].map(() => P.pipelineOrNull("2026-10-19", { read })));
    expect(out).toEqual([null, null, null]); expect(read).toHaveBeenCalledTimes(1);
    expect(await P.pipelineOrNull("2026-10-19", { read })).toEqual(view(1));
  });
  it("memo expires after 10 s; dates are memoised separately", async () => {
    const read = vi.fn(async (d: string) => ({ ...view(1), ist_date: d }));
    const t0 = Date.now(); const spy = vi.spyOn(Date, "now").mockReturnValue(t0);
    await P.pipelineOrNull("2026-10-19", { read }); await P.pipelineOrNull("2026-10-20", { read });
    expect(read).toHaveBeenCalledTimes(2);
    spy.mockReturnValue(t0 + 9_999); await P.pipelineOrNull("2026-10-19", { read }); expect(read).toHaveBeenCalledTimes(2);
    spy.mockReturnValue(t0 + 10_000); await P.pipelineOrNull("2026-10-19", { read }); expect(read).toHaveBeenCalledTimes(3);
  });
  it("default timeout is 4 s: 3.9 s resolves, 4.1 s is null", async () => {
    vi.useFakeTimers();
    const slow = (ms: number) => () => new Promise<P.PipelineView>((res) => setTimeout(() => res(view(1)), ms));
    const a = P.pipelineOrNull("2026-10-18", { read: slow(3900) }); await vi.advanceTimersByTimeAsync(3950); expect(await a).toEqual(view(1));
    const b = P.pipelineOrNull("2026-10-17", { read: slow(4100) }); await vi.advanceTimersByTimeAsync(4200); expect(await b).toBeNull();
  });
  it("pre-0173 DB (relation missing) through the real readPipeline: null, never a throw", async () => {
    M.fail.value = true; expect(await P.pipelineOrNull("2026-10-19")).toBeNull();
  });
  it("shapePipeline counts every one of the four statuses, including merged (refute T12)", () => {
    const v = P.shapePipeline("d", { signals: [], encounters: ["candidate", "confirmed", "rejected", "merged"].map((status, i) => ({ room_id: "r", status, n: i + 1, ambiguous: 0 })), jobs: [] }, new Date(0));
    expect(v.rooms.r.encounters).toMatchObject({ candidate: 1, confirmed: 2, rejected: 3, merged: 4 });
  });
  it("shapePipeline: unknown status and NaN counts never throw and never add keys", () => {
    const v = P.shapePipeline("d", { signals: [{ room_id: "r", proxy: "pulse", n: "abc" }], encounters: [{ room_id: "r", status: "weird", n: 3, ambiguous: null }], jobs: [{ room_id: "r", stage: "s", status: "nope", n: 1, oldest_queued: "bad" }] }, new Date(0));
    expect(v.rooms.r).toEqual({ signals: { pulse: 0 }, encounters: { candidate: 0, confirmed: 0, confirmed_single_proxy: 0, rejected: 0, merged: 0, ambiguous: 0, multi_machine: 0, pulse_overlap: 0, clamped: 0, clamp_failed: 0, covered_by_pulse: 0 }, stages: {}, oldest_queued_age_s: null });
  });
});


describe("Rooms Live route: a hung spine read delays the response by at most ~4 s", () => {
  it("admin: every pipeline is null", async () => {
    M.kind.value = "admin"; M.hang.value = true;
    const { GET } = await import("@/app/api/rooms-live/now/route");
    const t = Date.now(); const j = JSON.parse(await (await GET(new Request("https://x/api/rooms-live/now"))).text()); const ms = Date.now() - t;
    expect(ms).toBeLessThan(4600); expect(ms).toBeGreaterThan(3500); expect(j.rooms.every((r: { pipeline: unknown }) => r.pipeline === null)).toBe(true);
  }, 10_000);
  it("staff: no spine read is started at all", async () => {
    M.kind.value = "staff"; M.hang.value = true;
    const { GET } = await import("@/app/api/rooms-live/now/route");
    const t = Date.now(); const j = JSON.parse(await (await GET(new Request("https://x/api/rooms-live/now"))).text()); expect(Date.now() - t).toBeLessThan(1000);
    expect(JSON.stringify(j)).not.toContain("pipeline");
  });
});
