/**
 * lib/stt/speech-gate.ts — re-check that a diarizer segment contains speech.
 *
 * WHY. pyannote runs on pretrained defaults (`~/eta-diarize/server.py:42,:49-54`,
 * `min_duration_on/off = 0.1 s`) and nothing re-checks it, so room noise is stored as a
 * speaker-labelled segment. 7,548 stored segments (8.8%) fall 21:00–07:00 IST, when no
 * consultation can happen; every one of those is a false positive by construction.
 *
 * ─── IT FLAGS. IT DOES NOT DROP. ────────────────────────────────────────────────────────────────
 *
 * A dropped segment cannot be re-examined, and this gate's threshold is not yet earned. Flagging
 * keeps every segment and writes what the gate thought of it, so the same stored data can retune
 * the gate later. Nothing here deletes, re-flags or rewrites a segment that is already stored.
 *
 * ─── THE FAILURE MODE THIS GATE MUST NOT REPRODUCE ──────────────────────────────────────────────
 *
 * Silero is not a reliable authority on far-field room audio, and the router already learned it the
 * expensive way (`~/eta-router/router_server.py:295-313`). Measured 19 Sep across 30 room windows:
 * the VAD keeps 50.4% of the speech the diarizer finds, 11 of 30 keep under 5%, and FIVE WINDOWS
 * RETURNED ZERO SPANS on audio holding 179–671 seconds of diarized speech. Gain does not rescue it.
 * The router's comment puts it exactly: "'no speech' is a VAD failure far more often than it is a
 * quiet room", and it now falls through to fixed windows rather than believe an empty answer.
 *
 * So this gate refuses to convict on an empty answer. A window whose VAD returned NOTHING is not a
 * window of noise; it is a window the VAD could not read, and every segment in it is left UNJUDGED
 * (`is_speech: null`) rather than flagged as non-speech. Judging them would re-create, inside the
 * diarization path, the precise defect the transcription path already fixed.
 */
import type { DiarizeSegment } from "./speaker-clusters";
import { parseFlag } from "@/lib/flags";

/** Default OFF. The night-drain is mid-backlog and must not change behaviour without a switch. */
export const SPEECH_GATE_FLAG = "DIARIZE_SPEECH_GATE";

/**
 * Keep-if at least this much speech. 1.0 s is the knee split-speaker measured against V's ear:
 * it keeps 83% of what he affirmed and removes 70% of what he did not. It is a MEASURED STARTING
 * POINT, not a settled number — which is why nothing is dropped on the strength of it.
 */
export const DEFAULT_MIN_SPEECH_MS = 1_000;

/** Stamped on every judged segment so a stored row says how it was judged, not just what. */
export const SPEECH_GATE_BASIS = "silero-vad-0.5/overlap/v1";

export type SpeechSpan = { start_ms: number; end_ms: number };

/**
 * What the VAD said about a whole window. `spans: null` and `empty: true` are DIFFERENT: the first
 * is "we could not ask", the second is "we asked and it answered nothing" — and on this audio the
 * second is more often a VAD failure than a quiet room. Neither convicts.
 */
export type WindowSpeech =
  | { ok: true; spans: SpeechSpan[] }
  | { ok: false; reason: "vad_unavailable" | "vad_empty_window" };

export type SegmentVerdict = "speech" | "non_speech" | "unjudged";

export type GatedSegment = DiarizeSegment & {
  /** Milliseconds of this segment the VAD called speech. Null when the segment was not judged. */
  speech_ms: number | null;
  /** `speech_ms / duration`, 3 dp. Null when unjudged. */
  speech_ratio: number | null;
  verdict: SegmentVerdict;
  /** Why, when the verdict is `unjudged`. Absent otherwise. */
  unjudged_reason?: "vad_unavailable" | "vad_empty_window" | "gate_off";
  speech_basis: string;
};

export type GateSummary = {
  total: number;
  speech: number;
  non_speech: number;
  unjudged: number;
  min_speech_ms: number;
  basis: string;
};

export function speechGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlag(SPEECH_GATE_FLAG, env);
}

/** PURE — milliseconds two half-open ranges share. Never negative. */
export function overlapMs(a: { start_ms: number; end_ms: number }, b: { start_ms: number; end_ms: number }): number {
  return Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));
}

/**
 * PURE — how much of one segment the VAD called speech.
 *
 * Spans may arrive unsorted and may touch; overlap is summed per span, and the spans a VAD returns
 * never overlap each other, so summing cannot double-count.
 */
export function speechMsIn(segment: { start_ms: number; end_ms: number }, spans: readonly SpeechSpan[]): number {
  let total = 0;
  for (const s of spans) total += overlapMs(segment, s);
  const duration = segment.end_ms - segment.start_ms;
  return Math.min(total, Math.max(0, duration));
}

/**
 * PURE — judge every segment of one window. Segment times are CLIP-RELATIVE, the same clock the
 * VAD spans use; converting to wall time happens after this, in `diarizeWindow`.
 *
 * Returns every segment it was given, in order, always. A caller that stores the result stores the
 * same number of segments it would have stored before.
 */
export function gateSegments(
  segments: readonly DiarizeSegment[],
  speech: WindowSpeech,
  opts: { minSpeechMs?: number } = {},
): { segments: GatedSegment[]; summary: GateSummary } {
  const minSpeechMs = opts.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS;

  // THE REFUSAL. An unreadable or empty VAD answer judges nothing — see the header.
  if (!speech.ok) {
    const out = segments.map((sg): GatedSegment => ({
      ...sg,
      speech_ms: null,
      speech_ratio: null,
      verdict: "unjudged",
      unjudged_reason: speech.reason,
      speech_basis: SPEECH_GATE_BASIS,
    }));
    return {
      segments: out,
      summary: { total: out.length, speech: 0, non_speech: 0, unjudged: out.length, min_speech_ms: minSpeechMs, basis: SPEECH_GATE_BASIS },
    };
  }

  let speechN = 0;
  let nonSpeechN = 0;
  const out = segments.map((sg): GatedSegment => {
    const ms = speechMsIn(sg, speech.spans);
    const duration = Math.max(1, sg.end_ms - sg.start_ms);
    const isSpeech = ms >= minSpeechMs;
    if (isSpeech) speechN += 1;
    else nonSpeechN += 1;
    return {
      ...sg,
      speech_ms: ms,
      speech_ratio: Math.round((ms / duration) * 1000) / 1000,
      verdict: isSpeech ? "speech" : "non_speech",
      speech_basis: SPEECH_GATE_BASIS,
    };
  });
  return {
    segments: out,
    summary: { total: out.length, speech: speechN, non_speech: nonSpeechN, unjudged: 0, min_speech_ms: minSpeechMs, basis: SPEECH_GATE_BASIS },
  };
}

/**
 * PURE — what to store when the gate is OFF: the segments exactly as they arrived.
 *
 * Deliberately NOT "everything is speech". Off means unjudged, and a row written with the gate off
 * must not later read as though the gate had passed it.
 */
export function ungatedSegments(segments: readonly DiarizeSegment[]): GatedSegment[] {
  return segments.map((sg) => ({
    ...sg,
    speech_ms: null,
    speech_ratio: null,
    verdict: "unjudged" as const,
    unjudged_reason: "gate_off" as const,
    speech_basis: SPEECH_GATE_BASIS,
  }));
}

// ---------------------------------------------------------------------------
// Asking the VAD
// ---------------------------------------------------------------------------

/**
 * The Silero VAD this gate reuses lives in the transcription router
 * (`~/eta-router/router_server.py:258 vad_segments`, threshold `ETA_VAD_THRESHOLD`, default 0.5).
 * It is loaded there already — nothing is installed or downloaded for this gate.
 *
 * THE ENDPOINT DOES NOT EXIST YET. The router serves `/healthz`, `/route`, `/route/job` and
 * `/route/job/{id}`; there is no way to ask it for speech spans without also paying for a full
 * transcription. Adding a spans-only route to the router and restarting it is a change to a live
 * service on the Mini, which this order does not authorise — so the client is written against the
 * shape it needs and refuses cleanly until `ETA_VAD_URL` names something.
 *
 * Refusing is safe BY DESIGN: an absent VAD yields `vad_unavailable`, which judges nothing.
 */
export const VAD_URL_KEY = "ETA_VAD_URL";

export async function fetchWindowSpeech(
  audio: Uint8Array,
  contentType: string,
  opts: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<WindowSpeech> {
  const env = opts.env ?? process.env;
  const base = env[VAD_URL_KEY];
  if (!base) return { ok: false, reason: "vad_unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/vad`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: audio as unknown as BodyInit,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: "vad_unavailable" };
    const body = (await res.json()) as { spans?: Array<{ start_ms?: unknown; end_ms?: unknown }> };
    const spans: SpeechSpan[] = [];
    for (const s of body.spans ?? []) {
      const a = Number(s.start_ms);
      const b = Number(s.end_ms);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) spans.push({ start_ms: a, end_ms: b });
    }
    // An answer of NO SPANS is the documented VAD failure on this audio, not a verdict of silence.
    if (spans.length === 0) return { ok: false, reason: "vad_empty_window" };
    return { ok: true, spans };
  } catch {
    return { ok: false, reason: "vad_unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
