/**
 * lib/diarize-embed.ts — the missing half of the hybrid: ECAPA embeddings for pyannote.ai's speakers.
 *
 * pyannote.ai is the better segmenter on our rooms (V, 5 of 5) but returns `{start, end, speaker}`
 * and nothing else. Every identity this system has ever assigned comes from a cosine match against
 * an enrolled voiceprint, so turns without embeddings are turns nobody can be named in. This calls
 * `POST /embed_speakers` on the Mac Mini's own diarize service — the SAME ECAPA model that produced
 * every centroid on file — and gets back one embedding per speaker, plus the match the service's
 * own rule makes.
 *
 * WHY THE MATCH HAPPENS THERE AND NOT HERE. The app does have a matcher, `shadowMatch` in
 * lib/stt/losing-score.ts, but it is an AUDITOR, not a matcher: it branches on the service having
 * already claimed a clinician (`reportedId`), and for an unclaimed speaker it only records the
 * candidate that LOST. It cannot assign. Rewriting it to assign would also destroy the E20 control
 * that made it trustworthy, so the match stays where it is proven.
 *
 * ONE SPAN PER SPEAKER, AND THE LONGEST. That is what /diarize does — `longest = max(segments, key
 * = length)` — not a pooled average over a speaker's turns. Reproducing the rule matters more than
 * improving it: a centroid enrolled against longest-span embeddings is only comparable to
 * longest-span embeddings.
 *
 * THE INDEX IS OURS. /diarize numbers speakers by descending speech time; we number by first
 * appearance, because that is what our segment list uses. The endpoint preserves the index we send
 * and matches in speech-time order, so the greedy "longest talker picks a clinician first" rule is
 * reproduced without renumbering anything.
 */

import type { DiarizeSegment } from "@/lib/stt/speaker-clusters";
import type { ClinicianCentroid } from "@/lib/stt/diarize-window";
import { endpointsFor, runPool, type Verdict } from "@/lib/service-pool";
import { withServiceAccess, withDiarizeAuth } from "@/lib/service-access";

/**
 * Budget for one embedding call. Far smaller than DIARIZE_TIMEOUT_MS because the work is far
 * smaller: no segmentation, no clustering — a decode plus a handful of ECAPA passes over a few
 * seconds each. It shares the service's `_HEAVY_SEM` with /diarize, so the wait can still be a
 * queue rather than the model.
 */
export const EMBED_TIMEOUT_MS_DEFAULT = 120_000;
export const EMBED_TIMEOUT_MS = (): number =>
  Number(process.env.DIARIZE_EMBED_TIMEOUT_MS || EMBED_TIMEOUT_MS_DEFAULT);

/** What we ask the service to embed: one speaker, one span, and their total for the match order. */
export type EmbedRequestSpeaker = { idx: number; start_s: number; end_s: number; total_speech_sec: number };

/** What comes back. `embedding_base64` is null when the span was under ECAPA's 0.5 s floor. */
export type EmbeddedSpeaker = {
  idx: number;
  embedding_base64: string | null;
  clinician_id?: string;
  label?: string;
  type?: string;
  confidence?: number;
  source?: string;
};

export type EmbedOutcome =
  | { ok: true; speakers: EmbeddedSpeaker[]; latencyMs: number; served_by?: string }
  | { ok: false; error: "embed_base_url_missing" | "embed_failed" | "embed_bad_response"; retryable: boolean; served_by?: string };

/**
 * REDUNDANCY-R1 — `retryable` already says "that endpoint failed, not the request" (transport, timeout, 5xx):
 * the failover class. So is a 404 (R2): that endpoint does not serve /embed_speakers. Any other refusal or a
 * malformed body is the answer. The status travels beside the outcome and never reaches the caller, whose
 * result is exactly the old one.
 */
export function embedVerdict(r: { o: EmbedOutcome; status: number | null }): Verdict {
  if (r.o.ok) return "ok";
  return r.o.retryable || r.status === 404 ? "failover" : "final";
}

/**
 * PURE — the span to embed for each speaker: their LONGEST one.
 *
 * Returns nothing for a speaker with no spans. `total_speech_sec` is summed across ALL their spans,
 * not just the chosen one, because it decides match PRIORITY and priority is about who holds the
 * room, not about which single span happened to be longest.
 */
export function longestSpanPerSpeaker(segments: readonly DiarizeSegment[]): EmbedRequestSpeaker[] {
  const best = new Map<number, DiarizeSegment>();
  const total = new Map<number, number>();
  for (const s of segments) {
    const len = s.end_ms - s.start_ms;
    if (len <= 0) continue;
    total.set(s.speaker_idx, (total.get(s.speaker_idx) ?? 0) + len);
    const cur = best.get(s.speaker_idx);
    // Ties go to the EARLIER span. A strict `>` would instead keep whichever equal-length span
    // arrived first in the array, which makes the embedded span depend on input order — and the
    // same window re-run could then embed a different piece of audio for the same speaker.
    const curLen = cur ? cur.end_ms - cur.start_ms : -1;
    if (!cur || len > curLen || (len === curLen && s.start_ms < cur.start_ms)) best.set(s.speaker_idx, s);
  }
  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, s]) => ({
      idx,
      start_s: s.start_ms / 1000,
      end_s: s.end_ms / 1000,
      total_speech_sec: Math.round(total.get(idx) ?? 0) / 1000,
    }));
}

/**
 * Ask the Mini for one embedding per speaker.
 *
 * Soft-fails like every other call to this service: a failure means the hybrid has no identities
 * for this window, which the caller records honestly rather than pretending nobody matched.
 */
export async function embedSpeakers(
  audio: Uint8Array,
  speakers: readonly EmbedRequestSpeaker[],
  centroids: readonly ClinicianCentroid[],
  opts: { batchThreshold: number; label: string; contentType?: string } ,
): Promise<EmbedOutcome> {
  // Its own route pool (R2), falling back to the diarize lists and then DIARIZE_BASE_URL.
  const endpoints = endpointsFor("diarize_embed");
  if (endpoints.length === 0) return { ok: false, error: "embed_base_url_missing", retryable: false };
  if (speakers.length === 0) return { ok: true, speakers: [], latencyMs: 0 };
  // R1: the whole pool gets the ONE timeout an embed call always had; a failover gets only what is left.
  const { value, served_by } = await runPool(
    "diarize_embed", endpoints,
    (base, budgetMs) => embedAt(base, audio, speakers, centroids, opts, budgetMs),
    embedVerdict,
    { budgetMs: EMBED_TIMEOUT_MS() },
  );
  return served_by ? { ...value.o, served_by } : value.o;
}

async function embedAt(
  base: string,
  audio: Uint8Array,
  speakers: readonly EmbedRequestSpeaker[],
  centroids: readonly ClinicianCentroid[],
  opts: { batchThreshold: number; label: string; contentType?: string },
  timeoutMs: number,
): Promise<{ o: EmbedOutcome; status: number | null }> {
  const baseType = (opts.contentType?.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: baseType }), "audio.webm");
  form.append("speakers", JSON.stringify(speakers));
  form.append("clinician_centroids", JSON.stringify(centroids));
  form.append("batch_threshold", String(opts.batchThreshold));

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const url = `${base.replace(/\/+$/, "")}/embed_speakers`;
    const res = await fetch(url, withServiceAccess(url, withDiarizeAuth(url, {
      method: "POST", body: form, signal: controller.signal, cache: "no-store",
    })));
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // The service's message can describe the audio; the log gets a status and a length.
      console.error("[embed] refused", JSON.stringify({ window: opts.label, status: res.status, body_len: text.length }));
      return { o: { ok: false, error: "embed_failed", retryable: res.status >= 500 }, status: res.status };
    }
    const j = JSON.parse(text) as { ok?: boolean; speakers?: unknown };
    // Branch on `ok`, never on status: this service's sibling /enroll answers 200 with ok:false.
    if (j.ok !== true || !Array.isArray(j.speakers)) {
      console.error("[embed] bad response", JSON.stringify({ window: opts.label }));
      return { o: { ok: false, error: "embed_bad_response", retryable: false }, status: res.status };
    }
    return { o: { ok: true, speakers: j.speakers as EmbeddedSpeaker[], latencyMs: Date.now() - t0 }, status: res.status };
  } catch (e: unknown) {
    const timedOut = controller.signal.aborted;
    console.error("[embed] call failed", JSON.stringify({ window: opts.label, timed_out: timedOut }));
    return { o: { ok: false, error: "embed_failed", retryable: true }, status: null };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * PURE — fold the service's answer onto the speaker rows built from pyannote.ai's labels.
 *
 * Only ever ADDS identity; never removes a field and never invents one. A speaker the service
 * could not embed keeps exactly the row it had, which is a row with no identity — so the window
 * reports "this voice matched nobody" only where a voice was actually compared.
 */
export function mergeEmbeddings<T extends { idx: number }>(
  speakers: readonly T[],
  embedded: readonly EmbeddedSpeaker[],
): Array<T & Partial<EmbeddedSpeaker>> {
  const byIdx = new Map(embedded.map((e) => [e.idx, e] as const));
  return speakers.map((sp) => {
    const e = byIdx.get(sp.idx);
    if (!e || !e.embedding_base64) return { ...sp };
    return {
      ...sp,
      embedding_base64: e.embedding_base64,
      ...(e.clinician_id ? { clinician_id: e.clinician_id } : {}),
      ...(typeof e.confidence === "number" ? { confidence: e.confidence } : {}),
      // The service's label/type for a MATCHED speaker is the clinician's own name and "clinician",
      // which is an attribution, not a guess. For an unmatched one it says nothing, and the row
      // keeps the "unknown" this engine started with rather than acquiring a heuristic.
      ...(e.clinician_id && e.label ? { label: e.label } : {}),
      ...(e.clinician_id && e.type ? { type: e.type } : {}),
      ...(e.clinician_id && e.source ? { source: e.source } : {}),
    };
  });
}

/** How many of a window's speakers actually got a voiceprint comparison. */
export const embeddedCount = (rows: ReadonlyArray<{ embedding_base64?: string | null }>): number =>
  rows.filter((r) => typeof r.embedding_base64 === "string" && r.embedding_base64.length > 0).length;
