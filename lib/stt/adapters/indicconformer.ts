import type { SttAdapter, SttTranscribeResult } from "../types";

/** AI4Bharat IndicConformer-600M — local Indic ASR on the Mac Mini (Pattern B,
 *  exposed at INDICCONFORMER_BASE_URL, default https://indic.llmvinayminihome.uk).
 *
 *  Indic-only by design: it needs an EXPLICIT IN-22 language (no auto-detect,
 *  defaults to hi) and does NOT code-switch, so it is the submit-time fallback
 *  for genuinely Indic-dominant audio — NOT a live or English engine. It emits
 *  native script (no translation). See docs/IndicConformer handoff.
 */
const BASE = () => (process.env.INDICCONFORMER_BASE_URL || "https://indic.llmvinayminihome.uk").replace(/\/+$/, "");
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
    const form = new FormData();
    form.append("file", new Blob([audio], { type: baseType }), `clip.${ext}`);
    form.append("language", lang);
    form.append("decoding", DECODING);
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE()}/inference`, { method: "POST", body: form, cache: "no-store", signal: AbortSignal.timeout(120_000) });
      const body = await res.text().catch(() => "");
      if (!res.ok) return { original: null, english: null, language: lang, latencyMs: Date.now() - t0, costUsd: 0, error: `http_${res.status}: ${body.slice(0, 140)}` };
      const j = JSON.parse(body) as { text?: string; language?: string };
      const tr = (j.text ?? "").trim();
      // Local model on owned hardware → no per-call cost.
      return { original: tr || null, english: null, language: j.language ?? lang, latencyMs: Date.now() - t0, costUsd: 0, error: tr ? null : "empty_transcript" };
    } catch (e) {
      return { original: null, english: null, language: lang, latencyMs: Date.now() - t0, costUsd: 0, error: String(e).slice(0, 140) };
    }
  },

  async health() {
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE()}/healthz`, { signal: AbortSignal.timeout(8000) });
      const ok = r.status < 500;
      return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : `http_${r.status}` };
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 120) }; }
  },
};
