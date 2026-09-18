/**
 * lib/stt/losing-score.ts — E20. The score that lost, recomputed in the app, and a control on it.
 *
 * ─── WHY THIS EXISTS, AND WHY IT IS A SHADOW ───────────────────────────────────────────────────
 * The diarize service scores every speaker cluster against every centroid it was sent and keeps the
 * best (server.py:186-198), but it RESPONDS with `clinician_id` and `confidence` only when that best
 * clears `batch_threshold` (server.py:209-216). The losing candidate is discarded before the response.
 * So a room turn that missed by 0.02 and one that missed by 0.30 look identical, and the thresholds
 * (0.65 room, 0.70 encounter, 0.78 phone) have no distribution to be set from.
 *
 * The response does carry each speaker's raw ECAPA embedding (`embedding_base64`, server.py:205) — the
 * very vector the service matched. This module recomputes the match from it. That is a SECOND
 * IMPLEMENTATION of the service's match (testing rule 3), so it is only acceptable MEASURED
 * (ETA-E20-RULING §1): every speaker the service DID match is recomputed too, and the result is
 * compared with the service's own 3-dp confidence. The end state is the service returning the losing
 * candidate itself (option 2), recorded as score_basis 'service_reported'.
 *
 * ─── THE MIRROR ────────────────────────────────────────────────────────────────────────────────
 *   - speakers in the service's order (`idx`, which is its loudest-first enumeration, server.py:191);
 *   - centroids in the order they were sent, best by STRICT `>` from 0.0, so the first of a tie wins and
 *     a cosine at or below zero is never a candidate (server.py:190-198);
 *   - GREEDY: a clinician the service assigned to a louder speaker is not a candidate for a quieter one
 *     (`used_clinician_ids`, server.py:187,193-194,217). The exclusion follows the service's DECISION —
 *     the clinician_id it reported — not the shadow's, so a shadow error cannot move it;
 *   - cosine exactly as `_cosine` (server.py:98-103): 0 when either norm is 0.
 *
 * ─── AGREEMENT ─────────────────────────────────────────────────────────────────────────────────
 * A matched speaker AGREES when the shadow's best is the same clinician and its score rounds to the
 * service's 3-dp confidence: |shadow − service| <= 0.0005. A tolerance, not rounded equality: Python's
 * round() is half-to-even and a float64 recomputation of a float32 cosine can land either side of an
 * exact .0005, which would count disagreements that are not there. An UNMATCHED speaker whose shadow best
 * is at or above the threshold is also a disagreement: the service said no, the shadow says yes.
 */
import type { DiarizeSpeaker } from "@/lib/diarize";

/** What a losing score is based on. 'service_reported' is reserved for the option-2 round, unwritten. */
export const SCORE_BASIS_APP_RECOMPUTED = "app_recomputed";

export type ShadowCentroid = { clinician_id: string; centroid_base64: string };
export type LosingCandidate = { clinician_id: string; score: number };
export type ShadowGuard = {
  /** Matched speakers (service reported a clinician and a usable confidence) that were recomputed. */
  matched_checked: number;
  /** Of those: a different clinician, or a score further than 0.0005 from the service's confidence. */
  disagreements: number;
  /** Unmatched speakers whose shadow best is at or above the threshold — the service said no. */
  unmatched_above_threshold: number;
  /** Speakers the shadow could not recompute (no or malformed embedding). Never a losing score. */
  unrecomputable: number;
  /** |shadow − service confidence| for every matched speaker checked, in speaker order. */
  diffs: number[];
};
export type ShadowResult = { losingByIdx: Map<number, LosingCandidate>; guard: ShadowGuard };

const AGREE_TOLERANCE = 0.0005 + 1e-9;

/** base64 → little-endian float32, or null when it is not a whole number of float32s. */
export function decodeFloat32(b64: unknown): Float32Array | null {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

/** server.py `_cosine`: dot / (|a| |b|), and 0 when either norm is 0 or the lengths differ. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const reportedId = (s: DiarizeSpeaker) => (typeof s.clinician_id === "string" ? s.clinician_id.trim() : "");
const usable = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * PURE. The losing candidate for every speaker the service did not match, and the control on the shadow.
 * `centroids` MUST be the array sent on the same /diarize call, in the same order.
 */
export function shadowMatch(speakers: readonly DiarizeSpeaker[], centroids: readonly ShadowCentroid[], threshold: number): ShadowResult {
  const vecs = centroids
    .map((c) => ({ id: c.clinician_id, v: decodeFloat32(c.centroid_base64) }))
    .filter((c): c is { id: string; v: Float32Array } => c.v !== null);
  const ordered = [...speakers].filter((s) => typeof s.idx === "number" && Number.isFinite(s.idx)).sort((a, b) => a.idx - b.idx);
  const used = new Set<string>();
  const losingByIdx = new Map<number, LosingCandidate>();
  const guard: ShadowGuard = { matched_checked: 0, disagreements: 0, unmatched_above_threshold: 0, unrecomputable: 0, diffs: [] };

  for (const sp of ordered) {
    const id = reportedId(sp);
    const emb = decodeFloat32(sp.embedding_base64);
    let best: { id: string; score: number } | null = null;
    if (emb) {
      let bestScore = 0.0;
      for (const c of vecs) {
        if (used.has(c.id)) continue;
        const s = cosine(emb, c.v);
        if (s > bestScore) { best = { id: c.id, score: s }; bestScore = s; }
      }
    } else {
      guard.unrecomputable += 1;
    }

    if (id) {
      // The service claimed this clinician; a quieter speaker can no longer have it, whatever the shadow says.
      if (usable(sp.confidence) && emb) {
        guard.matched_checked += 1;
        const diff = best ? Math.abs(best.score - sp.confidence) : Math.abs(sp.confidence);
        guard.diffs.push(diff);
        if (!best || best.id !== id || diff > AGREE_TOLERANCE) guard.disagreements += 1;
      }
      used.add(id);
      continue;
    }
    if (!best) continue;
    if (best.score >= threshold) { guard.unmatched_above_threshold += 1; continue; }
    losingByIdx.set(sp.idx, { clinician_id: best.id, score: best.score });
  }
  return { losingByIdx, guard };
}

/** The shadow may be written only when its own control, in this window, found nothing wrong. */
export const shadowTrusted = (g: ShadowGuard) => g.disagreements === 0 && g.unmatched_above_threshold === 0;
