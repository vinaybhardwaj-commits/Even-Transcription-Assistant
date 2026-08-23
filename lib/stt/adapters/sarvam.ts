import { sarvamTranslate, sarvamTranscribe, sarvamBatchTranslate, sarvamBatchTranscribe } from "@/lib/sarvam";
import type { SttAdapter } from "../types";

/**
 * Sarvam Saaras / Saarika.
 *
 * TWO PRODUCTS, NOT ONE (K4b C4). `/speech-to-text-translate` returns ENGLISH whatever went in;
 * `/speech-to-text` returns the source language. Until K4b this adapter only ever called the
 * translate family and then reported the result as BOTH `original` and `english` — so a Hindi
 * consultation was stored with English sitting in the original-language field, and nothing
 * downstream could tell. `mode` is what picks between them, and it defaults to the old
 * behaviour so the encounter fan-out and the note path are untouched.
 */
export const sarvamAdapter: SttAdapter = {
  key: "sarvam",
  capabilities: { tiers: ["asr"], stages: ["live", "note", "room"], languages: ["indic", "multi"], streaming: true, translates: true, async: false },
  async transcribe(audio, opts) {
    const transcribeMode = opts.mode === "transcribe";
    // Long-form (fan-out / note / room window): Sarvam SYNC caps at 30s, so use the batch job
    // API for anything not known-short. Live/short path uses the sync endpoint.
    if (opts.longForm) {
      // C3 — the forced language is passed only when the caller supplies one. Sarvam has
      // mislabelled accented English and then transliterated it into the wrong script; when the
      // caller already holds Whisper's language id, Sarvam must not be left to re-decide.
      const bopts = { maxWaitMs: 150_000, ...(opts.language ? { languageCode: opts.language } : {}) };
      const r = transcribeMode
        ? await sarvamBatchTranscribe(audio, opts.contentType, bopts)
        : await sarvamBatchTranslate(audio, opts.contentType, bopts);
      if (r.ok) {
        // Only the translate family produces English. Claiming an English transcript from the
        // transcribe family would be the exact conflation this build exists to undo.
        return { original: r.transcript, english: transcribeMode ? null : r.transcript, language: r.languageCode, latencyMs: r.latencyMs, costUsd: null, error: null };
      }
      return { original: null, english: null, language: null, latencyMs: r.latencyMs, costUsd: null, error: r.error };
    }
    const r = transcribeMode
      ? await sarvamTranscribe(audio, opts.contentType)
      : await sarvamTranslate(audio, opts.contentType);
    if (r.ok) return { original: r.transcript, english: transcribeMode ? null : r.transcript, language: r.languageCode, latencyMs: r.latencyMs, costUsd: null, error: null };
    return { original: null, english: null, language: null, latencyMs: r.latencyMs, costUsd: null, error: r.error };
  },
  async health() {
    const key = process.env.SARVAM_API_KEY;
    if (!key) return { ok: false, latencyMs: 0, error: "sarvam_key_missing" };
    const t0 = Date.now();
    try {
      await fetch("https://api.sarvam.ai/", { method: "GET", signal: AbortSignal.timeout(8000) });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 120) }; }
  },
};
