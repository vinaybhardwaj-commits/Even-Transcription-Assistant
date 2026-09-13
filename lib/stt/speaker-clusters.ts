/**
 * lib/stt/speaker-clusters.ts — the room centroid slice, pure half (PRD §7, Build 4).
 *
 * Everything here is a pure function over values somebody else read. No database, no fetch, no
 * clock — so the matching rule, the running mean and the turn binding are all testable without a
 * Mac Mini, which matters because the threshold this rule turns on is not yet frozen.
 *
 * ─── EVERY CLUSTER THIS SLICE WRITES IS kind='other' ──────────────────────────────────────
 * `speaker_cluster.kind` is CHECK-constrained to ('doctor','other') and nothing here ever writes
 * 'doctor'. Calling a cluster the doctor needs identity evidence, and there is none: the two
 * enrolled voiceprints are May-vintage, were never refreshed from real audio (zero passive
 * samples), and PRD §1.9 settled that this slice does NOT match against them. The available
 * alternative — "the one who talks most is the doctor" — is a manufactured label that would be
 * right often enough to be trusted and wrong often enough to matter. `other` is the honest kind,
 * and a later slice with real evidence can promote a cluster.
 *
 * ─── ANONYMOUS, PER ROOM-DAY ──────────────────────────────────────────────────────────────
 * Clusters carry no name and never leave their room_day. Two clusters on two days are two
 * clusters even if the same person made both; joining them across days is identity work this
 * slice does not do.
 */

/** ECAPA embeddings are 192 float32 little-endian = 768 bytes (migration 0042's own comment). */
export const EMBEDDING_DIMS = 192;
export const EMBEDDING_BYTES = EMBEDDING_DIMS * 4;

/**
 * PURE — base64 → the embedding, or null when it is not one.
 *
 * NULL RATHER THAN A SHORTER VECTOR. A truncated or oversized payload is not a weak embedding, it
 * is a different thing arriving under the same name; cosine over a wrong-length vector returns a
 * plausible number, and a plausible number is how a wrong cluster gets written and believed.
 */
export function decodeEmbedding(b64: string | null | undefined): Float32Array | null {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (buf.byteLength !== EMBEDDING_BYTES) return null;
  const out = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) out[i] = buf.readFloatLE(i * 4);
  for (const v of out) if (!Number.isFinite(v)) return null;
  return out;
}

/** PURE — the stored form: 192 × float32 LE, exactly what 0042 documents. */
export function encodeCentroid(v: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(EMBEDDING_BYTES);
  for (let i = 0; i < EMBEDDING_DIMS; i++) buf.writeFloatLE(v[i] ?? 0, i * 4);
  return buf;
}

/** PURE — bytea → embedding. Same length rule as decodeEmbedding, same reason. */
export function decodeCentroid(raw: unknown): Float32Array | null {
  if (raw === null || raw === undefined) return null;
  let buf: Buffer | null = null;
  if (Buffer.isBuffer(raw)) buf = raw;
  else if (raw instanceof Uint8Array) buf = Buffer.from(raw);
  else if (typeof raw === "string") {
    // Postgres bytea over the HTTP driver arrives as `\x…` hex.
    const hex = raw.startsWith("\\x") ? raw.slice(2) : raw;
    if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
    buf = Buffer.from(hex, "hex");
  }
  if (!buf || buf.byteLength !== EMBEDDING_BYTES) return null;
  const out = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * PURE — cosine similarity, or null when either vector has no direction.
 *
 * A zero vector has no angle, so there is no similarity to report. Returning 0 would read as
 * "maximally different" and silently create a new cluster for every zero embedding.
 */
export function cosine(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return null;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  // ROUNDED, AND THE ROUNDING IS LOAD-BEARING. Summing 192 products accumulates float error, so a
  // vector compared with ITSELF comes back as 0.9999999999999999 for some inputs and exactly 1
  // for others — data-dependent, which means a threshold of 1.0 would sometimes mean "identical"
  // and sometimes mean "unreachable". Rounding at 1e-12 is twelve orders of magnitude below any
  // resolution a similarity threshold is ever chosen at, and it makes self-similarity exactly 1
  // for every input. The clamp then holds the mathematical bound.
  return Math.max(-1, Math.min(1, Math.round(c * 1e12) / 1e12));
}

export type ClusterCandidate = { id: string; centroid: Float32Array };

export type MatchDecision =
  | { kind: "match"; cluster_id: string; cosine: number }
  | { kind: "new"; best_cosine: number | null };

/**
 * PURE — match an embedding against a room-day's clusters (PRD §7).
 *
 * `>= threshold` is a MATCH; strictly below is a new cluster. The boundary is inclusive on the
 * match side deliberately: the threshold is the value at which two samples are declared the same
 * voice, so the value itself must be on the "same" side of the line, and a test pins it there.
 *
 * BEST MATCH WINS, NOT FIRST OVER THE LINE. With several clusters above the threshold the
 * nearest one takes the sample; first-past-the-post would make the result depend on row order,
 * and row order is not evidence about a voice.
 */
export function matchCluster(
  embedding: Float32Array,
  clusters: readonly ClusterCandidate[],
  threshold: number,
): MatchDecision {
  let best: { id: string; c: number } | null = null;
  for (const cl of clusters) {
    const c = cosine(embedding, cl.centroid);
    if (c === null) continue;
    if (!best || c > best.c) best = { id: cl.id, c };
  }
  if (best && best.c >= threshold) return { kind: "match", cluster_id: best.id, cosine: best.c };
  return { kind: "new", best_cosine: best ? best.c : null };
}

/**
 * PURE — the running mean (PRD §7: "update centroid (running mean)").
 *
 * `count` is how many samples the CURRENT centroid already averages, so the new centroid is
 * `(current * count + next) / (count + 1)`. Getting the count from the membership ledger rather
 * than from a column on the cluster is what makes this exact and re-runnable: a re-run that
 * re-binds the same (window, speaker) contributes nothing, because the ledger already holds that
 * row and the caller never reaches this function for it.
 */
export function runningMean(current: Float32Array, count: number, next: Float32Array): Float32Array {
  const n = Math.max(0, Math.trunc(count));
  const out = new Float32Array(current.length);
  for (let i = 0; i < current.length; i++) {
    out[i] = (current[i]! * n + next[i]!) / (n + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Turn binding
// ---------------------------------------------------------------------------

/**
 * A diarize segment. The shape is the Mini's own, documented in
 * `docs/ETA-MAC-MINI-BACKEND-HANDOVER.md`: `{ start_ms, end_ms, speaker_idx, overlap }`, with the
 * times RELATIVE TO THE CLIP, exactly like Whisper's segments. Only the caller knows what instant
 * the clip began at, so nothing here converts to wall clock.
 */
export type DiarizeSegment = { start_ms: number; end_ms: number; speaker_idx: number };

/** PURE — parse the service's `transcript_segments`, dropping anything unreadable individually. */
export function parseDiarizeSegments(raw: unknown): DiarizeSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: DiarizeSegment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const start = Number(o.start_ms);
    const end = Number(o.end_ms);
    const idx = Number(o.speaker_idx);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (!Number.isInteger(idx) || idx < 0) continue;
    out.push({ start_ms: start, end_ms: end, speaker_idx: idx });
  }
  return out;
}

export type TurnSpan = { source_ref: string; start_ms: number; end_ms: number };
// bindTurnsToSpeakers, TurnBinding and spanOverlapMs were DELETED in C2. They bound a whole turn to
// whichever speaker held most of it, which wrote one person's name across another's speech; the
// diarize_window job binds with bindTurnsExclusive (lib/stt/speaker-roles.ts), which refuses a name
// to a turn that holds more than one speaker.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const SPEAKER_CLUSTERS_ENABLED_ENV = "SPEAKER_CLUSTERS_ENABLED";
export const SPEAKER_MATCH_THRESHOLD_ENV = "SPEAKER_MATCH_THRESHOLD";

export function clustersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SPEAKER_CLUSTERS_ENABLED_ENV] === "1";
}

export type ThresholdRead =
  | { ok: true; threshold: number }
  | { ok: false; error: "threshold_unset" | "threshold_invalid"; raw: string | null };

/**
 * PURE — the match threshold, with NO DEFAULT.
 *
 * A default here would be the single most consequential invented number in the programme: it
 * decides how many people the system believes were in the room. PRD §7 is explicit that the
 * value is frozen only after the calibration report, so an unset threshold with the gate ON is a
 * LOUD config error and the pass refuses — it does not fall back to a plausible 0.7 and quietly
 * produce a day's worth of clusters nobody can defend.
 *
 * The existing live-identify threshold (0.78) and the passive-capture gate (0.82) are NOT
 * borrowed: both are thresholds against an ENROLLED clinician centroid, which is a different
 * comparison from one anonymous room sample against another.
 */
/**
 * SPEAKER_MATCH_THRESHOLD IS UNSET AND STAYS UNDERIVED — and here is the route back to setting it.
 *
 * This is the voice-to-voice cosine for grouping one room-day's speakers into clusters. It is NOT
 * DIARIZE_BATCH_THRESHOLD (0.65), which is the clinician-centroid-to-voice floor sent to /diarize;
 * reading that in its place would be supplying a number measured for a different question.
 *
 * Clustering has no writer as of C2 (see CLUSTERING_STATUS in lib/brain/state.ts). The way back,
 * in order, is a later slice and not this one:
 *   1. the diarize_window job writes room_diarize_window on every run (it does, now);
 *   2. calibration data accumulates there, and speaker-calibration/route.ts sweeps it;
 *   3. this threshold is frozen FROM that sweep, by a person, into the environment;
 *   4. clustering is rebuilt on the diarize_window job, reading this value.
 * Until step 3, `threshold_unset` is the correct and only answer.
 */
export function readThreshold(env: Record<string, string | undefined> = process.env): ThresholdRead {
  const raw = env[SPEAKER_MATCH_THRESHOLD_ENV];
  if (raw === undefined || raw.trim() === "") return { ok: false, error: "threshold_unset", raw: raw ?? null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -1 || n > 1) return { ok: false, error: "threshold_invalid", raw };
  return { ok: true, threshold: n };
}

/**
 * The 24 Aug Cardiology session PRD §7 names as the calibration tape.
 *
 * Lives here rather than in the route module because a Next.js route may export only handlers and
 * route config — and because the session this threshold was frozen against is a fact about the
 * calibration, not about the HTTP surface that happens to serve it.
 */
export const CALIBRATION_SESSION_ID = "bs_z3gpbh6e";

/** The sweep the calibration surface reports over. Wide enough to bracket any defensible value. */
export const CALIBRATION_THRESHOLDS: readonly number[] = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

export type SweepPoint = {
  threshold: number;
  clusters: number;
  /** Cosines that landed INSIDE a cluster (a sample matched an existing centroid). */
  within: number[];
  /** Best-cosine values that still fell short and opened a new cluster. */
  between: number[];
};

/**
 * PURE — replay the matcher over a list of embeddings at one threshold, writing nothing.
 *
 * This is the SAME code path the writer uses (matchCluster + runningMean), deliberately: a
 * calibration that modelled the matcher rather than running it would be calibrating a different
 * instrument from the one that ships.
 */
export function sweepThreshold(embeddings: readonly Float32Array[], threshold: number): SweepPoint {
  const clusters: Array<{ id: string; centroid: Float32Array; count: number }> = [];
  const within: number[] = [];
  const between: number[] = [];
  let next = 0;
  for (const e of embeddings) {
    const d = matchCluster(e, clusters, threshold);
    if (d.kind === "match") {
      within.push(d.cosine);
      const cl = clusters.find((c) => c.id === d.cluster_id)!;
      cl.centroid = runningMean(cl.centroid, cl.count, e);
      cl.count += 1;
    } else {
      if (d.best_cosine !== null) between.push(d.best_cosine);
      clusters.push({ id: `c${next++}`, centroid: e, count: 1 });
    }
  }
  return { threshold, clusters: clusters.length, within, between };
}

/** PURE — the five-number summary a human needs to pick a line. */
export function describeDistribution(values: readonly number[]): {
  n: number; min: number | null; p25: number | null; median: number | null; p75: number | null; max: number | null;
} {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, min: null, p25: null, median: null, p75: null, max: null };
  const at = (q: number) => v[Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))]!;
  return { n: v.length, min: v[0]!, p25: at(0.25), median: at(0.5), p75: at(0.75), max: v[v.length - 1]! };
}
