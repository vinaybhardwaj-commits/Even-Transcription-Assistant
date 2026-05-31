import { sarvamTranslate } from "@/lib/sarvam";
import type { SttAdapter } from "../types";

export const sarvamAdapter: SttAdapter = {
  key: "sarvam",
  capabilities: { tiers: ["asr"], stages: ["live", "note"], languages: ["indic", "multi"], streaming: true, translates: true, async: false },
  async transcribe(audio, opts) {
    // Sarvam translate yields English; it also returns the detected language.
    const r = await sarvamTranslate(audio, opts.contentType);
    if (r.ok) return { original: r.transcript, english: r.transcript, language: r.languageCode, latencyMs: r.latencyMs, costUsd: null, error: null };
    return { original: null, english: null, language: null, latencyMs: r.latencyMs, costUsd: null, error: r.error };
  },
  async health() {
    const key = process.env.SARVAM_API_KEY;
    if (!key) return { ok: false, latencyMs: 0, error: "sarvam_key_missing" };
    const t0 = Date.now();
    try {
      // Any HTTP response from the API host = reachable (no public ping endpoint).
      await fetch("https://api.sarvam.ai/", { method: "GET", signal: AbortSignal.timeout(8000) });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 120) }; }
  },
};
