/**
 * Build 4 §B / §C — the matcher, the running mean, and the turn binding.
 *
 * The number these tests exist around is `SPEAKER_MATCH_THRESHOLD`, which has no default and is
 * not yet frozen. It decides how many people the system believes were in the room: set it low and
 * a clinic day collapses into one cluster, set it high and one person becomes six, and NEITHER
 * failure announces itself — both produce a plausible integer. So the boundary behaviour is
 * pinned exactly, and the "unset is a loud refusal" rule is pinned twice.
 */
import { describe, it, expect } from "vitest";
import {
  decodeEmbedding,
  encodeCentroid,
  decodeCentroid,
  cosine,
  matchCluster,
  runningMean,
  parseDiarizeSegments,
  bindTurnsToSpeakers,
  spanOverlapMs,
  clustersEnabled,
  readThreshold,
  sweepThreshold,
  describeDistribution,
  EMBEDDING_DIMS,
  EMBEDDING_BYTES,
} from "@/lib/stt/speaker-clusters";

/** A deterministic unit-ish vector, so cosines are reproducible. */
function vec(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) v[i] = Math.sin(seed * 1.7 + i * 0.11);
  return v;
}
const b64 = (v: Float32Array) => encodeCentroid(v).toString("base64");

describe("embeddings are 192 float32 LE, or they are nothing", () => {
  it("round-trips through base64 and through bytea hex", () => {
    const v = vec(1);
    const back = decodeEmbedding(b64(v))!;
    expect(back).not.toBeNull();
    for (let i = 0; i < EMBEDDING_DIMS; i++) expect(back[i]).toBeCloseTo(v[i]!, 5);
    const hex = "\\x" + encodeCentroid(v).toString("hex");
    expect(decodeCentroid(hex)![0]).toBeCloseTo(v[0]!, 5);
    expect(decodeCentroid(encodeCentroid(v))![0]).toBeCloseTo(v[0]!, 5);
  });

  it("A WRONG LENGTH IS NULL, not a shorter vector", () => {
    // The failure prevented: cosine over a truncated vector returns a plausible number, and a
    // plausible number is how a wrong cluster gets written and believed.
    expect(EMBEDDING_BYTES).toBe(768);
    expect(decodeEmbedding(Buffer.alloc(100).toString("base64"))).toBeNull();
    expect(decodeEmbedding(Buffer.alloc(1000).toString("base64"))).toBeNull();
    expect(decodeCentroid(Buffer.alloc(100))).toBeNull();
  });

  it("absent, empty and non-string inputs are null", () => {
    expect(decodeEmbedding(null)).toBeNull();
    expect(decodeEmbedding(undefined)).toBeNull();
    expect(decodeEmbedding("")).toBeNull();
    expect(decodeCentroid(null)).toBeNull();
    expect(decodeCentroid("not-hex!!")).toBeNull();
  });

  it("a NaN inside the payload makes the whole embedding unusable", () => {
    const v = vec(2);
    v[7] = Number.NaN;
    expect(decodeEmbedding(b64(v))).toBeNull();
  });
});

describe("cosine", () => {
  it("a vector is identical to itself, and never exceeds 1 through float drift", () => {
    const v = vec(3);
    expect(cosine(v, v)).toBe(1);
    expect(cosine(v, v)!).toBeLessThanOrEqual(1);
  });

  it("a zero vector has NO similarity — null, not 0", () => {
    // 0 would read as "maximally different" and open a new cluster for every zero embedding.
    expect(cosine(new Float32Array(EMBEDDING_DIMS), vec(1))).toBeNull();
  });

  it("opposite vectors are -1", () => {
    const v = vec(4);
    const neg = new Float32Array(v.map((x) => -x));
    expect(cosine(v, neg)).toBeCloseTo(-1, 5);
  });
});

describe("the match boundary is exactly the threshold", () => {
  const a = vec(5);
  const clusters = [{ id: "sc_a", centroid: a }];

  it("a sample identical to a centroid matches at any threshold <= 1", () => {
    const d = matchCluster(a, clusters, 1);
    expect(d).toMatchObject({ kind: "match", cluster_id: "sc_a" });
  });

  it(">= threshold MATCHES; strictly below opens a NEW cluster", () => {
    const b = vec(6);
    const c = cosine(a, b)!;
    // At exactly the observed cosine the sample is the same voice.
    expect(matchCluster(b, clusters, c).kind).toBe("match");
    // A hair above it is not.
    expect(matchCluster(b, clusters, c + 1e-6).kind).toBe("new");
  });

  it("an empty room-day always opens a new cluster, with no best cosine to report", () => {
    expect(matchCluster(a, [], 0.7)).toEqual({ kind: "new", best_cosine: null });
  });

  it("the BEST match wins, not the first over the line — row order is not evidence", () => {
    const near = vec(5);
    const far = vec(50);
    const both = [{ id: "sc_far", centroid: far }, { id: "sc_near", centroid: near }];
    const d = matchCluster(a, both, -1);
    expect(d).toMatchObject({ kind: "match", cluster_id: "sc_near" });
  });

  it("a new-cluster decision reports the best cosine it fell short of", () => {
    const d = matchCluster(vec(7), clusters, 0.999);
    expect(d.kind).toBe("new");
    if (d.kind === "new") expect(typeof d.best_cosine).toBe("number");
  });
});

describe("the running mean", () => {
  it("averages the new sample against the count the centroid already carries", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([3, 3, 3]);
    // count 1 → (0*1 + 3) / 2
    expect(Array.from(runningMean(a, 1, b))).toEqual([1.5, 1.5, 1.5]);
    // count 2 → (0*2 + 3) / 3
    expect(Array.from(runningMean(a, 2, b))).toEqual([1, 1, 1]);
  });

  it("a count of 0 makes the new sample the centroid", () => {
    const a = new Float32Array([9, 9]);
    expect(Array.from(runningMean(a, 0, new Float32Array([1, 1])))).toEqual([1, 1]);
  });

  it("three samples averaged one at a time equal their arithmetic mean", () => {
    let c = new Float32Array([1, 1]);
    c = runningMean(c, 1, new Float32Array([2, 2]));
    c = runningMean(c, 2, new Float32Array([6, 6]));
    expect(Array.from(c)).toEqual([3, 3]); // (1+2+6)/3
  });
});

describe("turn binding by time overlap", () => {
  const segs = [
    { start_ms: 0, end_ms: 10_000, speaker_idx: 0 },
    { start_ms: 10_000, end_ms: 20_000, speaker_idx: 1 },
  ];

  it("a turn inside one speaker's span binds to that speaker", () => {
    const b = bindTurnsToSpeakers(segs, [{ source_ref: "t1", start_ms: 2_000, end_ms: 5_000 }]);
    expect(b).toEqual([{ source_ref: "t1", speaker_idx: 0, overlap_ms: 3_000 }]);
  });

  it("a turn straddling a change binds to the MAJORITY speaker and says how much", () => {
    const b = bindTurnsToSpeakers(segs, [{ source_ref: "t2", start_ms: 8_000, end_ms: 14_000 }]);
    expect(b[0]).toMatchObject({ speaker_idx: 1, overlap_ms: 4_000 });
  });

  it("A TURN THAT OVERLAPS NOTHING IS NOT BOUND — no row, no nearest-speaker guess", () => {
    const b = bindTurnsToSpeakers(segs, [{ source_ref: "t3", start_ms: 30_000, end_ms: 40_000 }]);
    expect(b).toEqual([]);
  });

  it("a partial overlap at the very edge still binds", () => {
    const b = bindTurnsToSpeakers(segs, [{ source_ref: "t4", start_ms: 9_999, end_ms: 30_000 }]);
    expect(b[0]).toMatchObject({ speaker_idx: 1, overlap_ms: 10_000 });
  });

  it("a zero-width touch is not an overlap", () => {
    expect(spanOverlapMs({ start_ms: 0, end_ms: 10 }, { start_ms: 10, end_ms: 20 })).toBe(0);
    expect(bindTurnsToSpeakers(segs, [{ source_ref: "t5", start_ms: 20_000, end_ms: 25_000 }])).toEqual([]);
  });

  it("an exact tie breaks on the LOWER speaker index, deterministically", () => {
    const b = bindTurnsToSpeakers(segs, [{ source_ref: "t6", start_ms: 5_000, end_ms: 15_000 }]);
    expect(b[0]!.speaker_idx).toBe(0);
    // Same input, same answer, whatever the Map iteration order.
    for (let i = 0; i < 5; i++) {
      expect(bindTurnsToSpeakers(segs, [{ source_ref: "t6", start_ms: 5_000, end_ms: 15_000 }])[0]!.speaker_idx).toBe(0);
    }
  });

  it("segments the service could not express are dropped individually", () => {
    const parsed = parseDiarizeSegments([
      { start_ms: 0, end_ms: 100, speaker_idx: 0 },
      { start_ms: 100, end_ms: 50, speaker_idx: 1 },   // end before start
      { start_ms: 200, end_ms: 300, speaker_idx: -1 }, // bad index
      { start_ms: "x", end_ms: 400, speaker_idx: 0 },  // unreadable
      null,
    ]);
    expect(parsed).toEqual([{ start_ms: 0, end_ms: 100, speaker_idx: 0 }]);
  });

  it("the documented Mini shape parses as-is", () => {
    // docs/ETA-MAC-MINI-BACKEND-HANDOVER.md, verbatim.
    expect(parseDiarizeSegments([{ start_ms: 2106, end_ms: 12974, speaker_idx: 1, overlap: false }]))
      .toEqual([{ start_ms: 2106, end_ms: 12974, speaker_idx: 1 }]);
  });
});

describe("the gate and the threshold", () => {
  it('only the exact string "1" arms the slice', () => {
    expect(clustersEnabled({ SPEAKER_CLUSTERS_ENABLED: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(clustersEnabled({ SPEAKER_CLUSTERS_ENABLED: v })).toBe(false);
    }
  });

  it("UNSET IS A LOUD REFUSAL, never a default", () => {
    expect(readThreshold({})).toEqual({ ok: false, error: "threshold_unset", raw: null });
    expect(readThreshold({ SPEAKER_MATCH_THRESHOLD: "   " })).toMatchObject({ ok: false, error: "threshold_unset" });
  });

  it("an out-of-range or non-numeric threshold is refused, not clamped", () => {
    for (const raw of ["abc", "1.5", "-2", "NaN"]) {
      expect(readThreshold({ SPEAKER_MATCH_THRESHOLD: raw })).toMatchObject({ ok: false, error: "threshold_invalid" });
    }
  });

  it("a valid threshold reads through", () => {
    expect(readThreshold({ SPEAKER_MATCH_THRESHOLD: "0.72" })).toEqual({ ok: true, threshold: 0.72 });
  });

  it("there is NO default threshold anywhere in the source", () => {
    const src = require("node:fs").readFileSync("lib/stt/speaker-clusters.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/SPEAKER_MATCH_THRESHOLD[^\n]*(\|\||\?\?)\s*[0-9.]/);
  });
});

describe("the calibration sweep runs the shipped matcher", () => {
  it("a lower threshold never produces MORE clusters than a higher one", () => {
    const es = [vec(1), vec(2), vec(3), vec(1), vec(2)];
    const counts = [0.5, 0.7, 0.9, 0.99].map((t) => sweepThreshold(es, t).clusters);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
  });

  it("identical samples collapse into one cluster at any reachable threshold", () => {
    const v = vec(9);
    expect(sweepThreshold([v, v, v], 0.99).clusters).toBe(1);
  });

  it("a threshold above 1 makes every sample its own cluster", () => {
    const es = [vec(1), vec(1), vec(1)];
    expect(sweepThreshold(es, 1.0001).clusters).toBe(3);
  });

  it("no embeddings is zero clusters, not an error", () => {
    expect(sweepThreshold([], 0.7)).toMatchObject({ clusters: 0, within: [], between: [] });
  });

  it("the distribution summary is empty-safe", () => {
    expect(describeDistribution([])).toEqual({ n: 0, min: null, p25: null, median: null, p75: null, max: null });
    expect(describeDistribution([0.1, 0.5, 0.9])).toMatchObject({ n: 3, min: 0.1, max: 0.9 });
  });
});
