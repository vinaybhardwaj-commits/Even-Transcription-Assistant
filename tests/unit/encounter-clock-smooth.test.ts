/**
 * E-4 — the hysteresis smoother (lib/encounter-clock/smooth.ts).
 *
 * Probes are written as strings, one character per probe, 60 s apart:
 *   S speech   N non_speech   U unjudged   D unjudged because the mic was dead
 * The rule these tests protect: UNJUDGED NEVER CLOSES AN ENCOUNTER, and unjudged time after the last
 * speech is never claimed as encounter time.
 */
import { describe, it, expect } from "vitest";
import {
  smoothEncounters, ENTER_SPEECH_PROBES, EXIT_NON_SPEECH_PROBES, MERGE_GAP_MS, SMOOTH_HOP_MS, SMOOTHER_VERSION,
  type ProbeVerdict,
} from "@/lib/encounter-clock/smooth";

const T0 = 1_790_000_000_000, HOP = SMOOTH_HOP_MS, HALF = HOP / 2, MIN = 60_000;
const at = (i: number) => T0 + i * HOP;
function seq(s: string, doctor?: (i: number) => boolean | null): ProbeVerdict[] {
  return [...s].map((c, i): ProbeVerdict => {
    const t = at(i);
    if (c === "S") return { t, verdict: "speech", reason: "speech", doctor_present: doctor ? doctor(i) : undefined };
    if (c === "N") return { t, verdict: "non_speech", reason: "no_text" };
    if (c === "D") return { t, verdict: "unjudged", reason: "dead_mic" };
    return { t, verdict: "unjudged", reason: "no_transcript_evidence" };
  });
}
const span = (e: { start_ms: number; end_ms: number }) => [(e.start_ms - T0 + HALF) / HOP, (e.end_ms - T0 - HALF) / HOP];

describe("E-4 hysteresis — entering", () => {
  it("nothing in, nothing out", () => { expect(smoothEncounters([])).toEqual([]); });
  it(`opens only after ${ENTER_SPEECH_PROBES} speech probes; one is not enough`, () => {
    expect(smoothEncounters(seq("S"))).toEqual([]);
    const [e] = smoothEncounters(seq("SS"));
    expect(e).toMatchObject({ version: SMOOTHER_VERSION, start_ms: at(0) - HALF, end_ms: at(1) + HALF, speech_probes: 2 });
  });
  it("a non_speech probe resets a run that has not yet opened", () => {
    expect(smoothEncounters(seq("SNS"))).toEqual([]);
    expect(span(smoothEncounters(seq("SNSS"))[0])).toEqual([2, 3]);
  });
  it("unjudged between speech probes neither counts nor breaks the run; the start is the first speech", () => {
    expect(span(smoothEncounters(seq("SUS"))[0])).toEqual([0, 2]);
    expect(smoothEncounters(seq("SUUUU"))).toEqual([]);
  });
});

describe("E-4 hysteresis — leaving", () => {
  it(`closes after ${EXIT_NON_SPEECH_PROBES} non_speech probes, ending at the LAST SPEECH, not at the run that closed it`, () => {
    const [e] = smoothEncounters(seq("SSSNNN"));
    expect(span(e)).toEqual([0, 2]);
    expect(e.closed_by).toBe("non_speech");
  });
  it("one short of the exit run, speech keeps the encounter open", () => {
    const r = smoothEncounters(seq("SSNNSS"));
    expect(r).toHaveLength(1);
    expect(span(r[0])).toEqual([0, 5]);
    expect(r[0].non_speech_probes).toBe(2);
  });
  it("unjudged does not reset the exit run: non_speech evidence adds up across it", () => {
    const [e] = smoothEncounters(seq("SSNN" + "U".repeat(30) + "N"));
    expect(e.closed_by).toBe("non_speech");
    expect(span(e)).toEqual([0, 1]);
  });
});

describe("E-4 — unjudged never closes an encounter by itself", () => {
  it("speech followed by a long unjudged stretch to the end of the day: one encounter, ending at the last speech", () => {
    const [e, ...rest] = smoothEncounters(seq("SS" + "U".repeat(100)));
    expect(rest).toEqual([]);
    expect(span(e)).toEqual([0, 1]);
    expect(e.closed_by).toBe("end_of_input");
    expect(e.unjudged_ms).toBe(0);                                  // the stretch after the last speech is not claimed
  });
  it("a long unjudged stretch INSIDE an encounter bridges it, and the interval says how much was unjudged", () => {
    const r = smoothEncounters(seq("SSS" + "U".repeat(60) + "SSS"));
    expect(r).toHaveLength(1);
    expect(span(r[0])).toEqual([0, 65]);
    expect(r[0].speech_probes).toBe(6);
    expect(r[0].unjudged_ms).toBe(60 * HOP);
    expect(r[0].longest_unjudged_run_ms).toBe(60 * HOP);
  });
  it("a hole in the probe series is unjudged time, never silence", () => {
    const ps: ProbeVerdict[] = [
      { t: at(0), verdict: "speech" }, { t: at(1), verdict: "speech" },
      { t: at(1) + 40 * MIN, verdict: "speech" }, { t: at(1) + 40 * MIN + HOP, verdict: "speech" },
    ];
    const r = smoothEncounters(ps);
    expect(r).toHaveLength(1);
    expect(r[0].unjudged_ms).toBe(40 * MIN - HOP);
  });
});

describe("E-4 — dead-mic runs", () => {
  it("a dead mic after speech holds the encounter open but is not claimed; non_speech then closes it at the last speech", () => {
    const [e] = smoothEncounters(seq("SS" + "D".repeat(30) + "NNN"));
    expect(span(e)).toEqual([0, 1]);
    expect(e.closed_by).toBe("non_speech");
    expect(e.dead_mic_ms).toBe(0);
  });
  it("a dead mic inside an encounter is bridged and reported as dead-mic time", () => {
    const [e] = smoothEncounters(seq("SS" + "D".repeat(10) + "SS"));
    expect(e.dead_mic_ms).toBe(10 * HOP);
    expect(e.unjudged_ms).toBe(10 * HOP);
  });
  it("a day that is all dead mic opens nothing", () => {
    expect(smoothEncounters(seq("D".repeat(500)))).toEqual([]);
  });
});

describe(`E-4 gap-merge — encounters at most ${MERGE_GAP_MS / MIN} min apart are one`, () => {
  it("a gap of exactly the merge limit merges, and the merged interval re-counts the span between", () => {
    const r = smoothEncounters(seq("SSNNNSS"));                     // gap = (5 - 1) hops - 1 hop = 180 s
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ merged_from: 2, speech_probes: 4, non_speech_probes: 3, closed_by: "end_of_input" });
    expect(span(r[0])).toEqual([0, 6]);
  });
  it("a gap one hop wider does not merge", () => {
    const r = smoothEncounters(seq("SSNNNNSS"));                    // gap = 240 s
    expect(r).toHaveLength(2);
    expect(r.map(span)).toEqual([[0, 1], [6, 7]]);
  });
});

describe("E-4 — inputs and constants", () => {
  it("order of input does not matter", () => {
    const s = seq("SSSNNNSS" + "U".repeat(5) + "SSNNN");
    expect(smoothEncounters([...s].reverse())).toEqual(smoothEncounters(s));
  });
  it("doctor_present is carried, not decided on: counted among an encounter's speech probes", () => {
    const [e] = smoothEncounters(seq("SSSS", (i) => (i === 0 ? true : i === 1 ? false : null)));
    expect(e.doctor_present).toEqual({ yes: 1, no: 1, unknown: 2 });
  });
  it("the constants are exported, provisional, and guarded", () => {
    expect([ENTER_SPEECH_PROBES, EXIT_NON_SPEECH_PROBES, MERGE_GAP_MS, SMOOTH_HOP_MS]).toEqual([2, 3, 180_000, 60_000]);
    expect(() => smoothEncounters(seq("SS"), { enter: 0 })).toThrow();
    expect(() => smoothEncounters(seq("SS"), { hop_ms: 0 })).toThrow();
  });
});
