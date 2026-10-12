/** Patient-leave shadow run. Jev is stubbed. The writer stores the reading the cache reads back. No database. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => H.sql(a) }));

const H = vi.hoisted(() => ({
  sql: (_a: unknown[]) => Promise.resolve([{ run_id: "ets_unused", n: 0 }]) as Promise<unknown>,
}));

import { answerPresent, runTimelineLeaveForRoomDay, writeLeaveRun, type LeaveRow, type LeaveRunInsert } from "@/lib/encounter-clock/shadow-leave";
import { checkTimelineGrammar } from "@/lib/encounter-clock/timeline";
import { featuresAreWordFree } from "@/lib/encounter-clock/timeline-features";
import { emptyCalibration, fitCalibration } from "@/lib/encounter-clock/timeline-calibration";
import { JevDisabledError } from "@/lib/jev/types";
import type { Anchor } from "@/lib/encounter-clock/anchors";
import type { TimelineEvidence } from "@/lib/room-access/encounter-timeline-io";
import type { CachedReading } from "@/lib/encounter-clock/timeline-cache";

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

const IN = { room_id: "room_fake1", room_day_id: "rd_fake1", ist_date: "2026-10-09" };
const blank = (): CachedReading => ({ end_row: null, end_signal: null, end_conf: null, late_start_p: null, kind: null, kind_conf: null });

function deps(o: {
  ev?: TimelineEvidence | null; anchors?: Anchor[]; refused?: boolean;
  ask?: (state: unknown) => Promise<unknown>; remember?: (key: string) => Promise<CachedReading | null>;
  written?: LeaveRunInsert[]; calibration?: ReturnType<typeof emptyCalibration>;
} = {}) {
  const written = o.written ?? [];
  return {
    written,
    partial: {
      load: async () => (o.ev === undefined ? evidence() : o.ev),
      anchors: async () => (o.refused ? { refused: "blind_room_day" as const } : { anchors: o.anchors ?? [anchor()], skipped: 0 }),
      remember: o.remember ?? (async () => null),
      calibration: o.calibration ?? emptyCalibration(),
      ask: (o.ask ?? (async (state: unknown) => {
        const rows = (state as { rows: Array<{ t: string }> }).rows;
        const choice = rows.find((r) => r.t === "t+10:00")?.t ?? "cannot_tell";
        return {
          model: "mock", latencyMs: 1, usage: { input_tokens: 1, output_tokens: 1 }, persisted: { ok: true, written: 4 },
          results: {
            end_row: { answer: { type: "choice", choice, probabilities: {}, confidence: 0.95 }, confidence: 0.95, band: "act", questionId: "", promptVersion: "", subjectType: "encounter", subjectId: "" },
            end_signal: { answer: { type: "choice", choice: "doctor_alone_then_quiet", probabilities: {}, confidence: 0.5 }, confidence: 0.5, band: "review", questionId: "", promptVersion: "", subjectType: "encounter", subjectId: "" },
            kind: { answer: { type: "choice", choice: "consultation", probabilities: {}, confidence: 0.4 }, confidence: 0.4, band: "review", questionId: "", promptVersion: "", subjectType: "encounter", subjectId: "" },
            late_start: { answer: { type: "noul", noul: 0.05 }, confidence: 0.4, band: "review", questionId: "", promptVersion: "", subjectType: "encounter", subjectId: "" },
          },
        };
      })) as never,
      write: async (r: LeaveRunInsert) => { written.push(r); return { ok: true as const, run_id: "ets_fake", n: r.rows.length }; },
    },
  };
}

describe("runTimelineLeaveForRoomDay", () => {
  it("stores the Jev reading and does not let an uncalibrated 0.95 place the end", async () => {
    const d = deps();
    const r = await runTimelineLeaveForRoomDay(IN, d.partial);
    expect(r.ok).toBe(true);
    const row = d.written[0]!.rows[0]!;
    expect(row.end_row).toBe("t+10:00");
    expect(row.end_signal).toBe("doctor_alone_then_quiet");
    expect(row.kind).toBe("consultation");
    expect(row.late_start_p).toBe(0.05);
    expect(row.jev_used).toBe(false);
    expect(row.reason_codes).toContain("uncalibrated_jev");
    expect(row.cache_hit).toBe(false);
    expect(featuresAreWordFree(row.features)).toBe(true);
    expect(row.features.every((f) => f.pitch === null)).toBe(true);
    expect(d.written[0]!.model).toBe("jev-1.13.0");
    expect(d.written[0]!.calibration_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(d.written[0]!.params).toMatchObject({ transcripts: "none_pre_stt" });
  });

  it("sends Jev only the timeline", async () => {
    let sent = "";
    await runTimelineLeaveForRoomDay(IN, deps({
      ask: async (state) => { sent = JSON.stringify(state); throw new Error("stop"); },
    }).partial);
    expect(sent).not.toMatch(/doc_uid_1|cl_fake1|rd_fake1|room_fake1|bw_\d|2026/);
    expect(checkTimelineGrammar(sent)).toEqual([]);
  });

  it("a stored answer is not asked again, and an all-null row is not a hit", async () => {
    const hit = deps({ remember: async () => ({ ...blank(), end_row: "t+09:00", end_conf: 0.4 }) });
    let asks = 0;
    hit.partial.ask = (async () => { asks++; throw new Error("asked"); }) as never;
    const r = await runTimelineLeaveForRoomDay(IN, hit.partial);
    expect(r.ok).toBe(true);
    expect(asks).toBe(0);
    expect(hit.written[0]!.rows[0]!.cache_hit).toBe(true);
    expect(hit.written[0]!.rows[0]!.end_row).toBe("t+09:00");

    const miss = deps({ remember: async () => blank() });
    await runTimelineLeaveForRoomDay(IN, miss.partial);
    expect(miss.written[0]!.rows[0]!.cache_hit).toBe(false);
    expect(miss.written[0]!.rows[0]!.end_row).toBe("t+10:00");
  });

  it("Jev disabled still writes the acoustic consult", async () => {
    const d = deps({ ask: async () => { throw new JevDisabledError(); } });
    const r = await runTimelineLeaveForRoomDay(IN, d.partial);
    expect(r.ok).toBe(true);
    expect(d.written[0]!.rows[0]!.end_row).toBeNull();
    expect(d.written[0]!.rows[0]!.jev_used).toBe(false);
    expect(d.written[0]!.params).toMatchObject({ jev_disabled: true });
  });

  it("a cache read that throws is cache_read_failed and writes nothing", async () => {
    const d = deps({ remember: async () => { throw new Error("relation does not exist"); } });
    expect(await runTimelineLeaveForRoomDay(IN, d.partial)).toEqual({ ok: false, error: "cache_read_failed" });
    expect(d.written).toHaveLength(0);
  });

  it("no anchors, no audio, and a held-out day write nothing", async () => {
    const written: LeaveRunInsert[] = [];
    expect(await runTimelineLeaveForRoomDay(IN, deps({ written, anchors: [] }).partial)).toEqual({ ok: false, error: "no_anchors" });
    expect(await runTimelineLeaveForRoomDay(IN, deps({ written, ev: null }).partial)).toEqual({ ok: false, error: "no_recorded_audio" });
    expect(await runTimelineLeaveForRoomDay(IN, deps({ written, refused: true }).partial)).toEqual({ ok: false, error: "blind_room_day" });
    expect(written).toHaveLength(0);
  });

  it("gate_diar is recorded on the run and does not change the table", async () => {
    const a = deps();
    const b = deps();
    await runTimelineLeaveForRoomDay(IN, a.partial);
    await runTimelineLeaveForRoomDay({ ...IN, gate_diar: true }, b.partial);
    expect(a.written[0]!.gate_version).toBe("encounter-clock-gate-v1");
    expect(b.written[0]!.gate_version).toBe("encounter-clock-gate-v2");
  });

  it("the default runner uses the stored fit (LEAVE_CALIBRATION), not an inline one", () => {
    const src = readFileSync("lib/encounter-clock/shadow-leave.ts", "utf8");
    expect(src).toContain("calibration: LEAVE_CALIBRATION");
    expect(src).not.toContain("calibration: emptyCalibration()");
    expect(src).toContain("model: TIMELINE_MODEL_PIN");
    expect(src).not.toMatch(/temperature/);
    const cal = fitCalibration(Array.from({ length: 8 }, (_, i) => ({ raw: (i + 1) / 10, correct: true })));
    expect(cal.method).toBe("isotonic");
  });
});

describe("writeLeaveRun", () => {
  const feature = { t: "t+00:00", who: ["DOC", "B"], loud_db: -20, silence_s: 10, mean_turn_s: 4, overlap_s: 1, level_events: 0, pitch: null as null };
  const row = (over: Partial<LeaveRow> = {}): LeaveRow => ({
    consult_key: "c1", start_ms: D0, end_ms: D0 + MIN, confidence: null, raw_confidence: 0.4, reason_codes: ["patient_left"],
    closed_by: "patient_left", encounter_end_ms: null, jev_used: false, cache_key: "k", cache_hit: false, features: [feature],
    end_row: "t+00:00", end_signal: "patient_left", late_start_p: 0.1, kind: "consultation", kind_conf: 0.4, ...over,
  });
  const run = (rows: LeaveRow[]): LeaveRunInsert => ({
    room_day_id: "rd_fake1", model: "jev-1.13.0", question_set_sha: "s", prompt_version: "u10-timeline-v1",
    calibration_sha: "c", gate_version: "encounter-clock-gate-v1", params: { transcripts: "none_pre_stt" }, rows,
  });

  it("persists the reading columns the cache selects", async () => {
    let payload = "";
    H.sql = async (a) => {
      const values = (a as unknown[]).slice(1) as unknown[];
      payload = values.map((v) => (typeof v === "string" ? v : "")).join("\n");
      return [{ run_id: values[0], n: 1 }];
    };
    const out = await writeLeaveRun(run([row()]));
    expect(out.ok).toBe(true);
    expect(payload).toContain("t+00:00");
    expect(payload).toContain("patient_left");
    expect(payload).not.toContain("doc_uid_1");
  });

  it("refuses a row that is not a span, a reason outside the list, or a feature that is not word-free", async () => {
    H.sql = async () => { throw new Error("should not write"); };
    expect((await writeLeaveRun(run([row({ end_ms: D0 })]))).ok).toBe(false);
    expect((await writeLeaveRun(run([row({ reason_codes: ["guessed" as never] })]))).ok).toBe(false);
    expect((await writeLeaveRun(run([row({ features: [{ ...feature, who: ["room five"] }] })]))).ok).toBe(false);
  });
});

describe("answerPresent", () => {
  it("an all-null reading is not an answer", () => {
    expect(answerPresent(blank())).toBe(false);
    expect(answerPresent({ ...blank(), end_conf: 0 })).toBe(true);
  });
});
