/**
 * The E-shadow run (lib/encounter-clock/shadow.ts + shadow-io.ts).
 *
 * The three the order names, and the one that matters most is the last: NO TABLE OUTSIDE THE TWO E-5
 * TABLES IS WRITTEN. That is asserted against every statement the run causes, not read off the code.
 * `sql` is mocked; no database, no audio, no STT.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] = () => [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(responder(text, values));
  },
}));

import { runShadow, checkTriggers, toInterval, SHADOW_VERSION, type DayEvidence, type ShadowSummary } from "@/lib/encounter-clock/shadow";
import { runShadowForRoomDay, tapeFromChunks, timelineOf, loadDayEvidence } from "@/lib/encounter-clock/shadow-io";
import { SMOOTHER_VERSION, type Encounter } from "@/lib/encounter-clock/smooth";
import { GATE_VERSION } from "@/lib/encounter-clock/gate";
import type { BenchLevelSample } from "@/lib/bench-levels";

const T0 = Date.parse("2026-09-23T03:30:00.000Z");           // 09:00 IST
const MIN = 60_000;
/** Level samples every 2 s across [a, b), loud enough to read active unless told otherwise. */
const levels = (a: number, b: number, peak = 0.07, zero = 0): BenchLevelSample[] => {
  const out: BenchLevelSample[] = [];
  for (let t = a; t < b; t += 2_000) out.push({ t_ms: t, peak, avg: null, zero_ratio: zero, session_open: true, tape_advancing: true, samples: 1 });
  return out;
};
/** A transcribed window whose text is one line per timeline span, as the router joins it. */
const windowWith = (start: number, lines: string[]) => ({
  start_ms: start, end_ms: start + 15 * MIN, text: lines.join("\n"),
  timeline: lines.map((l, i) => ({ start_s: i * 60, end_s: i * 60 + 55, chars: l.length })),
});
const evidence = (over: Partial<DayEvidence> = {}): DayEvidence => ({
  room_day_id: "rd_test", day_start_ms: T0, day_end_ms: T0 + 60 * MIN,
  level_samples: levels(T0, T0 + 60 * MIN), tape_off: [],
  windows: [windowWith(T0, ["the patient reports chest pain since monday", "and the cough has not settled"])],
  ...over,
});

beforeEach(() => { calls.length = 0; responder = () => []; });

describe("E-shadow — the pure run", () => {
  it("produces an E-5 run stamped with the versions and the constants it actually used", () => {
    const { run, summary } = runShadow(evidence());
    expect(run.room_day_id).toBe("rd_test");
    expect(run.smoother_version).toBe(SMOOTHER_VERSION);
    expect(run.gate_version).toBe(GATE_VERSION);
    expect(run.params).toMatchObject({
      shadow_version: SHADOW_VERSION, probe_s: 180, hop_s: 60,
      energy_source: "bench_level_sample", transcripts: "stored_only_no_stt",
    });
    expect(run.probes.speech + run.probes.non_speech + run.probes.unjudged).toBe(run.probes.total);
    expect(summary.probes.total).toBe(run.probes.total);
  });

  it("NO TRANSCRIPT: every probe is unjudged, no encounter, and nothing is invented", () => {
    const { run, summary } = runShadow(evidence({ windows: [] }));
    expect(run.probes.speech).toBe(0);
    expect(run.probes.non_speech).toBe(0);
    expect(run.probes.unjudged).toBe(run.probes.total);
    expect(run.intervals).toEqual([]);
    expect(summary.unjudged_share).toBe(1);
    expect(summary.reasons.no_transcript_evidence).toBe(run.probes.total);
  });

  it("a window whose text cannot be placed on the clock is MISSING evidence, not empty text", () => {
    const bad = { ...windowWith(T0, ["a b c"]), timeline: [{ start_s: 0, end_s: 10, chars: 999 }] };
    const { run, summary } = runShadow(evidence({ windows: [bad] }));
    expect(summary.windows).toMatchObject({ with_text: 1, placed: 0, unplaceable: 1 });
    expect(run.probes.unjudged).toBe(run.probes.total);
  });

  it("with text and an active level log it finds an encounter, and the interval matches the store's shape", () => {
    const { run, summary } = runShadow(evidence());
    expect(summary.encounters).toBeGreaterThan(0);
    const i = run.intervals[0]!;
    expect(i.end_ms).toBeGreaterThan(i.start_ms);
    expect(i.identity).toBeNull();                              // E-3 has not run: no clinician is named
    expect(Object.keys(i).sort()).toEqual([
      "closed_by", "dead_mic_ms", "doctor_present", "end_ms", "identity", "longest_unjudged_run_ms",
      "merged_from", "non_speech_probes", "speech_probes", "start_ms", "unjudged_ms",
    ]);
  });

  it("a dead mic in the level log never becomes speech", () => {
    const { run } = runShadow(evidence({ level_samples: levels(T0, T0 + 60 * MIN, 0.07, 0.99) }));
    expect(run.probes.speech).toBe(0);
    expect(run.intervals).toEqual([]);
  });

  it("each probe is judged on ITS OWN slice of the level log, not the day's", () => {
    // Loud for the first half, mic dead for the second. Handing the gate the whole day would median
    // the two together and no probe would read dead — the day would look uniformly alive.
    const half = T0 + 30 * MIN;
    const ev = evidence({
      level_samples: [...levels(T0, half, 0.07, 0), ...levels(half, T0 + 60 * MIN, 0.07, 0.99)],
      windows: [windowWith(T0, ["the patient reports chest pain since monday"]), windowWith(half, ["breathe in for me please"])],
    });
    const { summary } = runShadow(ev);
    expect(summary.reasons.dead_mic ?? 0).toBeGreaterThan(0);          // the dead half is seen as dead
    expect((summary.reasons.speech ?? 0) + (summary.reasons.no_text ?? 0)).toBeGreaterThan(0);  // the live half is not
    expect(summary.preselect.skip_dead_mic ?? 0).toBeGreaterThan(0);   // and the scheduler saw it too
  });

  it("toInterval carries the smoother's record across and drops only its version stamp", () => {
    const e: Encounter = {
      version: SMOOTHER_VERSION, start_ms: 1, end_ms: 2, speech_probes: 3, non_speech_probes: 4,
      unjudged_ms: 5, longest_unjudged_run_ms: 6, dead_mic_ms: 7, doctor_present: { yes: 1, no: 2, unknown: 3 },
      closed_by: "non_speech", merged_from: 1,
    };
    expect(toInterval(e)).toEqual({ ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== "version")), identity: null });
  });
});

describe("E-shadow — the rollback triggers travel with the run", () => {
  type Base = Omit<ShadowSummary, "triggers" | "triggers_tripped">;
  const base: Base = {
    room_day_id: "rd", shadow_version: SHADOW_VERSION, gate_version: GATE_VERSION, smoother_version: SMOOTHER_VERSION,
    probes: { total: 10, speech: 5, non_speech: 3, unjudged: 2 }, unjudged_share: 0.2, reasons: {}, preselect: {},
    windows: { with_text: 2, placed: 2, unplaceable: 0 }, encounters: 3, median_minutes: 20, longest_minutes: 40,
    closed_by: {},
  };
  const trip = (s: Partial<Base>) =>
    checkTriggers({ ...base, ...s }).filter((t) => t.tripped).map((t) => t.trigger);

  it("a clean run trips nothing", () => { expect(trip({})).toEqual([]); });
  it("an encounter over 2 h trips, at 121 minutes and not at 120", () => {
    expect(trip({ longest_minutes: 121 })).toContain("encounter_over_2h");
    expect(trip({ longest_minutes: 120 })).toEqual([]);
  });
  it("unjudged over 90% trips, at 0.91 and not at 0.90", () => {
    expect(trip({ unjudged_share: 0.91 })).toContain("unjudged_over_90pct");
    expect(trip({ unjudged_share: 0.9 })).toEqual([]);
  });
  it("a median over an hour, more than 15 encounters, and none at all on a day that had text", () => {
    expect(trip({ median_minutes: 61 })).toContain("median_over_60min");
    expect(trip({ encounters: 16 })).toContain("encounters_over_15");
    expect(trip({ encounters: 0, median_minutes: null, longest_minutes: null })).toContain("no_encounters_on_a_day_with_transcripts");
    expect(trip({ encounters: 0, median_minutes: null, longest_minutes: null, windows: { with_text: 0, placed: 0, unplaceable: 0 } }))
      .not.toContain("no_encounters_on_a_day_with_transcripts");
  });
});

describe("E-shadow — tape and timeline from what is stored", () => {
  it("tapeFromChunks finds the recorded day and the gaps wider than 5 s", () => {
    const iso = (t: number) => new Date(t).toISOString();
    const t = tapeFromChunks([
      { started_at: iso(T0), ended_at: iso(T0 + 5 * MIN) },
      { started_at: iso(T0 + 5 * MIN + 1_000), ended_at: iso(T0 + 10 * MIN) },   // 1 s: same tape
      { started_at: iso(T0 + 30 * MIN), ended_at: iso(T0 + 35 * MIN) },           // 20 min: tape-off
    ])!;
    expect(t.day_start_ms).toBe(T0);
    expect(t.day_end_ms).toBe(T0 + 35 * MIN);
    expect(t.tape_off).toEqual([{ start_ms: T0 + 10 * MIN, end_ms: T0 + 30 * MIN }]);
  });
  it("no chunks at all is no recorded day, not an empty one", () => {
    expect(tapeFromChunks([])).toBeNull();
  });
  it("timelineOf takes only well-formed spans and returns null when there are none", () => {
    expect(timelineOf({ spans: [{ start_s: 0, end_s: 1, chars: 5 }, { start_s: 2, chars: 3 }] })).toEqual([{ start_s: 0, end_s: 1, chars: 5 }]);
    expect(timelineOf('{"spans":[{"start_s":0,"end_s":1,"chars":5}]}')).toEqual([{ start_s: 0, end_s: 1, chars: 5 }]);
    expect(timelineOf(null)).toBeNull();
    expect(timelineOf({ spans: [] })).toBeNull();
    expect(timelineOf("not json")).toBeNull();
  });
});

describe("E-shadow — the write path", () => {
  const iso = (t: number) => new Date(t).toISOString();
  /** A day with chunks, one transcribed window, and level samples. */
  const wire = (opts: { previousRun?: string | null } = {}) => {
    responder = (text, values) => {
      if (/FROM bench_chunk/i.test(text)) return [{ started_at: iso(T0), ended_at: iso(T0 + 60 * MIN) }];
      if (/FROM bench_window/i.test(text)) {
        const lines = ["the patient reports chest pain since monday", "and the cough has not settled"];
        return [{
          start_ms: T0, end_ms: T0 + 15 * MIN, txt: lines.join("\n"),
          lt: { spans: lines.map((l, i) => ({ start_s: i * 60, end_s: i * 60 + 55, chars: l.length })) },
        }];
      }
      if (/FROM bench_level_sample/i.test(text)) {
        return levels(T0, T0 + 60 * MIN).map((s) => ({
          sampled_at: iso(s.t_ms), peak: s.peak, avg: null, zero_ratio: s.zero_ratio,
          session_open: true, tape_advancing: true, samples: 1,
        }));
      }
      if (/FROM encounter_hypothesis_run/i.test(text)) return opts.previousRun ? [{ id: opts.previousRun, room_day_id: "rd_test", smoother_version: SMOOTHER_VERSION, gate_version: GATE_VERSION, params: {}, probes_total: 0, probes_speech: 0, probes_non_speech: 0, probes_unjudged: 0, n_hypotheses: 0, created_at: iso(T0), runs_for_day: 1 }] : [];
      if (/FROM encounter_hypothesis\b/i.test(text)) return [];
      if (/INSERT INTO encounter_hypothesis_run/i.test(text)) {
        // mirror the store's own contract: it verifies the run id it generated and the row count
        const runId = String(values[0]);
        const jsonArg = values.find((v) => typeof v === "string" && v.trim().startsWith("[")) as string | undefined;
        const inserted = jsonArg ? (JSON.parse(jsonArg) as unknown[]).length : 0;
        return [{ run_id: runId, inserted }];
      }
      return [];
    };
  };

  it("writes NOTHING outside the two E-5 tables — asserted on every statement the run causes", async () => {
    wire();
    await runShadowForRoomDay({ room_id: "room_1", room_day_id: "rd_test", ist_date: "2026-09-23" });
    const writes = calls.filter((c) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(c.text));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.text, `a write must name an E-5 table: ${w.text.slice(0, 90)}`)
        .toMatch(/INSERT INTO encounter_hypothesis(_run)?\b/i);
      expect(w.text).not.toMatch(/\b(encounter|note|room_day|cue|visit|bench_window|bench_chunk|transcription_run|voice_print)\b\s*(SET|VALUES|\()/i);
    }
  });

  it("calls no STT and fetches no audio: it reads only the four tables it needs", async () => {
    wire();
    await runShadowForRoomDay({ room_id: "room_1", room_day_id: "rd_test", ist_date: "2026-09-23" });
    const reads = calls.filter((c) => /^SELECT/i.test(c.text));
    for (const r of reads) {
      expect(r.text).toMatch(/FROM (bench_chunk|bench_window|bench_level_sample|encounter_hypothesis(_run)?)\b/i);
    }
  });

  it("IDEMPOTENT for readers: a rerun appends a new run and names the one it supersedes", async () => {
    wire({ previousRun: "ehr_old" });
    const out = await runShadowForRoomDay({ room_id: "room_1", room_day_id: "rd_test", ist_date: "2026-09-23" });
    expect(out).toMatchObject({ ok: true, supersedes: "ehr_old" });
    expect((out as { run_id: string }).run_id).toMatch(/^ehr_/);
    // append-only by design: nothing is deleted or updated on a rerun
    expect(calls.some((c) => /\b(DELETE|UPDATE|TRUNCATE)\b/i.test(c.text))).toBe(false);
  });

  it("the FIRST run of a day supersedes nothing", async () => {
    wire({ previousRun: null });
    const out = await runShadowForRoomDay({ room_id: "room_1", room_day_id: "rd_test", ist_date: "2026-09-23" });
    expect(out).toMatchObject({ ok: true, supersedes: null });
  });

  it("a day with no recorded audio is refused, and nothing is written", async () => {
    responder = () => [];
    const out = await runShadowForRoomDay({ room_id: "room_1", room_day_id: "rd_none", ist_date: "2026-09-23" });
    expect(out).toEqual({ ok: false, error: "no_recorded_audio" });
    expect(calls.some((c) => /INSERT/i.test(c.text))).toBe(false);
  });

  it("loadDayEvidence asks only for this room-day, and for primary chunks", async () => {
    wire();
    await loadDayEvidence("room_1", "rd_test", "2026-09-23");
    const chunkQ = calls.find((c) => /FROM bench_chunk/i.test(c.text))!;
    expect(chunkQ.text).toMatch(/source, 'primary'\) = 'primary'/);
    expect(chunkQ.values).toContain("rd_test");
    expect(calls.find((c) => /FROM bench_window/i.test(c.text))!.values).toContain("rd_test");
  });
});
