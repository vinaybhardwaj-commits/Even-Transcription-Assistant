import { transcribeAudio } from "@/lib/transcribe";
import type { SttAdapter } from "../types";

export const deepgramAdapter: SttAdapter = {
  key: "deepgram",
  capabilities: { tiers: ["asr"], stages: ["live", "note"], languages: ["english"], streaming: true, translates: false, async: false },
  async transcribe(audio, opts) {
    const r = await transcribeAudio(audio, opts.contentType);
    if (r.ok) return { original: r.transcript, english: r.transcript, language: "en", latencyMs: r.latency_ms, costUsd: null, error: null };
    return { original: null, english: null, language: null, latencyMs: 0, costUsd: null, error: r.error };
  },
  async health() {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) return { ok: false, latencyMs: 0, error: "deepgram_key_missing" };
    const t0 = Date.now();
    try {
      const r = await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(8000) });
      return { ok: r.ok, latencyMs: Date.now() - t0, error: r.ok ? undefined : `http_${r.status}` };
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 120) }; }
  },
};
