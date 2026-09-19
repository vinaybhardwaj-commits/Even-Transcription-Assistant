/**
 * Night drain — the loop, against a fake clock, a fake queue and fake audio. What each group would catch:
 *   closed hours   a window started outside 21:30–07:30, or in the last four minutes of it
 *   gate           a window started while the watchdog said STOP_ (or on a stale/unreadable line)
 *   resume         a finished window being processed twice after a restart
 *   endings        ANY window that ends without exactly one named terminal state — the silent-swallow shape
 *   abandon        a cut-off window leaving a row, a live lease, or a hard-capped window looping for ever
 *   logs           a credential, a link or free text reaching the progress log
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOW_HARD_CAP_MS, type ClaimedWindow } from "@/lib/night-drain/store";
import { runBatch, runNight, serve, type Deps, type LogRecord, type StageCtx } from "@/lib/night-drain/worker";
import type { AudioFailure, WindowAudio } from "@/lib/night-drain/audio";
import type { FailedCode, Outcome } from "@/lib/night-drain/outcome";

const ist = (date: string, hhmm: string, sec = 0): number => Date.parse(`${date}T${hhmm}:${String(sec).padStart(2, "0")}.000+05:30`);

const okAudio = (seconds = 900): WindowAudio => ({ ok: true, clip: Buffer.alloc(1), seconds, pieces: 4, bytes: 1_000_000, mcp_ms: 900, download_ms: 4000, join_ms: 3000 });
const OK: Outcome = { kind: "recorded", state: "ok", speakers: 3, segments: 40 };

type Script = { audio?: WindowAudio | AudioFailure; diarize?: Outcome; audioCostMs?: number; diarizeCostMs?: number };

function harness(o: { start: number; windows: number; script?: Record<string, Script>; gate?: () => { go: boolean; reason: string }; claimNull?: boolean }) {
  const clock = { t: o.start };
  const ac = new AbortController();
  const windows: ClaimedWindow[] = Array.from({ length: o.windows }, (_, i) => ({
    id: `w${String(i + 1).padStart(2, "0")}`, session_id: "bs_x", room_day_id: "rd", start_ms: i * 900_000, end_ms: (i + 1) * 900_000, source: "primary", is_retry: false,
  }));
  const terminal = new Map<string, string>();
  const leases = new Map<string, { holder: string; parked: boolean }>();
  const calls = { claim: 0, audio: [] as string[], diarize: [] as string[], recordFailed: [] as string[], park: [] as string[], release: [] as string[], startedAt: [] as number[], gates: 0 };
  const logs: LogRecord[] = [];
  const script = o.script ?? {};

  const deps: Deps = {
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    gate: () => { calls.gates += 1; return o.gate ? o.gate() : { go: true, reason: "ok" }; },
    serviceHealth: async () => ({ ok: true, device: "mps" }),
    holder: "test-holder",
    store: {
      claimNext: async (holder) => {
        calls.claim += 1;
        if (o.claimNull) return null;
        const w = windows.find((x) => !terminal.has(x.id) && !leases.has(x.id));
        if (!w) return null;
        leases.set(w.id, { holder, parked: false });
        calls.startedAt.push(clock.t);
        return w;
      },
      release: async (id, holder) => { calls.release.push(id); return leases.get(id)?.holder === holder && leases.delete(id); },
      park: async (id, holder) => { calls.park.push(id); const l = leases.get(id); if (l?.holder !== holder) return false; l.parked = true; return true; },
      remaining: async () => ({ never_handled: windows.filter((w) => !terminal.has(w.id)).length, retry_pending: 0, exhausted: 0, closed_last_24h: 220 }),
      chunksForSession: async () => [],
      peek: async (n) => windows.filter((w) => !terminal.has(w.id)).slice(0, n),
    },
    audio: async (w) => {
      calls.audio.push(w.id);
      clock.t += script[w.id]?.audioCostMs ?? 20_000;
      return script[w.id]?.audio ?? okAudio();
    },
    diarize: async (w, _a, _ctx: StageCtx, mode) => {
      calls.diarize.push(w.id);
      clock.t += script[w.id]?.diarizeCostMs ?? 70_000;
      const out = script[w.id]?.diarize ?? OK;
      if (mode === "run" && out.kind === "recorded") terminal.set(w.id, out.state === "failed" ? `failed:${out.code}` : out.state);
      return { outcome: out, diarize_ms: 70_000 };
    },
    recordFailed: async (w, code: FailedCode) => { calls.recordFailed.push(`${w.id}:${code}`); terminal.set(w.id, `failed:${code}`); return { kind: "recorded", state: "failed", code }; },
    log: (r) => { logs.push(r); },
  };
  /** Stop the run the first time the loop has nothing left to do. */
  const stopWhenDrained = () => { const s = deps.sleep; deps.sleep = async (ms, sig) => { if (windows.every((w) => terminal.has(w.id) || script[w.id]?.diarize?.kind === "deferred")) ac.abort(); await s(ms, sig); }; };
  return { clock, ac, windows, terminal, leases, calls, logs, deps, stopWhenDrained };
}

const winLogs = (logs: LogRecord[]) => logs.filter((l) => l.event === "window");
afterEach(() => { vi.useRealTimers(); });

describe("night drain worker: closed hours", () => {
  it("drains a backlog: one terminal state per window, every lease released, a progress line per window", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 5 });
    h.stopWhenDrained();
    const s = await runNight(h.deps, h.ac.signal);
    expect([...h.terminal.values()]).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(h.calls.audio).toEqual(["w01", "w02", "w03", "w04", "w05"]);
    expect(h.leases.size).toBe(0);
    expect(s).toMatchObject({ started: 5, ok: 5, failed: 0, deferred: 0, abandoned: 0, fatal: null });
    const w = winLogs(h.logs);
    expect(w).toHaveLength(5);
    expect(w[0]).toMatchObject({ event: "window", window_id: "w01", terminal_state: "ok", segments: 40, speakers: 3, mode: "run", audio_s: 900, mcp_ms: 900, download_ms: 4000, join_ms: 3000, diarize_ms: 70_000 });
    expect(w[0]!.wall_s).toBe(90);
    expect(h.logs.find((l) => l.event === "night_start")).toMatchObject({ never_handled: 5, closed_last_24h: 220 });
    expect(h.logs.find((l) => l.event === "night_end")).toMatchObject({ started: 5, ok: 5, never_handled: 0, net_never_handled: 5 });
  });

  it("stops between windows at the end of closed hours, mid-backlog, leaving the rest untouched and unleased", async () => {
    const h = harness({ start: ist("2026-09-19", "07:10"), windows: 30 });
    const s = await runNight(h.deps, h.ac.signal);
    const cutoff = ist("2026-09-19", "07:26");                       // 07:30 minus the four-minute start buffer
    expect(h.calls.startedAt.length).toBeGreaterThan(5);
    expect(Math.max(...h.calls.startedAt)).toBeLessThan(cutoff);
    expect(s.started).toBe(h.calls.startedAt.length);
    expect(s.ok).toBe(s.started);
    expect(h.terminal.size).toBe(s.started);                          // the rest have NO row …
    expect(h.leases.size).toBe(0);                                    // … and no lease
    expect(h.windows.length - h.terminal.size).toBeGreaterThan(0);    // mid-backlog: work was left
    expect(h.clock.t).toBeLessThan(ist("2026-09-19", "07:30"));       // and the last window ended before clinic opened
    expect(h.logs.filter((l) => l.event === "night_end")).toHaveLength(1);
  });

  it("starts nothing in clinic hours", async () => {
    const h = harness({ start: ist("2026-09-18", "12:00"), windows: 3 });
    const sleeps: number[] = [];
    const base = h.deps.sleep;
    h.deps.sleep = async (ms, sig) => { sleeps.push(ms); if (h.clock.t > ist("2026-09-18", "13:00")) h.ac.abort(); await base(ms, sig); };
    await serve(h.deps, h.ac.signal);
    expect(h.calls.claim).toBe(0);
    expect(h.calls.audio).toEqual([]);
    expect(h.calls.gates).toBe(0);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(60_000);          // it wakes at least every minute to re-read the clock
  });

  it("waits for 21:30 and takes its first window at or after it", async () => {
    const h = harness({ start: ist("2026-09-18", "21:00"), windows: 2 });
    const base = h.deps.sleep;
    h.deps.sleep = async (ms, sig) => { if (h.windows.every((w) => h.terminal.has(w.id))) h.ac.abort(); await base(ms, sig); };
    await serve(h.deps, h.ac.signal);
    expect(h.calls.startedAt.length).toBe(2);
    expect(h.calls.startedAt[0]).toBeGreaterThanOrEqual(ist("2026-09-18", "21:30"));
  });

  it("in the last four minutes of closed hours it sleeps quietly: no night is entered, nothing is logged", async () => {
    const h = harness({ start: ist("2026-09-19", "07:27"), windows: 3 });
    const base = h.deps.sleep;
    h.deps.sleep = async (ms, sig) => { if (h.clock.t > ist("2026-09-19", "07:40")) h.ac.abort(); await base(ms, sig); };
    await serve(h.deps, h.ac.signal);
    expect(h.calls.claim).toBe(0);
    expect(h.logs.filter((l) => l.event === "night_start" || l.event === "night_end")).toEqual([]);
  });

  it("logs exactly one night_start and one night_end for a whole night", async () => {
    const h = harness({ start: ist("2026-09-18", "21:00"), windows: 4 });
    const base = h.deps.sleep;
    h.deps.sleep = async (ms, sig) => { if (h.clock.t > ist("2026-09-19", "08:00")) h.ac.abort(); await base(ms, sig); };
    await serve(h.deps, h.ac.signal);
    expect(h.logs.filter((l) => l.event === "night_start")).toHaveLength(1);
    expect(h.logs.filter((l) => l.event === "night_end")).toHaveLength(1);
    expect(h.terminal.size).toBe(4);
  });

  it("does not treat Sunday as closed", async () => {
    const h = harness({ start: ist("2026-09-13", "12:00"), windows: 1 });
    h.deps.sleep = async (ms) => { h.clock.t += ms; if (h.clock.t > ist("2026-09-13", "13:00")) h.ac.abort(); };
    await serve(h.deps, h.ac.signal);
    expect(h.calls.claim).toBe(0);
  });
});

describe("night drain worker: the watchdog gate", () => {
  it("claims nothing while the gate says no, logs the reason once, and goes when it clears", async () => {
    let polls = 0;
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 1, gate: () => (++polls <= 3 ? { go: false, reason: "stop:STOP_sustained_pressure" } : { go: true, reason: "ok" }) });
    h.stopWhenDrained();
    await runNight(h.deps, h.ac.signal);
    expect(h.terminal.get("w01")).toBe("ok");
    expect(h.logs.filter((l) => l.event === "gate_hold")).toEqual([{ event: "gate_hold", reason: "stop:STOP_sustained_pressure" }]);
    expect(h.logs.find((l) => l.event === "gate_go")).toMatchObject({ after: "stop:STOP_sustained_pressure" });
    expect(h.calls.startedAt[0]! - ist("2026-09-18", "22:00")).toBeGreaterThanOrEqual(3 * 20_000);   // it waited out three polls
  });

  it("never starts a window on a no-go line, however long it is held", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 3, gate: () => ({ go: false, reason: "diarize_ms:900" }) });
    const s = await runNight(h.deps, h.ac.signal);                   // holds until 07:26, then the night is over
    expect(h.calls.claim).toBe(0);
    expect(s.started).toBe(0);
    expect(h.logs.filter((l) => l.event === "gate_hold")).toHaveLength(1);
  });

  it("checks the gate before EVERY window, not once per night", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 4 });
    h.stopWhenDrained();
    await runNight(h.deps, h.ac.signal);
    expect(h.calls.gates).toBeGreaterThanOrEqual(4);
  });
});

describe("night drain worker: resume", () => {
  it("a restart picks up where it stopped and never redoes a finished window", async () => {
    const a = harness({ start: ist("2026-09-18", "22:00"), windows: 6 });
    const stopAfterThree = a.deps.diarize;
    a.deps.diarize = async (...args) => { const r = await stopAfterThree(...args); if (a.terminal.size === 3) a.ac.abort(); return r; };
    const first = await runNight(a.deps, a.ac.signal);
    expect(first.ok).toBe(3);
    expect(a.leases.size).toBe(0);

    // A new process: same database (terminal rows and leases), fresh loop state.
    const b = harness({ start: ist("2026-09-19", "00:30"), windows: 6 });
    for (const [k, v] of a.terminal) b.terminal.set(k, v);
    b.stopWhenDrained();
    const second = await runNight(b.deps, b.ac.signal);
    expect(second.ok).toBe(3);
    expect(b.calls.audio).toEqual(["w04", "w05", "w06"]);            // exactly the unfinished ones
    expect([...a.calls.audio, ...b.calls.audio].sort()).toEqual(["w01", "w02", "w03", "w04", "w05", "w06"]);   // each window's audio fetched once, ever
    expect([...b.terminal.keys()].sort()).toEqual(["w01", "w02", "w03", "w04", "w05", "w06"]);
  });

  it("a second copy running at the same time takes different windows, never the same one", async () => {
    const shared = harness({ start: ist("2026-09-18", "22:00"), windows: 6 });
    const other = harness({ start: ist("2026-09-18", "22:00"), windows: 6 });
    // Both loops share one queue (terminal rows + leases) and one set of windows; their claims interleave.
    other.deps.store = shared.deps.store;
    other.deps.diarize = shared.deps.diarize;
    other.deps.audio = shared.deps.audio;
    other.deps.holder = "other-holder";
    shared.stopWhenDrained();
    other.deps.sleep = shared.deps.sleep;
    other.ac.signal.addEventListener("abort", () => undefined);
    await Promise.all([runNight(shared.deps, shared.ac.signal), runNight({ ...other.deps, holder: "other-holder" }, shared.ac.signal)]);
    expect([...shared.calls.audio].sort()).toEqual(["w01", "w02", "w03", "w04", "w05", "w06"]);   // no window fetched twice
  });

  it("when another copy wins the race, it idles and looks again — it does not process anything", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 2, claimNull: true });
    let idles = 0;
    const base = h.deps.sleep;
    h.deps.sleep = async (ms, sig) => { if (++idles > 6) h.ac.abort(); await base(ms, sig); };
    await runNight(h.deps, h.ac.signal);
    expect(h.calls.audio).toEqual([]);
    expect(h.logs.filter((l) => l.event === "queue_idle")).toHaveLength(1);
  });
});

describe("night drain worker: every window ends in a named state", () => {
  const audioFail = (code: FailedCode): AudioFailure => ({ ok: false, kind: "failed", code });
  const recordedFail = (code: FailedCode): Outcome => ({ kind: "recorded", state: "failed", code });

  const recordedCases: Array<[string, Script, string]> = [
    ["no tape over the window", { audio: audioFail("no_covering_chunks") }, "failed:no_covering_chunks"],
    ["the door has no such chunk", { audio: audioFail("chunk_not_found") }, "failed:chunk_not_found"],
    ["the door gave no link", { audio: audioFail("chunk_link_missing") }, "failed:chunk_link_missing"],
    ["R2 no longer has the chunk", { audio: audioFail("chunk_gone") }, "failed:chunk_gone"],
    ["corrupt audio", { audio: audioFail("audio_corrupt") }, "failed:audio_corrupt"],
    ["under a second of audio", { audio: audioFail("audio_empty") }, "failed:audio_empty"],
    ["the service timed out", { diarize: recordedFail("diarize_timeout") }, "failed:diarize_timeout"],
    ["the service died mid-call (out of memory / killed)", { diarize: recordedFail("diarize_network") }, "failed:diarize_network"],
    ["the service refused the audio", { diarize: recordedFail("diarize_http_4xx") }, "failed:diarize_http_4xx"],
    ["the service failed on the audio", { diarize: recordedFail("diarize_http_5xx") }, "failed:diarize_http_5xx"],
    ["zero speakers found", { diarize: { kind: "recorded", state: "no_speakers", speakers: 0, segments: 0 } }, "no_speakers"],
    ["ok", { diarize: OK }, "ok"],
  ];
  it.each(recordedCases)("%s → a recorded, terminal row", async (_n, script, want) => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 1, script: { w01: script } });
    h.stopWhenDrained();
    const s = await runNight(h.deps, h.ac.signal);
    expect(h.terminal.get("w01")).toBe(want);
    expect(winLogs(h.logs)).toHaveLength(1);
    expect(winLogs(h.logs)[0]!.terminal_state).toBe(want);
    expect(h.leases.size).toBe(0);
    expect(h.calls.park).toEqual([]);
    expect(s.started).toBe(1);
  });

  it("an audio-stage failure never reaches the diarize service", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 1, script: { w01: { audio: audioFail("chunk_gone") } } });
    h.stopWhenDrained();
    await runNight(h.deps, h.ac.signal);
    expect(h.calls.diarize).toEqual([]);
    expect(h.calls.recordFailed).toEqual(["w01:chunk_gone"]);
  });

  const deferredCases: Array<[string, Script, string]> = [
    ["the door is unreachable", { audio: { ok: false, kind: "deferred", code: "mcp_unreachable" } }, "deferred:mcp_unreachable"],
    ["the door answered badly", { audio: { ok: false, kind: "deferred", code: "mcp_http_error" } }, "deferred:mcp_http_error"],
    ["a chunk download failed", { audio: { ok: false, kind: "deferred", code: "chunk_download_failed" } }, "deferred:chunk_download_failed"],
    ["no diarize slot (a live encounter has it)", { diarize: { kind: "deferred", code: "diarize_busy" } }, "deferred:diarize_busy"],
    ["the terminal row could not be written", { diarize: { kind: "deferred", code: "record_write_failed" } }, "deferred:record_write_failed"],
  ];
  it.each(deferredCases)("%s → no row, the window is PARKED, and it is logged", async (_n, script, want) => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 2, script: { w01: script } });
    h.stopWhenDrained();
    const s = await runNight(h.deps, h.ac.signal);
    expect(h.terminal.has("w01")).toBe(false);                        // no row: it stays eligible
    expect(h.calls.park).toEqual(["w01"]);                            // parked, not handed straight back …
    expect(h.calls.release).not.toContain("w01");
    expect(h.calls.audio.filter((x) => x === "w01")).toHaveLength(1); // … so it is not retried in the same pass
    expect(h.terminal.get("w02")).toBe("ok");                         // and the queue moved on
    expect(winLogs(h.logs).find((l) => l.window_id === "w01")!.terminal_state).toBe(want);
    expect(s.deferred).toBe(1);
  });

  it("a refused credential is FATAL: it writes nothing, stops the worker, and does not fail the rest of the backlog", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 5, script: { w01: { audio: { ok: false, kind: "fatal", code: "mcp_auth_refused" } } } });
    const s = await runNight(h.deps, h.ac.signal);
    expect(s.fatal).toBe("mcp_auth_refused");
    expect(h.terminal.size).toBe(0);
    expect(h.calls.audio).toEqual(["w01"]);
    expect(h.leases.size).toBe(0);
    expect(h.logs.find((l) => l.event === "fatal")).toEqual({ event: "fatal", code: "mcp_auth_refused" });
    expect((await serve(harness({ start: ist("2026-09-18", "22:00"), windows: 5, script: { w01: { audio: { ok: false, kind: "fatal", code: "mcp_auth_refused" } } } }).deps, new AbortController().signal)).fatal).toBe("mcp_auth_refused");
  });

  it("five deferrals in a row open a circuit and pause the drain", async () => {
    const script: Record<string, Script> = {};
    for (let i = 1; i <= 8; i++) script[`w0${i}`] = { audio: { ok: false, kind: "deferred", code: "mcp_unreachable" } };
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 8, script });
    h.stopWhenDrained();
    await runNight(h.deps, h.ac.signal);
    expect(h.logs.find((l) => l.event === "circuit_open")).toMatchObject({ consecutive_deferred: 5, pause_s: 300 });
  });

  it("a read that throws is deferred, not swallowed and not fatal", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 1 });
    h.deps.store.chunksForSession = async () => { throw new Error("connection terminated"); };
    let rounds = 0;
    const base = h.deps.sleep;
    h.deps.sleep = async (ms, sig) => { if (++rounds > 2) h.ac.abort(); await base(ms, sig); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runNight(h.deps, h.ac.signal);
    warn.mockRestore();
    expect(winLogs(h.logs)[0]!.terminal_state).toBe("deferred:db_error");
    expect(h.terminal.size).toBe(0);
  });

  it("a claim that throws is logged and retried, and starts nothing", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 1 });
    h.deps.store.claimNext = async () => { throw new Error("boom"); };
    let rounds = 0;
    const base = h.deps.sleep;
    h.deps.sleep = async (ms, sig) => { if (++rounds > 2) h.ac.abort(); await base(ms, sig); };
    await runNight(h.deps, h.ac.signal);
    expect(h.logs.filter((l) => l.event === "claim_failed").length).toBeGreaterThanOrEqual(2);
    expect(winLogs(h.logs)).toHaveLength(0);
  });

  it("does not start while the diarize service is down", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 1 });
    h.deps.serviceHealth = async () => ({ ok: false, device: null });
    let rounds = 0;
    const base = h.deps.sleep;
    h.deps.sleep = async (ms, sig) => { if (++rounds > 3) h.ac.abort(); await base(ms, sig); };
    await runNight(h.deps, h.ac.signal);
    expect(h.calls.claim).toBe(0);
    expect(h.logs.some((l) => l.event === "service_down")).toBe(true);
  });

  it("gives the remaining count at the start, every 25 windows, and at the end of the night", async () => {
    const h = harness({ start: ist("2026-09-18", "21:30"), windows: 60, script: {} });
    for (const w of h.windows) (h.deps as { audio: unknown }).audio = async (x: ClaimedWindow) => { h.calls.audio.push(x.id); h.clock.t += 5_000; return okAudio(); };
    h.deps.diarize = async (w, _a, _c, mode) => { h.clock.t += 10_000; if (mode === "run") h.terminal.set(w.id, "ok"); return { outcome: OK, diarize_ms: 10_000 }; };
    h.stopWhenDrained();
    await runNight(h.deps, h.ac.signal);
    expect(h.logs.filter((l) => l.event === "remaining").map((l) => l.processed)).toEqual([25, 50]);
    expect(h.logs.find((l) => l.event === "night_start")).toHaveProperty("never_handled", 60);
    expect(h.logs.find((l) => l.event === "night_end")).toMatchObject({ never_handled: 0, started: 60 });
  });
});

describe("night drain worker: cutting a window off", () => {
  /** Audio that never finishes by itself; it resolves as abandoned when the worker aborts it. */
  const hang = (h: ReturnType<typeof harness>) => {
    h.deps.audio = async (w, _c, sig) => {
      h.calls.audio.push(w.id);
      return new Promise<AudioFailure>((res) => { sig.addEventListener("abort", () => res({ ok: false, kind: "abandoned" }), { once: true }); });
    };
  };

  it("the hard cap (480 s) is a RECORDED failure, so a window that eats its whole cap cannot loop for ever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(ist("2026-09-18", "22:00"));
    const h = harness({ start: 0, windows: 1 });
    h.deps.now = () => Date.now();
    h.deps.sleep = async () => { h.ac.abort(); };
    hang(h);
    const run = runNight(h.deps, h.ac.signal);
    await vi.advanceTimersByTimeAsync(WINDOW_HARD_CAP_MS + 1);
    await run;
    expect(WINDOW_HARD_CAP_MS).toBe(480_000);
    expect(h.calls.recordFailed).toEqual(["w01:hard_cap"]);
    expect(h.terminal.get("w01")).toBe("failed:hard_cap");
    expect(h.leases.size).toBe(0);
  });

  it("a window in flight when closed hours end is abandoned two minutes after 07:30: NO row, lease released", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(ist("2026-09-19", "07:25", 30));                // allowed: more than four minutes before 07:30
    const h = harness({ start: 0, windows: 2 });
    h.deps.now = () => Date.now();
    h.deps.sleep = async () => undefined;
    hang(h);
    const run = runNight(h.deps, h.ac.signal);
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 29_000);          // 07:31:59 — not yet
    expect(h.leases.size).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);                        // 07:32:01 — abandoned
    const s = await run;
    expect(s.abandoned).toBe(1);
    expect(h.terminal.size).toBe(0);                                 // nothing half-written: no row at all
    expect(h.calls.recordFailed).toEqual([]);
    expect(h.leases.size).toBe(0);
    expect(winLogs(h.logs)[0]!.terminal_state).toBe("abandoned:closed_hours_ended");
    expect(h.calls.audio).toEqual(["w01"]);                          // and it did not start the second window
  });

  it("a stop signal mid-window abandons it as `stopped`: no row, lease released", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 2 });
    hang(h);
    const run = runNight(h.deps, h.ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.leases.size).toBe(1);
    h.ac.abort();
    const s = await run;
    expect(s.abandoned).toBe(1);
    expect(h.terminal.size).toBe(0);
    expect(h.leases.size).toBe(0);
    expect(winLogs(h.logs)[0]!.terminal_state).toBe("abandoned:stopped");
  });

  it("a diarize call cut off by the cap is recorded as hard_cap, not misfiled as a stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(ist("2026-09-18", "22:00"));
    const h = harness({ start: 0, windows: 1 });
    h.deps.now = () => Date.now();
    h.deps.sleep = async () => { h.ac.abort(); };
    h.deps.diarize = async (_w, _a, ctx) => new Promise((res) => { ctx.signal.addEventListener("abort", () => res({ outcome: { kind: "abandoned", code: "stopped" }, diarize_ms: null }), { once: true }); });
    const run = runNight(h.deps, h.ac.signal);
    await vi.advanceTimersByTimeAsync(WINDOW_HARD_CAP_MS + 1);
    await run;
    expect(h.terminal.get("w01")).toBe("failed:hard_cap");
  });
});

describe("night drain worker: the measuring modes", () => {
  it("audio-only fetches and joins, at any hour, and takes no lease, makes no diarize call and writes nothing", async () => {
    const h = harness({ start: ist("2026-09-18", "12:00"), windows: 4 });
    const s = await runBatch(h.deps, "audio-only", 3, h.ac.signal);
    expect(h.calls.audio).toEqual(["w01", "w02", "w03"]);
    expect(h.calls.claim).toBe(0);
    expect(h.calls.diarize).toEqual([]);
    expect(h.calls.recordFailed).toEqual([]);
    expect(h.calls.park.concat(h.calls.release)).toEqual([]);
    expect(h.terminal.size).toBe(0);
    expect(s.started).toBe(3);
    expect(winLogs(h.logs).map((l) => l.terminal_state)).toEqual(["audio_only_ok", "audio_only_ok", "audio_only_ok"]);
  });

  it("dry-run diarizes but refuses outside closed hours, and never writes a row even inside them", async () => {
    const day = harness({ start: ist("2026-09-18", "12:00"), windows: 2 });
    await runBatch(day.deps, "dry-run", 2, day.ac.signal);
    expect(day.calls.audio).toEqual([]);
    expect(day.logs.find((l) => l.event === "batch_stopped")).toMatchObject({ reason: "not_closed_hours" });

    const night = harness({ start: ist("2026-09-18", "22:00"), windows: 2 });
    await runBatch(night.deps, "dry-run", 2, night.ac.signal);
    expect(night.calls.diarize).toEqual(["w01", "w02"]);
    expect(night.terminal.size).toBe(0);
    expect(night.calls.claim).toBe(0);
    expect(winLogs(night.logs).map((l) => l.terminal_state)).toEqual(["dry-run:ok", "dry-run:ok"]);
  });

  it("a refused credential stops a batch at the first window instead of trying all of them", async () => {
    const script: Record<string, Script> = {};
    for (let i = 1; i <= 5; i++) script[`w0${i}`] = { audio: { ok: false, kind: "fatal", code: "mcp_auth_refused" } };
    const h = harness({ start: ist("2026-09-18", "12:00"), windows: 5, script });
    const s = await runBatch(h.deps, "audio-only", 5, h.ac.signal);
    expect(s.fatal).toBe("mcp_auth_refused");
    expect(h.calls.audio).toEqual(["w01"]);
    expect(h.logs.find((l) => l.event === "fatal")).toEqual({ event: "fatal", code: "mcp_auth_refused" });
  });

  it("dry-run stops when the gate says no", async () => {
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 2, gate: () => ({ go: false, reason: "stop:STOP_heavy_swap_now" }) });
    await runBatch(h.deps, "dry-run", 2, h.ac.signal);
    expect(h.calls.audio).toEqual([]);
    expect(h.logs.find((l) => l.event === "batch_stopped")).toMatchObject({ reason: "stop:STOP_heavy_swap_now" });
  });
});

describe("night drain worker: the progress log carries counts, ids and timings only", () => {
  it("has no credential, link or free text in any line, and every value is a primitive", async () => {
    const script: Record<string, Script> = {
      w01: { audio: { ok: false, kind: "failed", code: "chunk_gone" } },
      w02: { audio: { ok: false, kind: "deferred", code: "mcp_unreachable" } },
      w03: { audio: { ok: false, kind: "fatal", code: "mcp_auth_refused" } },
    };
    const h = harness({ start: ist("2026-09-18", "22:00"), windows: 4, script });
    await runNight(h.deps, h.ac.signal);
    const text = JSON.stringify(h.logs);
    for (const bad of ["postgres://", "Bearer", "X-Amz", "presigned", "tok-", "https://", "Authorization"]) expect(text, bad).not.toContain(bad);
    for (const rec of h.logs) for (const v of Object.values(rec)) expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
    for (const rec of winLogs(h.logs)) expect(Object.keys(rec).sort()).toEqual(["audio_s", "diarize_ms", "download_ms", "event", "join_ms", "mcp_ms", "mode", "retry", "segments", "speakers", "terminal_state", "wall_s", "window_id"]);
  });
});
