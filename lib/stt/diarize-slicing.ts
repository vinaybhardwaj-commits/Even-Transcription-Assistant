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
import { sliceStart, sliceEnd, type SliceStartMs, type SliceEndMs } from "./window-bounds";

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

export type SliceBound = { index: number; start: SliceStartMs; end: SliceEndMs };

/** PURE. The sub-windows a window becomes, cutting on the clock. The last one is short. */
export function sliceBounds(startMs: number, endMs: number, sliceMs: number = SLICE_MS): SliceBound[] {
  const out: SliceBound[] = [];
  if (!(endMs > startMs)) return out;
  let i = 0;
  for (let t = startMs; t < endMs; t += sliceMs, i += 1) {
    out.push({ index: i, start: sliceStart(t), end: sliceEnd(Math.min(endMs, t + sliceMs)) });
  }
  return out;
}

/** How far a nominal boundary may move to find a gap between turns. */
export const SNAP_WINDOW_MS = 10_000;

/**
 * PURE. Slice boundaries that try not to cut a turn in half.
 *
 * ─── WHY ───────────────────────────────────────────────────────────────────────────────────────
 * Every boundary that lands inside a turn costs that turn its attribution, permanently: a turn
 * spanning two slices belongs to two clusterings and can be named by neither. At 120 s slices that
 * is a few percent of turns and roughly twice that share of SPEECH SECONDS, because longer turns
 * are likelier to be cut. We already know where the turns are — `stt_turn` exists before diarize
 * runs — so donating those seconds to an arbitrary clock is a choice, not a constraint.
 *
 * ─── THE ALGORITHM, AND THE CAP THAT OUTRANKS IT ───────────────────────────────────────────────
 * Walk the nominal 120 s marks. For each, look for a turn BOUNDARY (a gap between turns) within
 * ±SNAP_WINDOW_MS and take the nearest. The hard cap wins every argument: a slice may never exceed
 * SLICE_MS, because 120 x 1.5 x 1000 + 45 000 = 225 000 against a 240 000 ms lease is the whole
 * reason slicing works, so a snap that would lengthen a slice past the cap is only taken EARLIER,
 * never later. With no usable boundary the cut stays on the clock and whatever it crosses is
 * marked `seam` — named, not hidden.
 */
export function snappedSliceBounds(
  startMs: number,
  endMs: number,
  turns: readonly { start_ms: number; end_ms: number }[],
  sliceMs: number = SLICE_MS,
  snapMs: number = SNAP_WINDOW_MS,
): SliceBound[] {
  if (!(endMs > startMs)) return [];
  // Candidate cut points: every turn edge. A cut ON an edge splits nothing.
  const edges = [...new Set(turns.flatMap((t) => [t.start_ms, t.end_ms]))].sort((a, b) => a - b);
  const cutsNothing = (at: number) => !turns.some((t) => t.start_ms < at && t.end_ms > at);

  const out: SliceBound[] = [];
  let from = startMs;
  let i = 0;
  while (from < endMs) {
    const nominal = Math.min(endMs, from + sliceMs);
    if (nominal >= endMs) { out.push({ index: i, start: sliceStart(from), end: sliceEnd(endMs) }); break; }
    // Only candidates that keep the slice inside the cap, and leave something after it.
    const lo = Math.max(from + 1, nominal - snapMs);
    const hi = Math.min(from + sliceMs, nominal + snapMs);
    let best: number | null = null;
    for (const e of edges) {
      if (e < lo || e > hi || e >= endMs) continue;
      if (!cutsNothing(e)) continue;
      if (best === null || Math.abs(e - nominal) < Math.abs(best - nominal)) best = e;
    }
    const cut = best ?? nominal;
    out.push({ index: i, start: sliceStart(from), end: sliceEnd(cut) });
    from = cut;
    i += 1;
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
 * Each speaker joins the BEST-matching existing identity whose OPENING member it meets at or above
 * the threshold; otherwise it opens one. Greedy and order-dependent by construction — it walks slices
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
    // The opener's hop is its REAL cosine with itself, computed, not assumed — 1 for a usable
    // vector and null for one we could not decode. A hard-coded 1 hid the case below.
    else groups.push({ id: clusterIdFor(groups.length), opener: emb, members: [sp], cosines: [cosine(emb, emb) ?? 0] });
  }

  for (const g of groups) {
    // The identity's clinician is whichever member the SERVICE named. If two members disagree the
    // identity is left unnamed: two different enrolled voices matched into one cluster means the
    // cluster is wrong, and picking one of them would be guessing which.
    const named = g.members.filter((m) => typeof m.clinician_id === "string" && m.clinician_id && typeof m.confidence === "number");
    const ids = new Set(named.map((m) => m.clinician_id));
    const clinician = ids.size === 1 ? (named[0]!.clinician_id as string) : null;
    const sourceConf = ids.size === 1 ? Math.min(...named.map((m) => m.confidence as number)) : null;

    // THE CLAIM IS ONLY AS GOOD AS THE WEAKEST LINK ON ITS PATH, and the path runs through the
    // opener: named member --hop--> opener --hop--> this member. Taking only a member's own hop let
    // an OPENER record the service's full confidence for a name that reached it through a 0.66
    // joiner — the exact overstatement this comment block claims to prevent.
    const namedHops = g.members.map((m, i) => (named.includes(m) ? (g.cosines[i] ?? 0) : null)).filter((x): x is number => x !== null);
    const weakestNamedHop = namedHops.length ? Math.min(...namedHops) : null;
    g.members.forEach((m, i) => {
      const ownHop = g.cosines[i] ?? 0;
      const usable = clinician !== null && sourceConf !== null && weakestNamedHop !== null;
      out.set(key(m.slice, m.idx), {
        cluster_id: g.id,
        clinician_id: clinician,
        match_confidence: usable ? Math.min(sourceConf, weakestNamedHop, ownHop) : null,
      });
    });
  }
  return out;
}

export const stitchKeyFor = key;
