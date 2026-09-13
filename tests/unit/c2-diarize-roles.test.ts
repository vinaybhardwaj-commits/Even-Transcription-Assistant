/**
 * C2 Part B — role comes from a MATCH, never from an index.
 *
 * server.py:191 sorts clusters by total speaking time descending, so speaker_idx 0 is the most
 * talkative voice — in a consultation usually the doctor, which is what makes ordering the
 * tempting wrong answer. These tests fail if role is ever derived from it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { windowStart, windowEnd } from "@/lib/stt/window-bounds";
import { roleForSpeaker, rolesByIndex, attributionCoverage } from "@/lib/stt/speaker-roles";
import type { DiarizeSpeaker } from "@/lib/diarize";
import { makeFakeClinician } from "../support/fake-identity";

const FAKE_DOC = makeFakeClinician(7);

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
    expect(roleForSpeaker(unmatched(0, { type: "clinician", label: FAKE_DOC.label, source: "heuristic" })).role).toBeNull();
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
      // HONOURS THE PREDICATE. An earlier fake returned every turn for any query containing
      // "FROM cue", which is exactly why it passed while production loaded zero: the real WHERE
      // could never match. The window bounds must actually equal the turn's stamped window.
      const wS = Number(v[1]), wE = Number(v[2]);
      return DB.turns.filter((t) => {
        const win = (t as { window?: { start_ms: number; end_ms: number } }).window ?? { start_ms: wS, end_ms: wE };
        return win.start_ms === wS && win.end_ms === wE;
      });
    }
    if (q.includes("INSERT INTO room_turn_speaker")) {
      // cluster_id, NOW() are LITERALS; the bound params are contiguous.
      DB.rows.push({ window_id: v[0], source_ref: v[1], speaker_idx: v[2], overlap_ms: v[3],
                     clinician_id: v[5], role: v[6], match_confidence: v[7], no_role_reason: v[8] });
      return [];
    }
    return [];
  },
}));
vi.mock("@/lib/diarize", () => ({
  runDiarize: async (_a: unknown, _c: string, opts: Record<string, unknown>) => { SVC.calls.push(opts); return SVC.out; },
}));

const WIN = { start: windowStart(1000), end: windowEnd(901_000) };
const call = (over: Record<string, unknown> = {}) =>
  ({ windowId: "bw_1", roomDayId: "rd_1", window: WIN, audio: new Uint8Array([1]), runId: "run_unit", ...over });

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
    const { diarizeWindow } = await import("@/lib/stt/diarize-window");
    const r = await diarizeWindow(call());
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
    const { diarizeWindow } = await import("@/lib/stt/diarize-window");
    await diarizeWindow(call());
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


describe("0.65 is on the wire, always", () => {
  beforeEach(() => { DB.rows = []; DB.centroids = []; SVC.calls = []; DB.turns = []; });

  it("the /diarize call carries the validated threshold, not the service's 0.70 default", async () => {
    const { diarizeWindow, DIARIZE_BATCH_THRESHOLD } = await import("@/lib/stt/diarize-window");
    expect(DIARIZE_BATCH_THRESHOLD).toBe(0.65);
    SVC.out = { ok: true, latencyMs: 10, result: { speakers: [], transcript_segments: [] } };
    await diarizeWindow(call());
    expect(SVC.calls, "ONE call for the whole window").toHaveLength(1);
    expect(SVC.calls[0]!.batchThreshold, "inheriting a remote default is how an unvalidated number governs identity").toBe(0.65);
    expect(SVC.calls[0]!.encounterId, "the window id, never an invented encounter").toBe("bw_1");
  });
});

describe("the whole window's turns are LOADED, with a count", () => {
  beforeEach(() => { DB.rows = []; DB.centroids = []; SVC.calls = []; });

  it("40 turns stamped with this window load; turns stamped with another window do not", async () => {
    const { loadWindowTurns } = await import("@/lib/stt/diarize-window");
    DB.turns = [
      ...Array.from({ length: 40 }, (_, i) => ({ source_ref: `t${i}`, start_ms: 1000 + i * 22_000, end_ms: 5000 + i * 22_000, window: { start_ms: 1000, end_ms: 901_000 } })),
      // A neighbouring window's turn — the predicate must exclude it, or the fake is lying.
      { source_ref: "other", start_ms: 901_500, end_ms: 905_000, window: { start_ms: 901_000, end_ms: 1_801_000 } },
    ];
    const got = await loadWindowTurns("rd_1", WIN);
    expect(got.length, "the COUNT is the assertion — a broken join reads 0, not 40").toBe(40);
    expect(got.some((t) => t.source_ref === "other")).toBe(false);
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
    expect(src).toContain("encounterId: opts.windowId,");
    expect(src).not.toMatch(/INSERT INTO encounter/);
  });
});

// ---------------------------------------------------------------------------
// R2 — the defects this round closed, each asserted where it actually lives
// ---------------------------------------------------------------------------


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


describe("R4 D5 — one predicate for confidence, and the code refuses before the database does", () => {
  it("usableConfidence is the single gate: NaN, out-of-range and non-numbers all fail it", async () => {
    const { usableConfidence } = await import("@/lib/stt/speaker-roles");
    for (const bad of [Number.NaN, Infinity, -Infinity, -0.01, 1.01, "0.8", null, undefined, {}]) {
      expect(usableConfidence(bad), `${String(bad)} must not pass`).toBe(false);
    }
    for (const good of [0, 0.65, 1]) expect(usableConfidence(good)).toBe(true);
  });

  it("a NaN confidence is refused a role in code, with a named reason, and never reaches an INSERT as a claim", async () => {
    const { roleForSpeaker } = await import("@/lib/stt/speaker-roles");
    const nan = { idx: 0, label: "x", type: "clinician", clinician_id: "doc_x", confidence: Number.NaN } as never;
    expect(roleForSpeaker(nan).role).toBeNull();
    expect(roleForSpeaker(nan).no_role_reason).toBe("no_match");

    DB.rows = []; SVC.calls = [];
    DB.turns = [{ source_ref: "t", start_ms: 1000, end_ms: 1500 }];
    SVC.out = { ok: true, latencyMs: 1, result: { speakers: [nan], transcript_segments: [{ start_ms: 0, end_ms: 1000, speaker_idx: 0, overlap: false }] } };
    const { diarizeWindow } = await import("@/lib/stt/diarize-window");
    await diarizeWindow(call());
    expect(DB.rows[0]!.role, "the row must not claim a clinician on an unusable number").toBeNull();
    expect(DB.rows[0]!.clinician_id).toBeNull();
    expect(DB.rows[0]!.match_confidence).toBeNull();
  });
});

describe("checkCentroid — exactly one 192-float32 voiceprint, byte for byte", () => {
  // fill 16 over 192 dims is a norm of ~221.7 — the scale of the real curated centroids.
  const vec = (dims: number, fill = 16) => Buffer.from(new Float32Array(dims).fill(fill).buffer).toString("base64");
  it("accepts 192 finite floats that re-encode identically", async () => {
    const { checkCentroid } = await import("@/lib/voiceprint-load");
    expect(checkCentroid(vec(192)).ok).toBe(true);
  });
  it("refuses 191 and 193 — never truncated, never padded", async () => {
    const { checkCentroid } = await import("@/lib/voiceprint-load");
    expect(checkCentroid(vec(191))).toEqual({ ok: false, reason: "centroid_dim_191_not_192" });
    expect(checkCentroid(vec(193))).toEqual({ ok: false, reason: "centroid_dim_193_not_192" });
  });
  it("refuses URL-safe base64 — Node's decoder would accept it, the stored bytes would not round-trip to the sent text", async () => {
    const { checkCentroid } = await import("@/lib/voiceprint-load");
    // Force at least one '+' or '/' so the URL-safe spelling differs from the standard one.
    const v = new Float32Array(192).fill(0.1); v[0] = -1.2345e-30; v[1] = 3.4e38;
    const std = Buffer.from(v.buffer).toString("base64");
    const urlSafe = std.replace(/\+/g, "-").replace(/\//g, "_");
    expect(urlSafe, "fixture must actually differ").not.toBe(std);
    expect(Buffer.from(urlSafe, "base64").length, "the lenient decoder takes it").toBe(768);
    expect(checkCentroid(urlSafe)).toEqual({ ok: false, reason: "centroid_not_base64" });
  });
  it("refuses NaN and Infinity, junk, and a missing value", async () => {
    const { checkCentroid } = await import("@/lib/voiceprint-load");
    expect(checkCentroid(vec(192, Number.NaN))).toEqual({ ok: false, reason: "centroid_non_finite_value" });
    expect(checkCentroid(vec(192, Infinity))).toEqual({ ok: false, reason: "centroid_non_finite_value" });
    expect(checkCentroid("not base64!!")).toEqual({ ok: false, reason: "centroid_not_base64" });
    expect(checkCentroid(undefined)).toEqual({ ok: false, reason: "centroid_missing" });
  });
  it("NORM: an all-zero vector is refused — a check on the type is not a check on the thing", async () => {
    const { checkCentroid } = await import("@/lib/voiceprint-load");
    expect(checkCentroid(vec(192, 0))).toEqual({ ok: false, reason: "centroid_norm_below_floor" });
  });
  it("NORM: a near-zero vector is refused, including one just under the floor", async () => {
    const { checkCentroid, MIN_CENTROID_L2 } = await import("@/lib/voiceprint-load");
    expect(MIN_CENTROID_L2).toBe(20);
    expect(checkCentroid(vec(192, 1e-3))).toEqual({ ok: false, reason: "centroid_norm_below_floor" });
    expect(checkCentroid(vec(192, 1e-30))).toEqual({ ok: false, reason: "centroid_norm_below_floor" });
    // One non-zero component, the rest zero: finite, "not all zero", still no usable direction scale.
    const one = new Float32Array(192); one[7] = 5;
    expect(checkCentroid(Buffer.from(one.buffer).toString("base64"))).toEqual({ ok: false, reason: "centroid_norm_below_floor" });
    // Just under and just over the floor: the boundary is the constant, not an accident.
    const under = new Float32Array(192).fill(19.9 / Math.sqrt(192));
    const over = new Float32Array(192).fill(20.1 / Math.sqrt(192));
    expect(checkCentroid(Buffer.from(under.buffer).toString("base64")).ok).toBe(false);
    expect(checkCentroid(Buffer.from(over.buffer).toString("base64")).ok).toBe(true);
  });
  it("NORM: a vector at a real ECAPA centroid's scale is accepted (synthetic — real voiceprints never enter this public repo)", async () => {
    const { checkCentroid } = await import("@/lib/voiceprint-load");
    const v = new Float32Array(192);
    for (let i = 0; i < 192; i += 1) v[i] = Math.sin(i * 0.7 + 1.3) * 22.6; // L2 ~ 221, the smallest real one measured
    expect(checkCentroid(Buffer.from(v.buffer).toString("base64")).ok).toBe(true);
  });
  it("redact removes a base64 blob from any string", async () => {
    const { redact } = await import("@/lib/voiceprint-load");
    expect(redact(`boom ${vec(192)} end`)).toBe("boom [redacted] end");
  });
});
