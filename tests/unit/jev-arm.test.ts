/**
 * tests/unit/jev-arm.test.ts — Slice J2 (ETA-JEV-ARM-D §5.4, §5.6). ARM D pure-function tests.
 * No DB, no model — `runJevArm` takes signals and cues directly. Fixtures here mirror the spec's
 * §5.6 scenarios (clean/gap/inconsistent/short/bind) in a compact, hand-computable form rather
 * than the full 60-window fixtures the spec sketches, so each threshold crossing is inspectable
 * in the test itself (see the build report for what was simplified and why).
 *
 * REFUTER F2/F3/F8 (19 Sep): tests appended below the original suite, one per finding.
 */
import { describe, it, expect, vi } from "vitest";
import { runJevArm, ETA_JEV_MIN_VISIT_WINDOWS, ETA_JEV_MAX_GAP_WINDOWS, type JevWindowSignal, type JevPhase } from "@/lib/brain/fuse/jev-arm";
import type { FuseCue } from "@/lib/brain/fuse/types";
import type { TapeSession } from "@/lib/brain/fuse/rules";

const SESSION_STARTED = "2026-08-19T04:00:00.000Z";
const SESSION_START_MS = Date.parse(SESSION_STARTED);
const SESSIONS: TapeSession[] = [{ id: "s1", started_at: SESSION_STARTED, ended_at: null }];

let n = 0;
function sig(startMs: number, over: Partial<JevWindowSignal> = {}): JevWindowSignal {
  n += 1;
  return {
    window_id: `w${String(n).padStart(3, "0")}`,
    room_day_id: "rd1",
    session_id: "s1",
    start_ms: startMs,
    end_ms: startMs + 30_000,
    phase: "non_clinical" as JevPhase,
    phase_probs: {},
    phase_confidence: 0,
    p_start: 0,
    p_end: 0,
    p_clinician: 0,
    p_clinical: 0,
    ...over,
  };
}

const epoch = (ms: number) => SESSION_START_MS + ms;

describe("J2 — arm D determinism", () => {
  it("the same signals twice give deeply equal output", () => {
    n = 0;
    const signals = [sig(0, { p_start: 0.8, p_clinical: 0.8 }), sig(30000, { p_clinical: 0.8 }), sig(60000, { p_end: 0.8, p_clinical: 0.8 })];
    const cues: FuseCue[] = [];
    const a = runJevArm(cues, signals, SESSIONS);
    const b = runJevArm(cues, signals, SESSIONS);
    expect(a).toEqual(b);
  });
});

describe("J2 — clean: explicit p_start / p_end open and close a visit", () => {
  it("emits one visit with correct tape bounds and thresholds", () => {
    n = 0;
    const signals = [
      sig(0, { p_start: 0.2, p_clinical: 0.1 }), // no visit yet
      sig(30000, { p_start: 0.85, p_clinical: 0.8, phase: "history" as JevPhase }), // opens
      sig(60000, { p_clinical: 0.8 }),
      sig(90000, { p_clinical: 0.8 }), // keeps windowCount at the opening MIN (3) before thelose a
      sig(120000, { p_end: 0.85, p_clinical: 0.7 }), // ose as
    ];
    const out = runJevArm([], signals, SESSIONS);
    expect(out.visits).toHaveLength(1);
    const v = out.visits[0]!;
    expect(v.opened_by).toBe(signals[1]!.window_id);
    expect(v.opened_by_kind).toBe("jev_window");
    expect(v.tape_start_ms).toBe(epoch(30000));
    expect(v.tape_end_ms).toBe(epoch(150000));
    expect(v.pstart_at).toBe(new Date(epoch(30000)).toISOString());
    expect(v.reasons).toContain("jev_end");
    expect(v.state).toBe("unknown"); // no uid cue to bind
    expect(out.unbound).toHaveLength(0);
  });
});

describe(`J2 — gap: ${ETA_JEV_MAX_GAP_WINDOWS} consecutive non-clinical windows close a still-open visit`, () => {
  it("ose as at the last clinical window's end, reason jev_gap", () => {
    n = 0;
    const clinical = [sig(0, { p_start: 0.8, p_clinical: 0.8 }), sig(30000, { p_clinical: 0.8 }), sig(60000, { p_clinical: 0.8 }), sig(90000, { p_clinical: 0.8 })];
    const gapWindows = Array.from({ length: ETA_JEV_MAX_GAP_WINDOWS }, (_, i) => sig(120000 + i * 30000, { p_clinical: 0.1 }));
    const out = runJevArm([], [...clinical, ...gapWindows], SESSIONS);
    expect(out.visits).toHaveLength(1);
    const v = out.visits[0]!;
    expect(v.reasons).toContain("jev_gap");
    // ose as at the end of the last CLINICAL window (w4's end = 90000+30000 = 120000), not at day end
    expect(v.tape_end_ms).toBe(epoch(120000));
  });
});

describe("J2 — inconsistency: p_start and p_end both fire in the same window while open", () => {
  it("ose as the running visit at that window's start, then opens fresh there", () => {
    n = 0;
    const visit1 = [sig(0, { p_start: 0.8, p_clinical: 0.8 }), sig(30000, { p_clinical: 0.8 }), sig(60000, { p_clinical: 0.8 })];
    const both = sig(90000, { p_start: 0.9, p_end: 0.9, p_clinical: 0.8 });
    const visit2rest = [sig(120000, { p_clinical: 0.8 }), sig(150000, { p_clinical: 0.8 })];
    const out = runJevArm([], [...visit1, both, ...visit2rest], SESSIONS);
    expect(out.visits).toHaveLength(2);
    const [v1, v2] = out.visits;
    expect(v1!.reasons).toContain("jev_start_end_same_window");
    expect(v1!.tape_end_ms).toBe(epoch(90000));
    expect(v2!.tape_start_ms).toBe(epoch(90000));
    expect(v2!.reasons).toContain("jev_start_end_same_window");
    // day ends inside visit2 — closed by day_end
    expect(v2!.reasons).toContain("day_end");
  });
});

describe(`J2 — short: fewer than ${ETA_JEV_MIN_VISIT_WINDOWS} windows is unbound, reason too_short`, () => {
  it("a 1-window blip never becomes a visit", () => {
    n = 0;
    const signals = [sig(0, { p_start: 0.8, p_clinical: 0.8 }), sig(30000, { p_end: 0.9, p_clinical: 0.7 })];
    const out = runJevArm([], signals, SESSIONS);
    expect(out.visits).toHaveLength(0);
    expect(out.unbound).toHaveLength(1);
    expect(out.unbound[0]).toMatchObject({ type: "jev_window", reason: "too_short", cue_id: signals[0]!.window_id });
  });
});

describe("J2 — bind: a consult_mark cue with individual_uid inside the tape span adopts it", () => {
  it("binds the uid, sets state in_chair, and records bound_to_cue", () => {
    n = 0;
    const signals = [sig(0, { p_start: 0.8, p_clinical: 0.8 }), sig(30000, { p_clinical: 0.8 }), sig(60000, { p_clinical: 0.8 }), sig(90000, { p_end: 0.85, p_clinical: 0.7 })];
    const cue: FuseCue = {
      id: "cue_mark_1",
      type: "consult_mark",
      at: new Date(epoch(45000)).toISOString(), // inside [tape_start_ms, tape_end_ms)
      payload: { individual_uid: "ind_abc" },
      source: "replay",
      source_ref: null,
    };
    const out = runJevArm([cue], signals, SESSIONS);
    expect(out.visits).toHaveLength(1);
    const v = out.visits[0]!;
    expect(v.state).toBe("in_chair");
    expect(v.individual_uid).toBe("ind_abc");
    expect(v.reasons).toContain(`bound_to_cue:${cue.id}`);
  });

  it("a visit with no matching cue stays uid-less and unknown", () => {
    n = 0;
    const signals = [sig(0, { p_start: 0.8, p_clinical: 0.8 }), sig(30000, { p_clinical: 0.8 }), sig(60000, { p_clinical: 0.8 }), sig(90000, { p_end: 0.85, p_clinical: 0.7 })];
    const out = runJevArm([], signals, SESSIONS);
    expect(out.visits[0]!.state).toBe("unknown");
    expect(out.visits[0]!.individual_uid).toBeNull();
  });
});

describe("J2 — no signals", () => {
  it("returns empty visits and unbound", () => {
    expect(runJevArm([], [], SESSIONS)).toEqual({ visits: [], unbound: [] });
  });
});

// =====================================================================================
// REFUTER F2 (19 Sep): the explicit-start rule fires before the gap rule.
// =====================================================================================
describe("F2 — a strong opener is never swallowed by a low p_clinical gap check", () => {
  it("3 clinical windows, then {p_start:0.95, p_clinical:0.5}, then 3 clinical → two visits", () => {
    n = 0;
    const visit1 = [sig(0, { p_start: 0.8, p_clinical: 0.8 }), sig(30000, { p_clinical: 0.8 }), sig(60000, { p_clinical: 0.8 })];
    const opener2 = sig(90000, { p_start: 0.95, p_clinical: 0.5 }); // strong opener, weak clinical
    const visit2rest = [sig(120000, { p_clinical: 0.8 }), sig(150000, { p_clinical: 0.8 }), sig(180000, { p_clinical: 0.8 })];
    const out = runJevArm([], [...visit1, opener2, ...visit2rest], SESSIONS);
    expect(out.visits).toHaveLength(2);
    expect(out.visits[1]!.opened_by).toBe(opener2.window_id);
    expect(out.visits[1]!.reasons).toContain("next_opener");
    expect(out.visits[1]!.tape_start_ms).toBe(epoch(90000));
  });
});

// =====================================================================================
// REFUTER F3 (19 Sep): a visit never spans two bench sessions.
// =====================================================================================
describe("F3 — visits never span sessions", () => {
  it("3 windows in s1, 2 in s2 an hour later close as two visits, each with its own session_id", async () => {
    vi.resetModules();
    const prevMin = process.env.ETA_JEV_MIN_VISIT_WINDOWS;
    process.env.ETA_JEV_MIN_VISIT_WINDOWS = "2"; // isolate the session-partition behaviour from the unrelated MIN_VISIT_WINDOWS floor
    const mod = await import("@/lib/brain/fuse/jev-arm");

    const S1_STARTED = "2026-08-19T04:00:00.000Z";
    const S2_STARTED = "2026-08-19T05:00:00.000Z"; // an hour later
    const sessions: TapeSession[] = [
      { id: "s1", started_at: S1_STARTED, ended_at: null },
      { id: "s2", started_at: S2_STARTED, ended_at: null },
    ];
    const mk = (id: string, session_id: string, startMs: number, over: Partial<JevWindowSignal> = {}): JevWindowSignal => ({
      window_id: id, room_day_id: "rd1", session_id, start_ms: startMs, end_ms: startMs + 30_000,
      phase: "non_clinical", phase_probs: {}, phase_confidence: 0, p_start: 0, p_end: 0, p_clinician: 0, p_clinical: 0.8,
      ...over,
    });
    const s1Signals = [mk("a1", "s1", 0, { p_start: 0.8 }), mk("a2", "s1", 30000), mk("a3", "s1", 60000)];
    const s2Signals = [mk("b1", "s2", 0, { p_start: 0.8 }), mk("b2", "s2", 30000)];

    const out = mod.runJevArm([], [...s1Signals, ...s2Signals], sessions);
    expect(out.visits).toHaveLength(2);
    expect(out.visits[0]!.session_id).toBe("s1");
    expect(out.visits[0]!.reasons).toContain("session_end");
    expect(out.visits[1]!.session_id).toBe("s2");
    expect(out.visits[1]!.reasons).toContain("day_end");
    expect(out.visits[0]!.opened_by).toBe("a1");
    expect(out.visits[1]!.opened_by).toBe("b1");

    if (prevMin === undefined) delete process.env.ETA_JEV_MIN_VISIT_WINDOWS;
    else process.env.ETA_JEV_MIN_VISIT_WINDOWS = prevMin;
    vi.resetModules();
  });
});

// =====================================================================================
// REFUTER F8 (19 Sep): phase-confidence floor is env-overridable; a gap window never grows
// windowCount; a phase-streak visit opens at the FIRST of its two qualifying windows.
// =====================================================================================
describe("F8 — ETA_JEV_T_PHASE_CONF is env-overridable", () => {
  it("raising the floor stops a phase-streak that used to qualify at the default 0.6", async () => {
    vi.resetModules();
    const prev = process.env.ETA_JEV_T_PHASE_CONF;
    process.env.ETA_JEV_T_PHASE_CONF = "0.9";
    const mod = await import("@/lib/brain/fuse/jev-arm");
    const mk = (id: string, startMs: number, over: Partial<JevWindowSignal> = {}): JevWindowSignal => ({
      window_id: id, room_day_id: "rd1", session_id: "s1", start_ms: startMs, end_ms: startMs + 30_000,
      phase: "arrival", phase_probs: {}, phase_confidence: 0.7, p_start: 0, p_end: 0, p_clinician: 0, p_clinical: 0.8,
      ...over,
    });
    const out = mod.runJevArm([], [mk("c1", 0), mk("c2", 30000)], SESSIONS);
    expect(out.visits).toHaveLength(0); // 0.7 < 0.9, streak never qualifies

    if (prev === undefined) delete process.env.ETA_JEV_T_PHASE_CONF;
    else process.env.ETA_JEV_T_PHASE_CONF = prev;
    vi.resetModules();
  });
});

describe("F8 — a gap window never increments windowCount", () => {
  it("a visit that only ever grows via gap windows stays too_short", () => {
    n = 0;
    const signals = [
      sig(0, { p_start: 0.8, p_clinical: 0.8 }), // windowCount: 1
      ...Array.from({ length: ETA_JEV_MAX_GAP_WINDOWS - 1 }, (_, i) => sig(30000 + i * 30000, { p_clinical: 0.1 })), // gaps, never absorbed
    ];
    const out = runJevArm([], signals, SESSIONS);
    expect(out.visits).toHaveLength(0);
    expect(out.unbound[0]).toMatchObject({ reason: "too_short" });
  });
});

describe("F8 — a phase-streak visit opens at the FIRST of its two qualifying windows", () => {
  it("opened_by and tape_start_ms point at window one, not window two", () => {
    n = 0;
    const w1 = sig(0, { phase: "arrival" as JevPhase, phase_confidence: 0.8, p_clinical: 0.8 });
    const w2 = sig(30000, { phase: "arrival" as JevPhase, phase_confidence: 0.8, p_clinical: 0.8 });
    const w3 = sig(60000, { p_clinical: 0.8 }); // clears MIN_VISIT_WINDOWS (windowCount seeded at 2, +1 here)
    const out = runJevArm([], [w1, w2, w3], SESSIONS);
    expect(out.visits).toHaveLength(1);
    expect(out.visits[0]!.opened_by).toBe(w1.window_id);
    expect(out.visits[0]!.tape_start_ms).toBe(epoch(0));
  });
});
