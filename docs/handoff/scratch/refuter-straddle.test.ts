/** REFUTER PROBE — ruling 2: a turn straddling a speaker boundary must get NO clinician role. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DiarizeSpeaker } from "@/lib/diarize";

const matched = (idx: number, id = "doc_fake0001"): DiarizeSpeaker =>
  ({ idx, label: "Dr X", type: "clinician", source: "auto", clinician_id: id, confidence: 0.82, total_speech_sec: 12 });
const unmatched = (idx: number): DiarizeSpeaker =>
  ({ idx, label: "Patient", type: "patient", source: "heuristic", total_speech_sec: 400 });

const DB = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, turns: [] as Array<Record<string, unknown>>, centroids: [] as Array<Record<string, unknown>> }));
const SVC = vi.hoisted(() => ({ out: {} as Record<string, unknown> }));
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM voice_print")) return DB.centroids;
    if (q.includes("FROM cue")) return DB.turns;
    if (q.includes("INSERT INTO room_turn_speaker")) {
      DB.rows.push({ source_ref: v[1], speaker_idx: v[2], overlap_ms: v[3], clinician_id: v[5], role: v[6], match_confidence: v[7] });
      return [];
    }
    return [];
  },
}));
vi.mock("@/lib/diarize", () => ({ runDiarize: async () => SVC.out }));

describe("RULING 2 PROBE", () => {
  beforeEach(() => { DB.rows = []; DB.centroids = []; });

  it("a turn straddling a speaker boundary gets NO clinician attribution", async () => {
    // One turn, 0-1000 on the window clock. The doctor (matched, idx 0) holds 0-600;
    // the patient (unmatched, idx 1) holds 600-1000. The boundary at 600 is STRICTLY INSIDE.
    DB.turns = [{ source_ref: "straddle", start_ms: 0, end_ms: 1000 }];
    SVC.out = { ok: true, latencyMs: 10, result: {
      speakers: [matched(0), unmatched(1)],
      transcript_segments: [
        { start_ms: 0, end_ms: 600, speaker_idx: 0, overlap: false },
        { start_ms: 600, end_ms: 1000, speaker_idx: 1, overlap: false },
      ] } };
    const { diarizeWindow } = await import("@/lib/stt/diarize-window");
    await diarizeWindow({ windowId: "bw_1", roomDayId: "rd_1", startMs: 0, endMs: 1000, audio: new Uint8Array([1]) });
    console.log("STRADDLE ROW:", JSON.stringify(DB.rows));
    expect(DB.rows[0]!.role, "40% of this turn is the patient speaking").toBe("unattributed");
    expect(DB.rows[0]!.clinician_id).toBeNull();
  });
});
