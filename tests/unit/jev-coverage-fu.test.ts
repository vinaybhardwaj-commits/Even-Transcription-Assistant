/** JEV-COVERAGE JB3-FU: single-flight + 10 s memo, projection, and the client coverage line. Synthetic counts only. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Coverage } from "@/lib/jev/worker/coverage";

vi.mock("@/lib/db", () => ({ sql: (() => Promise.resolve([])) as unknown }));
import { coverageOrNull, __resetCoverageMemoForTests } from "@/lib/jev/worker/coverage-view";
import { coverageLineText } from "@/components/rooms-live/RoomsLiveClient";

(globalThis as { React?: unknown }).React = React;

const COV: Coverage = { ist_date: "2026-10-15", cut: 12, transcribed: 9, jev_done: { "pitch-detect": 7, "chair-affect": 6 }, no_state: { "pitch-detect": 1, "chair-affect": 0 }, clef_done: 5 };

beforeEach(() => {
  vi.useFakeTimers();
  __resetCoverageMemoForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("single-flight and memo", () => {
  it("5 concurrent calls make 1 read", async () => {
    const read = vi.fn(async () => COV);
    const r = await Promise.all([1, 2, 3, 4, 5].map(() => coverageOrNull({ read })));
    expect(read).toHaveBeenCalledTimes(1);
    r.forEach((x) => expect(x).toEqual(COV));
  });
  it("a second call within 10 s makes 0 reads; after 10 s, 1", async () => {
    const read = vi.fn(async () => COV);
    await coverageOrNull({ read });
    vi.advanceTimersByTime(9_999);
    await coverageOrNull({ read });
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await coverageOrNull({ read });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("a failure is not memoised, and the retry is still single-flight", async () => {
    const read = vi.fn<() => Promise<Coverage>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(COV);
    expect(await coverageOrNull({ read })).toBeNull();
    const r = await Promise.all([coverageOrNull({ read }), coverageOrNull({ read }), coverageOrNull({ read })]);
    expect(read).toHaveBeenCalledTimes(2);
    r.forEach((x) => expect(x).toEqual(COV));
  });
  it("a caller times out at its own timeoutMs while the shared read continues, and the result is then memoised", async () => {
    let resolve!: (c: Coverage) => void;
    const read = vi.fn(() => new Promise<Coverage>((r) => { resolve = r; }));
    const slow = coverageOrNull({ read, timeoutMs: 100 });
    const patient = coverageOrNull({ read, timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(101);
    expect(await slow).toBeNull();
    resolve(COV);
    expect(await patient).toEqual(COV);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await coverageOrNull({ read })).toEqual(COV);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("FIX1: abandoned read and reset generation", () => {
  it("a never-settling read is abandoned after 10 s: the next poll makes a 2nd read and succeeds, still single-flight", async () => {
    const read = vi.fn<() => Promise<Coverage>>().mockImplementationOnce(() => new Promise<Coverage>(() => {})).mockResolvedValue(COV);
    const first = coverageOrNull({ read, timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await first).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    const early = coverageOrNull({ read, timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await early).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    const r = await Promise.all([coverageOrNull({ read }), coverageOrNull({ read }), coverageOrNull({ read })]);
    expect(read).toHaveBeenCalledTimes(2);
    r.forEach((x) => expect(x).toEqual(COV));
  });
  it("a read orphaned before a reset never writes the memo", async () => {
    let resolve!: (c: Coverage) => void;
    const old = vi.fn(() => new Promise<Coverage>((r) => { resolve = r; }));
    const p = coverageOrNull({ read: old, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    expect(await p).toBeNull();
    __resetCoverageMemoForTests();
    resolve({ ...COV, cut: 99 });
    await vi.advanceTimersByTimeAsync(0);
    const fresh = vi.fn(async () => COV);
    expect(await coverageOrNull({ read: fresh })).toEqual(COV);
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});

describe("projection", () => {
  it("drops an extra top-level key and an extra nested key", async () => {
    const dirty = { ...COV, secret: "x", jev_done: { ...COV.jev_done, extra: 3 }, no_state: { ...COV.no_state, other: 4 } } as unknown as Coverage;
    const r = await coverageOrNull({ read: async () => dirty });
    expect(r).toEqual(COV);
    expect(Object.keys(r!).sort()).toEqual(["clef_done", "cut", "ist_date", "jev_done", "no_state", "transcribed"]);
    expect(Object.keys(r!.jev_done).sort()).toEqual(["chair-affect", "pitch-detect"]);
    expect(Object.keys(r!.no_state).sort()).toEqual(["chair-affect", "pitch-detect"]);
  });
});

describe("coverage line render", () => {
  const line = (cov: unknown) => renderToStaticMarkup(React.createElement("p", { "data-testid": "coverage-line" }, coverageLineText(cov)));
  it("valid coverage", () => {
    expect(line(COV)).toContain("Today: cut 12 · transcribed 9 · Jev pitch 7 / affect 6 · Clef 5 · no state 1");
  });
  it("null and absent coverage", () => {
    expect(line(null)).toContain("Coverage unavailable");
    expect(line(undefined)).toContain("Coverage unavailable");
  });
  it("malformed coverage (jev_done missing) renders 0s and does not throw", () => {
    const bad = { ist_date: "2026-10-15", cut: 3, transcribed: 2, clef_done: 1 };
    expect(() => line(bad)).not.toThrow();
    expect(line(bad)).toContain("Today: cut 3 · transcribed 2 · Jev pitch 0 / affect 0 · Clef 1");
    expect(line({})).toContain("Today: cut 0 · transcribed 0 · Jev pitch 0 / affect 0 · Clef 0");
  });
});
