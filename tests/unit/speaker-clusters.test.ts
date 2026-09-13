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

describe("the gate and the threshold", () => {

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
