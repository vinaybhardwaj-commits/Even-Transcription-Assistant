/**
 * lib/steward/timeout.ts + sense.ts safeRead — F3: every sense source read has a timeout (default 6 s, steward_config source_timeout_ms) and nothing new starts after the
 * deadline. A timeout / skip names the source in `degraded` and the fallback stands in; the tick continues. Pure timers, no database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SourceTimeout, raceTimeout } from "@/lib/steward/timeout";
import { khSleepMarker, safeRead } from "@/lib/steward/sense";
import type { KioskHealthSnapshot } from "@/lib/kiosk-health-read";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("raceTimeout", () => {
  it("resolves with the value and leaves no timer behind; rejects with SourceTimeout when the call is slower; swallows a late rejection of the abandoned call", async () => {
    vi.useFakeTimers();
    expect(await raceTimeout(async () => 7, 1000)).toBe(7);
    expect(vi.getTimerCount()).toBe(0);

    let rejectLate: (e: Error) => void = () => {};
    const slow = raceTimeout(() => new Promise<number>((_, rej) => (rejectLate = rej)), 1000);
    const caught = slow.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await caught).toBeInstanceOf(SourceTimeout);
    expect(vi.getTimerCount()).toBe(0);
    rejectLate(new Error("late")); // must not become an unhandled rejection
    await vi.advanceTimersByTimeAsync(1);
  });
});

describe("safeRead", () => {
  it("ok: the value, nothing degraded", async () => {
    const d: string[] = [];
    expect(await safeRead({}, "src", d, async () => 5, 0)).toEqual({ v: 5, ok: true });
    expect(d).toEqual([]);
  });

  it("a source that throws is named; its fallback is returned", async () => {
    const d: string[] = [];
    const r = await safeRead({}, "bench_chunk", d, async () => { throw new Error("boom"); }, [] as number[]);
    expect(r).toEqual({ v: [], ok: false });
    expect(d).toEqual(["bench_chunk"]);
  });

  it("a source slower than sourceTimeoutMs is cut: '<source>:timeout' is degraded, the fallback is returned, the others are unaffected", async () => {
    vi.useFakeTimers();
    const d: string[] = [];
    const slow = safeRead({ sourceTimeoutMs: 6000 }, "presence_poller", d, () => new Promise<number>(() => {}), -1);
    const fast = safeRead({ sourceTimeoutMs: 6000 }, "bench_listener", d, async () => 2, -1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await slow).toEqual({ v: -1, ok: false });
    expect(await fast).toEqual({ v: 2, ok: true });
    expect(d).toEqual(["presence_poller:timeout"]);
  });

  it("the default timeout is 6 s: a 5.9 s source is kept, a 6.1 s one is cut", async () => {
    vi.useFakeTimers();
    const d: string[] = [];
    const mk = (ms: number) => () => new Promise<string>((res) => setTimeout(() => res("done"), ms));
    const a = safeRead({}, "a", d, mk(5900), "fb");
    const b = safeRead({}, "b", d, mk(6100), "fb");
    await vi.advanceTimersByTimeAsync(6200);
    expect((await a).v).toBe("done");
    expect((await b).v).toBe("fb");
    expect(d).toEqual(["b:timeout"]);
  });

  it("past the deadline nothing is started: '<source>:skipped', the function is never called; before it, the timeout is clamped to the time left", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const lim = { sourceTimeoutMs: 6000, deadlineMs: 17_000, now: () => clock };
    const d: string[] = [];
    clock = 17_000;
    const fn = vi.fn(async () => 1);
    expect(await safeRead(lim, "late_source", d, fn, 0)).toEqual({ v: 0, ok: false });
    expect(fn).not.toHaveBeenCalled();
    expect(d).toEqual(["late_source:skipped"]);

    clock = 15_500; // 1.5 s left: a source that would take 4 s is cut at 1.5 s, not 6 s
    const p = safeRead(lim, "tail", d, () => new Promise<number>(() => {}), 0);
    await vi.advanceTimersByTimeAsync(1499);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toEqual({ v: 0, ok: false });
    expect(d).toContain("tail:timeout");
  });
});

describe("khSleepMarker (bench rule R11 derivation)", () => {
  const A = Date.parse("2026-10-06T02:01:00Z"); // 07:31 IST
  const iso = (msAgo: number) => new Date(A - msAgo).toISOString();
  const H = 3_600_000;
  const snap = (over: Partial<KioskHealthSnapshot>): KioskHealthSnapshot =>
    ({ machine: "m", enrolled: true, power_events: [], last_display_state: null, last_heartbeat_received_at: null, ...over }) as unknown as KioskHealthSnapshot;
  const pe = (kind: string, msAgo: number) => ({ kind, ts: iso(msAgo), received_at: iso(msAgo), reason: null, kAESleep: null });

  it("a sleep 8 h ago with no heartbeat after sleep + 180 s is a marker; a later wake, a later heartbeat, an age > 12 h, or no enrolment is not", () => {
    expect(khSleepMarker(snap({ power_events: [pe("power.sleep", 8 * H)], last_heartbeat_received_at: iso(8 * H + 60_000) }), A)).toBe(iso(8 * H));
    expect(khSleepMarker(snap({ power_events: [pe("power.darkwake", 8 * H)] }), A)).toBe(iso(8 * H));
    expect(khSleepMarker(snap({ power_events: [pe("power.sleep", 8 * H), pe("power.wake", 7 * H)] }), A)).toBeNull();
    expect(khSleepMarker(snap({ power_events: [pe("power.sleep", 8 * H)], last_heartbeat_received_at: iso(2 * H) }), A)).toBeNull();
    expect(khSleepMarker(snap({ power_events: [pe("power.sleep", 13 * H)] }), A)).toBeNull();
    expect(khSleepMarker(snap({ enrolled: false, power_events: [pe("power.sleep", 8 * H)] }), A)).toBeNull();
    expect(khSleepMarker(undefined, A)).toBeNull();
  });

  it("a display.state 'asleep' newer than the newest power event counts; an older one does not", () => {
    const ds = (msAgo: number) => ({ ts: iso(msAgo), received_at: iso(msAgo), state: "asleep", origin: null });
    expect(khSleepMarker(snap({ last_display_state: ds(6 * H) }), A)).toBe(iso(6 * H));
    expect(khSleepMarker(snap({ power_events: [pe("power.wake", 5 * H)], last_display_state: ds(6 * H) }), A)).toBeNull();
  });
});
