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
  BRIDGE_UNJUDGED_MAX_MS, type ProbeVerdict,
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
  it("unjudged does not reset the exit run WITHIN the bridge limit: non_speech evidence adds up", () => {
    const [e] = smoothEncounters(seq("SSNN" + "UU" + "N"));
    expect(e.closed_by).toBe("non_speech");
    expect(span(e)).toEqual([0, 1]);
  });
});

describe(`E-4 — unjudged bridges an encounter, but only for ${BRIDGE_UNJUDGED_MAX_MS / MIN} min`, () => {
  it("speech then a long unjudged stretch to the end of the day: one encounter, ending at the last speech", () => {
    const r = smoothEncounters(seq("SS" + "U".repeat(100)));
    expect(r).toHaveLength(1);
    expect(span(r[0])).toEqual([0, 1]);
    expect(r[0].closed_by).toBe("unjudged_gap");                    // the day did not simply run out
    expect(r[0].unjudged_ms).toBe(0);                               // unjudged after the last speech is never claimed
  });
  it("a SHORT unjudged stretch still bridges: speech either side is ONE encounter", () => {
    const r = smoothEncounters(seq("SSS" + "U".repeat(3) + "SSS")); // 3 min of unjudged, at the limit
    expect(r).toHaveLength(1);
    expect(span(r[0])).toEqual([0, 8]);
    expect(r[0].unjudged_ms).toBe(3 * HOP);
  });
  it("a LONG unjudged stretch SPLITS it: it closes at its last speech and a later run opens a new one", () => {
    const r = smoothEncounters(seq("SSS" + "U".repeat(60) + "SSS"));
    expect(r).toHaveLength(2);
    expect(r.map(span)).toEqual([[0, 2], [63, 65]]);
    expect(r[0].closed_by).toBe("unjudged_gap");
    expect(r[0].unjudged_ms).toBe(0);
    expect(r[1].unjudged_ms).toBe(0);
  });
  it("the split survives the gap-merge — a limit the merge step could undo would be no limit at all", () => {
    expect(smoothEncounters(seq("SSS" + "U".repeat(60) + "SSS"), { merge_gap_ms: 60 * MIN })).toHaveLength(2);
  });
  it("a hole in the probe series is bridged by the same limit, and a long hole splits", () => {
    const short: ProbeVerdict[] = [
      { t: at(0), verdict: "speech" }, { t: at(1), verdict: "speech" },
      { t: at(1) + 2 * MIN, verdict: "speech" }, { t: at(1) + 2 * MIN + HOP, verdict: "speech" },
    ];
    expect(smoothEncounters(short)).toHaveLength(1);
    const long = short.map((p, i) => (i < 2 ? p : { ...p, t: p.t + 40 * MIN }));
    const r = smoothEncounters(long);
    expect(r).toHaveLength(2);
    expect(r[0].closed_by).toBe("unjudged_gap");
  });
});

describe("E-4 — tape-off and a dead mic close an encounter immediately", () => {
  const tape = (a: number, b: number) => [{ start_ms: at(a), end_ms: at(b) }];
  it("tape-off INSIDE a run of speech probes closes the encounter at the last speech before it", () => {
    const r = smoothEncounters(seq("SSSSSSSS"), { tape_off: tape(3, 5) });
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r[0].closed_by).toBe("tape_off");
    expect(span(r[0])).toEqual([0, 2]);
    expect(r[1].start_ms).toBeGreaterThanOrEqual(at(3) - HALF);
  });
  it("the gap-merge never rejoins across a tape-off, however short the gap", () => {
    expect(smoothEncounters(seq("SSSSSSSS"), { tape_off: tape(3, 5), merge_gap_ms: 60 * MIN })).toHaveLength(2);
  });
  it("tape-off after the last speech closes it as tape_off, not as the day running out", () => {
    expect(smoothEncounters(seq("SSS"), { tape_off: [{ start_ms: at(3), end_ms: at(9) }] })[0].closed_by).toBe("tape_off");
  });
  it("a dead mic closes an encounter immediately — it must never extend one", () => {
    const r = smoothEncounters(seq("SS" + "D".repeat(30) + "NNN"));
    expect(r[0].closed_by).toBe("dead_mic");
    expect(span(r[0])).toEqual([0, 1]);
    expect(r[0].dead_mic_ms).toBe(0);
  });
  it("speech after a dead mic is a new encounter, never a continuation", () => {
    const r = smoothEncounters(seq("SS" + "D".repeat(10) + "SS"));
    expect(r).toHaveLength(2);
    expect(r[0].closed_by).toBe("dead_mic");
    expect(r.map(span)).toEqual([[0, 1], [12, 13]]);
  });
  it("a day that is all dead mic opens nothing", () => {
    expect(smoothEncounters(seq("D".repeat(500)))).toEqual([]);
  });
  it("tape-off cannot open an encounter", () => {
    expect(smoothEncounters(seq("UU"), { tape_off: tape(0, 2) })).toEqual([]);
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

describe("E-4 — a run that has NOT yet opened is broken by the same rules", () => {
  // ETA-Refuter, 23 Sep: the ruling was enforced in `open` only, so a single speech probe bridged
  // without limit. `pending` is reset only by non_speech, and production almost never yields one (every
  // probe reads active against the floor), so a stray speech probe at the end of a clinic day and the
  // first one next morning became ONE encounter across the night.
  it("a speech probe, a long unjudged stretch, then speech: no encounter — the first probe's run is discarded", () => {
    expect(smoothEncounters(seq("S" + "U".repeat(20) + "S"))).toEqual([]);
    expect(smoothEncounters(seq("S" + "U".repeat(1000) + "S"))).toEqual([]);
  });
  it("two speech probes ten hours apart with NO probes between them are not one encounter", () => {
    const far: ProbeVerdict[] = [{ t: at(0), verdict: "speech" }, { t: at(600), verdict: "speech" }];
    expect(smoothEncounters(far)).toEqual([]);
  });
  it("a dead mic discards a pending run", () => {
    expect(smoothEncounters(seq("SDS"))).toEqual([]);
  });
  it("a tape-off discards a pending run", () => {
    expect(smoothEncounters(seq("SS"), { tape_off: [{ start_ms: at(0) + HALF, end_ms: at(1) - HALF }] })).toEqual([]);
  });
  it("WITHIN the bridge limit a pending run still survives an unjudged gap and opens", () => {
    const r = smoothEncounters(seq("S" + "UU" + "S"));
    expect(r).toHaveLength(1);
    expect(span(r[0])).toEqual([0, 3]);
  });
  it("CONTROL — an OPEN encounter is unaffected: two speech probes either side still split", () => {
    expect(smoothEncounters(seq("SS" + "U".repeat(20) + "SS"))).toHaveLength(2);
  });
});

describe("E-4 — accounting the Refuter's mutants reached", () => {
  it("M12 — a hole inside an encounter is counted as unjudged time, by its length", () => {
    const ps: ProbeVerdict[] = [
      { t: at(0), verdict: "speech" }, { t: at(1), verdict: "speech" },
      { t: at(1) + 2 * MIN, verdict: "speech" }, { t: at(1) + 2 * MIN + HOP, verdict: "speech" },
    ];
    const [e] = smoothEncounters(ps);
    expect(e.unjudged_ms).toBe(2 * MIN - HOP);          // the hole, less the hop each probe already owns
    expect(e.longest_unjudged_run_ms).toBe(2 * MIN - HOP);
  });
  it("M13 — speech resets the exit run: non-consecutive non_speech never closes an encounter", () => {
    const r = smoothEncounters(seq("SSNSNN"));
    expect(r).toHaveLength(1);
    expect(r[0].closed_by).toBe("end_of_input");        // not "non_speech": N S N N is not three in a row
    expect(span(r[0])).toEqual([0, 3]);
  });
  it("M14 — dead_mic_ms is 0 at the default constants: a dead mic ends the run, and no gap fits one", () => {
    const r = smoothEncounters(seq("SS" + "D".repeat(10) + "SS"));
    expect(r.every((e) => e.dead_mic_ms === 0)).toBe(true);
    expect(r.every((e) => e.unjudged_ms === 0)).toBe(true);
    expect(smoothEncounters(seq("SSNDSS")).map((e) => e.dead_mic_ms)).toEqual([0, 0]);
  });
  it("M14 — but it is a live field: lower `exit` and a merged span DOES count the dead mic inside it", () => {
    // At exit 3 the gap a non_speech close leaves is exactly filled by the probes that caused it, so a
    // dead mic cannot fit. At exit 1 the gap opens and the merge re-tallies across it (ETA-Refuter).
    const r = smoothEncounters(seq("SSNDSS"), { exit: 1 });
    expect(r).toHaveLength(1);
    expect(r[0].merged_from).toBe(2);
    expect(r[0].dead_mic_ms).toBe(HOP);
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
    expect([ENTER_SPEECH_PROBES, EXIT_NON_SPEECH_PROBES, MERGE_GAP_MS, SMOOTH_HOP_MS, BRIDGE_UNJUDGED_MAX_MS]).toEqual([2, 3, 180_000, 60_000, 180_000]);
    expect(() => smoothEncounters(seq("SS"), { enter: 0 })).toThrow();
    expect(() => smoothEncounters(seq("SS"), { hop_ms: 0 })).toThrow();
  });
});
