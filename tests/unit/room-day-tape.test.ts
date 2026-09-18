/**
 * S1 - the room-day tape (ETA-S1-ROOM-DAY-TAPE-SPEC-v1.0 section 7).
 *
 * assembleTape/buildSlotGrid/computeDrainReachable/toAbsoluteMs/parseTurnSourceRef are pure and
 * need no database. getRoomDayTape's own DB layer (the gate tests 6/7, and the NULL-room_day_id
 * fallback in 5) runs against the same fake-pg-over-`@/lib/db` harness shape as
 * tests/unit/fuse-arms.test.ts: the mock records every call's reconstructed SQL text and routes
 * it to a fixture table by the FROM clause, so test 6 can assert on the CALL LIST, not just the
 * output.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeClinician } from "../support/fake-identity";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };

type Fixture = {
  room: Row[];
  room_day: Row[];
  bench_session: Row[];
  bench_window: Row[];
  room_diarize_window: Row[];
  transcription_run: Row[];
  room_turn_speaker: Row[];
  room_emotion_window: Row[];
  room_span_emotion: Row[];
  clinician: Row[];
};

function emptyFixture(): Fixture {
  return {
    room: [],
    room_day: [],
    bench_session: [],
    bench_window: [],
    room_diarize_window: [],
    transcription_run: [],
    room_turn_speaker: [],
    room_emotion_window: [],
    room_span_emotion: [],
    clinician: [],
  };
}

let calls: Call[] = [];
let fixture: Fixture = emptyFixture();

// Order matters only in that every branch below is a DISTINCT substring of the real query text
// (lib/room-day/admin.ts) - "FROM room " (trailing space) is checked last so it never matches
// "FROM room_day" / "FROM room_diarize_window" / "FROM room_turn_speaker" / "FROM room_emotion_window"
// / "FROM room_span_emotion", none of which have a space after "room".
function routeFor(text: string): keyof Fixture | null {
  if (text.includes("FROM room_span_emotion")) return "room_span_emotion";
  if (text.includes("FROM room_diarize_window")) return "room_diarize_window";
  if (text.includes("FROM room_emotion_window")) return "room_emotion_window";
  if (text.includes("FROM room_turn_speaker")) return "room_turn_speaker";
  if (text.includes("FROM room_day")) return "room_day";
  if (text.includes("FROM bench_session")) return "bench_session";
  if (text.includes("FROM bench_window")) return "bench_window";
  if (text.includes("FROM transcription_run")) return "transcription_run";
  if (text.includes("FROM clinician")) return "clinician";
  if (text.includes("FROM room ")) return "room";
  return null;
}

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("");
    calls.push({ text, values });
    const key = routeFor(text);
    return Promise.resolve(key ? fixture[key] : []);
  },
}));

import {
  SLOT_MS,
  assembleTape,
  buildSlotGrid,
  computeDrainReachable,
  toAbsoluteMs,
  parseTurnSourceRef,
  getRoomDayTape,
  type AssembleTapeInput,
  type RawBenchWindowRow,
  type RawTurnRow,
} from "@/lib/room-day/admin";

beforeEach(() => {
  calls = [];
  fixture = emptyFixture();
});

// ---------------------------------------------------------------------------
// Fixtures for the pure assembleTape tests
// ---------------------------------------------------------------------------

const ROOM = { id: "room_1", name: "OPD 4 - Ortho", slug: "opd-4-ortho" };

function baseInput(overrides: Partial<AssembleTapeInput> = {}): AssembleTapeInput {
  return {
    room: ROOM,
    ist_date: "2026-09-18",
    roomDay: { id: "rd_1", doctor_id: null, started_at: null, ended_at: null },
    spanStartMs: 0,
    spanEndMs: SLOT_MS,
    windows: [],
    diarizeRows: [],
    transcriptRows: [],
    turnRows: [],
    emotionWindowRows: [],
    spanEmotionRows: [],
    clinicianNames: {},
    emotion: { compute_enabled: false, surface_enabled: false },
    nowMs: SLOT_MS * 1000,
    autoDrainMaxAgeHours: 6,
    ...overrides,
  };
}

function win(overrides: Partial<RawBenchWindowRow> = {}): RawBenchWindowRow {
  return {
    id: "bw_1",
    session_id: "bs_1",
    room_day_id: "rd_1",
    start_ms: 0,
    end_ms: SLOT_MS,
    source_mic: "primary",
    grid_aligned: true,
    state: "closed",
    closed_at: null,
    auto_drain_refused_at: null,
    auto_drain_refused_reason: null,
    ...overrides,
  };
}

function turn(overrides: Partial<RawTurnRow> = {}): RawTurnRow {
  return {
    window_id: "bw_1",
    source_ref: "bs_1|0|1000|0",
    speaker_idx: 0,
    cluster_id: null,
    cue_text: "hello",
    cue_start_ms: 0,
    cue_end_ms: 1000,
    clinician_id: null,
    role: null,
    match_confidence: null,
    no_role_reason: "no_match",
    losing_clinician_id: null,
    losing_score: null,
    score_basis: null,
    ...overrides,
  };
}

// ===========================================================================
// 1 - gaps are derived at read time, against a fresh clock (D-11 / section 5.4)
// ===========================================================================

describe("1 - no_recording fills the holes; the slot count is the span over 15 minutes", () => {
  it("a 3-slot span with a window in slot 0 and slot 2 leaves slot 1 as no_recording", () => {
    const tape = assembleTape(
      baseInput({
        spanStartMs: 0,
        spanEndMs: SLOT_MS * 3,
        windows: [win({ id: "bw_0", start_ms: 0, end_ms: SLOT_MS }), win({ id: "bw_2", start_ms: SLOT_MS * 2, end_ms: SLOT_MS * 3 })],
      }),
    );
    expect(tape.totals.slots).toBe(3);
    expect(tape.slots.map((s) => s.kind)).toEqual(["window", "no_recording", "window"]);
    expect(buildSlotGrid(0, SLOT_MS * 3)).toHaveLength(3);
  });
});

// ===========================================================================
// 2 - the six bench_window states each survive distinctly (section 5.3)
// ===========================================================================

describe("2 - the six bench_window states each render as themselves", () => {
  const STATES = ["open", "closed", "transcribing", "transcribed", "failed", "silent"] as const;

  it.each(STATES)("state=%s is not collapsed into another state", (state) => {
    const tape = assembleTape(baseInput({ windows: [win({ state })] }));
    const slot = tape.slots[0]!;
    expect(slot.kind).toBe("window");
    expect(slot.kind === "window" ? slot.window.state : null).toBe(state);
  });

  it("all six produce six distinct rendered states - none collapses into another", () => {
    const rendered = STATES.map((state) => {
      const tape = assembleTape(baseInput({ windows: [win({ state })] }));
      const slot = tape.slots[0]!;
      return slot.kind === "window" ? slot.window.state : null;
    });
    expect(new Set(rendered).size).toBe(6);
  });
});

// ===========================================================================
// 3 - drain_reachable, on an injected clock (section 5.5)
// ===========================================================================

describe("3 - drain_reachable respects AUTO_DRAIN_MAX_AGE_HOURS on an injected clock", () => {
  it("closed + older than the max age => unreachable; closed + inside it => reachable", () => {
    const maxAgeHours = 6;
    const nowMs = 1_700_000_000_000;
    const insideMs = nowMs - (maxAgeHours * 60 * 60 * 1000 - 60_000);
    const outsideMs = nowMs - (maxAgeHours * 60 * 60 * 1000 + 60_000);
    expect(computeDrainReachable("closed", insideMs, nowMs, maxAgeHours)).toBe(true);
    expect(computeDrainReachable("closed", outsideMs, nowMs, maxAgeHours)).toBe(false);
  });

  it("only `closed` is ever reachable - every other state reads false regardless of age", () => {
    const nowMs = 1_700_000_000_000;
    for (const state of ["open", "transcribing", "transcribed", "failed", "silent"]) {
      expect(computeDrainReachable(state, nowMs - 60_000, nowMs, 6)).toBe(false);
    }
  });

  it("end to end through assembleTape", () => {
    const nowMs = 1_700_000_000_000;
    const outsideMs = nowMs - 7 * 60 * 60 * 1000;
    const tape = assembleTape(
      baseInput({ nowMs, autoDrainMaxAgeHours: 6, windows: [win({ state: "closed", start_ms: outsideMs, end_ms: outsideMs + SLOT_MS })] }),
    );
    const slot = tape.slots[0]!;
    expect(slot.kind === "window" && slot.window.drain_reachable).toBe(false);
  });
});

// ===========================================================================
// 4 - a diarize segment is shifted by the window start_ms EXACTLY ONCE
// ===========================================================================

describe("4 - toAbsoluteMs shifts a clip-relative diarize segment onto the wall clock, once", () => {
  it("a segment at clip-relative 0 becomes exactly the window start", () => {
    const windowStartMs = 1_758_160_800_000;
    expect(toAbsoluteMs(0, windowStartMs)).toBe(windowStartMs);
  });

  it("a non-zero offset lands at windowStart + offset, not windowStart*2 or anything doubled", () => {
    const windowStartMs = 1_758_160_800_000;
    expect(toAbsoluteMs(5_000, windowStartMs)).toBe(windowStartMs + 5_000);
    // Applying it a SECOND time would be the double-add this function exists to prevent. This
    // library never does that; the assertion documents what "wrong" would look like.
    expect(toAbsoluteMs(toAbsoluteMs(0, windowStartMs) - windowStartMs, windowStartMs)).toBe(windowStartMs);
  });
});

// ===========================================================================
// 5 - a NULL room_day_id window is still placed, via bench_session + IST-date
// ===========================================================================

describe("5 - a NULL room_day_id window survives via the bench_session + IST-date fallback", () => {
  it("the orphaned window is placed in its slot on the tape", async () => {
    const dayStart = Date.parse("2026-01-01T00:00:00.000Z");
    fixture.room = [{ id: "room_1", slug: "opd-4-ortho", name: "OPD 4 - Ortho" }];
    fixture.room_day = [{ id: "rd_1", doctor_id: null, started_at: "2026-01-01T00:00:00.000Z", ended_at: null }];
    fixture.bench_session = [{ id: "bs_1", started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T01:00:00.000Z" }];
    fixture.bench_window = [
      {
        id: "bw_orphan",
        session_id: "bs_1",
        room_day_id: null,
        start_ms: dayStart + SLOT_MS,
        end_ms: dayStart + SLOT_MS * 2,
        source_mic: "primary",
        grid_aligned: true,
        state: "closed",
        closed_at: null,
        auto_drain_refused_at: null,
        auto_drain_refused_reason: null,
      },
    ];

    const tape = await getRoomDayTape("room_1", "2026-01-01", { now: () => dayStart + 10_000_000, env: {} });
    expect(tape).not.toBeNull();
    expect(tape!.totals.windows).toBe(1);
    const windowSlot = tape!.slots.find((s) => s.kind === "window");
    expect(windowSlot).toBeDefined();
    expect(windowSlot!.kind === "window" ? windowSlot!.window.id : null).toBe("bw_orphan");
  });
});

// ===========================================================================
// 6 - gate FALSE: emotion is null on every turn, and room_span_emotion is NEVER queried
// ===========================================================================

describe("6 - the emotion gate is checked BEFORE the query", () => {
  it("gate off => every turn.emotion is null AND no call ever names room_span_emotion", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    fixture.room = [{ id: "room_1", slug: "s", name: "N" }];
    fixture.room_day = [{ id: "rd_1", doctor_id: null, started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:15:00.000Z" }];
    fixture.bench_session = [{ id: "bs_1", started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:15:00.000Z" }];
    fixture.bench_window = [
      {
        id: "bw_1",
        session_id: "bs_1",
        room_day_id: "rd_1",
        start_ms: t0,
        end_ms: t0 + SLOT_MS,
        source_mic: "primary",
        grid_aligned: true,
        state: "transcribed",
        closed_at: null,
        auto_drain_refused_at: null,
        auto_drain_refused_reason: null,
      },
    ];
    fixture.room_turn_speaker = [
      {
        window_id: "bw_1",
        source_ref: "bs_1|0|1000|0",
        speaker_idx: 0,
        cluster_id: null,
        clinician_id: null,
        role: null,
        match_confidence: null,
        no_role_reason: "no_match",
        losing_clinician_id: null,
        losing_score: null,
        score_basis: null,
        cue_text: "hello",
        cue_start_ms: t0,
        cue_end_ms: t0 + 1000,
      },
    ];

    const tape = await getRoomDayTape("room_1", "2026-01-01", { now: () => t0 + SLOT_MS * 2, env: {} });
    expect(tape).not.toBeNull();
    expect(tape!.emotion).toEqual({ compute_enabled: false, surface_enabled: false });
    const windowSlot = tape!.slots.find((s) => s.kind === "window")!;
    const turns = windowSlot.kind === "window" ? windowSlot.window.turns : [];
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((t) => t.emotion === null)).toBe(true);
    expect(calls.some((c) => c.text.includes("FROM room_span_emotion"))).toBe(false);
  });
});

// ===========================================================================
// 7 - gate TRUE: emotion joins through source_refs @> ARRAY[source_ref]
// ===========================================================================

describe("7 - gate true joins emotion to the right turn through source_refs", () => {
  it("a run over two source_refs reaches both turns; a row with no source_refs matches none", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    fixture.room = [{ id: "room_1", slug: "s", name: "N" }];
    fixture.room_day = [{ id: "rd_1", doctor_id: null, started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:15:00.000Z" }];
    fixture.bench_session = [{ id: "bs_1", started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:15:00.000Z" }];
    fixture.bench_window = [
      {
        id: "bw_1",
        session_id: "bs_1",
        room_day_id: "rd_1",
        start_ms: t0,
        end_ms: t0 + SLOT_MS,
        source_mic: "primary",
        grid_aligned: true,
        state: "transcribed",
        closed_at: null,
        auto_drain_refused_at: null,
        auto_drain_refused_reason: null,
      },
    ];
    const mkTurn = (ref: string, s: number, e: number) => ({
      window_id: "bw_1",
      source_ref: ref,
      speaker_idx: 0,
      cluster_id: null,
      clinician_id: null,
      role: null,
      match_confidence: null,
      no_role_reason: "no_match",
      losing_clinician_id: null,
      losing_score: null,
      score_basis: null,
      cue_text: ref,
      cue_start_ms: s,
      cue_end_ms: e,
    });
    fixture.room_turn_speaker = [
      mkTurn("ref_a", t0, t0 + 1000),
      mkTurn("ref_b", t0 + 1000, t0 + 2000),
      mkTurn("ref_c", t0 + 2000, t0 + 3000),
    ];
    fixture.room_span_emotion = [
      {
        window_id: "bw_1",
        source_refs: ["ref_a", "ref_b"],
        top_label: "neutral",
        top_score: 0.8,
        speech_ms: 1200,
        speech_basis: "diarize_segments",
        anger: 0.01,
        disgust: 0.01,
        enthusiasm: 0.02,
        fear: 0.01,
        happiness: 0.1,
        neutral: 0.8,
        sadness: 0.05,
      },
      {
        window_id: "bw_1",
        source_refs: [],
        top_label: "sadness",
        top_score: 0.5,
        speech_ms: 0,
        speech_basis: "diarize_segments",
        anger: 0,
        disgust: 0,
        enthusiasm: 0,
        fear: 0,
        happiness: 0,
        neutral: 0,
        sadness: 0.5,
      },
    ];

    const tape = await getRoomDayTape("room_1", "2026-01-01", {
      now: () => t0 + SLOT_MS * 2,
      env: { EMOTION_ENABLED: "1", EMOTION_SURFACE_ENABLED: "1" },
    });
    expect(tape).not.toBeNull();
    expect(tape!.emotion).toEqual({ compute_enabled: true, surface_enabled: true });
    const windowSlot = tape!.slots.find((s) => s.kind === "window")!;
    const turns = windowSlot.kind === "window" ? windowSlot.window.turns : [];
    const byRef = Object.fromEntries(turns.map((t) => [t.source_ref, t]));
    expect(byRef.ref_a?.emotion?.top_label).toBe("neutral");
    expect(byRef.ref_b?.emotion?.top_label).toBe("neutral");
    expect(byRef.ref_c?.emotion).toBeNull();
    expect(calls.some((c) => c.text.includes("FROM room_span_emotion"))).toBe(true);
  });
});

// ===========================================================================
// 8 - an unnamed turn's losing score is never relabelled as a confidence
// ===========================================================================

describe("8 - losing_clinician_id/losing_score render on an unnamed turn", () => {
  it("renders both, and match_confidence stays null - no 'confidence' alias exists", () => {
    const fakeClinician = makeFakeClinician(9);
    const tape = assembleTape(
      baseInput({
        windows: [win({ state: "transcribed" })],
        turnRows: [turn({ losing_clinician_id: fakeClinician.id, losing_score: 0.61, score_basis: "app_recomputed" })],
        clinicianNames: { [fakeClinician.id]: fakeClinician.label },
      }),
    );
    const slot = tape.slots[0]!;
    expect(slot.kind).toBe("window");
    const t = slot.kind === "window" ? slot.window.turns[0] : undefined;
    expect(t).toBeDefined();
    expect(t!.voice.losing_clinician_id).toBe(fakeClinician.id);
    expect(t!.voice.losing_clinician_name).toBe(fakeClinician.label);
    expect(t!.voice.losing_score).toBe(0.61);
    expect(t!.voice.match_confidence).toBeNull();
    expect(t!.voice).not.toHaveProperty("confidence");
    expect(t!.voice).not.toHaveProperty("losing_confidence");
  });
});

// ===========================================================================
// 9 - the real production shape: transcript_english NULL, detected_language NULL
// ===========================================================================

describe("9 - transcript_english/detected_language NULL still yields a transcript", () => {
  it("text comes from transcript_original; language comes from metrics_json", () => {
    const tape = assembleTape(
      baseInput({
        windows: [win({ state: "transcribed" })],
        transcriptRows: [
          {
            window_id: "bw_1",
            engine: "sarvam",
            error: null,
            latency_ms: 1234,
            transcript_original: "namaste doctor",
            metrics_json: { full_window_language: "hi", activity: "speech", audio_seconds: 900, segment_count: 12 },
          },
        ],
      }),
    );
    const slot = tape.slots[0]!;
    const transcript = slot.kind === "window" ? slot.window.transcript : null;
    expect(transcript?.text).toBe("namaste doctor");
    expect(transcript?.language).toBe("hi");
    expect(transcript?.audio_seconds).toBe(900);
  });
});

// ===========================================================================
// Bonus - parseTurnSourceRef, the fallback timing source when a cue join misses
// ===========================================================================

describe("parseTurnSourceRef decodes the turn's own natural key", () => {
  it("both ms values are already absolute - {session}|{start}|{end}|{speaker}", () => {
    expect(parseTurnSourceRef("bs_xvntaugh|1755576000000|1755576004320|-")).toEqual({
      session_id: "bs_xvntaugh",
      start_ms: 1755576000000,
      end_ms: 1755576004320,
      speaker: "-",
    });
    expect(parseTurnSourceRef("not-shaped")).toBeNull();
  });
});
