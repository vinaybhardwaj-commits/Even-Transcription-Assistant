/**
 * lib/diarize-vad-trim.ts — send pyannote.ai the speech, not the room.
 *
 * pyannote.ai bills per audio-hour, and a 15-minute room window is mostly dead air: the examination
 * couch, the corridor, the minutes between patients. `DIARIZE_VAD_TRIM` (default OFF) runs Silero VAD
 * on the Mac Mini's eta-diarize (`POST /speech_regions`), gets back the speech regions AND a
 * speech-only audio file built from them, sends pyannote.ai that file, and maps pyannote.ai's
 * timestamps back onto the original clip's clock.
 *
 * WHY THE MINI BUILDS THE AUDIO. The clip in R2 is webm/Opus and nothing in the Vercel runtime can cut
 * it — there is no ffmpeg here. The Mini already decodes these clips for /diarize, so it cuts them.
 *
 * ─── THE REMAP IS THE WHOLE RISK ──────────────────────────────────────────────────────────────
 * pyannote.ai answers in TRIMMED time, where the kept regions sit end to end with nothing between
 * them. A segment that spans the join between two regions is, in the original clip, TWO pieces with
 * dead air between them. It must be SPLIT at the join. Stretching it across would put a speaker over
 * audio pyannote.ai never heard — and every reader downstream (turn binding, embeddings, the teacher
 * labels) would take it at its word, with nothing failing.
 *
 * WHY SAMPLE INDICES, NOT SECONDS. The Mini returns each region's original start/end AND the trimmed
 * offset it actually cut at, all as integer sample counts. Recomputing the trimmed offsets here from
 * rounded seconds would drift by up to half a millisecond per region — 50 ms after a hundred regions,
 * enough to move a boundary across a turn. Using the Mini's own cut points means the map is the cut.
 *
 * ─── NO ANSWER IS NOT "NO SPEECH" ─────────────────────────────────────────────────────────────
 * The same rule as the level gate and the speech gate: only a REAL answer with zero regions may stop
 * the paid call. An unreachable VAD, a malformed map, or a map that does not add up falls back to
 * sending the WHOLE clip — the pre-trim behaviour — never to skipping the window. A malformed map is
 * rejected rather than repaired, because a map that is slightly wrong misplaces every speaker quietly.
 */
import { parseFlag } from "@/lib/flags";
import type { DiarizeSegment } from "@/lib/stt/speaker-clusters";
import type { BenchLevelSample } from "@/lib/bench-levels";
import { DEFAULT_ROOM_ENERGY_FLOOR } from "@/lib/stt/window-measure";
import { isBulkContext, poolEndpoints, runPool, type Verdict } from "@/lib/service-pool";

/** The Mini's VAD sample rate. `allow_cut` is sent in these units BEFORE the Mini answers, so a map
 *  that comes back at any other rate is rejected: the spans it was cut against would be misaligned. */
export const VAD_SAMPLE_RATE = 16000;
/** The level log's bucket, as `readRoomLevelDay` groups it. */
const LEVEL_BUCKET_MS = 15_000;

/**
 * PURE — Fable's ruling (b), 23 Sep: the spans where a cut is ALLOWED, because the level log itself
 * confirmed quiet there. Clip-relative, in samples at VAD_SAMPLE_RATE.
 *
 * A bucket qualifies only if it was OBSERVED and its peak stayed under the shared room floor. An
 * ACTIVE bucket is not cuttable, and — the half that matters — neither is a bucket the log has no
 * reading for: absence of a reading is not a reading of silence. So a window the level log did not
 * cover produces no allowed cuts at all, and is diarized whole.
 *
 * A bucket's extent is its 15 s slot (the SQL groups by floor(epoch/15)). The level log samples every
 * few seconds, so a quiet bucket is quiet at the log's own resolution and no finer; a cut inside it
 * can still meet a sub-bucket sound the log did not catch. Silero's own speech regions protect that
 * case — a cut only ever happens where VAD ALSO found nothing (see the Mini's _apply_level_guard).
 */
export function observedQuietSpans(
  samples: readonly BenchLevelSample[],
  window: { start_ms: number; end_ms: number },
  floor: number = DEFAULT_ROOM_ENERGY_FLOOR,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const toSamples = (ms: number) => Math.round((ms * VAD_SAMPLE_RATE) / 1000);
  for (const s of samples) {
    if (!Number.isFinite(s.peak) || !(s.samples >= 1)) continue;   // not observed
    if (s.peak >= floor) continue;                                   // active: never cuttable
    const bStart = Math.floor(s.t_ms / LEVEL_BUCKET_MS) * LEVEL_BUCKET_MS;
    const a = Math.max(bStart, window.start_ms) - window.start_ms;
    const b = Math.min(bStart + LEVEL_BUCKET_MS, window.end_ms) - window.start_ms;
    if (b > a) spans.push([toSamples(a), toSamples(b)]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

export const DIARIZE_VAD_TRIM_ENV = "DIARIZE_VAD_TRIM";

/** Strict, like every flag here: an unrecognised value throws rather than reading as off. */
export function vadTrimEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlag(DIARIZE_VAD_TRIM_ENV, env);
}

/**
 * The parameters, as MEASURED — lab-mover, 23 Sep, Silero over the 20 bake windows that have
 * pyannote.ai teacher labels (/home/eta/eta-data/vad-measure/REPORT.md on the E2E box):
 *
 *   threshold 0.15, min_silence_duration_ms 1200, speech_pad_ms 500, min_speech_duration_ms 250
 *   -> 2.36% of pyannote-confirmed speech cut on the 16 normal windows, worst single window 6.5%.
 *
 * These are SILERO'S OWN knobs, so they go into Silero. The post-processing on top (pad / merge_gap
 * / min_region, Fable's first 0.4 / 1.5 / 0.5) now defaults to a NO-OP, so the Mini reproduces the
 * measurement exactly instead of padding and merging a second time on top of it. Both sets stay
 * overridable by env; the order said to use lab-mover's values when they landed, and they have.
 *
 * WHAT THIS DOES NOT FIX: on 4 of the 20 windows Silero cut 19-91% of real speech whatever the
 * params, because its frame probabilities stay near zero through normal-RMS speech. No setting here
 * addresses that; see the recommendation that DIARIZE_VAD_TRIM stays off until it is understood.
 */
export const VAD_TRIM_DEFAULTS = {
  pad_s: 0,
  merge_gap_s: 0,
  min_region_s: 0,
  threshold: 0.15,
  min_silence_ms: 1200,
  speech_pad_ms: 500,
  min_speech_ms: 250,
} as const;
export const VAD_TRIM_ENV = {
  pad_s: "DIARIZE_VAD_PAD_S",
  merge_gap_s: "DIARIZE_VAD_MERGE_GAP_S",
  min_region_s: "DIARIZE_VAD_MIN_REGION_S",
  threshold: "DIARIZE_VAD_THRESHOLD",
  min_silence_ms: "DIARIZE_VAD_MIN_SILENCE_MS",
  speech_pad_ms: "DIARIZE_VAD_SPEECH_PAD_MS",
  min_speech_ms: "DIARIZE_VAD_MIN_SPEECH_MS",
} as const;
/** Bounds, so a typo cannot quietly make every window one region (or none). Threshold is open (0,1). */
const VAD_TRIM_MAX = {
  pad_s: 5, merge_gap_s: 30, min_region_s: 30,
  threshold: 1, min_silence_ms: 10000, speech_pad_ms: 10000, min_speech_ms: 10000,
} as const;

export type VadTrimParams = {
  pad_s: number; merge_gap_s: number; min_region_s: number;
  threshold: number; min_silence_ms: number; speech_pad_ms: number; min_speech_ms: number;
};

export function vadTrimParams(env: Record<string, string | undefined> = process.env): VadTrimParams {
  const pick = (k: keyof VadTrimParams): number => {
    const raw = env[VAD_TRIM_ENV[k]];
    // Blank is absent, not zero — the same rule as the spend rate.
    if (raw === undefined || raw.trim() === "") return VAD_TRIM_DEFAULTS[k];
    const n = Number(raw);
    // Threshold is a probability: strictly between 0 and 1. 0 would keep everything, 1 nothing.
    if (k === "threshold") return Number.isFinite(n) && n > 0 && n < 1 ? n : VAD_TRIM_DEFAULTS.threshold;
    return Number.isFinite(n) && n >= 0 && n <= VAD_TRIM_MAX[k] ? n : VAD_TRIM_DEFAULTS[k];
  };
  return {
    pad_s: pick("pad_s"), merge_gap_s: pick("merge_gap_s"), min_region_s: pick("min_region_s"),
    threshold: pick("threshold"), min_silence_ms: pick("min_silence_ms"),
    speech_pad_ms: pick("speech_pad_ms"), min_speech_ms: pick("min_speech_ms"),
  };
}

/** One kept region, as the Mini cut it: original sample range, and where it starts in the trimmed file. */
export type SpeechRegion = { start_sample: number; end_sample: number; trim_start_sample: number };

/** A validated map, in milliseconds, ready to remap with. */
export type RegionMap = {
  sampleRate: number;
  regions: Array<{ origStartMs: number; origEndMs: number; trimStartMs: number; trimEndMs: number }>;
  /** Seconds of audio actually sent (the trimmed length) — what the paid engine bills. */
  speechSeconds: number;
  /** Seconds in the original clip, kept beside it so the saving is visible. */
  originalSeconds: number;
};

/**
 * PURE — validate the Mini's regions and turn them into a map. `null` means "do not trust this; send
 * the whole clip". Every check here is one that, if skipped, would misplace speakers silently:
 *   - sample rate positive and whole
 *   - each region non-empty, inside the clip, and after the previous one (sorted, non-overlapping)
 *   - each trimmed offset EXACTLY the sum of the lengths before it — i.e. the file really is the
 *     regions end to end, with no gap and no overlap. A map whose offsets do not add up describes a
 *     file that was not built the way the remap assumes.
 */
export function buildRegionMap(
  regions: readonly unknown[],
  sampleRate: unknown,
  totalSamples: unknown,
): RegionMap | null {
  const sr = Number(sampleRate);
  const total = Number(totalSamples);
  if (!Number.isInteger(sr) || sr <= 0) return null;
  if (!Number.isInteger(total) || total <= 0) return null;
  const toMs = (samples: number) => (samples * 1000) / sr;

  const out: RegionMap["regions"] = [];
  let expectedTrim = 0;
  let prevEnd = 0;
  for (const r of regions) {
    if (typeof r !== "object" || r === null) return null;
    const o = r as Record<string, unknown>;
    const s = Number(o.start_sample), e = Number(o.end_sample), t = Number(o.trim_start_sample);
    if (![s, e, t].every(Number.isInteger)) return null;
    if (s < 0 || e <= s || e > total) return null;          // empty, or outside the clip
    if (s < prevEnd) return null;                            // unsorted or overlapping
    if (t !== expectedTrim) return null;                     // the file is not the regions end to end
    out.push({ origStartMs: toMs(s), origEndMs: toMs(e), trimStartMs: toMs(t), trimEndMs: toMs(t + (e - s)) });
    expectedTrim += e - s;
    prevEnd = e;
  }
  return { sampleRate: sr, regions: out, speechSeconds: expectedTrim / sr, originalSeconds: total / sr };
}

/**
 * PURE — pyannote.ai's segments, in trimmed time, back onto the original clip.
 *
 * Each segment is intersected with every kept region it touches, and each intersection is moved to
 * that region's original position. So a segment that crosses a join comes back as one piece per
 * region, with the removed dead air between them — never one piece stretched across it.
 *
 * Output is in integer ms (rounded once, at the end) and sorted by start. A piece that rounds to zero
 * length is dropped, keeping `end_ms > start_ms`, which every reader of this shape relies on. A part
 * of a segment that falls outside every region (pyannote.ai answering past the end of the file) is
 * dropped rather than guessed at.
 */
export function remapSegments(segments: readonly DiarizeSegment[], map: RegionMap): DiarizeSegment[] {
  const out: DiarizeSegment[] = [];
  for (const seg of segments) {
    for (const r of map.regions) {
      const a = Math.max(seg.start_ms, r.trimStartMs);
      const b = Math.min(seg.end_ms, r.trimEndMs);
      if (b <= a) continue;
      const start_ms = Math.round(r.origStartMs + (a - r.trimStartMs));
      const end_ms = Math.round(r.origStartMs + (b - r.trimStartMs));
      if (end_ms > start_ms) out.push({ start_ms, end_ms, speaker_idx: seg.speaker_idx });
    }
  }
  return out.sort((x, y) => x.start_ms - y.start_ms || x.end_ms - y.end_ms);
}

/**
 * The Mini's answer. `audio` is a WAV of the kept regions end to end (16 kHz mono PCM16), `map` the
 * validated region map. `regionsEmpty` is a REAL answer that there was no speech — the only VAD answer
 * allowed to skip the paid call.
 */
export type SpeechRegionsOutcome = (
  | { ok: true; regionsEmpty: false; audio: Uint8Array; map: RegionMap; vadModel: string | null; latencyMs: number }
  | { ok: true; regionsEmpty: true; originalSeconds: number; vadModel: string | null; latencyMs: number }
  | { ok: false; error: "vad_base_url_missing" | "vad_failed" | "vad_bad_response" | "vad_bad_map"; retryable: boolean }
) & { /** REDUNDANCY-R1 — the origin that answered; present only when a diarize pool is configured. */ served_by?: string };

/**
 * REDUNDANCY-R1 — `retryable` is the endpoint-failed class (transport, timeout, 5xx), and a 404 is failover too
 * (R2: that endpoint does not serve /speech_regions). Anything else is the answer. The status travels beside the
 * outcome and never reaches the caller.
 */
export function speechRegionsVerdict(r: { o: SpeechRegionsOutcome; status: number | null }): Verdict {
  if (r.o.ok) return "ok";
  return r.o.retryable || r.status === 404 ? "failover" : "final";
}

/** Budget for one /speech_regions call: a decode, a VAD pass and a re-encode of a 15-minute clip. */
export const VAD_TRIM_TIMEOUT_MS_DEFAULT = 120_000;

/**
 * Ask the Mini for the speech regions and the speech-only file. Soft-fails: every failure is an
 * outcome the caller turns into "send the whole clip", never into a skipped window.
 */
export async function requestSpeechRegions(
  audio: Uint8Array,
  params: VadTrimParams,
  opts: { label: string; allowCut: ReadonlyArray<readonly [number, number]>; env?: Record<string, string | undefined> },
): Promise<SpeechRegionsOutcome> {
  const env = opts.env ?? process.env;
  // Its own route pool (R2), falling back to the diarize lists and then DIARIZE_BASE_URL.
  const endpoints = poolEndpoints("diarize_vad", { bulk: isBulkContext() }, env);
  if (endpoints.length === 0) return { ok: false, error: "vad_base_url_missing", retryable: false };
  // R1: the whole pool gets the ONE timeout this call always had; a failover gets only what is left.
  const timeoutMs = Number(env.DIARIZE_VAD_TRIM_TIMEOUT_MS || VAD_TRIM_TIMEOUT_MS_DEFAULT);
  const { value, served_by } = await runPool(
    "diarize_vad", endpoints,
    (base, budgetMs) => speechRegionsAt(base, audio, params, opts, budgetMs),
    speechRegionsVerdict,
    { budgetMs: timeoutMs, env },
  );
  return served_by ? { ...value.o, served_by } : value.o;
}

async function speechRegionsAt(
  base: string,
  audio: Uint8Array,
  params: VadTrimParams,
  opts: { label: string; allowCut: ReadonlyArray<readonly [number, number]> },
  timeoutMs: number,
): Promise<{ o: SpeechRegionsOutcome; status: number | null }> {
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: "audio/webm" }), "audio.webm");
  form.append("pad_s", String(params.pad_s));
  form.append("merge_gap_s", String(params.merge_gap_s));
  form.append("min_region_s", String(params.min_region_s));
  // Silero's own knobs, named as the endpoint names them.
  form.append("threshold", String(params.threshold));
  form.append("min_silence_duration_ms", String(params.min_silence_ms));
  form.append("speech_pad_ms", String(params.speech_pad_ms));
  form.append("min_speech_duration_ms", String(params.min_speech_ms));
  // Ruling (b): the ONLY places the Mini may cut. Empty means nothing is cuttable.
  form.append("allow_cut", JSON.stringify(opts.allowCut));

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/speech_regions`, {
      method: "POST", body: form, signal: controller.signal, cache: "no-store",
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // Status and length only: the body can describe the audio.
      console.error("[vad-trim] refused", JSON.stringify({ window: opts.label, status: res.status, body_len: text.length }));
      return { o: { ok: false, error: "vad_failed", retryable: res.status >= 500 }, status: res.status };
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { o: { ok: false, error: "vad_bad_response", retryable: false }, status: null };
    }
    // Branch on `ok`, never on status: this service's /enroll answers 200 with ok:false.
    if (j.ok !== true || !Array.isArray(j.regions)) return { o: { ok: false, error: "vad_bad_response", retryable: false }, status: null };
    const vadModel = typeof j.vad_model === "string" && j.vad_model.trim() ? j.vad_model.trim() : null;
    const latencyMs = Date.now() - t0;

    if (j.regions.length === 0) {
      const total = Number(j.total_samples), sr = Number(j.sample_rate);
      if (!Number.isInteger(total) || !Number.isInteger(sr) || sr <= 0) return { o: { ok: false, error: "vad_bad_map", retryable: false }, status: null };
      return { o: { ok: true, regionsEmpty: true, originalSeconds: total / sr, vadModel, latencyMs }, status: null };
    }
    const map = Number(j.sample_rate) === VAD_SAMPLE_RATE ? buildRegionMap(j.regions, j.sample_rate, j.total_samples) : null;
    if (!map) {
      console.error("[vad-trim] map rejected", JSON.stringify({ window: opts.label, regions: j.regions.length }));
      return { o: { ok: false, error: "vad_bad_map", retryable: false }, status: null };
    }
    const b64 = typeof j.audio_b64 === "string" ? j.audio_b64 : "";
    if (!b64) return { o: { ok: false, error: "vad_bad_response", retryable: false }, status: null };
    return { o: { ok: true, regionsEmpty: false, audio: new Uint8Array(Buffer.from(b64, "base64")), map, vadModel, latencyMs }, status: null };
  } catch {
    console.error("[vad-trim] call failed", JSON.stringify({ window: opts.label, timed_out: controller.signal.aborted }));
    return { o: { ok: false, error: "vad_failed", retryable: true }, status: null };
  } finally {
    clearTimeout(tid);
  }
}

/** The R2 key for a window's speech-only file. Derived from ids only; deleted when the job finishes. */
export function trimmedAudioKey(windowId: string, runId: string): string {
  return `vad-trim/${windowId}/${runId}.wav`;
}
