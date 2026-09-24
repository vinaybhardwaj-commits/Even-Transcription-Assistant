/**
 * Whisper bridge — server-side client for the Cloudflare-tunnelled
 * whisper.cpp server running on V's Mac Mini.
 *
 * Model: ggml-large-v3-turbo (Whisper large-v3 turbo distillation,
 * 798M params, 4-layer decoder, ~8x faster than full large-v3 on Apple
 * Silicon, 100 languages incl. Hindi + Kannada).
 *
 * Why local: same Mac Mini that hosts qwen2.5:14b, so no extra cloud
 * round-trip; audio stays inside the hospital network; zero per-minute
 * cost; multilingual one-pass for English↔Hindi↔Kannada code-switching.
 *
 * The whisper.cpp server exposes a POST /inference endpoint that
 * accepts multipart/form-data with a `file` part. Returns JSON like:
 *   { "text": "...", "language": "en", "duration": 2.34, "segments": [...] }
 *
 * DECODER (K3 §5): temperature, beam_size and best_of are all genuinely parsed by this server
 * and are pinned below to greedy / single-candidate / zero. `seed` is NOT a parameter it has.
 *
 * SEGMENTS (speech turns, slice A). This client used to ask for `json` and read
 * only `text`, so the segment timings the model had already produced were thrown
 * away at the parse and every caller got one undifferentiated slab. It now asks
 * for `verbose_json` and keeps them: a turn is a segment placed on the clock, and
 * a transcript with no timings can never become one.
 *
 * The segment times are SECONDS FROM THE START OF THE CLIP, not wall clock. Only
 * the caller knows what instant its clip began at, so nothing here is converted
 * to epoch time — that mapping belongs to whoever built the clip.
 *
 * Tolerant on the wire, strict in the type: whisper.cpp has shipped segment
 * bounds as numbers, as numeric strings and as "HH:MM:SS.mmm" (and with a comma
 * for the decimal). All are read; a segment whose bounds cannot be read at all is
 * dropped on its own rather than failing the transcript, and `text` is unchanged
 * either way. An older server that ignores verbose_json and answers plain json
 * still works — it returns no segments, so `segments` is empty and the transcript
 * is exactly what it always was.
 *
 * Env vars:
 *   - WHISPER_BASE_URL  e.g. https://whisper.llmvinayminihome.uk
 *
 * Same shape as TranscribeResult from ./transcribe so the comparison
 * orchestrator can treat both engines uniformly.
 */

/**
 * One segment of the transcript, in SECONDS FROM THE START OF THE CLIP that was sent.
 * Never wall-clock: the caller owns that mapping because only the caller knows the clip's
 * true start.
 */
// One declaration, in a module nothing needs to mock — see lib/whisper-constants.ts.
import { EMPTY_TRANSCRIPT } from "@/lib/whisper-constants";
import {
  dropWhisperNonSpeech,
  WHISPER_AVG_LOGPROB_MAX,
  WHISPER_GATE_BASIS,
  WHISPER_NO_SPEECH_MIN,
  whisperNoSpeechDropEnabled,
} from "@/lib/stt/speech-gate";
export { EMPTY_TRANSCRIPT };
import { endpointsFor, runPool, type Verdict } from "@/lib/service-pool";

export type WhisperSegment = {
  start_s: number;
  end_s: number;
  text: string;
  /** whisper.cpp's own no-speech probability, when it sends one. Judged by the speech gate. */
  no_speech_prob?: number;
  /** whisper.cpp's mean token log-probability for the segment, when it sends one. */
  avg_logprob?: number;
};

export type WhisperResult =
  | {
      ok: true;
      transcript: string;
      language?: string;
      duration_seconds?: number;
      latency_ms: number;
      /** Always present, possibly empty — a server that sent none is not an error. */
      segments: WhisperSegment[];
      /** How many segments the speech gate dropped as decoded-from-silence (A-ETA-3). */
      no_speech_dropped?: number;
      /**
       * Build 3 (PRD §5 amendment) — the model whisper.cpp REPORTED, when it reports one.
       *
       * Read defensively off the response body and never defaulted to the model named in this
       * file's header comment: the header says `ggml-large-v3-turbo` because that is what the
       * Mini was loaded with in June, and a comment is not evidence about what answered today.
       * Most whisper.cpp builds send no model field at all, so this is usually null — which is
       * the honest answer and keeps `receipt_complete` false rather than asserting a version
       * nobody confirmed.
       */
      engineVersion?: string | null;
      /**
       * How many attempts this answer took (1 or 2). Build 1 §C.3 — a call that only succeeded
       * on the retry is a healthy answer from an unhealthy link, and a latency trend that cannot
       * tell the two apart will read a flapping tunnel as a fast server.
       */
      attempts?: number;
      /** Present whenever a retry happened: what attempt 1's failure actually was. */
      first_error?: string;
      /** REDUNDANCY-R1 — the origin that answered; present only when a whisper pool is configured. */
      served_by?: string;
    }
  | { ok: false; error: string; latency_ms: number; attempts?: number; first_error?: string; served_by?: string };

const TIMESTAMP_RE = /^(\d{1,2}):([0-5]?\d):([0-5]?\d)(?:[.,](\d{1,3}))?$/;

/**
 * Seconds out of whatever the server sent: a number, a numeric string, or "HH:MM:SS[.,]mmm".
 * Null when it is none of those — the segment is then dropped, not guessed at.
 */
export function parseSegmentSeconds(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return null;
  const m = TIMESTAMP_RE.exec(s);
  if (m) {
    const ms = Number((m[4] ?? "0").padEnd(3, "0"));
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * PURE — the raw `segments` field → the segments that survive. A segment survives when both
 * bounds read as seconds and the interval is not negative; its text is trimmed but NOT judged,
 * because "is this blank" is the caller's window rule, not the transcriber's.
 */
export function parseWhisperSegments(raw: unknown): WhisperSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: WhisperSegment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const start = parseSegmentSeconds(o.start);
    const end = parseSegmentSeconds(o.end);
    if (start === null || end === null || end < start) continue;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const nsp = typeof o.no_speech_prob === "number" && Number.isFinite(o.no_speech_prob) ? o.no_speech_prob : undefined;
    const lp = typeof o.avg_logprob === "number" && Number.isFinite(o.avg_logprob) ? o.avg_logprob : undefined;
    out.push({
      start_s: start, end_s: end, text,
      ...(nsp === undefined ? {} : { no_speech_prob: nsp }),
      ...(lp === undefined ? {} : { avg_logprob: lp }),
    });
  }
  return out;
}

/**
 * The pause between the two attempts (Build 1 §C.3). One retry, one backoff, no ladder.
 */
export const WHISPER_RETRY_BACKOFF_MS = 2_000;

/**
 * PURE — is this failure worth a second attempt?
 *
 * WHAT IS RETRIED: transport failures. A network error or an HTTP 5xx is the Cloudflare tunnel
 * or the Mini blinking, and grounding §A5 recorded the cost of not retrying them — "a single
 * transient tunnel blip burns one of three job attempts", and three burnt attempts park a window
 * that was never actually unreadable.
 *
 * WHAT IS NOT, AND WHY IT MATTERS MORE THAN THE LIST OF WHAT IS:
 *
 *   TIMEOUTS. A timeout already spent its entire budget. The full room window is given 180 s, so
 *   retrying a timeout would make one call 362 s — past the 300 s ceiling of the function it runs
 *   inside. The retry would not fail; it would kill the whole request, and the window would end
 *   up parked by a fix meant to stop windows being parked. The intent in the grounding is a blip,
 *   and a blip is not a 180-second silence.
 *
 *   HTTP 4xx. The server understood and refused. Sending the identical body again gets the
 *   identical refusal, one backoff later.
 *
 *   empty_transcript. NOT A FAILURE OF THE CALL. The call succeeded and the model returned
 *   nothing, which on a quiet window is the true answer — and on THIS build it is the answer the
 *   whole silence measurement is looking for. Retrying it would spend a second inference to try
 *   to talk Whisper out of a correct result, and a second attempt that "succeeded" would report
 *   invented words on known-zero tape as though the first answer had been a fault.
 *
 *   whisper_base_url_missing. Configuration, not weather. It will be missing again in two
 *   seconds.
 */
/**
 * PURE — the model whisper.cpp reported, or null.
 *
 * VERBATIM FROM THE RESPONSE, with no fallback to anything we know or believe about the server.
 * whisper.cpp's `/inference` is not documented to return a model field and most builds do not,
 * so null is the expected answer; the moment a build starts reporting one, it flows through to
 * `transcription_run.engine_version_reported` with no further change.
 */
export function reportedWhisperModel(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as Record<string, unknown>;
  for (const k of ["model", "model_name"]) {
    const v = j[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function isRetryableWhisperError(error: string): boolean {
  if (error.startsWith('network:')) return true;
  const m = /^http_(\d{3})/.exec(error);
  if (m) return Number(m[1]) >= 500;
  return false;
}

/**
 * The Whisper call, WITH ONE RETRY (Build 1 §C.3).
 *
 * Attempt, and on a retryable transport failure wait `WHISPER_RETRY_BACKOFF_MS` and attempt once
 * more. Both failing is not a silent skip: the error is returned to the caller, and the room
 * drain turns it into the named `whisper_unavailable` step, which the operator report already
 * renders. There is no third attempt — the drain's own job machinery owns the retry ladder
 * above this (DRAIN_MAX_ATTEMPTS = 3), and nesting a second ladder inside it would multiply into
 * nine calls for one window.
 *
 * `latency_ms` on a retried call is the SECOND attempt's own latency, and `attempts` says how
 * many were made — so a latency figure is never the sum of a failure and a success, which would
 * make every recorded number a different quantity depending on whether the tunnel blipped.
 */
export async function transcribeWithWhisper(
  audio: Buffer | Uint8Array,
  contentType: string = 'audio/webm',
  opts: { language?: string; timeoutMs?: number } = {},
): Promise<WhisperResult> {
  const first = await whisperAttempt(audio, contentType, opts);
  if (first.ok) return { ...first, attempts: 1 };
  if (!isRetryableWhisperError(first.error)) return { ...first, attempts: 1 };

  await new Promise((r) => setTimeout(r, WHISPER_RETRY_BACKOFF_MS));

  const second = await whisperAttempt(audio, contentType, opts);
  // `first_error` is carried on BOTH outcomes. A call that only succeeded on the retry is the
  // most interesting case there is — the transcript is good and the link is not — and dropping
  // the blip on success would make a flapping tunnel invisible in exactly the runs that prove
  // it is flapping.
  return { ...second, attempts: 2, first_error: first.error };
}

/**
 * REDUNDANCY-R1 — which whisper answers mean "that endpoint is down, try the next": a transport failure,
 * a timeout, or a 5xx (exactly the class `isRetryableWhisperError` already retries, plus the timeout).
 * A 4xx or an empty transcript is the server's real answer and another endpoint would give the same one.
 */
export function whisperVerdict(r: WhisperResult): Verdict {
  if (r.ok) return "ok";
  return isRetryableWhisperError(r.error) || r.error.startsWith('timeout_') ? "failover" : "final";
}

/** One attempt, across the whisper pool (a single endpoint when no pool is configured). */
async function whisperAttempt(
  audio: Buffer | Uint8Array,
  contentType: string = 'audio/webm',
  opts: { language?: string; timeoutMs?: number } = {},
): Promise<WhisperResult> {
  const endpoints = endpointsFor('whisper');
  if (endpoints.length === 0) {
    return { ok: false, error: 'whisper_base_url_missing', latency_ms: 0 };
  }
  // R1: the whole pool gets the ONE timeout this attempt always had; a failover gets only what is left.
  const { value, served_by } = await runPool(
    'whisper', endpoints,
    (base, budgetMs) => whisperAttemptAt(base, audio, contentType, { ...opts, timeoutMs: budgetMs }),
    whisperVerdict,
    { budgetMs: opts.timeoutMs ?? 90_000 },
  );
  return served_by ? { ...value, served_by } : value;
}

async function whisperAttemptAt(
  base: string,
  audio: Buffer | Uint8Array,
  contentType: string = 'audio/webm',
  opts: { language?: string; timeoutMs?: number } = {},
): Promise<WhisperResult> {
  const url = `${base.replace(/\/+$/, '')}/inference`;

  // Construct multipart body. whisper.cpp's server expects a `file` field.
  const ext =
    contentType.includes('webm')
      ? 'webm'
      : contentType.includes('mp4')
        ? 'mp4'
        : contentType.includes('ogg')
          ? 'ogg'
          : contentType.includes('wav')
            ? 'wav'
            : 'webm';

  const form = new FormData();
  // Wrap Buffer as Blob so undici FormData treats it as a file
  const blob = new Blob([audio], { type: contentType });
  form.append('file', blob, `audio.${ext}`);
  // verbose_json, not json: `json` returns the text alone and the segment timings — which the
  // model has already computed — are lost at the wire, not at the parse.
  form.append('response_format', 'verbose_json');

  // ---- the pinned decoder (speech turns, slice A, K3 §5) ----------------------------------
  // Whisper is not a deterministic writer: two runs of the SAME clip returned 162 and 165
  // segments. That is why the write unit is now the window rather than the turn — but the churn
  // is still worth reducing, because every extra segment is an extra row and an extra key.
  //
  // Greedy, single candidate, zero temperature: no sampling, no beam tie-breaking, no fallback
  // to a hotter temperature on a low-confidence window. These three are what the endpoint
  // actually honours, verified against the live Mac Mini rather than assumed — posting a garbage
  // value to each returns HTTP 500 with `stoi: no conversion` / `stof: no conversion`, i.e. the
  // server really does parse them, which a silent 200 would not have proved.
  form.append('temperature', '0.0');
  form.append('beam_size', '1');
  form.append('best_of', '1');
  // No previous-text conditioning (A-ETA-1). With context on, one invented phrase is fed back as the
  // prompt for the next window, which is how a sticky loop propagates. The Mini's shim already
  // defaults this to 0 when absent; sending it here keeps it true on any path that is not the shim.
  // whisper.cpp's server parses it (`req.has_file("max_context")` → n_max_text_ctx).
  form.append('max_context', '0');
  //
  // THERE IS NO SEED. K3 §5 asked for a fixed seed; this endpoint has no such parameter. Posting
  // `seed` returns HTTP 200 and changes nothing — it is silently ignored, exactly as an invented
  // field name would be, which is how it was told apart from the three above. It is NOT sent
  // here, because a parameter that does nothing reads to the next maintainer as a guarantee that
  // is being kept. Flagged in the K3 report; the window-as-unit design does not depend on it.
  // Language: by default let whisper auto-detect (good for code-switching). BUT
  // whisper.cpp picks ONE language for the whole file from its first window, so a
  // code-mixed tail can poison detection and garble the entire transcript. When
  // the caller knows the dominant language (e.g. corroborated English), forcing it
  // avoids that drift. See enc_6tcns74jp7 (Poornima) — auto garbled, language=en clean.
  if (opts.language) form.append('language', opts.language);

  // 90s ceiling — short dictations should return in 1-5s; long ambient
  // recordings (60-180s) might need more. Cap at 90s as a safety net.
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const tid = setTimeout(() => controller.abort(), timeoutMs);

  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        error: `http_${res.status}: ${body.slice(0, 200)}`,
        latency_ms,
      };
    }

    const json = (await res.json()) as {
      text?: string;
      language?: string;
      duration?: number;
      segments?: unknown;
      model?: unknown;
      model_name?: unknown;
    };

    const parsed = parseWhisperSegments(json.segments);
    // A-ETA-3 — the speech gate's Whisper rule (lib/stt/speech-gate.ts). Segments Whisper itself
    // says were decoded out of silence are dropped, and counted; their text never reaches a caller.
    // ETA_WHISPER_NOSPEECH_DROP=off restores the behaviour before the gate, byte for byte.
    const { kept: segments, dropped: no_speech_dropped } = whisperNoSpeechDropEnabled()
      ? dropWhisperNonSpeech(parsed)
      : { kept: parsed, dropped: 0 };
    if (no_speech_dropped > 0) {
      console.log(`[whisper] speech gate dropped ${no_speech_dropped} of ${parsed.length} segments ` +
        `(no_speech_prob>=${WHISPER_NO_SPEECH_MIN} and avg_logprob<${WHISPER_AVG_LOGPROB_MAX}, ${WHISPER_GATE_BASIS})`);
    }
    // The transcript is still the server's own `text` when it sent one and nothing was dropped. Only
    // when it did not — some builds answer verbose_json with segments and no top-level text — or when
    // the gate dropped a segment (the server's text still carries it) is it rebuilt from the kept
    // segments, so widening the request cannot narrow the answer and a dropped segment cannot return.
    const fromSegments = segments.map((s) => s.text).filter(Boolean).join(' ');
    const transcript = (no_speech_dropped > 0 ? fromSegments : ((json.text ?? '').trim() || fromSegments)).trim();
    if (!transcript) {
      return { ok: false, error: EMPTY_TRANSCRIPT, latency_ms };
    }

    return {
      ok: true,
      transcript,
      language: json.language,
      duration_seconds: json.duration,
      latency_ms,
      segments,
      no_speech_dropped,
      engineVersion: reportedWhisperModel(json),
    };
  } catch (e: unknown) {
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;
    if (controller.signal.aborted) {
      return { ok: false, error: `timeout_${timeoutMs}ms`, latency_ms };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `network: ${msg}`, latency_ms };
  }
}
