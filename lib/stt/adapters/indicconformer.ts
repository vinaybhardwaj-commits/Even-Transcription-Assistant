import type { SttAdapter, SttTranscribeResult } from "../types";
import { endpointsFor, runPool, type Verdict } from "@/lib/service-pool";
import { withServiceAccess } from "@/lib/service-access";

/** AI4Bharat IndicConformer-600M — local Indic ASR on the Mac Mini (Pattern B,
 *  exposed at INDICCONFORMER_BASE_URL, default https://indic.llmvinayminihome.uk).
 *
 *  Indic-only by design: it needs an EXPLICIT IN-22 language (no auto-detect,
 *  defaults to hi) and does NOT code-switch, so it is the submit-time fallback
 *  for genuinely Indic-dominant audio — NOT a live or English engine. It emits
 *  native script (no translation). See docs/IndicConformer handoff.
 */
export const INDICCONFORMER_DEFAULT_URL = "https://indic.llmvinayminihome.uk";
const BASE = () => (process.env.INDICCONFORMER_BASE_URL || INDICCONFORMER_DEFAULT_URL).replace(/\/+$/, "");
const INFERENCE_TIMEOUT_MS = 120_000;

/**
 * STT-STACK-PARITY — the pool fails over only when an endpoint could not be reached or answered 5xx. Its own
 * timeout is NOT failover: the model may still be decoding, and a second endpoint would decode it again.
 */
type Attempt = { value: SttTranscribeResult; down: boolean };
const attemptVerdict = (a: Attempt): Verdict => (a.down ? "failover" : "final");
const DECODING = process.env.INDICCONFORMER_DECODING || "rnnt"; // rnnt (accurate) | ctc (fast)

// IN-22 codes the model accepts. English is handled by Whisper/Deepgram, not here.
const IN22 = new Set(["as","bn","brx","doi","gu","hi","kn","kok","ks","mai","ml","mni","mr","ne","or","pa","sa","sat","sd","ta","te","ur"]);

function toIndic(lang?: string | null): string | null {
  if (!lang) return null;
  const code = lang.toLowerCase().split(/[-_]/)[0];
  return IN22.has(code) ? code : null;
}

export const indicconformerAdapter: SttAdapter = {
  key: "indicconformer",
  // Submit-time ('note' stage) only; Indic; not streaming; transcript not translation.
  capabilities: { tiers: ["asr"], stages: ["note"], languages: ["indic"], streaming: false, translates: false, async: false },

  async transcribe(audio, opts): Promise<SttTranscribeResult> {
    const lang = toIndic(opts.language);
    // Indic-only: skip English/Latin/unknown so it never competes on the 93%
    // English slice (the leaderboard filters error IS NULL, so this is inert).
    if (!lang) return { original: null, english: null, language: null, latencyMs: 0, costUsd: 0, error: "skipped_non_indic" };

    const baseType = (opts.contentType.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
    const ext = baseType.includes("webm") ? "webm" : baseType.includes("mp4") ? "mp4" : baseType.includes("wav") ? "wav" : baseType.includes("ogg") ? "ogg" : "webm";
    // served_by reaches the job through the pool context (lib/jobs/runner.ts); the result keeps its shape.
    const { value } = await runPool(
      "indic", endpointsFor("indic", { fallback: INDICCONFORMER_DEFAULT_URL }),
      (base, budgetMs) => inferenceAt(base, audio, baseType, ext, lang, budgetMs),
      attemptVerdict,
      { budgetMs: INFERENCE_TIMEOUT_MS },
    );
    return value.value;
  },

  async health() {
    const t0 = Date.now();
    try {
      const healthUrl = `${BASE()}/healthz`;
      const r = await fetch(healthUrl, withServiceAccess(healthUrl, { signal: AbortSignal.timeout(8000) }));
      const ok = r.status < 500;
      return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : `http_${r.status}` };
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 120) }; }
  },
};

async function inferenceAt(base: string, audio: Buffer, baseType: string, ext: string, lang: string, timeoutMs: number): Promise<Attempt> {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: baseType }), `clip.${ext}`);
  form.append("language", lang);
  form.append("decoding", DECODING);
  const t0 = Date.now();
  try {
    const url = `${base.replace(/\/+$/, "")}/inference`;
    const res = await fetch(url, withServiceAccess(url, { method: "POST", body: form, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) }));
    const body = await res.text().catch(() => "");
    if (!res.ok) return { value: { original: null, english: null, language: lang, latencyMs: Date.now() - t0, costUsd: 0, error: `http_${res.status}: ${body.slice(0, 140)}` }, down: res.status >= 500 };
    const j = JSON.parse(body) as { text?: string; language?: string };
    const tr = (j.text ?? "").trim();
    // Local model on owned hardware → no per-call cost.
    return { value: { original: tr || null, english: null, language: j.language ?? lang, latencyMs: Date.now() - t0, costUsd: 0, error: tr ? null : "empty_transcript" }, down: false };
  } catch (e) {
    const name = (e as Error)?.name;
    return { value: { original: null, english: null, language: lang, latencyMs: Date.now() - t0, costUsd: 0, error: String(e).slice(0, 140) }, down: name !== "TimeoutError" && name !== "AbortError" && name !== "SyntaxError" };
  }
}
