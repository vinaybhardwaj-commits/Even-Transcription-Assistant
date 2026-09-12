/**
 * lib/stt/diarize-slicing.ts — C2 fix D4. Why a room window is diarized in pieces.
 *
 * ─── THE ARITHMETIC THAT MADE THE FEATURE INERT ────────────────────────────────────────────────
 * A room window is 900 s (WINDOW_MS). The service runs at ~1.5x realtime. A lease is 240 s. So an
 * inline call on a whole window projects to 900 x 1.5 x 1000 + 45 000 = 1 395 000 ms — roughly six
 * leases — and the first version refused it at admission. That refusal was correct and useless:
 * every production window hit it, so "the first live speaker attribution" could not fire on a
 * single real input.
 *
 * RAISING THE LEASE WOULD NOT HAVE HELPED. A 1 395 s inline HTTP call cannot be held by a
 * serverless runner at any lease value, and the Mini serialises this work behind a depth-1 gate, so
 * one window would also have occupied the only slot for twenty minutes. The fix is to ask smaller
 * questions.
 *
 * ─── SLICE SIZE ────────────────────────────────────────────────────────────────────────────────
 * 120 s, not the 130 s the arithmetic permits. 120 x 1.5 x 1000 + 45 000 = 225 000 ms against a
 * 240 000 ms lease: 15 s of margin for a slow tunnel or a service having a worse day than the
 * measurement did. A margin that only exists when everything is nominal is not a margin.
 */
import { LEASE_MS } from "@/lib/jobs/types";
import { DIARIZE_IO_MARGIN_MS, DIARIZE_REALTIME_FACTOR } from "./diarize-budget";

/** One slice of audio. 120 s keeps a step inside its lease with room to spare. */
export const SLICE_MS = 120_000;

/**
 * The cosine floor for accepting that a clinician centroid matches a voice.
 *
 * SENT EXPLICITLY ON EVERY CALL. The service defaults to 0.70 (`server.py:134`) and that default is
 * not ours: it is stricter, so the failure is quiet — fewer attributions, no error — which is
 * exactly how an unvalidated number governs identity for months. This codebase already refuses to
 * default this class of value (`speaker-clusters.ts` readThreshold), and inheriting a remote
 * default is the same mistake with an extra hop. 0.65 is the validated figure; it travels.
 */
export const DIARIZE_BATCH_THRESHOLD = 0.65;

/** The same floor, applied to OUR cosine when deciding two slices heard the same voice. */
export const SPEAKER_STITCH_THRESHOLD = 0.65;

export type SliceBound = { index: number; start_ms: number; end_ms: number };

/** PURE. The sub-windows a window becomes. The last one is short; none is ever empty. */
export function sliceBounds(startMs: number, endMs: number, sliceMs: number = SLICE_MS): SliceBound[] {
  const out: SliceBound[] = [];
  if (!(endMs > startMs)) return out;
  let i = 0;
  for (let t = startMs; t < endMs; t += sliceMs, i += 1) {
    out.push({ index: i, start_ms: t, end_ms: Math.min(endMs, t + sliceMs) });
  }
  return out;
}

/** PURE. Does one slice fit a lease? Kept so the refusal still exists for an absurd slice size. */
export function sliceFits(sliceSeconds: number, factor: number = DIARIZE_REALTIME_FACTOR()): boolean {
  return Math.round(sliceSeconds * factor * 1000) + DIARIZE_IO_MARGIN_MS <= LEASE_MS;
}

// ---------------------------------------------------------------------------
// Cross-slice identity
// ---------------------------------------------------------------------------

/** PURE. base64 of little-endian float32[192], exactly as /enroll and /diarize both emit it. */
export function decodeEmbedding(b64: string | null | undefined): Float32Array | null {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length === 0 || buf.length % 4 !== 0) return null;
    const out = new Float32Array(buf.length / 4);
    for (let i = 0; i < out.length; i += 1) out[i] = buf.readFloatLE(i * 4);
    return out;
  } catch { return null; }
}

/** PURE. Cosine similarity, or null when either side is unusable. Never throws, never guesses. */
export function cosine(a: Float32Array | null, b: Float32Array | null): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export type SliceSpeaker = {
  slice: number;
  idx: number;
  embedding_base64?: string | null;
  clinician_id?: string | null;
  confidence?: number | null;
};

export type StitchedIdentity = {
  cluster_id: string;
  /** Propagated from whichever member the SERVICE matched, never from order or from us. */
  clinician_id: string | null;
  /**
   * The weakest link in the chain that produced this claim: the service's own match confidence,
   * or the stitch cosine when the claim reached this slice through a stitch — whichever is lower.
   * A number that describes only the last hop would overstate a two-hop identity.
   */
  match_confidence: number | null;
};

const key = (s: number, i: number) => `${s}:${i}`;

/**
 * PURE. Group speakers across slices into identities, greedily, at `threshold`.
 *
 * Each speaker joins the first existing identity whose OPENING member it matches at or above the
 * threshold; otherwise it opens one. Greedy and order-dependent by construction — it walks slices
 * in order, which is the only order that exists — and deliberately compares against the opener
 * rather than a running mean, so one weak member cannot drag an identity onto a different voice.
 *
 * A speaker with no usable embedding NEVER joins anything: it gets its own identity and no
 * clinician. An unstitchable voice is an unknown voice, not a member of the nearest cluster.
 */
export function stitchSpeakers(
  speakers: readonly SliceSpeaker[],
  threshold: number = SPEAKER_STITCH_THRESHOLD,
  clusterIdFor: (n: number) => string = (n) => `rsc_${n}`,
): Map<string, StitchedIdentity> {
  const groups: Array<{ id: string; opener: Float32Array | null; members: SliceSpeaker[]; cosines: number[] }> = [];
  const out = new Map<string, StitchedIdentity>();

  for (const sp of [...speakers].sort((a, b) => a.slice - b.slice || a.idx - b.idx)) {
    const emb = decodeEmbedding(sp.embedding_base64);
    let joined: { g: (typeof groups)[number]; cos: number } | null = null;
    if (emb) {
      for (const g of groups) {
        const c = cosine(g.opener, emb);
        if (c !== null && c >= threshold && (!joined || c > joined.cos)) joined = { g, cos: c };
      }
    }
    if (joined) { joined.g.members.push(sp); joined.g.cosines.push(joined.cos); }
    else groups.push({ id: clusterIdFor(groups.length), opener: emb, members: [sp], cosines: [1] });
  }

  for (const g of groups) {
    // The identity's clinician is whichever member the SERVICE named. If two members disagree the
    // identity is left unnamed: two different enrolled voices matched into one cluster means the
    // cluster is wrong, and picking one of them would be guessing which.
    const named = g.members.filter((m) => typeof m.clinician_id === "string" && m.clinician_id && typeof m.confidence === "number");
    const ids = new Set(named.map((m) => m.clinician_id));
    const clinician = ids.size === 1 ? (named[0]!.clinician_id as string) : null;
    const sourceConf = ids.size === 1 ? Math.min(...named.map((m) => m.confidence as number)) : null;

    g.members.forEach((m, i) => {
      const hop = g.cosines[i] ?? 1;
      out.set(key(m.slice, m.idx), {
        cluster_id: g.id,
        clinician_id: clinician,
        match_confidence: clinician === null || sourceConf === null ? null : Math.min(sourceConf, hop),
      });
    });
  }
  return out;
}

export const stitchKeyFor = key;
