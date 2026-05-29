/**
 * Sarvam AI speech-to-text bridge (multilingual testbed engine).
 *
 * Why: Deepgram (nova-3-medical) is English-only and returns nothing for
 * Kannada/most Indian languages; Whisper large-v3-turbo mistranslates and
 * romanizes Indian-language audio. Sarvam (Saaras v3) handles Indian
 * languages accurately for both transcription (original script) and
 * translation to English, and accepts the browser's webm/opus directly.
 *
 * Endpoints (REST, synchronous, <=30s audio):
 *   POST /speech-to-text            mode=transcribe  -> original-language text
 *   POST /speech-to-text-translate  mode=translate   -> English text
 * Auth: header `api-subscription-key`. Response: {request_id, transcript, language_code}.
 *
 * For audio >30s use the Batch API (see sarvamBatch* below).
 *
 * Env: SARVAM_API_KEY (required), SARVAM_STT_MODEL (default 'saaras:v3').
 */

const SARVAM_BASE = "https://api.sarvam.ai";
const MODEL = process.env.SARVAM_STT_MODEL || "saaras:v3";
const SYNC_TIMEOUT_MS = 60_000;

export type SarvamMode = "transcribe" | "translate";

export type SarvamResult =
  | { ok: true; transcript: string; languageCode: string | null; latencyMs: number }
  | { ok: false; error: string; latencyMs: number };

function extName(contentType: string): string {
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("mp4") || contentType.includes("m4a")) return "mp4";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  return "webm";
}

async function callSync(
  path: string,
  mode: SarvamMode,
  audio: Buffer | Uint8Array,
  contentType: string,
): Promise<SarvamResult> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) return { ok: false, error: "sarvam_api_key_missing", latencyMs: 0 };

  // Sarvam's MIME allow-list rejects parameterized types like
  // "audio/webm; codecs=opus" (what MediaRecorder blobs carry) — it only
  // accepts the BARE type "audio/webm". Strip any ;codecs=... parameter.
  const baseType = (contentType.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
  const form = new FormData();
  const blob = new Blob([audio], { type: baseType });
  form.append("file", blob, `audio.${extName(baseType)}`);
  form.append("model", MODEL);
  form.append("mode", mode);

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${SARVAM_BASE}${path}`, {
      method: "POST",
      headers: { "api-subscription-key": key },
      body: form,
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(tid);
    const latencyMs = Date.now() - t0;
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // Surface Sarvam's structured error code/message when present.
      let msg = `http_${res.status}`;
      try {
        const j = JSON.parse(text);
        msg = `http_${res.status}: ${j?.error?.code || ""} ${j?.error?.message || text.slice(0, 160)}`.trim();
      } catch { msg = `http_${res.status}: ${text.slice(0, 160)}`; }
      return { ok: false, error: msg, latencyMs };
    }
    const j = JSON.parse(text) as { transcript?: string; language_code?: string | null };
    const transcript = (j.transcript ?? "").trim();
    if (!transcript) return { ok: false, error: "empty_transcript", latencyMs };
    return { ok: true, transcript, languageCode: j.language_code ?? null, latencyMs };
  } catch (e: unknown) {
    clearTimeout(tid);
    const latencyMs = Date.now() - t0;
    if (controller.signal.aborted) return { ok: false, error: `timeout_${SYNC_TIMEOUT_MS}ms`, latencyMs };
    return { ok: false, error: `network: ${e instanceof Error ? e.message : String(e)}`, latencyMs };
  }
}

/** Transcribe audio in its original language (<=30s). Returns original-script text + detected language. */
export function sarvamTranscribe(audio: Buffer | Uint8Array, contentType = "audio/webm"): Promise<SarvamResult> {
  return callSync("/speech-to-text", "transcribe", audio, contentType);
}

/** Translate audio to English (<=30s). Auto-detects source language. */
export function sarvamTranslate(audio: Buffer | Uint8Array, contentType = "audio/webm"): Promise<SarvamResult> {
  return callSync("/speech-to-text-translate", "translate", audio, contentType);
}

/** A BCP-47 code is non-English if present and not en-*. NULL/unknown => treat as English. */
export function isNonEnglish(languageCode: string | null | undefined): boolean {
  if (!languageCode) return false;
  const c = languageCode.toLowerCase();
  if (c === "unknown") return false;
  return !c.startsWith("en");
}
