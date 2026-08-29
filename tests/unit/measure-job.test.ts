/**
 * Build 1 §B — the nightly job's contract, tested against a mocked database.
 *
 * THE SQL IN THIS JOB IS INFERRED. The sandbox it was built in has no live database, so these
 * tests pin the two properties that must hold whatever the real schema turns out to be:
 *
 *   1. A FAILED READ WRITES NOTHING. Not an empty measurement, not NO_AUDIO — nothing. A window
 *      whose chunks could not be read stays unmeasured and is picked up on the next pass, which
 *      is exactly what "not yet measured" already means. A confident row built from a partial
 *      answer would be indistinguishable from a real one for ever.
 *
 *   2. RERUN IS IDEMPOTENT PER WINDOW. The scan excludes windows that already have a measure
 *      row, and the write is an UPSERT on the primary key, so an overlapping cron cannot produce
 *      two answers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ text: string; values: unknown[] }> = [];
/** Queued responses, matched in call order; a thrown value is rethrown to simulate a fault. */
let responses: Array<unknown> = [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    const next = responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? []);
  },
}));

vi.mock("@/lib/r2", () => ({
  headObject: async () => ({ size: null, content_type: null }),
  getObjectBytes: async () => null,
}));

vi.mock("@/lib/whisper", () => ({
  transcribeWithWhisper: async () => ({ ok: false, error: "not_called", latency_ms: 0 }),
}));

const { runMeasureJob } = await import("@/lib/stt/measure-job");

const T0 = Date.parse("2026-08-24T06:30:00.000Z");
const T1 = T0 + 15 * 60_000;

const windowRow = {
  id: "bw_test_1", session_id: "bs_test", room_id: "room_card",
  start_ms: String(T0), end_ms: String(T1), source_mic: "primary",
};

const verifiedChunk = (peak: number | null) => ({
  started_at: new Date(T0).toISOString(),
  ended_at: new Date(T1).toISOString(),
  upload_state: "verified",
  peak_level: peak,
  gap_before_ms: 0,
});

beforeEach(() => {
  calls.length = 0;
  responses = [];
});

const silent = () => {};

describe("a failed read writes nothing", () => {
  it("a chunk read that throws skips the window — it does NOT record NO_AUDIO", async () => {
    responses = [
      [windowRow],                       // window scan
      new Error("column peak_level does not exist"), // chunk read FAILS
    ];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.scanned).toBe(1);
    expect(r.measured).toBe(0);
    expect(r.skipped_unreadable).toBe(1);
    // The decisive assertion: no INSERT of any kind reached the database.
    expect(calls.some((c) => c.text.includes("INSERT INTO stt_window_measure"))).toBe(false);
  });

  it("a window scan that throws degrades to an empty pass, never a 500", async () => {
    responses = [new Error("relation stt_window_measure does not exist")];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.scanned).toBe(0);
    expect(r.measured).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("an unreadable transcription_run still measures the window, with NO opinions", async () => {
    responses = [
      [windowRow],
      [verifiedChunk(0.5)],
      new Error("metrics_json is not jsonb"), // run read FAILS
      [],                                     // the measure INSERT
      [],                                     // the cue read
    ];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.measured).toBe(1);
    const insert = calls.find((c) => c.text.includes("INSERT INTO stt_window_measure"));
    expect(insert).toBeDefined();
    // opinions_present must say 0 — missing evidence, never agreement.
    expect(insert!.values).toContain(0);
    expect(insert!.values).toContain(null);
  });

  it("a window with unreadable bounds is skipped rather than measured as zero", async () => {
    responses = [[{ ...windowRow, start_ms: "not-a-number", end_ms: "also-not" }]];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.skipped_unreadable).toBe(1);
    expect(r.measured).toBe(0);
    expect(calls.some((c) => c.text.includes("INSERT INTO stt_window_measure"))).toBe(false);
  });
});

describe("idempotence is structural, not careful", () => {
  it("the scan EXCLUDES windows that already carry a measurement", async () => {
    responses = [[]];
    await runMeasureJob({ log: silent, skipFork: true });
    const scan = calls[0]!.text;
    expect(scan).toContain("NOT EXISTS");
    expect(scan).toContain("stt_window_measure");
  });

  it("the measure write is an UPSERT on the window primary key — a second writer cannot duplicate", async () => {
    responses = [[windowRow], [verifiedChunk(0.5)], [{ metrics_json: {} }], [], []];
    await runMeasureJob({ log: silent, skipFork: true });
    const insert = calls.find((c) => c.text.includes("INSERT INTO stt_window_measure"))!;
    expect(insert.text).toContain("ON CONFLICT (window_id) DO UPDATE");
  });

  it("the score write is an UPSERT on (window_id, engine_key)", async () => {
    responses = [
      [windowRow],
      [verifiedChunk(0.0001)],
      [{ metrics_json: { probe_language: "english" } }],
      [],
      [{ engine: "whisper", start_ms: String(T0 + 1000), end_ms: String(T0 + 5000), text: "hello" }],
      [],
    ];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.scores_written).toBe(1);
    const score = calls.find((c) => c.text.includes("INSERT INTO stt_window_score"))!;
    expect(score.text).toContain("ON CONFLICT (window_id, engine_key) DO UPDATE");
  });
});

describe("a quarantined window is never scored", () => {
  it("below the floor, the job does not even read the cues", async () => {
    responses = [
      [windowRow],
      [verifiedChunk(null)],           // all unknown → NO_LEVELS, m = 0
      [{ metrics_json: {} }],
      [],                              // the measure INSERT
    ];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.measured).toBe(1);
    expect(r.quarantined.NO_LEVELS).toBe(1);
    expect(r.scores_written).toBe(0);
    expect(calls.some((c) => c.text.includes("stt_turn"))).toBe(false);
  });
});

describe("the coverage report is the job's first honest output", () => {
  it("level coverage is NULL when nothing was covered — not 0%", async () => {
    responses = [[]];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.coverage.level_coverage).toBeNull();
  });

  it("coverage is the measured fraction of covered time", async () => {
    responses = [[windowRow], [verifiedChunk(0.5)], [{ metrics_json: {} }], [], []];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.coverage.level_coverage).toBe(1);
    expect(r.coverage.energy_ms).toBe(15 * 60_000);
  });

  it("every pass names the instrument that produced it", async () => {
    responses = [[]];
    const r = await runMeasureJob({ log: silent, skipFork: true });
    expect(r.proxy_version).toBe("window-measure-v1");
  });
});

describe("the fork step cannot take the pass down", () => {
  it("an absent clip is a clean no-op inside a real pass", async () => {
    responses = [[]];
    const r = await runMeasureJob({ log: silent });
    expect(r.fork.kind).toBe("absent");
  });
});
