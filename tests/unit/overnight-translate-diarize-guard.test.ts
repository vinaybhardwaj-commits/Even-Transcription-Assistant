/**
 * The diarize-leak guard's decision — over/under threshold, in-flight vs idle, and the hard ceiling
 * (Fable's order, 22 Sep 2026 07:25). PURE functions only; the runner's real I/O (pgrep, top, launchctl,
 * the log tail, the state file) is not under test here, same split as gate.ts.
 */
import { describe, it, expect } from "vitest";
import {
  parseTopMemGb, driverInFlight, guardDecision, EMPTY_STATE, HARD_CEILING_STREAK, HARD_CEILING_MS,
  type GuardState, type DriverLogEvent,
} from "@/lib/overnight-translate/diarize-guard";

describe("parseTopMemGb — the tail data line of `top -l 1 -pid PID -stats mem`", () => {
  it("reads G, M and K, case-sensitive to top's own units", () => {
    expect(parseTopMemGb("Mem\n11.00G")).toBe(11);
    expect(parseTopMemGb("Mem\n512M")).toBeCloseTo(0.5, 6);
    expect(parseTopMemGb("Mem\n1024K")).toBeCloseTo(1024 / 1024 / 1024, 9);
  });
  it("strips the +/- trend marker top sometimes appends", () => {
    expect(parseTopMemGb("Mem\n7.92G-")).toBe(7.92);
    expect(parseTopMemGb("Mem\n1.17G+")).toBe(1.17);
  });
  it("reads only the LAST line — the header row above it is ignored", () => {
    expect(parseTopMemGb("Processes: 400\nMem\nPID COMMAND %CPU MEM\n0.04G")).toBe(0.04);
  });
  it("is whitespace-tolerant", () => {
    expect(parseTopMemGb("  6.50G  \n")).toBe(6.5);
    expect(parseTopMemGb("6.50 G")).toBe(6.5);
  });
  it("is null for anything it cannot read — never a silent 0 (which would look like 'under threshold')", () => {
    for (const bad of ["", "  ", "not memory", "12", "12X", "-1G", "NaNG", "Infinity G"]) {
      expect(parseTopMemGb(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("driverInFlight — reads the overnight driver's own log", () => {
  const submitted = (id: string): DriverLogEvent => ({ event: "window_submitted", job_id: id });
  const done = (id: string): DriverLogEvent => ({ event: "window_done", job_id: id });
  const failed = (id: string): DriverLogEvent => ({ event: "window_failed", job_id: id });
  const other = (event: string): DriverLogEvent => ({ event });

  it("no events at all: not in flight (idle)", () => expect(driverInFlight([])).toBe(false));

  it("a submitted job with no terminal event yet: in flight", () => {
    expect(driverInFlight([other("night_start"), submitted("job_a")])).toBe(true);
  });

  it("a submitted job that finished done: not in flight", () => {
    expect(driverInFlight([submitted("job_a"), done("job_a")])).toBe(false);
  });

  it("a submitted job that finished FAILED also frees the slot — a failure is a terminal state too", () => {
    expect(driverInFlight([submitted("job_a"), failed("job_a")])).toBe(false);
  });

  it("gate_hold with nothing ever submitted: not in flight", () => {
    expect(driverInFlight([other("start"), other("night_start"), other("gate_hold"), other("gate_hold")])).toBe(false);
  });

  it("gate_hold logged AFTER a job finished: still not in flight — the hold is about the NEXT submit, not this job", () => {
    expect(driverInFlight([submitted("job_a"), done("job_a"), other("gate_hold")])).toBe(false);
  });

  it("three jobs at once (a future concurrency>1): in flight until EVERY one has a terminal event", () => {
    const seq = [submitted("job_a"), submitted("job_b"), submitted("job_c"), done("job_a"), failed("job_b")];
    expect(driverInFlight(seq), "job_c still open").toBe(true);
    expect(driverInFlight([...seq, done("job_c")]), "all three now closed").toBe(false);
  });

  it("a done/failed event with no matching open submission is ignored, not an error", () => {
    expect(driverInFlight([done("job_ghost")])).toBe(false);
  });

  it("job_id must be a string — a malformed line (missing or non-string job_id) never opens or closes a slot", () => {
    expect(driverInFlight([{ event: "window_submitted" }])).toBe(false);
    expect(driverInFlight([{ event: "window_submitted", job_id: 123 }])).toBe(false);
  });
});

describe("guardDecision — over/under threshold, in-flight vs idle, and the hard ceiling", () => {
  const NOW = Date.parse("2026-09-22T02:00:00Z");
  const dec = (over: Partial<{ rssGb: number; thresholdGb: number; inFlight: boolean; state: GuardState; nowMs: number }> = {}) =>
    guardDecision({ nowMs: NOW, rssGb: 8, thresholdGb: 6, inFlight: false, state: EMPTY_STATE, ...over });

  it("under threshold: always skip, state resets to empty regardless of what it carried in", () => {
    const carried: GuardState = { overStreak: 5, firstOverAtMs: NOW - 100_000 };
    expect(dec({ rssGb: 5.99, thresholdGb: 6, state: carried })).toEqual({ action: "skip", reason: "under_threshold", nextState: EMPTY_STATE });
  });
  it("exactly at the threshold counts as over (>= not >)", () => {
    expect(dec({ rssGb: 6, thresholdGb: 6 }).action).toBe("restart");
  });

  it("over threshold, IDLE, first sighting: restart immediately — no need to wait for the ceiling", () => {
    expect(dec({ inFlight: false, state: EMPTY_STATE })).toEqual({ action: "restart", reason: "idle_over_threshold", nextState: EMPTY_STATE });
  });

  it("over threshold, IN FLIGHT, first sighting: skip, and the streak/timer starts", () => {
    const d = dec({ inFlight: true, state: EMPTY_STATE });
    expect(d).toEqual({ action: "skip", reason: "in_flight_over_threshold", nextState: { overStreak: 1, firstOverAtMs: NOW } });
  });

  it(`HARD CEILING (streak): ${HARD_CEILING_STREAK} consecutive over-threshold-and-in-flight checks force a restart regardless`, () => {
    let state: GuardState = EMPTY_STATE;
    let d: ReturnType<typeof guardDecision>;
    for (let i = 0; i < HARD_CEILING_STREAK - 1; i += 1) {
      d = dec({ inFlight: true, state, nowMs: NOW + i * 300_000 });
      expect(d.action, `check ${i + 1}`).toBe("skip");
      state = d.nextState;
    }
    d = dec({ inFlight: true, state, nowMs: NOW + (HARD_CEILING_STREAK - 1) * 300_000 });
    expect(d).toMatchObject({ action: "restart", reason: "hard_ceiling_streak" });
    expect(d.nextState).toEqual(EMPTY_STATE);
  });

  it("staying IDLE never needs the ceiling: idle always restarts on its own first over-threshold check", () => {
    expect(dec({ inFlight: false, state: EMPTY_STATE }).reason).toBe("idle_over_threshold");
  });

  it("HARD CEILING (elapsed), isolated from the streak ceiling: overStreak still 0 (this would be only the 2nd check), " +
     "but 30 minutes have passed since first seen over — restarts on the elapsed ceiling alone", () => {
    const firstSeen: GuardState = { overStreak: 0, firstOverAtMs: NOW - HARD_CEILING_MS };
    const d = dec({ inFlight: true, state: firstSeen, nowMs: NOW });
    expect(d).toMatchObject({ action: "restart", reason: "hard_ceiling_elapsed" });
  });

  it("just under BOTH ceilings (overStreak 0, elapsed one ms short of 30 minutes): still skips, in flight", () => {
    const almost: GuardState = { overStreak: 0, firstOverAtMs: NOW - (HARD_CEILING_MS - 1) };
    const d = dec({ inFlight: true, state: almost, nowMs: NOW });
    expect(d).toEqual({ action: "skip", reason: "in_flight_over_threshold", nextState: { overStreak: 1, firstOverAtMs: almost.firstOverAtMs } });
  });

  it("a restart clears BOTH the streak and the elapsed-timer state, not just one", () => {
    const d = dec({ inFlight: false, state: { overStreak: 1, firstOverAtMs: NOW - 60_000 } });
    expect(d.nextState).toEqual(EMPTY_STATE);
  });

  it("going back under threshold after a long streak forgets it — a leak that regrows is seen fresh, not fast-tracked", () => {
    const longStreak: GuardState = { overStreak: HARD_CEILING_STREAK - 1, firstOverAtMs: NOW - HARD_CEILING_MS + 1000 };
    expect(dec({ rssGb: 1, thresholdGb: 6, state: longStreak }).nextState).toEqual(EMPTY_STATE);
  });
});
