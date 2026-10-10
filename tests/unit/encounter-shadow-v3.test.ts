/** shadow-v3 (epic #23 f): the timeline run end to end over synthetic evidence, with every seam stubbed. No real Jev, no DB. */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ sql: () => { throw new Error("no database in this test"); } }));
import { runTimelineShadowForRoomDay, roleFor, dominantClinician, docUidOf, type TimelineDeps } from "@/lib/encounter-clock/shadow-v3";
import { checkTimelineGrammar } from "@/lib/encounter-clock/timeline";
import { checkRunInput, type HypothesisRunInput } from "@/lib/encounter-hypotheses";
import { JevDisabledError } from "@/lib/jev/types";
import { getJevQuestion } from "@/lib/jev/registry";
import {
  registerTimelineQuestions, U10_PROMPT_VERSION, U10_END_ROW_ID, U10_KIND_ID, U10_END_SIGNAL_ID, U10_LATE_START_ID, u10EndRowQuestion,
} from "@/lib/jev/prompts/timeline-v1";
import type { TimelineEvidence } from "@/lib/room-access/encounter-timeline-io";
import { turnsOf, speakerIdx } from "@/lib/room-access/encounter-timeline-io";
import type { Anchor } from "@/lib/encounter-clock/anchors";

const D0 = 1_790_000_000_000, MIN = 60_000;
const anchor = (o: Partial<Anchor> = {}): Anchor => ({
  consult_key: "c1", room_id: "room_fake1", start_ms: D0 + 5 * MIN, close_kind: "open", end_clicked: false, end_click_ms: null, end_weak_ms: null,
  end_weak_kind: null, next_start_ms: null, doctor_uid_warehouse: "doc_uid_1", doctor_uid_ext: null, doctor_source: "warehouse",
  quality: "ok" as never, weak_start: false, ...o,
});
const evidence = (over: Partial<TimelineEvidence> = {}): TimelineEvidence => ({
  room_day_id: "rd_fake1", day_start_ms: D0, day_end_ms: D0 + 60 * MIN, tape_off: [],
  level_samples: Array.from({ length: 360 }, (_, i) => {
    const t = D0 + i * 10_000, speaking = t >= D0 + 5 * MIN && t < D0 + 15 * MIN;
    return { t_ms: t, avg: speaking ? 0.2 : 0.0001, peak: speaking ? 0.3 : 0.0002, zero_ratio: 0 } as never;
  }),
  windows: [0, 1, 2, 3].map((k) => ({
    window_id: `bw_${k}`, origin_ms: D0 + k * 15 * MIN, window_end_ms: D0 + (k + 1) * 15 * MIN,
    turns: k === 0 ? [{ start_ms: 5 * MIN, end_ms: 9 * MIN, speaker_idx: 0 }, { start_ms: 8 * MIN, end_ms: 14 * MIN, speaker_idx: 1 }]
      : k === 1 ? [{ start_ms: 0, end_ms: 0.5 * MIN, speaker_idx: 0 }] : [],
  })),
  identity: new Map([["bw_0", new Map([[0, { pulse_doctor_uid: "doc_uid_1", clinician_id: "cl_fake1", match_confidence: 0.81, speech_ms: 240_000 }]])]]),
  day_complete: true, n_blind_excluded: 0, ...over,
});
type Written = HypothesisRunInput[];
function deps(o: { ev?: TimelineEvidence | null; anchors?: Anchor[]; refused?: boolean; ask?: TimelineDeps["ask"]; written?: Written } = {}): Partial<TimelineDeps> {
  const written = o.written ?? [];
  return {
    load: async () => (o.ev === undefined ? evidence() : o.ev),
    anchors: async () => (o.refused ? { refused: "blind_room_day" as const } : { anchors: o.anchors ?? [anchor()], skipped: 0 }),
    ask: o.ask ?? (async (state, asks) => {
      expect(checkTimelineGrammar(JSON.stringify(state))).toEqual([]);
      const rows = (state as { rows: Array<{ t: string }> }).rows;
      return {
        model: "mock", latencyMs: 1, usage: { input_tokens: 1, output_tokens: 1 }, persisted: { ok: true, written: asks.length },
        results: {
          end_row: { answer: { type: "choice", choice: rows.find((r) => r.t === "t+10:00")?.t ?? "cannot_tell", probabilities: {}, confidence: 0.95 }, confidence: 0.95, band: "act", questionId: "", promptVersion: "", subjectType: "encounter", subjectId: "" },
          kind: { answer: { type: "choice", choice: "consultation", probabilities: {}, confidence: 0.9 }, confidence: 0.9, band: "act", questionId: "", promptVersion: "", subjectType: "encounter", subjectId: "" },
          late_start: { answer: { type: "noul", noul: 0.05 }, confidence: 0.9, band: "act", questionId: "", promptVersion: "", subjectType: "encounter", subjectId: "" },
        } as never,
      };
    }),
    write: async (r) => { written.push(r); return { ok: true, run_id: "ehr_fake", n_hypotheses: r.intervals.length }; },
  };
}
const IN = { room_id: "room_fake1", room_day_id: "rd_fake1", ist_date: "2026-10-09" };

describe("runTimelineShadowForRoomDay", () => {
  it("writes ONE timeline run: anchor start, Jev end snapped to the last turn, DOC from the pulse uid", async () => {
    const written: Written = [];
    const r = await runTimelineShadowForRoomDay({ ...IN, gate_diar: true }, deps({ written }));
    expect(r.ok).toBe(true);
    expect(written).toHaveLength(1);
    const run = written[0]!;
    expect(run.source).toBe("timeline");
    expect(checkRunInput(run)).toEqual([]);
    expect(run.intervals).toHaveLength(1);
    const iv = run.intervals[0]!;
    expect(iv.start_ms).toBe(D0 + 4 * MIN);
    expect(iv.closed_by).toBe("jev_end");
    expect(iv.origin).toBe("jev");
    expect(iv.end_ms).toBe(D0 + 15.5 * MIN); // last diarized turn inside the t+10:00 row
    expect(iv.identity).toMatchObject({ clinician_id: "cl_fake1", match_source: "voice_print", doctor_cosine: 0.81 });
    // doctor present only where DOC speech reached 5 s in the probe slot; never false
    expect(iv.doctor_present.no).toBe(0);
    expect(iv.doctor_present.yes).toBeGreaterThan(0);
    expect(run.params).toMatchObject({ prompt_version: U10_PROMPT_VERSION, transcripts: "none_pre_stt" });
    if (r.ok) expect(r.summary.jev).toMatchObject({ segments_asked: 1, segments_answered: 1 });
  });

  it("sends Jev only the timeline: no text, name, id or clock time", async () => {
    let sent = "";
    await runTimelineShadowForRoomDay(IN, deps({
      ask: async (state) => { sent = JSON.stringify(state); throw new Error("stop after capture"); },
    })).catch(() => undefined);
    expect(sent).not.toMatch(/doc_uid_1|cl_fake1|rd_fake1|room_fake1|bw_\d|2026|1790\d{6}/);
    expect(checkTimelineGrammar(sent)).toEqual([]);
  });

  it("Jev disabled → nothing written, reason jev_disabled", async () => {
    const written: Written = [];
    const r = await runTimelineShadowForRoomDay(IN, deps({ written, ask: async () => { throw new JevDisabledError(); } }));
    expect(r).toEqual({ ok: false, error: "jev_disabled" });
    expect(written).toHaveLength(0);
  });
  it("every Jev call failing → nothing written, jev_failed_all", async () => {
    const written: Written = [];
    const r = await runTimelineShadowForRoomDay(IN, deps({ written, ask: async () => { throw new Error("upstream"); } }));
    expect(r).toMatchObject({ ok: false, error: "jev_failed_all" });
    expect(written).toHaveLength(0);
  });
  it("no anchors / no audio / held-out day → nothing written", async () => {
    const written: Written = [];
    expect(await runTimelineShadowForRoomDay(IN, deps({ written, anchors: [] }))).toEqual({ ok: false, error: "no_anchors" });
    expect(await runTimelineShadowForRoomDay(IN, deps({ written, ev: null }))).toEqual({ ok: false, error: "no_recorded_audio" });
    expect(await runTimelineShadowForRoomDay(IN, deps({ written, refused: true }))).toEqual({ ok: false, error: "blind_room_day" });
    expect(written).toHaveLength(0);
  });
  it("a missing identity pass means nobody is DOC and the doctor is unknown, not absent", async () => {
    const written: Written = [];
    await runTimelineShadowForRoomDay(IN, deps({ written, ev: evidence({ identity: new Map() }) }));
    const iv = written[0]!.intervals[0]!;
    expect(iv.doctor_present).toMatchObject({ yes: 0, no: 0 });
    expect(iv.identity).toBeNull();
  });
  it("gate_diar changes the stored gate_version and the speech counts", async () => {
    const a: Written = [], b: Written = [];
    await runTimelineShadowForRoomDay(IN, deps({ written: a }));
    await runTimelineShadowForRoomDay({ ...IN, gate_diar: true }, deps({ written: b }));
    expect(a[0]!.gate_version).toBe("encounter-clock-gate-v1");
    expect(b[0]!.gate_version).toBe("encounter-clock-gate-v2");
    expect(a[0]!.probes.speech).toBe(0);
    expect(b[0]!.probes.speech).toBeGreaterThan(0);
  });
  it("two consults are disjoint and ordered", async () => {
    const written: Written = [];
    await runTimelineShadowForRoomDay(IN, deps({ written, anchors: [anchor({ next_start_ms: D0 + 20 * MIN }), anchor({ consult_key: "c2", start_ms: D0 + 20 * MIN })] }));
    const iv = written[0]!.intervals;
    expect(iv).toHaveLength(2);
    expect(iv[1]!.start_ms).toBeGreaterThanOrEqual(iv[0]!.end_ms);
  });
});

describe("pure helpers", () => {
  it("docUidOf follows doctor_source", () => {
    expect(docUidOf(anchor())).toBe("doc_uid_1");
    expect(docUidOf(anchor({ doctor_source: "extension", doctor_uid_ext: "e1" }))).toBe("e1");
    expect(docUidOf(anchor({ doctor_source: "none" }))).toBeNull();
  });
  it("roleFor: DOC only on an exact pulse uid match", () => {
    const role = roleFor(evidence())!;
    expect(role("bw_0", 0, anchor())).toBe("doc");
    expect(role("bw_0", 1, anchor())).toBe("other");
    expect(role("bw_0", 0, anchor({ doctor_uid_warehouse: "someone_else" }))).toBe("other");
    expect(role("bw_0", 0, null)).toBe("other");
  });
  it("dominantClinician picks the most speech", () => {
    const ev = evidence();
    expect(dominantClinician(ev, D0, D0 + 60 * MIN)).toMatchObject({ clinician_id: "cl_fake1" });
    expect(dominantClinician(ev, D0 + 30 * MIN, D0 + 40 * MIN)).toBeNull();
  });
  it("turnsOf / speakerIdx refuse malformed input", () => {
    expect(speakerIdx("spk3")).toBe(3);
    expect(speakerIdx("S3")).toBeNull();
    expect(turnsOf([[0, 10, "spk0"], [5, 5, "spk1"], [1, 2, "bad"], "x", [NaN, 4, "spk0"]])).toEqual([{ start_ms: 0, end_ms: 10, speaker_idx: 0 }]);
    expect(turnsOf(null)).toEqual([]);
  });
});

describe("u10 questions", () => {
  it("register once and build with per-call end-row options", () => {
    registerTimelineQuestions();
    registerTimelineQuestions();
    for (const id of [U10_END_SIGNAL_ID, U10_LATE_START_ID, U10_KIND_ID]) expect(getJevQuestion(id, U10_PROMPT_VERSION)()).toBeTruthy();
    const q = getJevQuestion(U10_END_ROW_ID, U10_PROMPT_VERSION)(["t+00:00", "t+00:30"]);
    expect(q.type === "choice" && Object.keys(q.criteria)).toEqual(["t+00:00", "t+00:30", "continues_past_segment", "cannot_tell"]);
    expect(u10EndRowQuestion([]).type).toBe("choice");
  });
});
