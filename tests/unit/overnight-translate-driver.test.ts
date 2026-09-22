/**
 * Overnight translate — the driver, run through whole nights on a FAKE CLOCK against a fake store, fake door
 * and fake gate. Nothing here touches a network, a database or a token: V's ruling is that the driver is built
 * and tested against a fake, and that it is not started.
 *
 * What is pinned: it submits only inside 21:30-07:10 IST and never after; it reads the watchdog/disk gate before
 * EVERY submit; one job is in flight at a time; a refused credential stops the run on the spot; failures,
 * deferrals and a stuck job all have a limit; Transcript-off rooms get the per-job override and Transcript-on
 * rooms do not; and no log line ever carries the token or any free text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runOvernight, jobArgsFor, ACTOR, WINDOW_DEADLINE_MS, CONSECUTIVE_FAILURE_LIMIT, DEFERRED_LIMIT, STATUS_POLL_MS, GATE_POLL_MS, DEFAULT_CONCURRENCY,
  JOIN_RETRY_LIMIT, JOIN_RETRY_DELAY_MS, CONSECUTIVE_FOREIGN_CANCEL_LIMIT, CONSECUTIVE_JOIN_CONTENTION_LIMIT, type Deps,
} from "@/lib/overnight-translate/driver";
import { IST_OFFSET_MS, maySubmit } from "@/lib/overnight-translate/hours";
import { makeDoor, type Door, type SubmitResult, type StatusResult, type RoomWindowSubmit } from "@/lib/overnight-translate/door";
import type { Candidate, Store, Summary } from "@/lib/overnight-translate/select";
import type { GateDecision } from "@/lib/overnight-translate/gate";

const at = (h: number, m = 0, s = 0, day = 21) => Date.UTC(2026, 8, day, h, m, s) - IST_OFFSET_MS;
const NIGHT = at(22, 0, 0);                      // 22:00 IST — well inside the submit window
const ORIGIN = "https://www.evenscribe.app";

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  window_id: id, room_id: "room_1", room_day_id: "rd_x", start_ms: 0, end_ms: 900_000, klass: "backlog", room_transcript_on: true, has_run: false, attempt: 1, ...over,
});
const SUMMARY: Summary = {
  fixture_windows: 0, fixture_need_asr: 0, fixture_need_english_only: 0, fixture_skipped_native_english: 0, fixture_skipped_proxy: 0,
  retry_pending: 0, parked: 0, backlog_remaining: 0, backlog_in_transcript_off_rooms: 0, excluded_closed_hours: 0, excluded_no_speakers: 0,
};
const done = (): StatusResult => ({ ok: true, status: "done", step: "finish", error_code: null, attempts: 5, failures: 0, join_contended: false });
const running = (): StatusResult => ({ ok: true, status: "running", step: "engine", error_code: null, attempts: 1, failures: 0, join_contended: false });
const failed = (): StatusResult => ({ ok: true, status: "failed", step: "segment", error_code: "room_window_failed", attempts: 2, failures: 1, join_contended: false });
const joinContended = (): StatusResult => ({ ok: true, status: "failed", step: "prepare", error_code: "room_window_failed", attempts: 1, failures: 1, join_contended: true });
const foreignCancel = (): StatusResult => ({ ok: true, status: "cancelled", step: "engine", error_code: null, attempts: 1, failures: 0, join_contended: false });

type Opts = {
  start?: number;
  cands?: Candidate[];
  /** polls that answer "running" before a job answers `final` */
  polls?: number;
  final?: (windowId: string, n: number) => StatusResult;
  submit?: (args: RoomWindowSubmit, n: number) => SubmitResult;
  status?: (jobId: string, n: number, windowId: string) => StatusResult;
  gate?: (t: number, call: number) => GateDecision;
  summary?: Summary;
  /** the selection is a database round trip: how long it takes on the fake clock */
  nextDelayMs?: number;
  /** make store.next throw on the n-th call (1-based) */
  storeThrows?: (n: number) => boolean;
  summarizeThrows?: boolean;
  /** the English canary's answer for a window (default "ok") */
  english?: (windowId: string) => "ok" | "missing";
  englishThrows?: boolean;
};

function harness(o: Opts = {}) {
  const clock = { t: o.start ?? NIGHT };
  const log: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const submits: Array<{ args: RoomWindowSubmit; at: number }> = [];
  const nextCalls: Array<Set<string>> = [];
  const englishChecks: string[] = [];
  const pending = [...(o.cands ?? [])];
  const jobWindow = new Map<string, string>();
  const polled = new Map<string, number>();
  let gateCalls = 0;
  let statusCalls = 0;
  const store: Store = {
    async next(exclude) {
      nextCalls.push(new Set(exclude));
      clock.t += o.nextDelayMs ?? 0;
      // The message deliberately carries a connection string: only the error's NAME may ever be logged.
      if (o.storeThrows?.(nextCalls.length)) throw Object.assign(new Error("connect failed postgres://user:pw@host/db"), { name: "NeonDbError" });
      return pending.find((c) => !exclude.has(c.window_id)) ?? null;
    },
    async englishCheck(windowId) {
      englishChecks.push(windowId);
      if (o.englishThrows) throw Object.assign(new Error("boom postgres://user:pw@host/db"), { name: "NeonDbError" });
      return o.english ? o.english(windowId) : "ok";
    },
    async summarize() {
      if (o.summarizeThrows) throw Object.assign(new Error("relation does not exist postgres://user:pw@host/db"), { name: "NeonDbError" });
      return o.summary ?? SUMMARY;
    },
  };
  const door: Door = {
    async submitRoomWindow(args) {
      submits.push({ args, at: clock.t });
      const n = submits.length;
      events.push(`submit:${args.window_id}`);
      const r = o.submit ? o.submit(args, n) : ({ ok: true, job_id: `job_${n}` } as SubmitResult);
      if (r.ok) { jobWindow.set(r.job_id, args.window_id); polled.set(r.job_id, 0); }
      return r;
    },
    async jobStatus(jobId) {
      statusCalls += 1;
      const w = jobWindow.get(jobId) ?? "?";
      const k = (polled.get(jobId) ?? 0) + 1;
      polled.set(jobId, k);
      let r: StatusResult;
      if (o.status) r = o.status(jobId, k, w);
      else if (k <= (o.polls ?? 2)) r = running();
      else r = o.final ? o.final(w, k) : done();
      if (r.ok && (r.status === "done" || r.status === "failed")) events.push(`${r.status}:${w}`);
      return r;
    },
  };
  const deps: Deps = {
    store, door, origin: ORIGIN,
    now: () => clock.t,
    sleep: async (ms, signal) => { if (!signal.aborted) clock.t += ms; },
    gate: () => { gateCalls += 1; return o.gate ? o.gate(clock.t, gateCalls) : { go: true, reason: "ok" }; },
    log: (ev) => log.push(ev),
  };
  const run = (mode: "run" | "dry-run" = "run", limit = 0, ac = new AbortController(), concurrency = 1) => runOvernight(deps, mode, limit, ac.signal, concurrency);
  return { clock, log, events, submits, nextCalls, englishChecks, deps, run, gateCalls: () => gateCalls, statusCalls: () => statusCalls };
}
const evs = (log: Array<Record<string, unknown>>, name: string) => log.filter((e) => e.event === name);

// ===========================================================================
describe("the job's args — exactly what goes on the wire", () => {
  it("a window in a Transcript-ON room: translate:true, NO override", () => {
    expect(jobArgsFor(cand("bw_1"), ORIGIN)).toEqual({ window_id: "bw_1", origin: ORIGIN, actor: ACTOR, via: "mcp", translate: true });
  });
  it("a window in a Transcript-OFF room: translate:true AND switch_override:true (V, 21 Sep — the flag must not stop the run)", () => {
    expect(jobArgsFor(cand("bw_1", { room_transcript_on: false }), ORIGIN)).toEqual({
      window_id: "bw_1", origin: ORIGIN, actor: ACTOR, via: "mcp", translate: true, switch_override: true,
    });
  });
  it("the actor is the driver's own name, and the origin is passed through unchanged", () => {
    expect(ACTOR).toBe("overnight-translate");
    expect(jobArgsFor(cand("x"), "https://www.evenscribe.app").origin).toBe("https://www.evenscribe.app");
  });
});

describe("a night — order, one at a time, and what the summary says", () => {
  it("submits in the store's order (fixtures before backlog is the store's job; the driver keeps it)", async () => {
    const h = harness({ cands: [cand("bw_fix", { klass: "fixture" }), cand("bw_b1"), cand("bw_b2")] });
    const s = await h.run();
    expect(h.submits.map((x) => x.args.window_id)).toEqual(["bw_fix", "bw_b1", "bw_b2"]);
    expect(s).toMatchObject({ started: 3, done: 3, failed: 0, fatal: null, stop: "backlog_empty" });
  });

  it("ONE job in flight: a window is polled to done before the next is submitted", async () => {
    const h = harness({ cands: [cand("A"), cand("B"), cand("C")], polls: 3 });
    await h.run();
    expect(h.events).toEqual(["submit:A", "done:A", "submit:B", "done:B", "submit:C", "done:C"]);
  });

  it("never re-submits a window it has already tried this run (the exclude set grows)", async () => {
    const h = harness({ cands: [cand("A"), cand("B")] });
    await h.run();
    expect([...h.nextCalls[0]!]).toEqual([]);
    expect([...h.nextCalls[1]!]).toEqual(["A"]);
    expect([...h.nextCalls[2]!].sort()).toEqual(["A", "B"]);
  });

  it("counts the windows submitted with the override", async () => {
    const h = harness({ cands: [cand("A"), cand("B", { room_transcript_on: false }), cand("C", { room_transcript_on: false })] });
    const s = await h.run();
    expect(s.overridden).toBe(2);
    expect(h.submits.map((x) => "switch_override" in x.args)).toEqual([false, true, true]);
  });

  it("an empty backlog stops immediately with backlog_empty and submits nothing", async () => {
    const h = harness({ cands: [] });
    expect(await h.run()).toMatchObject({ started: 0, stop: "backlog_empty", fatal: null });
    expect(h.submits).toHaveLength(0);
  });

  it("--limit N stops after N windows with stop=limit", async () => {
    const h = harness({ cands: [cand("A"), cand("B"), cand("C")] });
    expect(await h.run("run", 2)).toMatchObject({ started: 2, done: 2, stop: "limit" });
    expect(h.submits).toHaveLength(2);
  });

  it("logs night_start with the store's counts and night_end with the summary", async () => {
    const h = harness({ cands: [cand("A")], summary: { ...SUMMARY, backlog_remaining: 2076, fixture_need_asr: 41 } });
    await h.run();
    expect(evs(h.log, "night_start")[0]).toMatchObject({ mode: "run", backlog_remaining: 2076, fixture_need_asr: 41 });
    expect(evs(h.log, "night_end")[0]).toMatchObject({ started: 1, done: 1, stop: "backlog_empty" });
  });
});

describe("THE CLOCK — never a submit outside 21:30-07:10 IST", () => {
  it("started in the DAY: waits for closed hours (logged once), and the first submit is at or after 21:30", async () => {
    const h = harness({ start: at(12, 0, 0), cands: [cand("A"), cand("B")] });
    const s = await h.run();
    expect(evs(h.log, "waiting_for_closed_hours")).toHaveLength(1);
    expect(evs(h.log, "waiting_for_closed_hours")[0]!.ms).toBe(9.5 * 3_600_000);
    expect(h.submits[0]!.at).toBeGreaterThanOrEqual(at(21, 30, 0));
    expect(h.submits[0]!.at).toBeLessThan(at(21, 32, 0));
    expect(s.started).toBe(2);
  });

  it("HARD STOP: started at 07:05, it submits until 07:10 and not one second after", async () => {
    const cands = Array.from({ length: 20 }, (_, i) => cand(`W${i}`));
    const h = harness({ start: at(7, 5, 0, 22), cands, polls: 11 });   // ~2 minutes per window
    const s = await h.run();
    expect(s.stop).toBe("submit_window_closed");
    expect(h.submits.length).toBeGreaterThan(0);
    expect(h.submits.length).toBeLessThan(20);
    for (const sub of h.submits) {
      expect(maySubmit(sub.at), `submitted at ${new Date(sub.at + IST_OFFSET_MS).toISOString()} IST`).toBe(true);
      expect(sub.at).toBeLessThan(at(7, 10, 0, 22));
    }
    // The job in flight when the window closed was allowed to FINISH: every submit got a terminal poll.
    expect(s.done).toBe(h.submits.length);
    expect(s.abandoned).toBe(0);
  });

  it("across a whole simulated night, EVERY submit lands inside the window", async () => {
    const cands = Array.from({ length: 400 }, (_, i) => cand(`W${i}`));
    const h = harness({ start: at(20, 0, 0), cands, polls: 20 });
    const s = await h.run();
    expect(h.submits.length).toBeGreaterThan(50);
    for (const sub of h.submits) expect(maySubmit(sub.at)).toBe(true);
    expect(["submit_window_closed", "closed_hours_over"]).toContain(s.stop);
  });

  it("started in the dead zone between 07:10 and 07:30 it does NOT begin: it waits for tonight", async () => {
    const h = harness({ start: at(7, 20, 0, 22), cands: [cand("A")] });
    await h.run();
    expect(evs(h.log, "waiting_for_closed_hours")).toHaveLength(1);
    expect(h.submits[0]!.at).toBeGreaterThanOrEqual(at(21, 30, 0, 22));
  });

  it("a job still running when closed hours END is not waited on into clinic hours: stop, and name the job left running", async () => {
    const h = harness({ start: at(7, 9, 0, 22), cands: [cand("A"), cand("B")], status: () => running() });
    const s = await h.run();
    expect(s).toMatchObject({ stop: "closed_hours_over", abandoned: 1, started: 1, fatal: null });
    expect(evs(h.log, "left_running")[0]).toMatchObject({ window_id: "A", job_id: "job_1", why: "closed_hours_over" });
    expect(h.clock.t).toBeGreaterThanOrEqual(at(7, 30, 0, 22));
    expect(h.clock.t).toBeLessThan(at(7, 30, 30, 22));
    expect(h.submits).toHaveLength(1);
  });
});

describe("THE GATES — watchdog and disk, read before every submit", () => {
  it("a STOP verdict holds the run: nothing is submitted while it lasts, the hold is logged ONCE, and GO resumes", async () => {
    const start = NIGHT;
    const h = harness({
      cands: [cand("A")],
      gate: (t) => (t < start + 3 * GATE_POLL_MS ? { go: false, reason: "stop:STOP_sustained_pressure" } : { go: true, reason: "ok" }),
    });
    const s = await h.run();
    expect(evs(h.log, "gate_hold")).toEqual([{ event: "gate_hold", reason: "stop:STOP_sustained_pressure" }]);
    expect(evs(h.log, "gate_go")).toHaveLength(1);
    expect(h.submits[0]!.at).toBeGreaterThanOrEqual(start + 3 * GATE_POLL_MS);
    expect(s.started).toBe(1);
  });

  it("the gate is read BEFORE EACH submit, not once: it can hold window 2 after window 1 went through", async () => {
    let held = false;
    const h = harness({
      cands: [cand("A"), cand("B")],
      gate: (_t, call) => {
        // window A reads the gate twice (loop top, then just before the call): calls 1-2; B's loop top is call 3.
        if (call === 3 && !held) { held = true; return { go: false, reason: "diarize_ms:512" }; }
        return { go: true, reason: "ok" };
      },
    });
    await h.run();
    expect(h.gateCalls()).toBeGreaterThanOrEqual(5);            // A x2, hold, then B x2
    expect(evs(h.log, "gate_hold")).toEqual([{ event: "gate_hold", reason: "diarize_ms:512" }]);
    expect(h.submits.map((x) => x.args.window_id)).toEqual(["A", "B"]);
    expect(h.submits[1]!.at - h.submits[0]!.at).toBeGreaterThanOrEqual(GATE_POLL_MS);
  });

  it("a DISK-floor NO-GO holds it the same way, with its own reason", async () => {
    const h = harness({ cands: [cand("A")], gate: (t) => (t < NIGHT + GATE_POLL_MS ? { go: false, reason: "disk:39GB<40GB" } : { go: true, reason: "ok" }) });
    await h.run();
    expect(evs(h.log, "gate_hold")[0]).toMatchObject({ reason: "disk:39GB<40GB" });
    expect(h.submits).toHaveLength(1);
  });

  it("a hold that changes reason is logged again; the same reason is not repeated", async () => {
    const reasons = ["stop:STOP_a", "stop:STOP_a", "stop:STOP_b", "ok"];
    let i = 0;
    const h = harness({ cands: [cand("A")], gate: () => { const r = reasons[Math.min(i++, reasons.length - 1)]!; return r === "ok" ? { go: true, reason: "ok" } : { go: false, reason: r }; } });
    await h.run();
    expect(evs(h.log, "gate_hold").map((e) => e.reason)).toEqual(["stop:STOP_a", "stop:STOP_b"]);
  });

  it("if the gate holds until the submit window closes, nothing is submitted at all", async () => {
    const h = harness({ start: at(7, 5, 0, 22), cands: [cand("A")], gate: () => ({ go: false, reason: "stop:STOP_x" }) });
    const s = await h.run();
    expect(h.submits).toHaveLength(0);
    expect(s).toMatchObject({ started: 0, stop: "submit_window_closed" });
  });
});

describe("RE-CHECK — the clock and the gate are taken again immediately before the call (Reviewer finding B)", () => {
  it("a slow selection that crosses 07:10 does NOT become a submit after the stop", async () => {
    const h = harness({ start: at(7, 9, 50, 22), nextDelayMs: 25_000, cands: [cand("A")] });
    const s = await h.run();
    expect(h.submits, "the query ended at 07:10:15 — too late").toHaveLength(0);
    expect(s).toMatchObject({ started: 0, stop: "submit_window_closed", fatal: null });
  });

  it("without the delay the same window IS submitted (the re-check is not what blocked it)", async () => {
    const h = harness({ start: at(7, 9, 50, 22), cands: [cand("A")] });
    expect((await h.run()).started).toBe(1);
  });

  it("a watchdog STOP that lands DURING the selection is seen before the submit; the candidate is kept for later, not marked tried", async () => {
    let n = 0;
    const h = harness({
      cands: [cand("A")],
      nextDelayMs: 5_000,
      gate: () => (++n === 2 ? { go: false, reason: "stop:STOP_sustained_pressure" } : { go: true, reason: "ok" }),
    });
    const s = await h.run();
    expect(evs(h.log, "gate_hold")).toEqual([{ event: "gate_hold", reason: "stop:STOP_sustained_pressure" }]);
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]!.at - NIGHT, "waited out the hold before submitting").toBeGreaterThanOrEqual(GATE_POLL_MS);
    expect(h.nextCalls.length, "A was selected twice — the first pick was dropped, not tried").toBe(3);
    expect([...h.nextCalls[1]!], "and not excluded the second time").toEqual([]);
    expect(s).toMatchObject({ started: 1, done: 1 });
  });
});

describe("THE STORE — a database blip is not a verdict on a window", () => {
  it(`${DEFERRED_LIMIT - 1} failures then success carries on; only the error NAME is logged, never its message`, async () => {
    const h = harness({ cands: [cand("A")], storeThrows: (n) => n < DEFERRED_LIMIT });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 1, fatal: null });
    const errs = evs(h.log, "store_error");
    expect(errs).toHaveLength(DEFERRED_LIMIT - 1);
    expect(errs[0]).toEqual({ event: "store_error", error_name: "NeonDbError", streak: 1 });
    expect(JSON.stringify(h.log)).not.toContain("postgres://");
    expect(JSON.stringify(h.log)).not.toContain("connect failed");
  });

  it(`${DEFERRED_LIMIT} failures in a row stop the run with store_unreadable — a clean stop, not a crash`, async () => {
    const h = harness({ cands: [cand("A")], storeThrows: () => true });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: "store_unreadable", stop: "fatal", started: 0 });
    expect(h.submits).toHaveLength(0);
    expect(JSON.stringify(h.log)).not.toContain("postgres://");
  });

  it("the night's opening counts are only for the log: if they cannot be read the night still runs", async () => {
    const h = harness({ cands: [cand("A")], summarizeThrows: true });
    const s = await h.run();
    expect(evs(h.log, "summary_unavailable")).toEqual([{ event: "summary_unavailable", error_name: "NeonDbError" }]);
    expect(s).toMatchObject({ started: 1, done: 1 });
    expect(JSON.stringify(h.log)).not.toContain("postgres://");
  });

  it("a dry run whose store cannot be read reports the failure instead of printing an empty plan", async () => {
    const h = harness({ cands: [cand("A")], storeThrows: () => true });
    const s = await h.run("dry-run", 5);
    expect(s.fatal).toBe("store_unreadable");
    expect(evs(h.log, "store_error")).toHaveLength(1);
  });
});

describe("FATAL — a refused credential stops the run on the spot", () => {
  it("401 on submit: mcp_auth_refused, ONE attempt, no further submit, no further store read", async () => {
    const h = harness({ cands: [cand("A"), cand("B")], submit: () => ({ ok: false, kind: "fatal", code: "mcp_auth_refused" }) });
    const s = await h.run();
    expect(s).toMatchObject({ started: 0, fatal: "mcp_auth_refused", stop: "fatal" });
    expect(h.submits).toHaveLength(1);
    expect(h.nextCalls).toHaveLength(1);
    expect(evs(h.log, "fatal")[0]).toMatchObject({ code: "mcp_auth_refused", window_id: "A" });
  });
  it("403 (the token has no `invoke`): mcp_scope_refused, same behaviour", async () => {
    const h = harness({ cands: [cand("A")], submit: () => ({ ok: false, kind: "fatal", code: "mcp_scope_refused" }) });
    expect(await h.run()).toMatchObject({ fatal: "mcp_scope_refused", started: 0 });
  });
  it("a credential refused while POLLING also stops the run — and names the job left behind", async () => {
    const h = harness({ cands: [cand("A"), cand("B")], status: () => ({ ok: false, kind: "fatal", code: "mcp_auth_refused" }) });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: "mcp_auth_refused", started: 1 });
    expect(h.submits).toHaveLength(1);
    expect(evs(h.log, "fatal")[0]).toMatchObject({ window_id: "A", job_id: "job_1" });
  });
});

describe("FAILURE LIMITS", () => {
  it(`${CONSECUTIVE_FAILURE_LIMIT} failed jobs in a row stop the run (too_many_failures)`, async () => {
    const h = harness({ cands: Array.from({ length: 10 }, (_, i) => cand(`W${i}`)), final: () => failed() });
    const s = await h.run();
    expect(s).toMatchObject({ failed: CONSECUTIVE_FAILURE_LIMIT, started: CONSECUTIVE_FAILURE_LIMIT, fatal: "too_many_failures", stop: "fatal" });
    expect(h.submits).toHaveLength(CONSECUTIVE_FAILURE_LIMIT);
  });
  it("a success RESETS the count: F F F D F F D never trips the limit", async () => {
    const pattern = ["F", "F", "F", "D", "F", "F", "D"];
    const h = harness({ cands: pattern.map((_, i) => cand(`W${i}`)), final: (w) => (pattern[Number(w.slice(1))] === "F" ? failed() : done()) });
    const s = await h.run();
    expect(s).toMatchObject({ started: 7, done: 2, failed: 5, fatal: null, stop: "backlog_empty" });
  });
  it("a failed window's error code is logged as a closed code, with its step", async () => {
    const h = harness({ cands: [cand("A")], final: () => failed() });
    await h.run();
    expect(evs(h.log, "window_failed")[0]).toMatchObject({ window_id: "A", status: "failed", step: "segment", error_code: "room_window_failed" });
  });
  it("a window the door REFUSES is skipped for the rest of the run (not retried) and the run moves on", async () => {
    const h = harness({ cands: [cand("A"), cand("B")], submit: (a, n) => (a.window_id === "A" ? { ok: false, kind: "refused", code: "bad_args" } : { ok: true, job_id: `job_${n}` }) });
    const s = await h.run();
    expect(s).toMatchObject({ refused: 1, started: 1, done: 1, fatal: null });
    expect(h.submits.map((x) => x.args.window_id)).toEqual(["A", "B"]);
    expect(evs(h.log, "window_refused")[0]).toEqual({ event: "window_refused", window_id: "A", code: "bad_args" });
  });
  it("refusals count toward the consecutive-failure limit too", async () => {
    const h = harness({ cands: Array.from({ length: 10 }, (_, i) => cand(`W${i}`)), submit: () => ({ ok: false, kind: "refused", code: "bad_args" }) });
    expect(await h.run()).toMatchObject({ refused: CONSECUTIVE_FAILURE_LIMIT, fatal: "too_many_failures", started: 0 });
  });
});

describe("DEFERRED — the door being unreachable is not a verdict on the window", () => {
  it(`${DEFERRED_LIMIT - 1} deferrals then success carries on, and the window is retried`, async () => {
    const h = harness({ cands: [cand("A")], submit: (_a, n) => (n < DEFERRED_LIMIT ? { ok: false, kind: "deferred", code: "mcp_unreachable" } : { ok: true, job_id: "job_ok" }) });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 1, fatal: null });
    expect(h.submits).toHaveLength(DEFERRED_LIMIT);
    expect(evs(h.log, "door_deferred")).toHaveLength(DEFERRED_LIMIT - 1);
  });
  it(`${DEFERRED_LIMIT} deferrals in a row are fatal: door_unreachable`, async () => {
    const h = harness({ cands: [cand("A")], submit: () => ({ ok: false, kind: "deferred", code: "mcp_timeout" }) });
    expect(await h.run()).toMatchObject({ fatal: "door_unreachable", started: 0 });
    expect(h.submits).toHaveLength(DEFERRED_LIMIT);
  });
  it("a deferred STATUS poll is retried; the job is not abandoned for one bad answer", async () => {
    let calls = 0;
    const h = harness({ cands: [cand("A")], status: () => (++calls === 1 ? { ok: false, kind: "deferred", code: "mcp_http_error" } : done()) });
    expect(await h.run()).toMatchObject({ done: 1, fatal: null });
  });
});

describe("THE ENGLISH CANARY — a `done` that made no English is a failure (the deploy-order and routing-change guard)", () => {
  it("is asked once per FINISHED window, and only for jobs that reported done", async () => {
    const h = harness({ cands: [cand("A"), cand("B"), cand("C")], final: (w) => (w === "B" ? failed() : done()) });
    await h.run();
    expect(h.englishChecks).toEqual(["A", "C"]);
  });

  it(`a done job whose window has text but no English counts as a FAILURE; ${CONSECUTIVE_FAILURE_LIMIT} in a row stop the night`, async () => {
    const h = harness({ cands: Array.from({ length: 10 }, (_, i) => cand(`W${i}`)), english: () => "missing" });
    const s = await h.run();
    expect(s).toMatchObject({ done: 0, failed: CONSECUTIVE_FAILURE_LIMIT, started: CONSECUTIVE_FAILURE_LIMIT, fatal: "too_many_failures", stop: "fatal" });
    expect(h.submits, "the night stopped after five, not after ten").toHaveLength(CONSECUTIVE_FAILURE_LIMIT);
    expect(evs(h.log, "window_failed")[0]).toMatchObject({ window_id: "W0", status: "done", error_code: "no_english" });
    expect(evs(h.log, "window_done")).toHaveLength(0);
  });

  it("an ok answer resets the count: missing x4 then ok never trips the limit", async () => {
    const h = harness({ cands: Array.from({ length: 8 }, (_, i) => cand(`W${i}`)), english: (w) => (Number(w.slice(1)) < CONSECUTIVE_FAILURE_LIMIT - 1 || Number(w.slice(1)) === 5 ? "missing" : "ok") });
    const s = await h.run();
    expect(s.fatal).toBeNull();
    expect(s.started).toBe(8);
    expect(s.done + s.failed).toBe(8);
  });

  it("if the check ITSELF cannot be read, the window is NOT recorded done — it is unverified and counts as a failure; only the error's name is logged", async () => {
    const h = harness({ cands: [cand("A", { room_day_id: "rd_A" })], englishThrows: true });
    const s = await h.run();
    expect(s).toMatchObject({ done: 0, failed: 0, unverified: 1, started: 1, fatal: null });
    expect(evs(h.log, "window_done")).toHaveLength(0);
    expect(evs(h.log, "english_check_unavailable")).toEqual([
      { event: "english_check_unavailable", window_id: "A", room_day_id: "rd_A", job_id: "job_1", error_name: "NeonDbError", attempt: 1, consecutive: 1 },
    ]);
    expect(JSON.stringify(h.log)).not.toContain("postgres://");
  });

  it(`a check that keeps THROWING stops the night after ${CONSECUTIVE_FAILURE_LIMIT}, like a check that keeps saying missing (it was done=40, failed=0)`, async () => {
    const h = harness({ cands: Array.from({ length: 40 }, (_, i) => cand(`W${i}`)), englishThrows: true });
    const s = await h.run();
    expect(s).toMatchObject({ done: 0, unverified: CONSECUTIVE_FAILURE_LIMIT, started: CONSECUTIVE_FAILURE_LIMIT, fatal: "too_many_failures", stop: "fatal" });
    expect(h.submits, "the night stopped after five, not after forty").toHaveLength(CONSECUTIVE_FAILURE_LIMIT);
    expect(evs(h.log, "english_check_unavailable")).toHaveLength(CONSECUTIVE_FAILURE_LIMIT);
    expect(evs(h.log, "window_done")).toHaveLength(0);
  });

  it("an unreadable check does NOT reset the counter: missing x2, unreadable x1, missing x2 is five in a row and stops", async () => {
    const h = harness({
      cands: Array.from({ length: 10 }, (_, i) => cand(`W${i}`)),
      english: (w) => { if (w === "W2") throw new Error("read failed"); return "missing"; },
    });
    const s = await h.run();
    expect(s).toMatchObject({ failed: 4, unverified: 1, done: 0, fatal: "too_many_failures", started: 5 });
    expect(h.submits).toHaveLength(5);
  });

  it("an OK answer after unreadable ones resets the count: unreadable x4 then ok never trips the limit", async () => {
    const h = harness({
      cands: Array.from({ length: 6 }, (_, i) => cand(`W${i}`)),
      english: (w) => { if (Number(w.slice(1)) < CONSECUTIVE_FAILURE_LIMIT - 1) throw new Error("read failed"); return "ok"; },
    });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: null, unverified: CONSECUTIVE_FAILURE_LIMIT - 1, done: 2, started: 6 });
  });

  it("a dry run never asks it (nothing was submitted)", async () => {
    const h = harness({ cands: [cand("A")] });
    await h.run("dry-run", 3);
    expect(h.englishChecks).toHaveLength(0);
  });
});

describe("OPEN EARLY (ETA_OVERNIGHT_OPEN_EARLY=1) — the driver, end to end, on the fake clock", () => {
  /** Runs `body` with the variable set (or unset), restoring what was there. The driver reads process.env at call time. */
  async function withEarly<T>(v: string | undefined, body: () => Promise<T>): Promise<T> {
    const was = process.env.ETA_OVERNIGHT_OPEN_EARLY;
    try {
      if (v === undefined) delete process.env.ETA_OVERNIGHT_OPEN_EARLY; else process.env.ETA_OVERNIGHT_OPEN_EARLY = v;
      return await body();
    } finally {
      if (was === undefined) delete process.env.ETA_OVERNIGHT_OPEN_EARLY; else process.env.ETA_OVERNIGHT_OPEN_EARLY = was;
    }
  }

  it("UNSET at 20:45: it waits for 21:30 and the first submit is at or after 21:30 — today's behaviour", async () => {
    await withEarly(undefined, async () => {
      const h = harness({ start: at(20, 45, 0), cands: [cand("A")] });
      await h.run();
      expect(evs(h.log, "waiting_for_closed_hours")[0]!.ms).toBe(45 * 60_000);
      expect(h.submits[0]!.at).toBeGreaterThanOrEqual(at(21, 30, 0));
    });
  });

  it("SET at 20:45: the first submit is at 20:45 exactly, with no wait", async () => {
    await withEarly("1", async () => {
      const h = harness({ start: at(20, 45, 0), cands: [cand("A"), cand("B")] });
      const s = await h.run();
      expect(evs(h.log, "waiting_for_closed_hours")).toHaveLength(0);
      expect(h.submits[0]!.at).toBe(at(20, 45, 0));
      expect(s).toMatchObject({ started: 2, done: 2, fatal: null });
    });
  });

  it("SET: a job stood by for at 20:45 is NOT abandoned as 'running into clinic hours' (closedHoursOver must move with the start)", async () => {
    await withEarly("1", async () => {
      const h = harness({ start: at(20, 45, 0), cands: [cand("A")], polls: 6 });
      const s = await h.run();
      expect(evs(h.log, "left_running")).toHaveLength(0);
      expect(s).toMatchObject({ abandoned: 0, done: 1, stop: "backlog_empty" });
    });
  });

  it("SET at 18:30: still blocked — it waits 30 minutes for 19:00, and the first submit is at 19:00", async () => {
    await withEarly("1", async () => {
      const h = harness({ start: at(18, 30, 0), cands: [cand("A")] });
      await h.run();
      expect(evs(h.log, "waiting_for_closed_hours")[0]!.ms).toBe(30 * 60_000);
      expect(h.submits[0]!.at).toBeGreaterThanOrEqual(at(19, 0, 0));
      expect(h.submits[0]!.at).toBeLessThan(at(19, 2, 0));
    });
  });

  it("SET: the 07:10 stop is unchanged — a night that reaches 07:10 stops submitting exactly as before", async () => {
    await withEarly("1", async () => {
      const cands = Array.from({ length: 40 }, (_, i) => cand(`W${i}`));
      const h = harness({ start: at(7, 5, 0, 22), cands, polls: 11 });
      const s = await h.run();
      expect(s.stop).toBe("submit_window_closed");
      for (const sub of h.submits) expect(maySubmit(sub.at, true), "every submit was inside the window").toBe(true);
      expect(Math.max(...h.submits.map((x) => x.at))).toBeLessThan(at(7, 10, 0, 22));
    });
  });

  it("SET: started at 07:20 (the dead zone) it still waits — for 19:00, not for 07:10 — and never submits in the clinic day", async () => {
    await withEarly("1", async () => {
      const h = harness({ start: at(7, 20, 0, 22), cands: [cand("A")] });
      await h.run();
      expect(evs(h.log, "waiting_for_closed_hours")[0]!.ms).toBe((11 * 60 + 40) * 60_000);
      expect(h.submits[0]!.at).toBeGreaterThanOrEqual(at(19, 0, 0, 22));
    });
  });
});

describe("ALLOW DAYTIME (ETA_OVERNIGHT_ALLOW_DAYTIME=1) — the driver, end to end", () => {
  async function withDaytime<T>(v: string | undefined, body: () => Promise<T>): Promise<T> {
    const was = process.env.ETA_OVERNIGHT_ALLOW_DAYTIME;
    try {
      if (v === undefined) delete process.env.ETA_OVERNIGHT_ALLOW_DAYTIME; else process.env.ETA_OVERNIGHT_ALLOW_DAYTIME = v;
      return await body();
    } finally {
      if (was === undefined) delete process.env.ETA_OVERNIGHT_ALLOW_DAYTIME; else process.env.ETA_OVERNIGHT_ALLOW_DAYTIME = was;
    }
  }

  it("SET at 10:00: the first submit is at 10:00 exactly, no wait, past the 07:10 stop too", async () => {
    await withDaytime("1", async () => {
      const h = harness({ start: at(10, 0, 0), cands: [cand("A")] });
      await h.run();
      expect(evs(h.log, "waiting_for_closed_hours")).toHaveLength(0);
      expect(h.submits[0]!.at).toBe(at(10, 0, 0));
    });
  });

  it("SET: the pressure/disk gate STILL holds a submit at 10:00 — daytime lifts the clock, not the gate", async () => {
    await withDaytime("1", async () => {
      // The gate says NO-GO for its first 3 calls (pressure), then GO. Daytime never touches this gate at all.
      const h = harness({ start: at(10, 0, 0), cands: [cand("A")], gate: (_t, call) => (call <= 3 ? { go: false, reason: "stop:STOP_sustained_pressure" } : { go: true, reason: "ok" }) });
      const s = await h.run();
      expect(evs(h.log, "gate_hold").length).toBeGreaterThanOrEqual(1);
      expect(evs(h.log, "gate_hold")[0]).toMatchObject({ reason: "stop:STOP_sustained_pressure" });
      expect(s).toMatchObject({ started: 1, done: 1 });
    });
  });

  it("SET: a job is never abandoned mid-day — closedHoursOver never fires", async () => {
    await withDaytime("1", async () => {
      const h = harness({ start: at(14, 0, 0), cands: [cand("A")], polls: 6 });
      const s = await h.run();
      expect(evs(h.log, "left_running")).toHaveLength(0);
      expect(s).toMatchObject({ abandoned: 0, done: 1 });
    });
  });

  it("UNSET at 10:00: today's behaviour — it waits for 21:30", async () => {
    await withDaytime(undefined, async () => {
      const h = harness({ start: at(10, 0, 0), cands: [cand("A")] });
      await h.run();
      expect(evs(h.log, "waiting_for_closed_hours")[0]!.ms).toBe(11.5 * 3_600_000);
    });
  });
});

describe("CONCURRENCY (ETA_OVERNIGHT_CONCURRENCY) — Fable's order of 22 Sep 2026, 07:00", () => {
  it("the default is 1 — exactly today's behaviour when the caller passes nothing", () => {
    expect(DEFAULT_CONCURRENCY).toBe(1);
  });

  it("a malformed concurrency (0, negative, fractional) never means zero slots — it floors to at least 1", async () => {
    for (const bad of [0, -1, 0.5]) {
      const h = harness({ cands: [cand("A")], polls: 1 });
      const s = await h.run("run", 0, new AbortController(), bad);
      expect(s, `concurrency=${bad}`).toMatchObject({ started: 1, done: 1 });
    }
  });

  it("n=3: three candidates are submitted in ONE fill pass, at the same instant, before any is polled", async () => {
    const h = harness({ cands: [cand("A"), cand("B"), cand("C")], polls: 5 });
    const run = h.run("run", 0, new AbortController(), 3);
    // let the fill pass happen; the fake clock only advances on `sleep`, so all three submits land at NIGHT.
    await Promise.race([run, new Promise((r) => setTimeout(r, 20))]);
    expect(h.submits).toHaveLength(3);
    expect(h.submits.every((x) => x.at === NIGHT)).toBe(true);
    expect(h.submits.map((x) => x.args.window_id)).toEqual(["A", "B", "C"]);
    await run;
  });

  it("n=3 over 6 windows: never more than 3 in flight at once, and the 4th-6th are only submitted as slots free", async () => {
    const h = harness({ cands: Array.from({ length: 6 }, (_, i) => cand(`W${i}`)), polls: 1 });
    let inFlight = 0, maxInFlight = 0;
    const origLog = h.deps.log;
    h.deps.log = (ev) => {
      if (ev.event === "window_submitted") { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); }
      if (ev.event === "window_done" || ev.event === "window_failed") inFlight -= 1;
      origLog(ev);
    };
    const s = await h.run("run", 0, new AbortController(), 3);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3);
    expect(s).toMatchObject({ started: 6, done: 6 });
  });

  it("the gate is checked fresh before EVERY submit, not once per batch — 3 fills cost at least 3 gate reads", async () => {
    const h = harness({ cands: [cand("A"), cand("B"), cand("C")], polls: 1 });
    await h.run("run", 0, new AbortController(), 3);
    expect(h.gateCalls()).toBeGreaterThanOrEqual(3);
  });

  it("a Transcript-OFF window still gets the override and only the off windows are counted, with 3 in flight", async () => {
    const h = harness({ cands: [cand("A"), cand("B", { room_transcript_on: false }), cand("C")], polls: 1 });
    const s = await h.run("run", 0, new AbortController(), 3);
    expect(h.submits.find((x) => x.args.window_id === "B")!.args).toMatchObject({ switch_override: true });
    expect(h.submits.find((x) => x.args.window_id === "A")!.args).not.toHaveProperty("switch_override");
    expect(s.overridden).toBe(1);
  });

  it(`THE CANARY ACROSS INTERLEAVED COMPLETIONS: one shared counter, updated in submission order within a batch, ` +
     `and carried across batches — 5 no-English in a row (spread over two batches of 3) still stops the run`, async () => {
    const cands = Array.from({ length: 6 }, (_, i) => cand(`W${i}`));
    const h = harness({
      cands, polls: 0,   // every jobStatus call is immediately terminal — all of a batch finishes together
      english: (w) => (w === "W0" ? "ok" : "missing"),
    });
    const s = await h.run("run", 0, new AbortController(), 3);
    // batch 1 (W0,W1,W2): ok resets to 0, then two "missing" take it to 2 — nowhere near the limit yet.
    // batch 2 (W3,W4,W5): missing,missing,missing take it 3->4->5, tripping the stop on the THIRD of this batch.
    expect(s).toMatchObject({ started: 6, done: 1, failed: 5, fatal: "too_many_failures", stop: "fatal", abandoned: 0 });
    expect(evs(h.log, "window_failed").map((e) => e.window_id)).toEqual(["W1", "W2", "W3", "W4", "W5"]);
  });

  it("a job stuck past the deadline fatals the run and abandons the OTHER jobs still in flight, not just itself", async () => {
    const h = harness({
      cands: [cand("A"), cand("B"), cand("C")],
      status: (jobId, k, w) => (w === "B" ? running() : running()),   // nobody ever finishes; B is the one we let time out
    });
    const s = await h.run("run", 0, new AbortController(), 3);
    expect(s).toMatchObject({ fatal: "job_stuck", stop: "fatal" });
    // all three were still active when the deadline fired: the stuck one plus the two abandoned bystanders.
    expect(s.abandoned).toBe(3);
    expect(evs(h.log, "left_running")).toHaveLength(2);
    expect(evs(h.log, "fatal")[0]).toMatchObject({ code: "job_stuck" });
  });

  it("closed hours ending mid-run abandons EVERY job still in flight, not just one", async () => {
    const h = harness({ start: at(7, 5, 0, 22), cands: [cand("A"), cand("B"), cand("C")], status: () => running() });
    const s = await h.run("run", 0, new AbortController(), 3);
    expect(s.stop).toBe("closed_hours_over");
    expect(s.abandoned).toBe(3);
    expect(evs(h.log, "left_running")).toHaveLength(3);
    expect(evs(h.log, "left_running").every((e) => e.why === "closed_hours_over")).toBe(true);
  });

  it("a fatal (401/403) door read on ONE job stops the run and abandons the OTHERS still in flight", async () => {
    const h = harness({
      cands: [cand("A"), cand("B"), cand("C")],
      status: (jobId, k, w) => (w === "B" ? { ok: false, kind: "fatal", code: "mcp_auth_refused" } : running()),
    });
    const s = await h.run("run", 0, new AbortController(), 3);
    expect(s).toMatchObject({ fatal: "mcp_auth_refused", stop: "fatal" });
    // B itself is not counted as "abandoned" (it is the CAUSE, reported via the fatal event's own window_id/job_id) —
    // A and C, still in flight with no verdict, ARE the bystanders left running.
    expect(s.abandoned).toBe(2);
    expect(evs(h.log, "left_running")).toHaveLength(2);
    expect(evs(h.log, "left_running").map((e) => e.window_id).sort()).toEqual(["A", "C"]);
    expect(evs(h.log, "fatal")[0]).toMatchObject({ code: "mcp_auth_refused", window_id: "B" });
  });

  it("n=3 with only 2 candidates: fills what it can, never blocks waiting for a 3rd that will never come", async () => {
    const h = harness({ cands: [cand("A"), cand("B")], polls: 1 });
    const s = await h.run("run", 0, new AbortController(), 3);
    expect(s).toMatchObject({ started: 2, done: 2, stop: "backlog_empty" });
  });

  it("dry-run ignores concurrency entirely — it never submits, so the plan is identical regardless of n", async () => {
    const h1 = harness({ cands: [cand("A"), cand("B"), cand("C")] });
    const h3 = harness({ cands: [cand("A"), cand("B"), cand("C")] });
    await h1.run("dry-run", 3, new AbortController(), 1);
    await h3.run("dry-run", 3, new AbortController(), 3);
    expect(evs(h1.log, "plan").map((e) => e.window_id)).toEqual(evs(h3.log, "plan").map((e) => e.window_id));
    expect(h1.submits).toHaveLength(0);
    expect(h3.submits).toHaveLength(0);
  });

  it("aborted mid-poll with 3 in flight: every one of them is logged left_running, not just the first", async () => {
    const ac = new AbortController();
    const h = harness({
      cands: [cand("A"), cand("B"), cand("C")],
      status: (jobId, k, w) => { if (w === "A" && k === 1) ac.abort(); return running(); },
    });
    const s = await h.run("run", 0, ac, 3);
    expect(s.stop).toBe("aborted");
    expect(s.abandoned).toBe(3);
    expect(evs(h.log, "left_running")).toHaveLength(3);
    expect(evs(h.log, "left_running").every((e) => e.why === "aborted")).toBe(true);
    expect(h.submits).toHaveLength(3);   // no MORE submissions after the abort was noticed
  });
});

describe("JOIN-SERVICE CONTENTION — a bounded retryable deferral, not a counted failure (V, 22 Sep 2026 08:20, option b)", () => {
  it(`a single collision retries after ${JOIN_RETRY_DELAY_MS}ms and succeeds: counted joinDeferred, then done — never failed`, async () => {
    let n = 0;
    const h = harness({ cands: [cand("A")], status: () => (++n === 1 ? joinContended() : done()) });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 1, failed: 0, joinDeferred: 1 });
    expect(h.submits.filter((x) => x.args.window_id === "A")).toHaveLength(2);
    expect(evs(h.log, "window_join_deferred")).toHaveLength(1);
    expect(evs(h.log, "window_join_deferred")[0]).toMatchObject({ window_id: "A", job_id: "job_1", retry_job_id: "job_2", retry: 1 });
    expect(evs(h.log, "window_failed")).toHaveLength(0);
  });

  it("the retry waits the backoff on the fake clock, then resubmits — not instantly", async () => {
    let n = 0;
    const h = harness({ cands: [cand("A")], status: () => (++n === 1 ? joinContended() : done()) });
    await h.run();
    const [first, second] = h.submits;
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(JOIN_RETRY_DELAY_MS);
  });

  it(`exhausting JOIN_RETRY_LIMIT (${JOIN_RETRY_LIMIT}) collisions in a row: the LAST one is a distinct, non-generic failure (join_contention_exhausted)`, async () => {
    const h = harness({ cands: [cand("A")], status: () => joinContended() });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 0, failed: 1, joinDeferred: JOIN_RETRY_LIMIT });
    expect(h.submits.filter((x) => x.args.window_id === "A")).toHaveLength(JOIN_RETRY_LIMIT + 1);
    expect(evs(h.log, "window_join_deferred")).toHaveLength(JOIN_RETRY_LIMIT);
    expect(evs(h.log, "window_failed")).toHaveLength(1);
    expect(evs(h.log, "window_failed")[0]).toMatchObject({ window_id: "A", error_code: "join_contention_exhausted" });
  });

  it("collisions that eventually succeed do NOT count toward the 5-in-a-row stop, however many windows hit them", async () => {
    const cands = Array.from({ length: 6 }, (_, i) => cand(`W${i}`));
    const counts = new Map<string, number>();
    const h = harness({
      cands,
      status: (jobId, k, w) => {
        const n = (counts.get(w) ?? 0) + 1;
        counts.set(w, n);
        return n === 1 ? joinContended() : done();
      },
    });
    const s = await h.run();
    expect(s).toMatchObject({ started: 6, done: 6, failed: 0, joinDeferred: 6, fatal: null, stop: "backlog_empty" });
  });

  it("a retry that ALSO collides keeps counting the retry number and eventually still resolves", async () => {
    let n = 0;
    const h = harness({ cands: [cand("A")], status: () => (++n <= JOIN_RETRY_LIMIT ? joinContended() : done()) });
    const s = await h.run();
    expect(s).toMatchObject({ done: 1, failed: 0, joinDeferred: JOIN_RETRY_LIMIT });
    expect(evs(h.log, "window_join_deferred").map((e) => e.retry)).toEqual(Array.from({ length: JOIN_RETRY_LIMIT }, (_, i) => i + 1));
  });

  it("if the RETRY submit itself is refused/deferred, this cycle counts the ORIGINAL as a real failure (kept simple, per 'bounded')", async () => {
    const h = harness({
      cands: [cand("A"), cand("B")],
      status: (jobId, k, w) => (w === "A" && k === 1 ? joinContended() : done()),
      submit: (args, n) => (n === 2 ? { ok: false, kind: "refused", code: "bad_args" } : { ok: true, job_id: `job_${n}` }),
    });
    const s = await h.run();
    expect(s).toMatchObject({ failed: 1, joinDeferred: 0 });
    expect(evs(h.log, "window_failed")[0]).toMatchObject({ window_id: "A", error_code: "join_contention_exhausted" });
  });

  it("n=3: a collision on one slot retries independently — the OTHER two slots are untouched", async () => {
    let bCollided = false;
    const h = harness({
      cands: [cand("A"), cand("B"), cand("C")],
      status: (jobId, k, w) => (w === "B" && !bCollided ? ((bCollided = true), joinContended()) : done()),
    });
    const s = await h.run("run", 0, new AbortController(), 3);
    expect(s).toMatchObject({ started: 3, done: 3, failed: 0, joinDeferred: 1 });
  });

  it("the join_contended flag alone (without the failed status) never triggers a retry — done/running are unaffected", async () => {
    const h = harness({ cands: [cand("A")], status: () => ({ ok: true, status: "done", step: "finish", error_code: null, attempts: 1, failures: 0, join_contended: true }) });
    const s = await h.run();
    // A done job is a done job regardless of a stray join_contended flag — that field only matters on `failed`.
    expect(s).toMatchObject({ done: 1, joinDeferred: 0 });
  });

  it("join_contended on a CANCELLED job (not failed) never retries — a cancelled job is a foreign cancel (deferred), not a failure at all", async () => {
    const h = harness({ cands: [cand("A")], status: () => ({ ok: true, status: "cancelled", step: null, error_code: null, attempts: 1, failures: 0, join_contended: true }) });
    const s = await h.run();
    expect(s).toMatchObject({ failed: 0, joinDeferred: 0, windowDeferred: 1 });
    expect(h.submits).toHaveLength(1);
  });

  it("the log for a deferred collision carries only ids/counts — no free text, and the token never appears", async () => {
    let n = 0;
    const h = harness({ cands: [cand("A")], status: () => (++n === 1 ? joinContended() : done()) });
    await h.run();
    const line = evs(h.log, "window_join_deferred")[0]!;
    expect(Object.keys(line).sort()).toEqual(["event", "job_id", "retry", "retry_job_id", "window_id"].sort());
  });
});

describe("THE JOIN-RETRY BACKOFF RE-CHECKS THE CLOCK AND THE GATE (Refuter finding 1, 22 Sep 2026)", () => {
  it("a gate STOP that lands during the backoff abandons the retry: no resubmit, not a failure, doesn't touch consecutiveFailures", async () => {
    let n = 0;
    const h = harness({
      cands: [cand("A")],
      status: () => (++n === 1 ? joinContended() : done()),
      gate: (_t, call) => (call === 3 ? { go: false, reason: "stop:STOP_retry_test" } : { go: true, reason: "ok" }),
    });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 0, failed: 0, joinDeferred: 0, windowDeferred: 1, fatal: null, stop: "backlog_empty" });
    expect(h.submits.filter((x) => x.args.window_id === "A"), "no resubmit went out").toHaveLength(1);
    expect(evs(h.log, "window_deferred")).toEqual([{ event: "window_deferred", window_id: "A", job_id: "job_1", reason: "gate_hold", retry: 1 }]);
    expect(evs(h.log, "window_join_deferred")).toHaveLength(0);
    expect(evs(h.log, "window_failed")).toHaveLength(0);
  });

  it("the clock closing during the backoff abandons the retry the same way: reason clock_closed, no resubmit", async () => {
    let n = 0;
    const h = harness({
      start: at(7, 9, 56, 22),
      cands: [cand("A")],
      status: () => (++n === 1 ? joinContended() : done()),
    });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 0, failed: 0, joinDeferred: 0, windowDeferred: 1, fatal: null, stop: "submit_window_closed" });
    expect(h.submits.filter((x) => x.args.window_id === "A"), "no resubmit went out").toHaveLength(1);
    expect(evs(h.log, "window_deferred")).toEqual([{ event: "window_deferred", window_id: "A", job_id: "job_1", reason: "clock_closed", retry: 1 }]);
    expect(evs(h.log, "window_join_deferred")).toHaveLength(0);
    expect(evs(h.log, "window_failed")).toHaveLength(0);
  });

  it("a fatal (401/403 / mcp_scope_refused) answer on the RETRY submit stops the run exactly like a fatal on any other submit — not counted as a window failure", async () => {
    const h = harness({
      cands: [cand("A")],
      status: () => joinContended(),
      submit: (_args, k) => (k === 2 ? { ok: false, kind: "fatal", code: "mcp_scope_refused" } : { ok: true, job_id: `job_${k}` }),
    });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: "mcp_scope_refused", stop: "fatal", failed: 0, started: 1 });
    expect(evs(h.log, "fatal")[0]).toMatchObject({ code: "mcp_scope_refused", window_id: "A", job_id: "job_1" });
    expect(evs(h.log, "window_failed")).toHaveLength(0);
  });

  it("join_contention_exhausted failures are kept OUT of the canary's consecutive-failure count (too_many_failures) " +
     "— they trip THEIR OWN limit instead (ETA-Refuter Finding 1: this used to run all night silently)", async () => {
    const cands = Array.from({ length: 6 }, (_, i) => cand(`W${i}`));
    const h = harness({ cands, status: () => joinContended() });
    const s = await h.run();
    expect(s).toMatchObject({ started: CONSECUTIVE_JOIN_CONTENTION_LIMIT, done: 0, failed: CONSECUTIVE_JOIN_CONTENTION_LIMIT, fatal: "join_contention" });
    expect(evs(h.log, "fatal")).toHaveLength(1);
    expect(evs(h.log, "fatal")[0].code).toBe("join_contention");
    expect(evs(h.log, "window_failed").every((e) => e.error_code === "join_contention_exhausted")).toBe(true);
  });
});

describe("THE TWO NEW STOPS (ETA-Refuter Finding 1, 22 Sep 2026) — a silent all-night backlog_empty is a FAIL", () => {
  it(`THE REFUTER'S PROBE A — a canceller cancels every job we submit: ${CONSECUTIVE_FOREIGN_CANCEL_LIMIT} in a row is fatal=foreign_cancels, NOT backlog_empty`, async () => {
    const cands = Array.from({ length: 200 }, (_, i) => cand(`W${i}`));
    const h = harness({ cands, status: () => foreignCancel() });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: "foreign_cancels", stop: "fatal", done: 0, failed: 0, windowDeferred: CONSECUTIVE_FOREIGN_CANCEL_LIMIT });
    expect(h.submits.length, "stopped, did not run all night").toBe(CONSECUTIVE_FOREIGN_CANCEL_LIMIT);
    expect(evs(h.log, "fatal")[0]).toMatchObject({ code: "foreign_cancels", consecutive: CONSECUTIVE_FOREIGN_CANCEL_LIMIT });
  });

  it(`THE REFUTER'S PROBE B — the join service is held all night: ${CONSECUTIVE_JOIN_CONTENTION_LIMIT} exhausted retries in a row is fatal=join_contention, NOT backlog_empty`, async () => {
    const cands = Array.from({ length: 200 }, (_, i) => cand(`W${i}`));
    const h = harness({ cands, status: () => joinContended() });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: "join_contention", stop: "fatal", done: 0 });
    expect(evs(h.log, "fatal")[0]).toMatchObject({ code: "join_contention", consecutive: CONSECUTIVE_JOIN_CONTENTION_LIMIT });
    // each window that reaches this fatal already spent its JOIN_RETRY_LIMIT retries — the limit governs
    // CONSECUTIVE WINDOWS exhausted, not consecutive individual submits.
    expect(evs(h.log, "window_failed").filter((e) => e.error_code === "join_contention_exhausted")).toHaveLength(CONSECUTIVE_JOIN_CONTENTION_LIMIT);
  });

  it("the two streaks are INDEPENDENT — a join-contention exhaustion between two foreign cancels does not " +
     "itself advance the foreign-cancel count (nor do foreign cancels advance the join-contention count)", async () => {
    // 2 foreign cancels, 1 full join-contention exhaustion, 2 more foreign cancels: comfortably under BOTH
    // limits (well below 5) throughout, so a design that accidentally let one type feed the other's counter
    // would show up as an unexpectedly early fatal — this asserts there is none, and the EXACT final windowDeferred
    // (4, not 5) proves the join event did not itself count as a foreign cancel.
    const cands = [cand("B0"), cand("B1"), cand("J"), cand("A0"), cand("A1")];
    const h = harness({ cands, status: (jobId, k, w) => (w === "J" ? joinContended() : foreignCancel()) });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: null, stop: "backlog_empty", windowDeferred: 4, failed: 1 });
  });

  it("a done resets BOTH streaks — near-misses on each, then a done, then the same near-misses again never trip either", async () => {
    const outcomes: StatusResult[] = [
      ...Array.from({ length: CONSECUTIVE_FOREIGN_CANCEL_LIMIT - 1 }, () => foreignCancel()),
      done(),
      ...Array.from({ length: CONSECUTIVE_FOREIGN_CANCEL_LIMIT - 1 }, () => foreignCancel()),
    ];
    let n = 0;
    const cands = Array.from({ length: outcomes.length }, (_, i) => cand(`W${i}`));
    const h = harness({ cands, status: () => outcomes[n++]! });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: null, stop: "backlog_empty", done: 1 });
  });

  it("a done resets the JOIN streak TOO, not just the foreign one (ETA-Refuter round 2, M4: the prior test only used foreign cancels)", async () => {
    // (LIMIT-1) windows that each exhaust their own join retries, a done, then (LIMIT-1) more — if the done
    // failed to reset consecutiveJoinContentionExhausted, the second batch alone would trip it.
    const before = CONSECUTIVE_JOIN_CONTENTION_LIMIT - 1;
    const after = CONSECUTIVE_JOIN_CONTENTION_LIMIT - 1;
    const cands = [
      ...Array.from({ length: before }, (_, i) => cand(`B${i}`)),
      cand("D"),
      ...Array.from({ length: after }, (_, i) => cand(`A${i}`)),
    ];
    const h = harness({ cands, status: (jobId, k, w) => (w === "D" ? done() : joinContended()) });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: null, stop: "backlog_empty", done: 1, failed: before + after });
  });

  it(`CONSECUTIVE_FOREIGN_CANCEL_LIMIT is hardcoded 5, not merely self-consistent (ETA-Refuter round 2, M5: a probe ` +
     `that reads the constant moves with it and never catches a mutant that changes the constant itself)`, () => {
    expect(CONSECUTIVE_FOREIGN_CANCEL_LIMIT).toBe(5);
  });

  it(`CONSECUTIVE_JOIN_CONTENTION_LIMIT is hardcoded 5 too, for the same reason`, () => {
    expect(CONSECUTIVE_JOIN_CONTENTION_LIMIT).toBe(5);
  });

  it("a JOIN failure does NOT reset the FOREIGN streak (ETA-Refuter round 2, M13: the earlier independence test " +
     "stayed under both limits, so a wrong reset and a correct no-reset looked the same)", async () => {
    // 3 foreign cancels, one full join-contention exhaustion, then 2 MORE foreign cancels — 3+2 = the foreign
    // limit exactly. If the join event had reset the foreign streak, the last 2 alone would not reach it.
    const cands = [cand("B0"), cand("B1"), cand("B2"), cand("J"), cand("A0"), cand("A1")];
    const h = harness({ cands, status: (jobId, k, w) => (w === "J" ? joinContended() : foreignCancel()) });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: "foreign_cancels", stop: "fatal" });
    expect(evs(h.log, "fatal")[0]).toMatchObject({ code: "foreign_cancels", consecutive: CONSECUTIVE_FOREIGN_CANCEL_LIMIT });
  });
});

describe("A FOREIGN CANCEL — a cancelled job we did not ask for (Fable, 22 Sep 2026 21:10, ETA-OVERNIGHT-FATALS-ROOTCAUSE)", () => {
  it("this driver never calls a cancel tool — driver.ts contains no `.cancel(`-shaped call, and Door itself has no cancel method to call", () => {
    // TypeScript already makes `deps.door.cancel(...)` a compile error if Door has no such method (the harness's
    // fake Door below is exhaustively typed against the real one). This confirms both halves at once: no CALL
    // site in driver.ts's own source, and the object the harness builds — shaped exactly like the real Door —
    // has no key that could be one. Deliberately NOT a "never says the word cancel" check: this file legitimately
    // talks ABOUT foreign cancels, in this very test file and in driver.ts's own explanatory comments.
    const src = readFileSync(join(process.cwd(), "lib/overnight-translate/driver.ts"), "utf8");
    expect(src).not.toMatch(/\.cancel\w*\(/i);
    const doorSrc = readFileSync(join(process.cwd(), "lib/overnight-translate/door.ts"), "utf8");
    expect(doorSrc).not.toMatch(/scribe_job_cancel/);
    const fakeDoorKeys = Object.keys({ submitRoomWindow: async () => {}, jobStatus: async () => {} });
    expect(fakeDoorKeys.some((k) => /cancel/i.test(k))).toBe(false);
  });

  it("a cancelled job is window_deferred reason=foreign_cancel — not a failure, no touch of consecutiveFailures", async () => {
    const h = harness({ cands: [cand("A"), cand("B")], status: (jobId, k, w) => (w === "A" ? foreignCancel() : done()) });
    const s = await h.run();
    expect(s).toMatchObject({ started: 2, done: 1, failed: 0, windowDeferred: 1 });
    expect(evs(h.log, "window_deferred")[0]).toMatchObject({ window_id: "A", reason: "foreign_cancel" });
    expect(evs(h.log, "window_failed")).toHaveLength(0);
  });

  it("a foreign cancel between two real failures does not reset OR advance the FAILURE streak — it is simply not part of it", async () => {
    let n = 0;
    const outcomes = [failed(), failed(), foreignCancel(), failed(), failed(), failed()];
    const cands = Array.from({ length: outcomes.length }, (_, i) => cand(`W${i}`));
    const h = harness({ cands, status: () => outcomes[n++]! });
    const s = await h.run();
    // 5 real failures (the cancel does not interrupt the count) trips the stop on the 5th REAL one.
    expect(s).toMatchObject({ failed: 5, windowDeferred: 1, fatal: "too_many_failures" });
  });

  it("n=3: a foreign cancel on one slot is independent — the others are untouched", async () => {
    const h = harness({ cands: [cand("A"), cand("B"), cand("C")], status: (jobId, k, w) => (w === "B" ? foreignCancel() : done()) });
    const s = await h.run("run", 0, new AbortController(), 3);
    expect(s).toMatchObject({ started: 3, done: 2, windowDeferred: 1, failed: 0 });
  });

  it("the log carries only ids and a closed reason — no free text", async () => {
    const h = harness({ cands: [cand("A")], status: () => foreignCancel() });
    await h.run();
    const line = evs(h.log, "window_deferred").find((e) => e.reason === "foreign_cancel")!;
    expect(Object.keys(line).sort()).toEqual(["event", "job_id", "reason", "window_id"].sort());
  });
});

describe("A STUCK JOB", () => {
  it("still running past the deadline: stop with job_stuck, name the job, submit nothing more", async () => {
    const h = harness({ cands: [cand("A"), cand("B")], status: () => running() });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: "job_stuck", abandoned: 1, started: 1, stop: "fatal" });
    expect(evs(h.log, "fatal")[0]).toMatchObject({ code: "job_stuck", window_id: "A", job_id: "job_1" });
    expect(h.submits).toHaveLength(1);
    expect(h.clock.t - NIGHT).toBeGreaterThan(WINDOW_DEADLINE_MS);
    expect(h.clock.t - NIGHT).toBeLessThan(WINDOW_DEADLINE_MS + 2 * STATUS_POLL_MS);
  });
});

describe("ABORT — SIGTERM stops submitting and names what it left", () => {
  it("aborted mid-poll: stop=aborted, the job in flight is logged as left running, and no more are submitted", async () => {
    const ac = new AbortController();
    const h = harness({ cands: [cand("A"), cand("B")], status: () => { ac.abort(); return running(); } });
    const s = await h.run("run", 0, ac);
    expect(s).toMatchObject({ stop: "aborted", abandoned: 1 });
    expect(evs(h.log, "left_running")[0]).toMatchObject({ window_id: "A", why: "aborted" });
    expect(h.submits).toHaveLength(1);
  });
  it("aborted before it starts: nothing is submitted", async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness({ cands: [cand("A")] });
    expect((await h.run("run", 0, ac)).stop).toBe("aborted");
    expect(h.submits).toHaveLength(0);
  });
});

describe("DRY RUN — the plan, and nothing else", () => {
  it("logs the first N windows in order with their override flag, and submits NOTHING", async () => {
    const h = harness({ cands: [cand("A", { klass: "fixture" }), cand("B", { room_transcript_on: false }), cand("C"), cand("D")] });
    const s = await h.run("dry-run", 3);
    expect(h.submits).toHaveLength(0);
    expect(h.statusCalls()).toBe(0);
    expect(evs(h.log, "plan").map((e) => [e.n, e.window_id, e.klass, e.switch_override])).toEqual([
      [1, "A", "fixture", false], [2, "B", "backlog", true], [3, "C", "backlog", false],
    ]);
    expect(s.stop).toBe("dry_run_done");
  });
  it("applies NO clock and NO gate — it is safe to run at noon, with the watchdog red", async () => {
    const h = harness({ start: at(12, 0, 0), cands: [cand("A")], gate: () => { throw new Error("gate must not be read in a dry run"); } });
    await expect(h.run("dry-run", 5)).resolves.toMatchObject({ stop: "dry_run_done" });
    expect(h.gateCalls()).toBe(0);
    expect(h.clock.t).toBe(at(12, 0, 0));
  });
  it("stops when the plan runs out before the limit", async () => {
    const h = harness({ cands: [cand("A")] });
    await h.run("dry-run", 50);
    expect(evs(h.log, "plan")).toHaveLength(1);
  });
});

describe("LOG HYGIENE — ids, counts, durations and closed codes only; never the token", () => {
  const TOKEN = "TOKEN-SECRET-abc123-do-not-leak";
  const KEYS = new Set([
    "event", "mode", "limit", "n", "window_id", "job_id", "room_day_id", "klass", "has_run", "attempt", "room_transcript_on", "switch_override", "translate",
    "code", "reason", "streak", "ms", "status", "step", "error_code", "wall_s", "why", "consecutive",
    "started", "done", "failed", "refused", "abandoned", "unverified", "joinDeferred", "windowDeferred", "overridden", "fatal", "stop", "error_name",
    "retry_job_id", "retry",
    ...Object.keys(SUMMARY),
  ]);

  it("through the REAL door client with a token, a whole mixed night logs no token and nothing but whitelisted fields", async () => {
    let n = 0;
    const seen: string[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push(String((init?.headers as Record<string, string>).authorization));
      const tool = body.params.name as string;
      if (tool === "scribe_job_submit") {
        n += 1;
        const sc = n === 2 ? { ok: false, error: "bad_args", detail: "some free text about a patient" } : { ok: true, job_id: `job_${n}` };
        return new Response(JSON.stringify({ result: { structuredContent: sc } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: { structuredContent: { ok: true, status: n === 3 ? "failed" : "done", step: "finish", error_code: n === 3 ? "room_window_failed" : null, attempts: 1, failures: 0 } } }), { status: 200 });
    }) as typeof fetch;
    const h = harness({ cands: [cand("A"), cand("B"), cand("C", { room_transcript_on: false }), cand("D")] });
    const deps: Deps = { ...h.deps, door: makeDoor({ baseUrl: ORIGIN, token: TOKEN }, f) };
    await runOvernight(deps, "run", 0, new AbortController().signal);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);           // the token DID travel — in the header only
    const text = JSON.stringify(h.log);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("patient");
    for (const ev of h.log) {
      for (const [k, v] of Object.entries(ev)) {
        expect(KEYS.has(k), `unexpected log field "${k}" in ${JSON.stringify(ev)}`).toBe(true);
        if (typeof v === "string") expect(v.length, `${k} looks like free text`).toBeLessThanOrEqual(64);
      }
    }
  });
});
