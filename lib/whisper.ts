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
export type WhisperSegment = {
  start_s: number;
  end_s: number;
  text: string;
  /** whisper.cpp's own no-speech probability, when it sends one. Reported, never acted on here. */
  no_speech_prob?: number;
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
    }
  | { ok: false; error: string; latency_ms: number };

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
    out.push({ start_s: start, end_s: end, text, ...(nsp === undefined ? {} : { no_speech_prob: nsp }) });
  }
  return out;
}

export async function transcribeWithWhisper(
  audio: Buffer | Uint8Array,
  contentType: string = 'audio/webm',
  opts: { language?: string; timeoutMs?: number } = {},
): Promise<WhisperResult> {
  const base = process.env.WHISPER_BASE_URL;
  if (!base) {
    return { ok: false, error: 'whisper_base_url_missing', latency_ms: 0 };
  }

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
    };

    const segments = parseWhisperSegments(json.segments);
    // The transcript is still the server's own `text` when it sent one. Only when it did not —
    // some builds answer verbose_json with segments and no top-level text — is it rebuilt from
    // the segments, so widening the request cannot narrow the answer.
    const transcript = ((json.text ?? '').trim() || segments.map((s) => s.text).filter(Boolean).join(' ')).trim();
    if (!transcript) {
      return { ok: false, error: 'empty_transcript', latency_ms };
    }

    return {
      ok: true,
      transcript,
      language: json.language,
      duration_seconds: json.duration,
      latency_ms,
      segments,
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
