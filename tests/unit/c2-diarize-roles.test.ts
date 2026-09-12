/**
 * C2 Part B — role comes from a MATCH, never from an index.
 *
 * server.py:191 sorts clusters by total speaking time descending, so speaker_idx 0 is the most
 * talkative voice — in a consultation usually the doctor, which is what makes ordering the
 * tempting wrong answer. These tests fail if role is ever derived from it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { roleForSpeaker, rolesByIndex, attributionCoverage } from "@/lib/stt/speaker-roles";
import type { DiarizeSpeaker } from "@/lib/diarize";

const matched = (idx: number, id = "doc_fake0001"): DiarizeSpeaker =>
  ({ idx, label: "Dr X", type: "clinician", source: "auto", clinician_id: id, confidence: 0.82, total_speech_sec: 12 });
const unmatched = (idx: number, over: Partial<DiarizeSpeaker> = {}): DiarizeSpeaker =>
  ({ idx, label: "Patient", type: "patient", source: "heuristic", total_speech_sec: 400, ...over });

describe("item 3 — NEVER infer role from speaker order", () => {
  it("speaker_idx 0 with no match gets NO role, however much it talked", () => {
    // The exact trap: the longest-speaking cluster, labelled "Patient" by the service's own
    // cascade, at index 0. No centroid matched, so nothing is claimed.
    expect(roleForSpeaker(unmatched(0))).toEqual({ role: "unattributed", clinician_id: null, match_confidence: null });
  });

  it("a matched speaker at a HIGH index is still the clinician — order is not evidence either way", () => {
    expect(roleForSpeaker(matched(3))).toEqual({ role: "clinician", clinician_id: "doc_fake0001", match_confidence: 0.82 });
  });

  it("REORDERING the speakers changes nothing — the decision cannot see the index", () => {
    const speakers = [unmatched(0), matched(1, "doc_fake0002"), unmatched(2)];
    const a = rolesByIndex(speakers);
    const b = rolesByIndex([...speakers].reverse());
    for (const idx of [0, 1, 2]) expect(b.get(idx)).toEqual(a.get(idx));
    expect(a.get(1)!.role).toBe("clinician");
    expect(a.get(0)!.role).toBe("unattributed");
  });

  it("the service's own `type` and `label` are NOT evidence — with no centroids it invents them", () => {
    // With an empty centroid list the cascade labels the longest cluster "Patient" and, in other
    // shapes, could say "clinician" from a heuristic. Neither may create an attribution.
    expect(roleForSpeaker(unmatched(0, { type: "clinician", label: "Dr Someone", source: "heuristic" })).role).toBe("unattributed");
    expect(roleForSpeaker(unmatched(1, { type: "patient" })).role).toBe("unattributed");
  });

  it("a clinician_id with NO confidence is not a match this system will assert", () => {
    const half = { idx: 0, label: "x", type: "clinician", clinician_id: "doc_fake0001" } as DiarizeSpeaker;
    expect(roleForSpeaker(half).role, "the number is what a reviewer needs to judge it").toBe("unattributed");
    const blank = { idx: 0, label: "x", type: "clinician", clinician_id: "   ", confidence: 0.9 } as DiarizeSpeaker;
    expect(roleForSpeaker(blank).role).toBe("unattributed");
  });

  it("STRUCTURAL: the role module never reads idx, label, type or speaking time", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/stt/speaker-roles.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const decide = src.slice(src.indexOf("export function roleForSpeaker"), src.indexOf("export function rolesByIndex"));
    for (const forbidden of ["speaker.idx", "speaker.label", "speaker.type", "total_speech_sec", "speaker.source"]) {
      expect(decide, `roleForSpeaker must not read ${forbidden}`).not.toContain(forbidden);
    }
    expect(decide).toContain("speaker.clinician_id");
    expect(decide).toContain("speaker.confidence");
  });

  it("coverage counts only real matches", () => {
    expect(attributionCoverage([unmatched(0), matched(1), unmatched(2)])).toEqual({ speakers: 3, attributed: 1 });
    expect(attributionCoverage([unmatched(0), unmatched(1)])).toEqual({ speakers: 2, attributed: 0 });
  });
});

// ---------------------------------------------------------------------------

const DB = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, turns: [] as Array<Record<string, unknown>>, centroids: [] as Array<Record<string, unknown>> }));
const SVC = vi.hoisted(() => ({ out: {} as Record<string, unknown>, calls: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM voice_print")) return DB.centroids;
    if (q.includes("FROM cue")) return DB.turns;
    if (q.includes("INSERT INTO room_turn_speaker")) {
      // NULL/NOW() are literals; the bound params are contiguous.
      DB.rows.push({ window_id: v[0], source_ref: v[1], speaker_idx: v[2], cluster_id: v[3], overlap_ms: v[4],
                     clinician_id: v[6], role: v[7], match_confidence: v[8] });
      return [];
    }
    return [];
  },
}));
vi.mock("@/lib/diarize", () => ({
  runDiarize: async (_a: unknown, _c: string, opts: Record<string, unknown>) => { SVC.calls.push(opts); return SVC.out; },
}));

const SLICE = { index: 0, start_ms: 1000, end_ms: 121_000 };

describe("D1 — a turn containing a speaker change gets NO name", () => {
  beforeEach(() => {
    DB.rows = []; DB.centroids = []; SVC.calls = [];
  });

  it("THE REFUTER'S CASE: turn 0-1000, speaker 0 (matched) 0-600, speaker 1 600-1000", async () => {
    DB.turns = [{ source_ref: "straddle", start_ms: 1000, end_ms: 2000 }];
    SVC.out = { ok: true, latencyMs: 10, result: {
      speakers: [matched(0), unmatched(1)],
      transcript_segments: [
        { start_ms: 0, end_ms: 600, speaker_idx: 0, overlap: false },
        { start_ms: 600, end_ms: 1000, speaker_idx: 1, overlap: false },
      ],
    } };
    const { diarizeSlice } = await import("@/lib/stt/diarize-window");
    const r = await diarizeSlice({ windowId: "bw_1", roomDayId: "rd_1", slice: SLICE, audio: new Uint8Array([1]) });
    expect(r.ok).toBe(true);
    const row = DB.rows[0]!;
    // The dominant speaker is still recorded — it is a useful diagnostic.
    expect(row.speaker_idx).toBe(0);
    // But 400 ms of someone else's speech means nobody's name goes on this row.
    expect(row.role, "a straddled turn may not carry a clinician").toBe("unattributed");
    expect(row.clinician_id).toBeNull();
    expect(row.match_confidence).toBeNull();
    expect((r as { outcome: { straddled: number } }).outcome.straddled).toBe(1);
  });

  it("an EXCLUSIVE turn still gets its name — the rule is not a blanket refusal", async () => {
    DB.turns = [{ source_ref: "clean", start_ms: 1000, end_ms: 1500 }];
    SVC.out = { ok: true, latencyMs: 10, result: {
      speakers: [matched(0, "doc_fake0002")],
      transcript_segments: [{ start_ms: 0, end_ms: 1000, speaker_idx: 0, overlap: false }],
    } };
    const { diarizeSlice } = await import("@/lib/stt/diarize-window");
    await diarizeSlice({ windowId: "bw_1", roomDayId: "rd_1", slice: SLICE, audio: new Uint8Array([1]) });
    expect(DB.rows[0]!.role).toBe("clinician");
    expect(DB.rows[0]!.clinician_id).toBe("doc_fake0002");
  });

  it("bindTurnsExclusive reports the straddle directly", async () => {
    const { bindTurnsExclusive } = await import("@/lib/stt/speaker-roles");
    const segs = [{ start_ms: 0, end_ms: 600, speaker_idx: 0 }, { start_ms: 600, end_ms: 1000, speaker_idx: 1 }];
    const [b] = bindTurnsExclusive(segs, [{ source_ref: "t", start_ms: 0, end_ms: 1000 }]);
    expect(b).toMatchObject({ speaker_idx: 0, overlap_ms: 600, exclusive: false, speaker_count: 2 });
    const [c] = bindTurnsExclusive(segs, [{ source_ref: "t", start_ms: 0, end_ms: 500 }]);
    expect(c).toMatchObject({ exclusive: true, speaker_count: 1 });
  });
});

describe("D4 — a real 900 s window is REACHABLE and produces rows", () => {
  beforeEach(() => { DB.rows = []; DB.centroids = []; SVC.calls = []; });

  it("900 s becomes 8 slices, every one of which fits a lease", async () => {
    const { sliceBounds, sliceFits, SLICE_MS } = await import("@/lib/stt/diarize-slicing");
    const slices = sliceBounds(0, 900_000);
    expect(SLICE_MS).toBe(120_000);
    expect(slices).toHaveLength(8);
    expect(slices[7]).toEqual({ index: 7, start_ms: 840_000, end_ms: 900_000 });
    for (const s of slices) expect(sliceFits((s.end_ms - s.start_ms) / 1000), `slice ${s.index}`).toBe(true);
  });

  it("REACHABILITY, not arithmetic: slicing a 900 s window writes real rows", async () => {
    const { sliceBounds } = await import("@/lib/stt/diarize-slicing");
    const { diarizeSlice } = await import("@/lib/stt/diarize-window");
    const slices = sliceBounds(0, 900_000);
    for (const sl of slices) {
      // One clean turn per slice, wholly inside it.
      DB.turns = [{ source_ref: `t${sl.index}`, start_ms: sl.start_ms + 1000, end_ms: sl.start_ms + 5000 }];
      SVC.out = { ok: true, latencyMs: 50, result: {
        speakers: [matched(0)],
        transcript_segments: [{ start_ms: 0, end_ms: 120_000, speaker_idx: 0, overlap: false }],
      } };
      const r = await diarizeSlice({ windowId: "bw_900", roomDayId: "rd_1", slice: sl, audio: new Uint8Array([1]) });
      expect(r.ok, `slice ${sl.index} must run`).toBe(true);
    }
    expect(DB.rows, "eight slices, eight rows — the feature fires on a production-sized window").toHaveLength(8);
    expect(DB.rows.every((x) => x.role === "clinician")).toBe(true);
  });

  it("a turn crossing a SLICE SEAM gets no name, however clean the speakers are", async () => {
    // The turn starts inside slice 0 and ends past its end: two clusterings, no single speaker.
    DB.turns = [{ source_ref: "seam", start_ms: 119_000, end_ms: 125_000 }];
    SVC.out = { ok: true, latencyMs: 10, result: {
      speakers: [matched(0)],
      transcript_segments: [{ start_ms: 0, end_ms: 120_000, speaker_idx: 0, overlap: false }],
    } };
    const { diarizeSlice } = await import("@/lib/stt/diarize-window");
    const r = await diarizeSlice({ windowId: "bw_1", roomDayId: "rd_1", slice: { index: 0, start_ms: 0, end_ms: 120_000 }, audio: new Uint8Array([1]) });
    expect(DB.rows[0]!.role).toBe("unattributed");
    expect(DB.rows[0]!.clinician_id).toBeNull();
    expect((r as { outcome: { seam_skipped: number } }).outcome.seam_skipped).toBe(1);
  });
});

describe("D5 — 0.65 is on the wire, always", () => {
  beforeEach(() => { DB.rows = []; DB.centroids = []; SVC.calls = []; DB.turns = []; });

  it("every /diarize call carries the validated threshold, not the service's 0.70 default", async () => {
    const { DIARIZE_BATCH_THRESHOLD, SPEAKER_STITCH_THRESHOLD } = await import("@/lib/stt/diarize-slicing");
    expect(DIARIZE_BATCH_THRESHOLD).toBe(0.65);
    SVC.out = { ok: true, latencyMs: 10, result: { speakers: [], transcript_segments: [] } };
    const { diarizeSlice } = await import("@/lib/stt/diarize-window");
    await diarizeSlice({ windowId: "bw_1", roomDayId: "rd_1", slice: SLICE, audio: new Uint8Array([1]) });
    expect(SVC.calls).toHaveLength(1);
    expect(SVC.calls[0]!.batchThreshold, "inheriting a remote default is how an unvalidated number governs identity").toBe(0.65);
    // The stitch uses the same floor for OUR cosine.
    expect(SPEAKER_STITCH_THRESHOLD).toBe(0.65);
  });

  it("the stitch applies 0.65 to its own cosine — same voice joins, different voice does not", async () => {
    const { stitchSpeakers } = await import("@/lib/stt/diarize-slicing");
    const vec = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");
    const same = vec([1, 0, 0, 0]);
    const near = vec([0.9, 0.436, 0, 0]);   // cosine ~0.90 with `same` — joins
    const far = vec([0, 1, 0, 0]);          // cosine 0 — does not
    const ids = stitchSpeakers([
      { slice: 0, idx: 0, embedding_base64: same, clinician_id: "doc_fake0001", confidence: 0.8 },
      { slice: 1, idx: 0, embedding_base64: near },
      { slice: 2, idx: 0, embedding_base64: far },
    ]);
    const a = ids.get("0:0")!, b = ids.get("1:0")!, c = ids.get("2:0")!;
    expect(b.cluster_id, "a near voice is the same identity").toBe(a.cluster_id);
    expect(c.cluster_id, "a different voice is not").not.toBe(a.cluster_id);
    // The clinician propagates across the stitch, carrying the WEAKEST link's confidence.
    expect(b.clinician_id).toBe("doc_fake0001");
    expect(b.match_confidence!).toBeLessThanOrEqual(0.8);
    expect(c.clinician_id, "an unstitched voice is never named").toBeNull();
  });

  it("a speaker with NO usable embedding is its own identity and is never named", async () => {
    const { stitchSpeakers } = await import("@/lib/stt/diarize-slicing");
    const ids = stitchSpeakers([
      { slice: 0, idx: 0, embedding_base64: Buffer.from(new Float32Array([1, 0]).buffer).toString("base64"), clinician_id: "doc_x", confidence: 0.9 },
      { slice: 1, idx: 0, embedding_base64: null },
    ]);
    expect(ids.get("1:0")!.clinician_id).toBeNull();
    expect(ids.get("1:0")!.cluster_id).not.toBe(ids.get("0:0")!.cluster_id);
  });
});

describe("the reader, and the one diarize kind", () => {
  it("the reader is registered, read-scope, and warns that speaker_idx is not a role", async () => {
    const { STT_TOOLS } = await import("@/lib/mcp/tools/stt");
    const t = STT_TOOLS.find((x) => x.name === "scribe_window_speakers");
    expect(t).toBeTruthy();
    expect(t!.scope).toBe("read");
    expect(t!.description).toMatch(/NOT a role/);
    expect(t!.description).toMatch(/No transcript text/);
  });

  it("D3 — diarize_window is the ONLY diarize kind", async () => {
    const { JOB_KIND_NAMES } = await import("@/lib/jobs/kinds");
    expect(JOB_KIND_NAMES.filter((n) => n.includes("diarize"))).toEqual(["diarize_window"]);
  });

  it("the window id is what goes in encounter_id — no encounter is invented for room audio", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/stt/diarize-window.ts", "utf8");
    expect(src).toMatch(/encounterId: `\$\{opts\.windowId\}#\$\{opts\.slice\.index\}`/);
    expect(src).not.toMatch(/INSERT INTO encounter/);
  });
});
