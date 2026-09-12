/**
 * C2 Part B — role comes from a MATCH, never from an index.
 *
 * server.py:191 sorts clusters by total speaking time descending, so speaker_idx 0 is the most
 * talkative voice — in a consultation usually the doctor, which is what makes ordering the
 * tempting wrong answer. These tests fail if role is ever derived from it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { windowStart, windowEnd, sliceStart, sliceEnd } from "@/lib/stt/window-bounds";
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
    expect(roleForSpeaker(unmatched(0))).toEqual({ role: null, clinician_id: null, match_confidence: null, no_role_reason: "no_match" });
  });

  it("a matched speaker at a HIGH index is still the clinician — order is not evidence either way", () => {
    expect(roleForSpeaker(matched(3))).toEqual({ role: "clinician", clinician_id: "doc_fake0001", match_confidence: 0.82, no_role_reason: null });
  });

  it("REORDERING the speakers changes nothing — the decision cannot see the index", () => {
    const speakers = [unmatched(0), matched(1, "doc_fake0002"), unmatched(2)];
    const a = rolesByIndex(speakers);
    const b = rolesByIndex([...speakers].reverse());
    for (const idx of [0, 1, 2]) expect(b.get(idx)).toEqual(a.get(idx));
    expect(a.get(1)!.role).toBe("clinician");
    expect(a.get(0)!.role).toBeNull();
  });

  it("the service's own `type` and `label` are NOT evidence — with no centroids it invents them", () => {
    // With an empty centroid list the cascade labels the longest cluster "Patient" and, in other
    // shapes, could say "clinician" from a heuristic. Neither may create an attribution.
    expect(roleForSpeaker(unmatched(0, { type: "clinician", label: "Dr Someone", source: "heuristic" })).role).toBeNull();
    expect(roleForSpeaker(unmatched(1, { type: "patient" })).role).toBeNull();
  });

  it("a clinician_id with NO confidence is not a match this system will assert", () => {
    const half = { idx: 0, label: "x", type: "clinician", clinician_id: "doc_fake0001" } as DiarizeSpeaker;
    expect(roleForSpeaker(half).role, "the number is what a reviewer needs to judge it").toBeNull();
    const blank = { idx: 0, label: "x", type: "clinician", clinician_id: "   ", confidence: 0.9 } as DiarizeSpeaker;
    expect(roleForSpeaker(blank).role).toBeNull();
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
    if (q.includes("FROM cue")) {
      // HONOURS THE PREDICATE. The round-1 fake returned every turn for any query containing
      // "FROM cue", which is exactly why it passed while production loaded zero: the real WHERE
      // could never match. Window bounds identify the window; the turn's own bounds select.
      const wS = Number(v[1]), wE = Number(v[2]);
      const hasSlice = q.includes("payload->>'start_ms')::bigint <");
      const sE = hasSlice ? Number(v[3]) : Infinity;
      const sS = hasSlice ? Number(v[4]) : -Infinity;
      return DB.turns.filter((t) => {
        const win = (t as { window?: { start_ms: number; end_ms: number } }).window ?? { start_ms: wS, end_ms: wE };
        if (win.start_ms !== wS || win.end_ms !== wE) return false;
        return Number(t.start_ms) < sE && Number(t.end_ms) > sS;
      });
    }
    if (q.includes("INSERT INTO room_turn_speaker")) {
      // NULL/NOW() are literals; the bound params are contiguous.
      DB.rows.push({ window_id: v[0], source_ref: v[1], speaker_idx: v[2], cluster_id: v[3], overlap_ms: v[4],
                     clinician_id: v[6], role: v[7], match_confidence: v[8], no_role_reason: v[9] });
      return [];
    }
    return [];
  },
}));
vi.mock("@/lib/diarize", () => ({
  runDiarize: async (_a: unknown, _c: string, opts: Record<string, unknown>) => { SVC.calls.push(opts); return SVC.out; },
}));

const WIN = { start: windowStart(1000), end: windowEnd(901_000) };
const SLICE = { index: 0, start: sliceStart(1000), end: sliceEnd(121_000) };
const call = (over: Record<string, unknown> = {}) =>
  ({ windowId: "bw_1", roomDayId: "rd_1", window: WIN, slice: SLICE, audio: new Uint8Array([1]), ...over });

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
    const r = await diarizeSlice(call());
    expect(r.ok).toBe(true);
    const row = DB.rows[0]!;
    // The dominant speaker is still recorded — it is a useful diagnostic.
    expect(row.speaker_idx).toBe(0);
    // But 400 ms of someone else's speech means nobody's name goes on this row.
    expect(row.role, "a straddled turn may not carry a clinician").toBeNull();
    expect(row.no_role_reason, "and the row records WHY, so the stitch cannot undo it").toBe("straddle");
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
    await diarizeSlice(call());
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
    expect(slices[7]).toEqual({ index: 7, start: 840_000, end: 900_000 });
    for (const s of slices) expect(sliceFits((s.end - s.start) / 1000), `slice ${s.index}`).toBe(true);
  });

  it("REACHABILITY, not arithmetic: slicing a 900 s window writes real rows", async () => {
    const { sliceBounds } = await import("@/lib/stt/diarize-slicing");
    const { diarizeSlice } = await import("@/lib/stt/diarize-window");
    const slices = sliceBounds(0, 900_000);
    for (const sl of slices) {
      // One clean turn per slice, wholly inside it.
      DB.turns = [{ source_ref: `t${sl.index}`, start_ms: sl.start + 1000, end_ms: sl.start + 5000 }];
      SVC.out = { ok: true, latencyMs: 50, result: {
        speakers: [matched(0)],
        transcript_segments: [{ start_ms: 0, end_ms: 120_000, speaker_idx: 0, overlap: false }],
      } };
      const r = await diarizeSlice(call({ windowId: "bw_900", window: { start: windowStart(0), end: windowEnd(900_000) }, slice: sl }));
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
    const r = await diarizeSlice(call({ window: { start: windowStart(0), end: windowEnd(900_000) }, slice: { index: 0, start: sliceStart(0), end: sliceEnd(120_000) } }));
    expect(DB.rows[0]!.role).toBeNull();
    expect(DB.rows[0]!.no_role_reason).toBe("seam");
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
    await diarizeSlice(call());
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

// ---------------------------------------------------------------------------
// R2 — the defects this round closed, each asserted where it actually lives
// ---------------------------------------------------------------------------

describe("R2 D2 — turns are LOADED per slice, with a count", () => {
  beforeEach(() => { DB.rows = []; DB.centroids = []; SVC.calls = []; });

  it("40 turns in a 900 s window are loaded BY SLICE, not lost to a window/slice bound mix-up", async () => {
    const { loadSliceTurns, loadWindowTurns } = await import("@/lib/stt/diarize-window");
    // 40 turns spread across the window, each stamped with the 900 s WINDOW bounds, as buildTurns does.
    DB.turns = Array.from({ length: 40 }, (_, i) => ({
      source_ref: `t${i}`, start_ms: i * 22_000, end_ms: i * 22_000 + 4_000,
      window: { start_ms: 0, end_ms: 900_000 },
    }));
    const win = { start: windowStart(0), end: windowEnd(900_000) };
    expect(await loadWindowTurns("rd_1", win), "the control: the whole window").toHaveLength(40);

    const { snappedSliceBounds } = await import("@/lib/stt/diarize-slicing");
    const slices = snappedSliceBounds(0, 900_000, DB.turns.map((t) => ({ start_ms: Number(t.start_ms), end_ms: Number(t.end_ms) })));
    const seen = new Set<string>();
    let nonEmpty = 0;
    for (const sl of slices) {
      const got = await loadSliceTurns("rd_1", win, sl);
      if (got.length > 0) nonEmpty += 1;
      for (const t of got) seen.add(t.source_ref);
    }
    // THE COUNT IS THE ASSERTION. Production loaded ZERO here; the fake now honours the predicate,
    // so a regression to window-vs-slice bounds makes this read 0 rather than 40.
    expect(seen.size, "every turn must be reachable by some slice").toBe(40);
    expect(nonEmpty, "and the work must be spread across slices, not landing in one").toBeGreaterThan(5);
  });
});

describe("R2 D1 — the stitch may fill only 'no_match'", () => {
  const UPDATES = vi.hoisted(() => ({ sql: [] as string[] }));
  it("straddle and seam rows survive a stitch untouched; a no_match row is filled", async () => {
    // Drive the REAL UPDATE against a tiny row store that applies its WHERE clause.
    const rows: Array<Record<string, unknown>> = [
      { source_ref: "straddle", cluster_id: "s0:0", role: null, no_role_reason: "straddle", clinician_id: null, match_confidence: null },
      { source_ref: "seam", cluster_id: "s0:0", role: null, no_role_reason: "seam", clinician_id: null, match_confidence: null },
      { source_ref: "nomatch", cluster_id: "s0:0", role: null, no_role_reason: "no_match", clinician_id: null, match_confidence: null },
    ];
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
        const q = strings.join("?").replace(/\s+/g, " ");
        UPDATES.sql.push(q);
        if (!q.includes("UPDATE room_turn_speaker") || !q.includes("SET cluster_id") || !q.includes("no_role_reason = 'no_match'")) return [];
        const hit = rows.filter((r) => r.cluster_id === "s0:0" && r.role === null && r.no_role_reason === "no_match");
        for (const r of hit) { r.role = "clinician"; r.clinician_id = v[1]; r.match_confidence = v[2]; r.no_role_reason = null; }
        return hit.map((r) => ({ source_ref: r.source_ref }));
      },
    }));
    const { applyStitch } = await import("@/lib/stt/diarize-window");
    await applyStitch("bw_1", new Map([["0:0", { cluster_id: "rsc_0", clinician_id: "doc_x", match_confidence: 0.66 }]]));

    // ASSERTED ON THE ROW, after the UPDATE — not on the function's return value.
    const byRef = new Map(rows.map((r) => [r.source_ref, r]));
    expect(byRef.get("straddle")!.role, "structural: two speakers really did hold this turn").toBeNull();
    expect(byRef.get("straddle")!.clinician_id).toBeNull();
    expect(byRef.get("seam")!.role, "structural: it belongs to two clusterings").toBeNull();
    expect(byRef.get("seam")!.clinician_id).toBeNull();
    expect(byRef.get("nomatch")!.role, "unresolved, so the stitch may resolve it").toBe("clinician");
    expect(byRef.get("nomatch")!.clinician_id).toBe("doc_x");
    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });
});

describe("R2 D3 — no synthetic 1.0 at the opener", () => {
  it("an opener named through a 0.66 joiner records 0.66, not the service's 0.9", async () => {
    const { stitchSpeakers } = await import("@/lib/stt/diarize-slicing");
    const vec = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");
    // Two vectors ~0.66 apart. The OPENER is unmatched; the NAME arrives from the joiner.
    const a = vec([1, 0]);
    const b = vec([0.66, 0.7513]);
    const ids = stitchSpeakers([
      { slice: 0, idx: 0, embedding_base64: a },
      { slice: 1, idx: 0, embedding_base64: b, clinician_id: "doc_x", confidence: 0.9 },
    ]);
    const opener = ids.get("0:0")!;
    expect(opener.clinician_id).toBe("doc_x");
    expect(opener.match_confidence!, "its link runs through a 0.66 hop and cannot be worth 0.9").toBeLessThanOrEqual(0.67);
  });
});

describe("R2 ruling — snapping cuts between turns", () => {
  it("a window with known turn bounds is cut without splitting any of them, all slices <= 120 s", async () => {
    const { snappedSliceBounds, SLICE_MS } = await import("@/lib/stt/diarize-slicing");
    // Turns every 20 s, 15 s long — so there is always a gap near the nominal 120 s marks.
    const turns = Array.from({ length: 45 }, (_, i) => ({ start_ms: i * 20_000, end_ms: i * 20_000 + 15_000 }));
    const slices = snappedSliceBounds(0, 900_000, turns);
    for (const sl of slices) {
      expect(sl.end - sl.start, `slice ${sl.index} exceeds the cap`).toBeLessThanOrEqual(SLICE_MS);
      const cutsATurn = turns.some((t) => t.start_ms < sl.end && t.end_ms > sl.end && sl.end !== 900_000);
      expect(cutsATurn, `slice ${sl.index} ends inside a turn`).toBe(false);
    }
    expect(slices[slices.length - 1]!.end).toBe(900_000);
  });

  it("with NO turn boundary available it falls back to the hard cut, never past the cap", async () => {
    const { snappedSliceBounds, SLICE_MS } = await import("@/lib/stt/diarize-slicing");
    // One continuous 900 s turn: nowhere to snap to.
    const slices = snappedSliceBounds(0, 900_000, [{ start_ms: 0, end_ms: 900_000 }]);
    // The COUNT follows from the stride, which is deliberately a snap-width short of the cap so
    // both halves of ±10 s are reachable. What must hold is the cap and full coverage, not 8.
    expect(slices.length).toBeGreaterThanOrEqual(8);
    for (const sl of slices) expect(sl.end - sl.start).toBeLessThanOrEqual(SLICE_MS);
    expect(slices[0]!.start).toBe(0);
    expect(slices[slices.length - 1]!.end).toBe(900_000);
  });
});

describe("R2 D5 — the job door enumerates the live registry", () => {
  it("the submit tool's enum and its prose both equal JOB_KIND_NAMES", async () => {
    const { JOB_TOOLS } = await import("@/lib/mcp/tools/jobs");
    const { JOB_KIND_NAMES } = await import("@/lib/jobs/kinds");
    const t = JOB_TOOLS.find((x) => x.name === "scribe_job_submit")!;
    const enumList = ((t.inputSchema as unknown as { properties: { kind: { enum: string[] } } }).properties.kind.enum);
    expect([...enumList].sort()).toEqual([...JOB_KIND_NAMES].sort());
    for (const k of JOB_KIND_NAMES) expect(t.description, `the door must name ${k}`).toContain(k);
    expect(t.description, "a kind that no longer exists must not be advertised").not.toContain("diarize_clip");
  });
});

describe("R2 rulings — the stitch verifies its inputs; a re-run does not duplicate", () => {
  it("the stitch REFUSES a partial window and names the missing slices", async () => {
    const STORE = { slices: [] as Array<{ index: number; speakers: unknown[] }> };
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      sql: async (strings: TemplateStringsArray) => {
        const q = strings.join("?").replace(/\s+/g, " ");
        if (q.includes("FROM bench_window")) return [{ id: "bw_1", session_id: "s1", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000, source_mic: "primary" }];
        if (q.includes("FROM cue")) return [];
        if (q.includes("speakers_json FROM room_diarize_window")) return [{ speakers_json: STORE }];
        return [];
      },
    }));
    const { diarizeWindowKind } = await import("@/lib/jobs/kinds/diarize-window");
    // Drive the REAL planner so the geometry is whatever the algorithm says, then drop one.
    const { snappedSliceBounds } = await import("@/lib/stt/diarize-slicing");
    const N = snappedSliceBounds(0, 900_000, []).length;
    STORE.slices = Array.from({ length: N }, (_, i) => i).filter((i) => i !== 3).map((i) => ({ index: i, speakers: [] }));
    const out = await diarizeWindowKind.run({ job: {} as never, step: "stitch", args: { window_id: "bw_1" }, progress: {}, runner: "r1" });
    expect(out.kind, "a stitch over a partial window produces identities that are quietly wrong").toBe("fail");
    expect((out as { error: string }).error).toContain("3");
    expect((out as { error: string }).error).toContain("missing");

    // With all eight it proceeds, and reports the OBSERVED count.
    STORE.slices = Array.from({ length: N }, (_, i) => ({ index: i, speakers: [] }));
    const ok = await diarizeWindowKind.run({ job: {} as never, step: "stitch", args: { window_id: "bw_1" }, progress: {}, runner: "r1" });
    expect(ok.kind).toBe("done");
    expect((ok as { result: Record<string, unknown> }).result.slices, "observed, never planned").toBe(N);

    // R3 D6 — SET EQUALITY. An unplanned index and a duplicate must BOTH be refused, where
    // presence-only checking let them through while inflating the count.
    STORE.slices = [...Array.from({ length: N }, (_, i) => ({ index: i, speakers: [] })), { index: 99, speakers: [] }];
    const extra = await diarizeWindowKind.run({ job: {} as never, step: "stitch", args: { window_id: "bw_1" }, progress: {}, runner: "r1" });
    expect(extra.kind, "an index that was never planned").toBe("fail");
    expect((extra as { error: string }).error).toContain("unplanned 99");

    STORE.slices = [{ index: 0, speakers: [] }, ...Array.from({ length: N }, (_, i) => ({ index: i, speakers: [] }))];
    const dup = await diarizeWindowKind.run({ job: {} as never, step: "stitch", args: { window_id: "bw_1" }, progress: {}, runner: "r1" });
    expect(dup.kind, "a duplicated index — the invariant the slice write exists to maintain").toBe("fail");
    expect((dup as { error: string }).error).toContain("duplicated 0");
    // R3 D7 — the failure branch states the OBSERVED count, not just the planned denominator.
    expect((dup as { error: string }).error).toMatch(/observed \d+ of \d+ planned/);
    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });

  it("the slice write REPLACES its index — running slice 0 twice leaves ONE entry", async () => {
    // The statement is asserted directly: it must strip index i before appending it.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/jobs/kinds/diarize-window.ts", "utf8");
    expect(src, "append-only is how a lease loss produced indices [0,0]").toContain("WHERE (e->>'index')::int <> ");
    expect(src).toContain("jsonb_array_elements");
    // And the shape it produces: strip-then-append is idempotent for a repeated index.
    const strip = (entries: Array<{ index: number }>, i: number) => entries.filter((e) => e.index !== i);
    let entries = [{ index: 0 }, { index: 1 }];
    entries = [...strip(entries, 0), { index: 0 }];
    entries = [...strip(entries, 0), { index: 0 }];
    expect(entries.filter((e) => e.index === 0), "one entry per index, however many re-runs").toHaveLength(1);
  });
});

describe("R3 D3 — the snap window is genuinely two-sided", () => {
  /** The R2 algorithm, reimplemented here as the BEFORE oracle: nominal at +SLICE_MS. */
  const backwardOnly = (startMs: number, endMs: number, turns: Array<{ start_ms: number; end_ms: number }>, L: number, S: number) => {
    const edges = [...new Set(turns.flatMap((t) => [t.start_ms, t.end_ms]))].sort((a, b) => a - b);
    const clean = (at: number) => !turns.some((t) => t.start_ms < at && t.end_ms > at);
    const out: Array<{ start: number; end: number }> = [];
    let from = startMs;
    while (from < endMs) {
      const nominal = Math.min(endMs, from + L);
      if (nominal >= endMs) { out.push({ start: from, end: endMs }); break; }
      const lo = Math.max(from + 1, nominal - S), hi = Math.min(from + L, nominal + S);
      let best: number | null = null;
      for (const e of edges) {
        if (e < lo || e > hi || e >= endMs || !clean(e)) continue;
        if (best === null || Math.abs(e - nominal) < Math.abs(best - nominal)) best = e;
      }
      const cut = best ?? nominal;
      out.push({ start: from, end: cut });
      from = cut;
    }
    return out;
  };

  it("4000 random layouts: splits fall sharply, and no slice ever exceeds the cap", async () => {
    const { snappedSliceBounds, SLICE_MS, SNAP_WINDOW_MS } = await import("@/lib/stt/diarize-slicing");
    let rng = 12345;
    const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let before = 0, after = 0, cuts = 0, overCap = 0, layouts = 0;
    for (let n = 0; n < 4000; n += 1) {
      const turns: Array<{ start_ms: number; end_ms: number }> = [];
      let t = 0;
      while (t < 900_000) {
        const dur = 1000 + Math.floor(rand() * 12_000);
        const gap = Math.floor(rand() * 9_000);
        if (t + dur >= 900_000) break;
        turns.push({ start_ms: t, end_ms: t + dur });
        t += dur + gap;
      }
      if (turns.length < 5) continue;
      layouts += 1;
      const splitsIn = (sl: Array<{ start: number; end: number }>) => {
        let s = 0;
        for (let i = 0; i < sl.length - 1; i += 1) if (turns.some((x) => x.start_ms < sl[i]!.end && x.end_ms > sl[i]!.end)) s += 1;
        return s;
      };
      const now = snappedSliceBounds(0, 900_000, turns).map((s) => ({ start: s.start as number, end: s.end as number }));
      for (const s of now) { if (s.end - s.start > SLICE_MS) overCap += 1; }
      cuts += now.length - 1;
      after += splitsIn(now);
      before += splitsIn(backwardOnly(0, 900_000, turns, SLICE_MS, SNAP_WINDOW_MS));
    }
    // eslint-disable-next-line no-console
    console.log(`SNAP SWEEP layouts=${layouts} interior_cuts=${cuts} splits_before=${before} splits_after=${after} over_cap=${overCap}`);
    expect(overCap, "the cap outranks the snap, always").toBe(0);
    expect(after, "a two-sided search must split fewer turns than a one-sided one").toBeLessThan(before);
  });

  it("a clean edge AFTER the nominal mark is now reachable — it never was before", async () => {
    const { snappedSliceBounds, SLICE_MS, SNAP_WINDOW_MS } = await import("@/lib/stt/diarize-slicing");
    const stride = SLICE_MS - SNAP_WINDOW_MS;
    // One long turn straddling the nominal mark, with the only clean edge 5 s AFTER it.
    const turns = [{ start_ms: 0, end_ms: stride + 5_000 }, { start_ms: stride + 9_000, end_ms: 900_000 }];
    const sl = snappedSliceBounds(0, 900_000, turns);
    expect(sl[0]!.end as number, "the forward edge is inside ±10 s and under the cap").toBe(stride + 5_000);
    expect((sl[0]!.end as number) - (sl[0]!.start as number)).toBeLessThanOrEqual(SLICE_MS);
  });
});

describe("R3 D5 — the plan is frozen on the row", () => {
  it("the bounds ride in progress and later steps read them, so turns moving cannot move geometry", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/jobs/kinds/diarize-window.ts", "utf8");
    expect(src, "the plan is read from progress before it is ever recomputed").toContain("let slices = readPlan(ctx.progress);");
    expect(src).toContain("slice_plan: writePlan(slices)");
    // And the stitch uses the same frozen plan — it must not call the planner itself.
    const stitchBranch = src.slice(src.indexOf('if (ctx.step === STEPS.stitch)'), src.indexOf('if (ctx.step !== STEPS.slice)'));
    expect(stitchBranch, "the stitch must not re-plan").not.toContain("snappedSliceBounds(");
  });
});

describe("R3 close-out — the ten adversarial layouts", () => {
  it("every invariant holds on all ten, and the split count is REPORTED per layout", async () => {
    const { snappedSliceBounds, SLICE_MS } = await import("@/lib/stt/diarize-slicing");
    const { SNAP_LAYOUTS, SNAP_WINDOW_END } = await import("../support/snap-layouts");

    let aggregate = 0;
    const lines: string[] = [];
    for (const L of SNAP_LAYOUTS) {
      const sl = snappedSliceBounds(0, SNAP_WINDOW_END, L.turns);
      // ── cap ──────────────────────────────────────────────────────────────────────────────
      for (const s of sl) {
        expect((s.end as number) - (s.start as number), `${L.id}: slice ${s.index} exceeds the cap`).toBeLessThanOrEqual(SLICE_MS);
        expect((s.end as number) - (s.start as number), `${L.id}: slice ${s.index} is empty`).toBeGreaterThan(0);
      }
      // ── monotonic, tiling, no hole, sequential indices ───────────────────────────────────
      expect(sl[0]!.start as number, `${L.id}: does not start at the window start`).toBe(0);
      expect(sl[sl.length - 1]!.end as number, `${L.id}: does not reach the window end`).toBe(SNAP_WINDOW_END);
      for (let i = 1; i < sl.length; i += 1) {
        expect(sl[i]!.start as number, `${L.id}: hole or overlap at slice ${i}`).toBe(sl[i - 1]!.end as number);
        expect(sl[i]!.index, `${L.id}: indices not sequential`).toBe(sl[i - 1]!.index + 1);
      }
      // ── splits, counted, not tuned ───────────────────────────────────────────────────────
      let splits = 0;
      for (let i = 0; i < sl.length - 1; i += 1) {
        const at = sl[i]!.end as number;
        if (L.turns.some((t) => t.start_ms < at && t.end_ms > at)) splits += 1;
      }
      aggregate += splits;
      lines.push(`  ${L.id} slices=${String(sl.length).padStart(2)} cuts=${String(sl.length - 1).padStart(2)} splits=${splits}  ${L.what}`);
    }
    // eslint-disable-next-line no-console
    console.log(`TEN LAYOUTS (aggregate splits = ${aggregate})\n${lines.join("\n")}`);
    // NO assertion on the split count. These layouts are built to be unsatisfiable in places —
    // B has no clean edge anywhere, I has none at all — so a threshold here would be a number
    // chosen to pass rather than a fact. The invariants above are what must hold.
    expect(aggregate).toBeGreaterThanOrEqual(0);
  });
});

describe("R4 D5 — one predicate for confidence, and the code refuses before the database does", () => {
  it("usableConfidence is the single gate: NaN, out-of-range and non-numbers all fail it", async () => {
    const { usableConfidence } = await import("@/lib/stt/speaker-roles");
    for (const bad of [Number.NaN, Infinity, -Infinity, -0.01, 1.01, "0.8", null, undefined, {}]) {
      expect(usableConfidence(bad), `${String(bad)} must not pass`).toBe(false);
    }
    for (const good of [0, 0.65, 1]) expect(usableConfidence(good)).toBe(true);
  });

  it("a NaN confidence is refused by BOTH gates — it used to pass one and fail the other", async () => {
    const { roleForSpeaker } = await import("@/lib/stt/speaker-roles");
    const { stitchSpeakers } = await import("@/lib/stt/diarize-slicing");
    const nan = { idx: 0, label: "x", type: "clinician", clinician_id: "doc_x", confidence: Number.NaN } as never;
    // Gate 1 — the per-speaker role.
    expect(roleForSpeaker(nan).role).toBeNull();
    expect(roleForSpeaker(nan).no_role_reason).toBe("no_match");
    // Gate 2 — the cross-slice identity. This one used to accept NaN and hand it to an UPDATE,
    // where 0085's confidence CHECK would have refused it: a database doing a code gate's job.
    const vec = Buffer.from(new Float32Array([1, 0]).buffer).toString("base64");
    const ids = stitchSpeakers([{ slice: 0, idx: 0, embedding_base64: vec, clinician_id: "doc_x", confidence: Number.NaN }]);
    const id = ids.get("0:0")!;
    expect(id.clinician_id, "no name may be claimed on an unusable number").toBeNull();
    expect(id.match_confidence).toBeNull();
  });

  it("applyStitch never issues an UPDATE for an identity with no usable claim", async () => {
    const seen: string[] = [];
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ sql: async (s: TemplateStringsArray) => { seen.push(s.join("?")); return []; } }));
    const { applyStitch } = await import("@/lib/stt/diarize-window");
    const n = await applyStitch("bw_1", new Map([["0:0", { cluster_id: "rsc_0", clinician_id: null, match_confidence: null }]]));
    expect(n).toBe(0);
    expect(seen, "a claimless identity must not reach the database at all").toHaveLength(0);
    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });
});
