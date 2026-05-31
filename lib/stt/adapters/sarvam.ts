import { sarvamTranslate, sarvamBatchTranslate } from "@/lib/sarvam";
import type { SttAdapter } from "../types";

export const sarvamAdapter: SttAdapter = {
  key: "sarvam",
  capabilities: { tiers: ["asr"], stages: ["live", "note"], languages: ["indic", "multi"], streaming: true, translates: true, async: false },
  async transcribe(audio, opts) {
    // Long-form (fan-out / note): Sarvam SYNC caps at 30s, so use the batch job
    // API for anything not known-short. Live/short path uses the sync endpoint.
    if (opts.longForm) {
      const r = await sarvamBatchTranslate(audio, opts.contentType, { maxWaitMs: 150_000 });
      if (r.ok) return { original: r.transcript, english: r.transcript, language: r.languageCode, latencyMs: r.latencyMs, costUsd: null, error: null };
      return { original: null, english: null, language: null, latencyMs: r.latencyMs, costUsd: null, error: r.error };
    }
    const r = await sarvamTranslate(audio, opts.contentType);
    if (r.ok) return { original: r.transcript, english: r.transcript, language: r.languageCode, latencyMs: r.latencyMs, costUsd: null, error: null };
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
