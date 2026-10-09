/**
 * diarize-nemotron-identity.test.ts — ECAPA identity on Nemotron speakers (epic #23 c), the PURE half: the switches,
 * the embed request (longest span, speech-time rank), the service's answer folded into speaker rows (match,
 * losing candidate, attribution, the shadow control), per-turn identity with straddles, doctor_present,
 * hypothesis identity, and the timeline's DOC role. Vectors are typed by hand as float32 bytes; expected rows
 * are written out from the fixture, never computed by the module under test. All ids are fake.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { effectiveCheckValues } from "../support/sql-check";
import {
  CENTROID_SETS,
  CentroidSetError,
  DOCTOR_PRESENT_MIN_MS,
  centroidSetFrom,
  doctorPresent,
  dominantIdentity,
  embedPlan,
  encodeFloat32,
  nemotronIdentityEnabled,
  roleFromIdentities,
  segmentsFromTurns,
  speakerIdentities,
  turnIdentities,
  type NemoSegment,
} from "@/lib/diarize-nemotron/identity";
import { buildSegment } from "@/lib/encounter-clock/timeline";
import type { Anchor } from "@/lib/encounter-clock/anchors";
import { FlagValueError } from "@/lib/flags";
import { makeFakeClinician } from "../support/fake-identity";

/** float32 little-endian, base64 — written here independently of encodeFloat32. */
const vec = (...xs: number[]) => {
  const b = Buffer.alloc(xs.length * 4);
  xs.forEach((x, i) => b.writeFloatLE(x, i * 4));
  return b.toString("base64");
};
const S = (s: number) => s * 1000;
const seg = (a: number, b: number, idx: number): NemoSegment => ({ start_ms: S(a), end_ms: S(b), speaker_idx: idx });

const centroidOf = (n: number, v: string) => { const c = makeFakeClinician(n); return { clinician_id: c.id, full_name: c.full_name, centroid_base64: v }; };
const CA = centroidOf(1, vec(1, 0, 0));
const CB = centroidOf(2, vec(0, 1, 0));

describe("switches", () => {
  it("IDENT_CENTROID_SET: unset or blank is voice_print; the three sets pass; anything else throws", () => {
    expect(centroidSetFrom({})).toBe("voice_print");
    expect(centroidSetFrom({ IDENT_CENTROID_SET: "  " })).toBe("voice_print");
    for (const s of ["voice_print", "voice_centroid:room_primary", "confirmed6"]) expect(centroidSetFrom({ IDENT_CENTROID_SET: s })).toBe(s);
    expect(() => centroidSetFrom({ IDENT_CENTROID_SET: "voiceprint" })).toThrow(CentroidSetError);
  });
  it("NEMOTRON_IDENTITY_ENABLED is strict and off by default", () => {
    expect(nemotronIdentityEnabled({})).toBe(false);
    expect(nemotronIdentityEnabled({ NEMOTRON_IDENTITY_ENABLED: "1" })).toBe(true);
    expect(() => nemotronIdentityEnabled({ NEMOTRON_IDENTITY_ENABLED: "yep" })).toThrow(FlagValueError);
  });
  it("0141's centroid_set CHECKs admit exactly the sets the code knows", () => {
    for (const c of ["diarize_nemotron_identity_set_chk", "diarize_nemotron_speaker_set_chk"]) {
      expect(effectiveCheckValues("db/migrations", c, "centroid_set").values).toEqual(new Set(CENTROID_SETS));
    }
  });
  it("0141 has no column that could hold a vector or a name", () => {
    const ddl = readFileSync("db/migrations/0141_diarize_nemotron_identity.sql", "utf8").toLowerCase();
    expect(ddl).not.toMatch(/\b(embedding|vector|centroid_base64|bytea|real\[\]|full_name|name)\b\s+(text|bytea|real|jsonb)/);
  });
});

describe("turns and the embed request", () => {
  it("reads stored turns; one malformed turn refuses the whole row", () => {
    expect(segmentsFromTurns([[0, 1000, "spk0"], [500, 2500, "spk12"]])).toEqual([
      { start_ms: 0, end_ms: 1000, speaker_idx: 0 }, { start_ms: 500, end_ms: 2500, speaker_idx: 12 },
    ]);
    for (const bad of [null, {}, [[0, 1000]], [[0, 1000, "spk"]], [[1000, 1000, "spk0"]], [[-1, 5, "spk0"]], [[0, 5, "spk123"]]]) {
      expect(segmentsFromTurns(bad)).toBeNull();
    }
  });

  it("one span per speaker, the longest; ranked by whole speech, most first", () => {
    // spk0: 0–10 + 20–50 = 40 s (longest 20–50); spk1: 10–15 + 50–120 = 75 s (longest 50–120); spk2: 130–131 = 1 s
    const segs = [seg(0, 10, 0), seg(10, 15, 1), seg(20, 50, 0), seg(50, 120, 1), seg(130, 131, 2)];
    const plan = embedPlan(segs);
    expect(plan.request).toEqual([
      { idx: 0, start_s: 50, end_s: 120, total_speech_sec: 75 },
      { idx: 1, start_s: 20, end_s: 50, total_speech_sec: 40 },
      { idx: 2, start_s: 130, end_s: 131, total_speech_sec: 1 },
    ]);
    expect([...plan.speakerOfRank]).toEqual([[0, 1], [1, 0], [2, 2]]);
  });

  it("equal speech goes to the lower spkN; equal spans to the earlier one; a speaker's own overlap counts once", () => {
    const plan = embedPlan([seg(0, 10, 3), seg(5, 10, 3), seg(20, 30, 1), seg(40, 50, 3)].concat([seg(60, 70, 1)]));
    // spk3: 0–10 ∪ 5–10 ∪ 40–50 = 20 s; spk1: 20–30 + 60–70 = 20 s → tie → spk1 first
    expect(plan.request.map((r) => [r.idx, r.start_s, r.total_speech_sec])).toEqual([[0, 20, 20], [1, 0, 20]]);
  });
});

describe("the service's answer as speaker rows", () => {
  const segs = [seg(0, 10, 0), seg(10, 15, 1), seg(20, 50, 0), seg(50, 120, 1), seg(130, 131, 2)];
  const plan = embedPlan(segs); // rank 0 = spk1, rank 1 = spk0, rank 2 = spk2

  it("matched, losing (shadow trusted), and not compared — and no embedding comes back out", () => {
    const e0 = vec(1, 0, 0); // spk1: the service matched A at 1.0
    const e1 = vec(0.8, 0.6, 0); // spk0: unmatched; A is taken, so its best is B at 0.6 (< 0.65)
    const out = speakerIdentities(segs, plan, [
      { idx: 0, embedding_base64: e0, clinician_id: CA.clinician_id, confidence: 1.0 },
      { idx: 1, embedding_base64: e1 },
      { idx: 2, embedding_base64: null },
    ], [CA, CB], 0.65);
    expect(out.trusted).toBe(true);
    expect(out.embedded).toBe(2);
    expect(out.speakers.map((s) => ({ ...s, losing_score: s.losing_score === null ? null : Number(s.losing_score.toFixed(3)) }))).toEqual([
      { speaker_label: "spk0", speech_ms: 40_000, clinician_id: null, match_confidence: null, losing_clinician_id: CB.clinician_id, losing_score: 0.6, centroids_offered: 2, attribution: "voiceprint" },
      { speaker_label: "spk1", speech_ms: 75_000, clinician_id: CA.clinician_id, match_confidence: 1.0, losing_clinician_id: null, losing_score: null, centroids_offered: 2, attribution: "voiceprint" },
      { speaker_label: "spk2", speech_ms: 1_000, clinician_id: null, match_confidence: null, losing_clinician_id: null, losing_score: null, centroids_offered: 2, attribution: "none" },
    ]);
    const text = JSON.stringify(out);
    for (const b of [e0, e1, CA.centroid_base64, CB.centroid_base64]) expect(text).not.toContain(b);
    expect(text).not.toContain(CA.full_name);
    expect(text).not.toContain(CB.full_name);
  });

  it("an untrusted shadow keeps the service's match but writes no losing candidate", () => {
    const out = speakerIdentities(segs, plan, [
      { idx: 0, embedding_base64: vec(1, 0, 0), clinician_id: CA.clinician_id, confidence: 0.9 }, // shadow says 1.0: disagreement
      { idx: 1, embedding_base64: vec(0.8, 0.6, 0) },
    ], [CA, CB], 0.65);
    expect(out.trusted).toBe(false);
    expect(out.speakers.find((s) => s.speaker_label === "spk1")).toMatchObject({ clinician_id: CA.clinician_id, match_confidence: 0.9 });
    expect(out.speakers.find((s) => s.speaker_label === "spk0")).toMatchObject({ losing_clinician_id: null, losing_score: null });
  });

  it("no centroids offered: nobody is attributed, even with embeddings", () => {
    const out = speakerIdentities(segs, plan, [{ idx: 0, embedding_base64: vec(1, 0, 0) }], [], 0.65);
    expect(out.speakers.map((s) => [s.attribution, s.clinician_id, s.centroids_offered])).toEqual([["none", null, 0], ["none", null, 0], ["none", null, 0]]);
  });

  it("encodeFloat32 is the encoding the shadow decodes", () => {
    expect(encodeFloat32([1, 0, 0])).toBe(vec(1, 0, 0));
    expect(encodeFloat32([0.8, 0.6, 0])).toBe(vec(0.8, 0.6, 0));
  });
});

describe("per turn, per probe, per hypothesis", () => {
  const speakers = [
    { speaker_label: "spk0", clinician_id: CA.clinician_id, match_confidence: 0.81 },
    { speaker_label: "spk1", clinician_id: null, match_confidence: null },
    { speaker_label: "spk2", clinician_id: CB.clinician_id, match_confidence: 0.7 },
  ];

  it("a turn inherits its speaker's match; two speakers at once are a straddle with no name", () => {
    // spk0 0–10, spk1 8–14, spk0 14–20 (touching spk1's end), spk0 again 18–19 inside its own turn
    expect(turnIdentities([seg(0, 10, 0), seg(8, 14, 1), seg(14, 20, 0), seg(18, 19, 0)], speakers)).toEqual([
      { start_ms: S(0), end_ms: S(8), speaker_label: "spk0", clinician_id: CA.clinician_id, straddle: false },
      { start_ms: S(8), end_ms: S(10), speaker_label: null, clinician_id: null, straddle: true },
      { start_ms: S(10), end_ms: S(14), speaker_label: "spk1", clinician_id: null, straddle: false },
      { start_ms: S(14), end_ms: S(20), speaker_label: "spk0", clinician_id: CA.clinician_id, straddle: false },
    ]);
  });

  it("doctor_present: true at the 5 s bar, null below it, never false; straddles do not count", () => {
    expect(DOCTOR_PRESENT_MIN_MS).toBe(5_000);
    const probe = { start_ms: S(100), end_ms: S(280) };
    const p = (a: number, b: number, c: string | null, straddle = false) => ({ start_ms: S(a), end_ms: S(b), speaker_label: c ? "spk0" : null, clinician_id: c, straddle });
    expect(doctorPresent(probe, [p(98, 105, CA.clinician_id)])).toBe(true); // 5 s inside
    expect(doctorPresent(probe, [p(98, 104.999, CA.clinician_id)])).toBeNull();
    expect(doctorPresent(probe, [p(100, 103, CA.clinician_id), p(110, 113, CB.clinician_id)])).toBeNull(); // 3 s each, not pooled
    expect(doctorPresent(probe, [p(100, 200, null, true)])).toBeNull();
    expect(doctorPresent(probe, [p(100, 200, CA.clinician_id, true)])).toBeNull(); // a straddle never names, even if handed a name
    expect(doctorPresent(probe, [p(100, 200, null)])).toBeNull(); // an unmatched voice is not "absent"
    expect(doctorPresent(probe, [])).toBeNull();
  });

  it("hypothesis identity: the matched clinician with most speech, its best cosine, in 0114's shape", () => {
    const pieces = turnIdentities([seg(0, 30, 0), seg(30, 70, 2), seg(70, 80, 0), seg(80, 200, 1)], speakers);
    // A: 30 + 10 = 40 s; B: 40 s → tie → the lower id (A)
    expect(dominantIdentity({ start_ms: 0, end_ms: S(200) }, pieces, speakers)).toEqual({ clinician_id: CA.clinician_id, match_source: "voice_print", centroid_id: null, doctor_cosine: 0.81 });
    expect(dominantIdentity({ start_ms: S(30), end_ms: S(75) }, pieces, speakers)).toMatchObject({ clinician_id: CB.clinician_id, doctor_cosine: 0.7 });
    expect(dominantIdentity({ start_ms: S(100), end_ms: S(200) }, pieces, speakers)).toBeNull();
  });
});

describe("the timeline's DOC", () => {
  const anchor: Anchor = {
    consult_key: "c_fake01@m_fake", room_id: "room_fake_a", start_ms: 1_790_000_000_000, close_kind: "open", end_clicked: false,
    end_click_ms: null, end_weak_ms: null, end_weak_kind: null, next_start_ms: null, doctor_uid_warehouse: "wh_fake0001", doctor_uid_ext: null,
    doctor_source: "warehouse", quality: "clean", weak_start: false,
  };
  const byWindow = new Map([["bw_fake0001_a", new Map<number, string | null>([[0, CA.clinician_id], [1, null]])]]);

  it("DOC only for the speaker matched to the consult's clinician; no mapping, nobody", () => {
    const role = roleFromIdentities(byWindow, () => CA.clinician_id);
    expect([role("bw_fake0001_a", 0, anchor), role("bw_fake0001_a", 1, anchor), role("bw_other", 0, anchor)]).toEqual(["doc", "other", "other"]);
    const someoneElse = roleFromIdentities(byWindow, () => CB.clinician_id);
    expect(someoneElse("bw_fake0001_a", 0, anchor)).toBe("other");
    const unmapped = roleFromIdentities(byWindow, () => null);
    expect(unmapped("bw_fake0001_a", 0, anchor)).toBe("other");
  });

  it("feeds buildSegment: the matched speaker is DOC, the other is a letter", () => {
    const t0 = anchor.start_ms;
    const built = buildSegment({ anchor, start_ms: t0 - 60_000, end_ms: t0 + 60_000 }, {
      grid_origin_ms: t0 - 120_000, energy: [], tape_off: [],
      windows: [{ window_id: "bw_fake0001_a", origin_ms: t0 - 60_000, window_end_ms: t0 + 60_000, turns: [
        { start_ms: 60_000, end_ms: 70_000, speaker_idx: 0 }, { start_ms: 70_000, end_ms: 80_000, speaker_idx: 1 },
      ] }],
      role: roleFromIdentities(byWindow, () => CA.clinician_id),
    });
    if (!built.ok) throw new Error("refused");
    expect(built.state.rows.map((r) => ("spk" in r ? r.spk : null))).toEqual([{}, {}, { DOC: 10, B: 10 }, {}]);
  });
});
