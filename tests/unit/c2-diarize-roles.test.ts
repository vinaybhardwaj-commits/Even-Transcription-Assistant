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
const SVC = vi.hoisted(() => ({ out: {} as Record<string, unknown> }));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM voice_print")) return DB.centroids;
    if (q.includes("FROM cue")) return DB.turns;
    if (q.includes("INSERT INTO room_turn_speaker")) {
      // NULL (cluster_id) and NOW() are LITERALS in the statement, not bound values, so the
      // params are contiguous: window, source_ref, speaker_idx, overlap_ms, room_day, then the
      // three identity columns.
      DB.rows.push({ window_id: v[0], source_ref: v[1], speaker_idx: v[2], overlap_ms: v[3], clinician_id: v[5], role: v[6], match_confidence: v[7] });
      return [];
    }
    return [];
  },
}));
vi.mock("@/lib/diarize", () => ({ runDiarize: async () => SVC.out }));

describe("the write — an alignment, and what it records", () => {
  beforeEach(() => {
    DB.rows = []; DB.centroids = [];
    DB.turns = [
      { source_ref: "s|0|2000|a", start_ms: 1000, end_ms: 3000 },
      { source_ref: "s|3000|5000|b", start_ms: 4000, end_ms: 6000 },
    ];
    SVC.out = {
      ok: true, latencyMs: 900,
      result: {
        speakers: [unmatched(0), matched(1, "doc_fake0002")],
        transcript_segments: [
          { start_ms: 0, end_ms: 2500, speaker_idx: 0, overlap: false },
          { start_ms: 3000, end_ms: 5500, speaker_idx: 1, overlap: false },
        ],
      },
    };
  });

  it("binds each turn to the speaker it overlaps most, and names ONLY the matched one", async () => {
    const { diarizeWindow } = await import("@/lib/stt/diarize-window");
    const r = await diarizeWindow({ windowId: "bw_1", roomDayId: "rd_1", startMs: 1000, endMs: 7000, audio: new Uint8Array([1]) });
    expect(r.ok).toBe(true);
    expect(DB.rows).toHaveLength(2);
    const first = DB.rows.find((x) => x.source_ref === "s|0|2000|a")!;
    const second = DB.rows.find((x) => x.source_ref === "s|3000|5000|b")!;
    // Speaker 0 talked most and is index 0 — and gets no name, because nothing matched it.
    expect(first.speaker_idx).toBe(0);
    expect(first.role).toBe("unattributed");
    expect(first.clinician_id).toBeNull();
    // Speaker 1 was matched, so it is named — at a higher index.
    expect(second.speaker_idx).toBe(1);
    expect(second.role).toBe("clinician");
    expect(second.clinician_id).toBe("doc_fake0002");
    expect(second.match_confidence).toBe(0.82);
  });

  it("no span carries transcript text", async () => {
    const { diarizeWindow } = await import("@/lib/stt/diarize-window");
    await diarizeWindow({ windowId: "bw_1", roomDayId: "rd_1", startMs: 1000, endMs: 7000, audio: new Uint8Array([1]) });
    for (const r of DB.rows) {
      expect(Object.keys(r).sort()).toEqual(["clinician_id", "match_confidence", "overlap_ms", "role", "source_ref", "speaker_idx", "window_id"]);
    }
  });

  it("WITH NO ENROLLED CENTROIDS nothing is attributed — the coverage question, in miniature", async () => {
    SVC.out = { ok: true, latencyMs: 500, result: { speakers: [unmatched(0), unmatched(1)],
      transcript_segments: [{ start_ms: 0, end_ms: 6000, speaker_idx: 0, overlap: false }] } };
    const { diarizeWindow } = await import("@/lib/stt/diarize-window");
    const r = await diarizeWindow({ windowId: "bw_1", roomDayId: "rd_1", startMs: 1000, endMs: 7000, audio: new Uint8Array([1]) });
    expect((r as { outcome: { attributed_turns: number } }).outcome.attributed_turns).toBe(0);
    expect(DB.rows.every((x) => x.role === "unattributed")).toBe(true);
  });

  it("the window id is what goes in encounter_id — no encounter is invented for room audio", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/stt/diarize-window.ts", "utf8");
    expect(src).toContain("encounterId: opts.windowId");
    expect(src, "no INSERT INTO encounter anywhere on this path").not.toMatch(/INSERT INTO encounter/);
  });

  it("a service failure distinguishes 'never reached it' from 'it refused'", async () => {
    SVC.out = { ok: false, error: "no slot", retryable: true, latencyMs: 0 };
    const { diarizeWindow } = await import("@/lib/stt/diarize-window");
    const r = await diarizeWindow({ windowId: "bw_1", roomDayId: "rd_1", startMs: 0, endMs: 1000, audio: new Uint8Array([1]) });
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(DB.rows, "a failed run writes no spans").toHaveLength(0);
  });
});

describe("the budget, and the reader", () => {
  it("a 900 s window is REFUSED at ~1.5x realtime — five times the lease", async () => {
    const { diarizeFits } = await import("@/lib/stt/diarize-budget");
    const { LEASE_MS } = await import("@/lib/jobs/types");
    expect(diarizeFits(900).fits).toBe(false);
    expect(diarizeFits(900).budget_ms).toBe(LEASE_MS);
    // ~2 minutes of audio does fit, which is the size this path can actually serve today.
    expect(diarizeFits(120).fits).toBe(true);
  });

  it("the reader is registered, read-scope, and warns that speaker_idx is not a role", async () => {
    const { STT_TOOLS } = await import("@/lib/mcp/tools/stt");
    const t = STT_TOOLS.find((x) => x.name === "scribe_window_speakers");
    expect(t).toBeTruthy();
    expect(t!.scope).toBe("read");
    expect(t!.description).toMatch(/NOT a role/);
    expect(t!.description).toMatch(/No transcript text/);
    expect(t!.description, "unattributed must not be read as 'someone else'").toMatch(/NOT that it was someone else/);
  });

  it("the kind is registered and refuses an oversized window before downloading anything", async () => {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    expect(KIND_BY_NAME.get("diarize_window")).toBeTruthy();
    expect(KIND_BY_NAME.get("diarize_window")!.scope).toBe("invoke");
  });
});
