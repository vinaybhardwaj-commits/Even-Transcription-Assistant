/**
 * pulse_room — the decision rule at its edges, the matcher, and SUGGEST-ONLY at grep level.
 * Vectors are typed by hand: with centroids e1 and e2 and an embedding (a, b, sqrt(1-a²-b²)), the cosines are exactly a and b.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CENTROID_SETS, PULSE_ROOM_MIN_COSINE, PULSE_ROOM_MIN_MARGIN, PULSE_ROOM_EMBEDDING_MODEL,
  centroidSetFrom, decidePulseRoom, embedPlan, encodeFloat32, pulseRoomIdentities,
} from "@/lib/diarize-nemotron/identity";

const UID1 = "U".repeat(20), UID2 = "V".repeat(20), UID3 = "W".repeat(20);
const cent = (uid: string, ...v: number[]) => ({ clinician_id: uid, full_name: uid, centroid_base64: encodeFloat32(v) });
const emb = (a: number, b: number, c: number) => encodeFloat32([a, b, c]);
const unitWith = (a: number, b: number) => [a, b, Math.sqrt(1 - a * a - b * b)];
const segs = [{ start_ms: 0, end_ms: 10_000, speaker_idx: 0 }];
const one = (best: number, second: number) => {
  const [x, y, z] = unitWith(best, second);
  const plan = embedPlan(segs);
  return pulseRoomIdentities(segs, plan, [{ idx: 0, embedding_base64: emb(x, y, z) }], [cent(UID1, 1, 0, 0), cent(UID2, 0, 1, 0)]).speakers[0]!;
};

describe("constants and set", () => {
  it("are named and exact", () => {
    expect(PULSE_ROOM_MIN_COSINE).toBe(0.65);
    expect(PULSE_ROOM_MIN_MARGIN).toBe(0.05);
    expect(PULSE_ROOM_EMBEDDING_MODEL).toBe("speechbrain/spkrec-ecapa-voxceleb");
    expect(CENTROID_SETS).toContain("pulse_room");
  });
  it("default is unchanged; pulse_room only when named", () => {
    expect(centroidSetFrom({})).toBe("voice_print");
    expect(centroidSetFrom({ IDENT_CENTROID_SET: "" })).toBe("voice_print");
    expect(centroidSetFrom({ IDENT_CENTROID_SET: "pulse_room" })).toBe("pulse_room");
  });
});

describe("decidePulseRoom — the edges", () => {
  it("matches at 0.651 / margin 0.051", () => expect(decidePulseRoom(0.651, 0.6)).toBe("match"));
  it("matches exactly on both edges (0.65, 0.05)", () => expect(decidePulseRoom(0.65, 0.6)).toBe("match"));
  it("abstains at 0.649 even with a wide margin", () => expect(decidePulseRoom(0.649, 0.1)).toBe("abstain"));
  it("abstains at margin 0.049 even with a high best", () => expect(decidePulseRoom(0.9, 0.851)).toBe("abstain"));
  it("MARGIN: a close runner-up abstains though best clears the floor", () => expect(decidePulseRoom(0.7, 0.69)).toBe("abstain"));
  it("a missing runner-up (one-centroid set) abstains", () => expect(decidePulseRoom(0.95, null)).toBe("abstain"));
  it("no best abstains", () => expect(decidePulseRoom(null, null)).toBe("abstain"));
});

describe("pulseRoomIdentities", () => {
  it("0.651 vs 0.6 matches and records both cosines, a uid and no clinician", () => {
    const r = one(0.651, 0.6);
    expect(r).toMatchObject({ decision: "match", pulse_doctor_uid: UID1, attribution: "voiceprint", centroids_offered: 2 });
    expect(r.best_cosine).toBeCloseTo(0.651, 5);
    expect(r.runner_up_cosine).toBeCloseTo(0.6, 5);
    expect(r).not.toHaveProperty("clinician_id");
  });
  it("0.649 abstains and keeps both cosines (no uid)", () => {
    const r = one(0.649, 0.1);
    expect(r).toMatchObject({ decision: "abstain", pulse_doctor_uid: null });
    expect(r.best_cosine).toBeCloseTo(0.649, 5);
    expect(r.runner_up_cosine).toBeCloseTo(0.1, 5);
  });
  it("margin 0.049 abstains with both cosines", () => {
    const r = one(0.7, 0.651);
    expect(r).toMatchObject({ decision: "abstain", pulse_doctor_uid: null });
    expect(r.best_cosine! - r.runner_up_cosine!).toBeLessThan(0.05);
  });
  it("margin 0.051 matches", () => expect(one(0.7, 0.649)).toMatchObject({ decision: "match", pulse_doctor_uid: UID1 }));
  it("picks the best uid among three, and the runner-up is the second best", () => {
    const plan = embedPlan(segs);
    const r = pulseRoomIdentities(segs, plan, [{ idx: 0, embedding_base64: emb(0.1, 0.9, Math.sqrt(0.18)) }],
      [cent(UID1, 1, 0, 0), cent(UID2, 0, 1, 0), cent(UID3, 0, 0, 1)]).speakers[0]!;
    expect(r.pulse_doctor_uid).toBe(UID2);
    expect(r.runner_up_cosine).toBeCloseTo(Math.sqrt(0.18), 4);
  });
  it("ignores the Mini's own match: a service clinician_id does not decide", () => {
    const plan = embedPlan(segs);
    const [x, y, z] = unitWith(0.649, 0.1);
    const r = pulseRoomIdentities(segs, plan, [{ idx: 0, embedding_base64: emb(x, y, z), clinician_id: UID1, confidence: 0.99 }],
      [cent(UID1, 1, 0, 0), cent(UID2, 0, 1, 0)]).speakers[0]!;
    expect(r.decision).toBe("abstain");
  });
  it("no embedding, or no centroids, is not_compared with attribution none", () => {
    const plan = embedPlan(segs);
    expect(pulseRoomIdentities(segs, plan, [{ idx: 0, embedding_base64: null }], [cent(UID1, 1, 0, 0), cent(UID2, 0, 1, 0)]).speakers[0])
      .toMatchObject({ decision: "not_compared", attribution: "none", best_cosine: null, pulse_doctor_uid: null });
    expect(pulseRoomIdentities(segs, plan, [{ idx: 0, embedding_base64: emb(1, 0, 0) }], []).speakers[0])
      .toMatchObject({ decision: "not_compared", attribution: "none", centroids_offered: 0 });
  });
  it("a dimension mismatch scores 0 and abstains", () => {
    const plan = embedPlan(segs);
    expect(pulseRoomIdentities(segs, plan, [{ idx: 0, embedding_base64: encodeFloat32([1, 0]) }], [cent(UID1, 1, 0, 0), cent(UID2, 0, 1, 0)]).speakers[0])
      .toMatchObject({ decision: "abstain", best_cosine: 0 });
  });
});

describe("SUGGEST-ONLY (grep level)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pulseWriter = () => {
    const s = read("lib/room-access/nemotron-identity.ts");
    return code(s.slice(s.indexOf("export async function recordPulseRoomOk"), s.indexOf("export async function chooseIdentityRows")));
  };
  it("the pulse_room writer touches only the two nemotron identity tables", () => {
    const w = pulseWriter();
    const targets = [...w.matchAll(/(?:INSERT INTO|(?<!DO )UPDATE|DELETE FROM)\s+(\w+)/gi)].map((m) => m[1]);
    expect([...new Set(targets)].sort()).toEqual(["diarize_nemotron_identity", "diarize_nemotron_speaker"]);
    expect(w).toMatch(/SELECT ident\.window_row_id, 'pulse_room', x\.speaker_label, x\.speech_ms, NULL, NULL, NULL, NULL/);
  });
  it("no source file outside the tables' own writer and 0145 writes room_turn_speaker.clinician_id, the warehouse or consulting_doctor_uid from pulse_room", () => {
    for (const f of ["lib/diarize-nemotron/identity.ts", "lib/jobs/kinds/nemotron-identity.ts", "lib/room-access/nemotron-identity.ts", "tools/pulse-room-centroids/load.py"]) {
      const c = code(read(f));
      expect(c, f).not.toMatch(/room_turn_speaker/i);
      expect(c, f).not.toMatch(/consulting_doctor_uid/i);
      expect(c, f).not.toMatch(/warehouse/i);
      expect(c, f).not.toMatch(/(?:UPDATE|INSERT INTO)\s+(?:voice_print|voice_centroid|clinician|encounter\w*)\b/i);
    }
    const loader = read("tools/pulse-room-centroids/load.py");
    expect(loader.match(/(?:INSERT INTO|UPDATE)\s+(\w+)/g)!.map((m) => m.split(/\s+/).pop())).toEqual(["pulse_doctor_voice", "pulse_doctor_voice"]);
  });
  it("the pulse_room branch of the job calls neither the clinician path's writer nor its speaker builder", () => {
    const j = read("lib/jobs/kinds/nemotron-identity.ts");
    const branch = j.slice(j.indexOf('if (set === "pulse_room")'), j.indexOf("const out = speakerIdentities"));
    expect(branch).toContain("recordPulseRoomOk");
    expect(branch).not.toMatch(/recordIdentityOk|speakerIdentities/);
  });
  it("no env is set by the branch: the default stays voice_print and nothing writes IDENT_CENTROID_SET", () => {
    for (const f of ["lib/diarize-nemotron/identity.ts", "lib/jobs/kinds/nemotron-identity.ts", "lib/diarize-nemotron/identity-enqueue.ts", ".env.example"]) {
      expect(read(f), f).not.toMatch(/IDENT_CENTROID_SET\s*=\s*pulse_room/);
    }
  });
});
