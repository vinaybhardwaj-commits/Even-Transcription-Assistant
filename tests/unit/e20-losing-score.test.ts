/**
 * E20 — the score that lost (lib/stt/losing-score.ts, written by lib/stt/diarize-window.ts, 0096).
 *
 * The diarize service discards the losing candidate before responding (server.py:209-216). The app
 * recomputes it from the embeddings the service returns — a shadow of the service's match — so these tests
 * prove three things: the shadow MIRRORS the service (including its greedy exclusion), the shadow is
 * CONTROLLED (matched speakers recomputed and compared, a window that disagrees writes nothing), and the
 * WRITE touches only an exclusive no_match turn, leaving a named turn exactly as it is today.
 *
 * Vectors are synthetic and constructed so each cosine is known exactly: a speaker embedding is
 * cos θ · e_a + sin θ · e_z, where e_a is centroid a's axis and e_z an axis no centroid uses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { shadowMatch, shadowTrusted, cosine, decodeFloat32, SCORE_BASIS_APP_RECOMPUTED } from "@/lib/stt/losing-score";
import { windowStart, windowEnd } from "@/lib/stt/window-bounds";
import type { DiarizeSpeaker } from "@/lib/diarize";

const D = 192;
const b64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
/** Unit vector along axis i. */
const axis = (i: number) => { const v = new Float32Array(D); v[i] = 1; return v; };
/** A vector with cosine c_k to axis k for each [k, c_k], the rest along a spare axis so the norm is 1. */
const toward = (parts: Array<[number, number]>, spare = 190) => {
  const v = new Float32Array(D);
  let s = 0;
  for (const [k, c] of parts) { v[k] = c; s += c * c; }
  v[spare] = Math.sqrt(Math.max(0, 1 - s));
  return v;
};
const centroid = (id: string, axisIdx: number) => ({ clinician_id: id, full_name: id, centroid_base64: b64(axis(axisIdx)) });
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const matchedSp = (idx: number, id: string, emb: Float32Array, conf?: number): DiarizeSpeaker =>
  ({ idx, label: "Dr", type: "clinician", source: "auto", clinician_id: id, confidence: conf ?? r3(cosine(emb, axis(0))), embedding_base64: b64(emb) });
const unmatchedSp = (idx: number, emb: Float32Array): DiarizeSpeaker =>
  ({ idx, label: "Patient", type: "patient", source: "heuristic", embedding_base64: b64(emb) });

describe("the mirror — server.py's match, recomputed", () => {
  it("cosine is server.py _cosine: exact on constructed vectors, 0 on a zero norm", () => {
    expect(cosine(axis(0), toward([[0, 0.5]]))).toBeCloseTo(0.5, 6);
    expect(cosine(new Float32Array(D), axis(0))).toBe(0);
    expect(decodeFloat32(b64(axis(3)))![3]).toBe(1);
    expect(decodeFloat32("AAA")).toBeNull();
  });

  it("V1 (pure): an unmatched speaker gets its best candidate below the threshold, id and score", () => {
    const cents = [centroid("doc_a", 0), centroid("doc_b", 1)];
    const r = shadowMatch([unmatchedSp(0, toward([[0, 0.5], [1, 0.3]]))], cents, 0.65);
    expect(r.losingByIdx.get(0)!.clinician_id).toBe("doc_a");
    expect(r.losingByIdx.get(0)!.score).toBeCloseTo(0.5, 6);
    expect(r.guard).toMatchObject({ matched_checked: 0, disagreements: 0, unmatched_above_threshold: 0 });
  });

  it("GREEDY EXCLUSION — two speakers, one centroid both would match: the louder takes it, the quieter has NO losing candidate", () => {
    const cents = [centroid("doc_a", 0)];
    const loud = toward([[0, 0.8]]), quiet = toward([[0, 0.78]]);
    const r = shadowMatch([matchedSp(0, "doc_a", loud), unmatchedSp(1, quiet)], cents, 0.65);
    expect(r.guard).toMatchObject({ matched_checked: 1, disagreements: 0, unmatched_above_threshold: 0 });
    expect(r.losingByIdx.has(1), "doc_a was taken by the louder speaker: 0.78 against it is not a near miss").toBe(false);
  });

  it("GREEDY EXCLUSION with a second centroid: the quieter speaker's losing candidate is the OTHER clinician, not the taken one", () => {
    const cents = [centroid("doc_a", 0), centroid("doc_b", 1)];
    const r = shadowMatch([matchedSp(0, "doc_a", toward([[0, 0.8]])), unmatchedSp(1, toward([[0, 0.78], [1, 0.4]]))], cents, 0.65);
    expect(r.losingByIdx.get(1)!.clinician_id).toBe("doc_b");
    expect(r.losingByIdx.get(1)!.score).toBeCloseTo(0.4, 6);
  });

  it("the exclusion follows SERVICE ORDER (idx), not array order", () => {
    const cents = [centroid("doc_a", 0), centroid("doc_b", 1)];
    const speakers = [unmatchedSp(1, toward([[0, 0.78], [1, 0.4]])), matchedSp(0, "doc_a", toward([[0, 0.8]]))];
    expect(shadowMatch(speakers, cents, 0.65).losingByIdx.get(1)!.clinician_id).toBe("doc_b");
  });

  it("strict > from 0.0: the first of a tie wins, and a cosine at or below zero is never a candidate", () => {
    const tie = shadowMatch([unmatchedSp(0, toward([[0, 0.4], [1, 0.4]]))], [centroid("doc_a", 0), centroid("doc_b", 1)], 0.65);
    expect(tie.losingByIdx.get(0)!.clinician_id).toBe("doc_a");
    const neg = new Float32Array(D); neg[0] = -1;
    expect(shadowMatch([unmatchedSp(0, neg)], [centroid("doc_a", 0)], 0.65).losingByIdx.size).toBe(0);
  });
});

describe("the control — matched speakers recomputed and compared with the service's 3-dp confidence", () => {
  const cents = [centroid("doc_a", 0), centroid("doc_b", 1)];
  const e = toward([[0, 0.8123]]);

  it("agreement: the service's rounded confidence is within 0.0005 of the recomputation — zero disagreements, trusted", () => {
    const g = shadowMatch([matchedSp(0, "doc_a", e, 0.812)], cents, 0.65).guard;
    expect(g).toMatchObject({ matched_checked: 1, disagreements: 0 });
    expect(g.diffs[0]!).toBeLessThanOrEqual(0.0005);
    expect(shadowTrusted(g)).toBe(true);
  });

  it("DISAGREEMENT on the score: 0.002 away from the recomputation is counted and not trusted", () => {
    const g = shadowMatch([matchedSp(0, "doc_a", e, 0.814)], cents, 0.65).guard;
    expect(g.disagreements).toBe(1);
    expect(shadowTrusted(g)).toBe(false);
  });

  it("DISAGREEMENT on the clinician: the service named doc_b, the recomputation's best is doc_a", () => {
    const g = shadowMatch([matchedSp(0, "doc_b", e, 0.812)], cents, 0.65).guard;
    expect(g.disagreements).toBe(1);
  });

  it("DISAGREEMENT the other way: an unmatched speaker recomputes at or above the threshold — counted, and no losing score for it", () => {
    const r = shadowMatch([unmatchedSp(0, toward([[0, 0.7]]))], cents, 0.65);
    expect(r.guard.unmatched_above_threshold).toBe(1);
    expect(r.losingByIdx.size).toBe(0);
    expect(shadowTrusted(r.guard)).toBe(false);
  });
});

// ═══ THE WRITE ════════════════════════════════════════════════════════════════════════════════════
const DB = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, turns: [] as Array<Record<string, unknown>> }));
const SVC = vi.hoisted(() => ({ out: {} as Record<string, unknown> }));
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM cue")) return DB.turns;
    if (q.includes("INSERT INTO room_turn_speaker")) {
      // cluster_id and NOW() are literals; the losing columns follow run_id.
      DB.rows.push({ source_ref: v[1], speaker_idx: v[2], clinician_id: v[5], role: v[6], match_confidence: v[7], no_role_reason: v[8],
                     losing_clinician_id: v[10], losing_score: v[11], score_basis: v[12] });
    }
    return [];
  },
}));
vi.mock("@/lib/diarize", () => ({ runDiarize: async () => SVC.out }));

const WIN = { start: windowStart(0), end: windowEnd(900_000) };
const CENTS = [centroid("doc_a", 0), centroid("doc_b", 1)];
const run = async () => {
  const { diarizeWindow } = await import("@/lib/stt/diarize-window");
  return diarizeWindow({ windowId: "bw_e20", roomDayId: "rd_1", window: WIN, audio: new Uint8Array([1]), runId: "run_e20", centroids: CENTS });
};
const byRef = (ref: string) => DB.rows.find((r) => r.source_ref === ref)!;
const segs = [
  { start_ms: 0, end_ms: 400_000, speaker_idx: 0, overlap: false },
  { start_ms: 400_000, end_ms: 900_000, speaker_idx: 1, overlap: false },
];

describe("the write — only an exclusive no_match turn, and a named turn exactly as today", () => {
  beforeEach(() => {
    DB.rows = [];
    DB.turns = [
      { source_ref: "named", start_ms: 10_000, end_ms: 20_000 },
      { source_ref: "unmatched", start_ms: 500_000, end_ms: 510_000 },
      { source_ref: "straddle", start_ms: 395_000, end_ms: 405_000 },
    ];
  });

  it("V1: the exclusive unmatched turn gets the losing clinician and score, basis app_recomputed; role NULL, no_match, match_confidence NULL", async () => {
    const loud = toward([[0, 0.8123]]);
    SVC.out = { ok: true, latencyMs: 1, result: { speakers: [matchedSp(0, "doc_a", loud, 0.812), unmatchedSp(1, toward([[0, 0.7], [1, 0.52]]))], transcript_segments: segs } };
    const r = await run();
    const u = byRef("unmatched");
    // The basis is written LITERALLY here, never taken from the module's constant: a wrong constant would
    // otherwise agree with the test. 0096's CHECK vocabulary is the contract.
    expect(u).toMatchObject({ role: null, no_role_reason: "no_match", clinician_id: null, match_confidence: null, losing_clinician_id: "doc_b", score_basis: "app_recomputed" });
    expect(SCORE_BASIS_APP_RECOMPUTED).toBe("app_recomputed");
    expect(u.losing_score as number).toBeCloseTo(0.52, 6);
    expect(r.ok && r.outcome).toMatchObject({ losing_recorded: 1, shadow: { matched_checked: 1, disagreements: 0, trusted: true } });
  });

  it("V2: the named turn's row is today's row — same role, clinician and confidence, NULL in all three new columns", async () => {
    SVC.out = { ok: true, latencyMs: 1, result: { speakers: [matchedSp(0, "doc_a", toward([[0, 0.8123]]), 0.812), unmatchedSp(1, toward([[1, 0.4]]))], transcript_segments: segs } };
    await run();
    expect(byRef("named")).toEqual({ source_ref: "named", speaker_idx: 0, clinician_id: "doc_a", role: "clinician", match_confidence: 0.812, no_role_reason: null,
                                     losing_clinician_id: null, losing_score: null, score_basis: null });
  });

  it("V3: the straddle turn gets nothing — even though the speaker it binds to has a losing candidate", async () => {
    SVC.out = { ok: true, latencyMs: 1, result: { speakers: [unmatchedSp(0, toward([[0, 0.5]])), unmatchedSp(1, toward([[1, 0.4]]))], transcript_segments: segs } };
    await run();
    expect(byRef("straddle")).toMatchObject({ role: null, no_role_reason: "straddle", losing_clinician_id: null, losing_score: null, score_basis: null });
    expect(byRef("named").losing_clinician_id, "control: the exclusive turn of the same speaker does get one").toBe("doc_a");
  });

  it("A WINDOW WHOSE CONTROL FAILS WRITES NO LOSING SCORES — and still writes every row exactly as before", async () => {
    SVC.out = { ok: true, latencyMs: 1, result: { speakers: [matchedSp(0, "doc_a", toward([[0, 0.8123]]), 0.9), unmatchedSp(1, toward([[1, 0.4]]))], transcript_segments: segs } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await run();
    expect(byRef("unmatched")).toMatchObject({ role: null, no_role_reason: "no_match", losing_clinician_id: null, losing_score: null, score_basis: null });
    expect(byRef("named")).toMatchObject({ role: "clinician", clinician_id: "doc_a", match_confidence: 0.9 });
    expect(r.ok && r.outcome).toMatchObject({ losing_recorded: 0, shadow: { disagreements: 1, trusted: false } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("no centroids offered: nothing to lose to, so no losing candidate and nothing to check", async () => {
    SVC.out = { ok: true, latencyMs: 1, result: { speakers: [unmatchedSp(0, toward([[0, 0.5]])), unmatchedSp(1, toward([[1, 0.4]]))], transcript_segments: segs } };
    const { diarizeWindow } = await import("@/lib/stt/diarize-window");
    await diarizeWindow({ windowId: "bw_e20", roomDayId: "rd_1", window: WIN, audio: new Uint8Array([1]), runId: "run_e20", centroids: [] });
    expect(DB.rows.every((x) => x.losing_score === null)).toBe(true);
  });
});

describe("0096 — the migration file (its CHECKs run in c2-e2e-runner against postgres)", () => {
  it("is additive: ADD COLUMN IF NOT EXISTS, no DEFAULT, constraints guarded by name, recorded as 96; service_reported reserved", async () => {
    const { readFileSync } = await import("node:fs");
    const sqlText = readFileSync("db/migrations/0096_room_turn_speaker_losing_score.sql", "utf8").replace(/^\s*--.*$/gm, "");
    for (const c of ["losing_clinician_id", "losing_score", "score_basis"]) expect(sqlText).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`));
    expect(sqlText).not.toMatch(/\bDEFAULT\b/);
    expect(sqlText).not.toMatch(/\bmatch_confidence\b\s*(=|DOUBLE|text|ADD)/i);
    expect((sqlText.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? []).length).toBe(4);
    expect(sqlText).toContain("'app_recomputed', 'service_reported'");
    expect(sqlText).toMatch(/VALUES \(96, '0096_room_turn_speaker_losing_score'\)/);
  });
});
