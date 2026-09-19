/**
 * tests/unit/jev-arm.test.ts — Slice J2 (ETA-JEV-ARM-D §5.4, §5.6). ARM D pure-function tests.
 * No DB, no model — `runJevArm` takes signals and cues directly. Fixtures here mirror the spec's
 * §5.6 scenarios (clean/gap/inconsistent/short/bind) in a compact, hand-computable form rather
 * than the full 60-window fixtures the spec sketches, so each threshold crossing is inspectable
 * in the test itself (see the build report for what was simplified and why).
 */
import { describe, it, expect } from "vitest";
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
