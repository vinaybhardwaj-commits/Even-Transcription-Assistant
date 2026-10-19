/** Spine S4: pipelineOrNull (timeout, throw, memo, shape) and the merge into the Rooms Live payload. Synthetic ids only. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ kind: { value: "admin" as string }, pipeline: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: (() => Promise.resolve([])) as unknown }));
vi.mock("@/lib/rooms-live/guard", () => ({ roomsLiveGuard: async () => ({ ok: true, kind: M.kind.value }) }));
vi.mock("@/lib/rooms-live/claims", () => ({ realClaimsPort: () => ({}) }));
vi.mock("@/lib/rooms-live/snapshot", () => ({ getSnapshot: async () => ({ generated_at: "x", degraded: [], rooms: [{ room_id: "room_a" }, { room_id: "room_b" }] }) }));
vi.mock("@/lib/micguard-read", () => ({ readMicGuard: async () => ({ byRoom: { room_a: "ok" } }) }));
vi.mock("@/lib/jev/worker/coverage-view", () => ({ coverageOrNull: async () => null }));
vi.mock("@/lib/spine/pipeline-view", async (orig) => ({ ...(await orig<typeof import("@/lib/spine/pipeline-view")>()), pipelineOrNull: M.pipeline }));

import { __resetPipelineMemoForTests, PIPELINE_MEMO_MS, shapePipeline, type PipelineView } from "@/lib/spine/pipeline-view";

const actual = await vi.importActual<typeof import("@/lib/spine/pipeline-view")>("@/lib/spine/pipeline-view");
const view = (n: number): PipelineView => ({ ist_date: "2026-10-19", rooms: { room_a: { signals: { pulse: n }, encounters: { candidate: 0, confirmed: n, rejected: 0, merged: 0, ambiguous: 0 }, stages: {}, oldest_queued_age_s: null } } });

beforeEach(() => {
  __resetPipelineMemoForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pipelineOrNull", () => {
  it("returns the view on success and memoises it for 10 s", async () => {
    const read = vi.fn(async () => view(3));
    expect(await actual.pipelineOrNull("2026-10-19", { read })).toEqual(view(3));
    expect(await actual.pipelineOrNull("2026-10-19", { read })).toEqual(view(3));
    expect(read).toHaveBeenCalledTimes(1);
    expect(PIPELINE_MEMO_MS).toBe(10_000);
  });

  it("a throw gives null, logs one closed-class line without the error text, and is not memoised", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("postgres://secret")).mockResolvedValue(view(1));
    expect(await actual.pipelineOrNull("2026-10-19", { read })).toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(String((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])).toBe("[spine-pipeline] read failed error");
    expect(await actual.pipelineOrNull("2026-10-19", { read })).toEqual(view(1));
  });

  it("a synchronous throw gives null", async () => {
    expect(await actual.pipelineOrNull("2026-10-19", { read: () => { throw new Error("x"); } })).toBeNull();
  });

  it("a read slower than the timeout gives null", async () => {
    const read = () => new Promise<PipelineView>(() => {});
    expect(await actual.pipelineOrNull("2026-10-19", { read, timeoutMs: 20 })).toBeNull();
    expect((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toBe("[spine-pipeline] read failed timeout");
  });

  it("rebuilds the result key by key: no field beyond counts reaches the caller", async () => {
    const dirty = { ist_date: "2026-10-19", rooms: { room_a: { signals: { pulse: 2 }, encounters: { candidate: 1, confirmed: 0, rejected: 0, merged: 0, ambiguous: 1, name: "x" }, stages: { recut: { done: 1, queued: 0, failed: 0, dead: 0, text: "y" } }, oldest_queued_age_s: 5, note: "z" } } };
    const out = await actual.pipelineOrNull("2026-10-19", { read: async () => dirty as never });
    const r = out!.rooms.room_a;
    expect(Object.keys(r).sort()).toEqual(["encounters", "oldest_queued_age_s", "signals", "stages"]);
    expect(Object.keys(r.encounters).sort()).toEqual(["ambiguous", "candidate", "confirmed", "merged", "rejected"]);
    expect(Object.keys(r.stages.recut).sort()).toEqual(["dead", "done", "failed", "queued"]);
  });
});

describe("shapePipeline", () => {
  const now = new Date("2026-10-19T10:00:00.000Z");
  it("counts signals, encounters (ambiguous shown), stages and the oldest queued age; superseded and shadow are ignored", () => {
    const v = shapePipeline("2026-10-19", {
      signals: [{ room_id: "room_a", proxy: "pulse", n: 2 }, { room_id: "room_a", proxy: "acoustic", n: "3" }, { room_id: null, proxy: "caa", n: 1 }],
      encounters: [{ room_id: "room_a", status: "confirmed", n: 2, ambiguous: 1 }, { room_id: "room_a", status: "candidate", n: 1, ambiguous: 0 }],
      jobs: [
        { room_id: "room_a", stage: "recut", status: "queued", n: 2, oldest_queued: "2026-10-19T09:50:00.000Z" },
        { room_id: "room_a", stage: "recut", status: "leased", n: 1, oldest_queued: "2026-10-19T09:00:00.000Z" },
        { room_id: "room_a", stage: "recut", status: "done", n: 4, oldest_queued: null },
        { room_id: "room_a", stage: "recut", status: "shadow", n: 9, oldest_queued: null },
      ],
    }, now);
    expect(v.rooms.room_a.signals).toEqual({ pulse: 2, acoustic: 3 });
    expect(v.rooms.room_a.encounters).toEqual({ candidate: 1, confirmed: 2, rejected: 0, merged: 0, ambiguous: 1 });
    expect(v.rooms.room_a.stages.recut).toEqual({ done: 4, queued: 3, failed: 0, dead: 0 });
    expect(v.rooms.room_a.oldest_queued_age_s).toBe(3600);
    expect(v.rooms._none.signals).toEqual({ caa: 1 });
  });
  it("no rows gives no rooms", () => expect(shapePipeline("2026-10-19", { signals: [], encounters: [], jobs: [] }, now).rooms).toEqual({}));
});

describe("Rooms Live payload", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/rooms-live/now/route");
    return (await (await GET(new Request("https://x/api/rooms-live/now"))).json()) as { rooms: Array<Record<string, unknown>> };
  };
  it("admin: merged per room beside mic_guard; a room without a view gets null", async () => {
    M.kind.value = "admin";
    M.pipeline.mockResolvedValue(view(2));
    const j = await call();
    expect(j.rooms[0]).toEqual({ room_id: "room_a", mic_guard: "ok", pipeline: view(2).rooms.room_a });
    expect(j.rooms[1]).toEqual({ room_id: "room_b", mic_guard: null, pipeline: null });
  });
  it("admin: a null view leaves every room at null, no 500", async () => {
    M.kind.value = "admin";
    M.pipeline.mockResolvedValue(null);
    expect((await call()).rooms.every((r) => r.pipeline === null)).toBe(true);
  });
  it("non-admin: no pipeline field at all, and no read started", async () => {
    M.kind.value = "staff";
    M.pipeline.mockClear();
    const j = await call();
    expect(j.rooms[0]).toEqual({ room_id: "room_a" });
    expect(M.pipeline).not.toHaveBeenCalled();
  });
});
