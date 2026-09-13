import { transcribeWithWhisper } from "@/lib/whisper";
import type { SttAdapter } from "../types";

export const whisperAdapter: SttAdapter = {
  key: "whisper",
  capabilities: { tiers: ["asr"], stages: ["live", "note"], languages: ["multi"], streaming: false, translates: false, async: false },
  async transcribe(audio, opts) {
    const r = await transcribeWithWhisper(audio, opts.contentType);
    if (r.ok) return { original: r.transcript, english: null, language: r.language ?? null, latencyMs: r.latency_ms, costUsd: 0, error: null };
    return { original: null, english: null, language: null, latencyMs: r.latency_ms, costUsd: 0, error: r.error };
  },
  async health() {
    const base = process.env.WHISPER_BASE_URL;
    if (!base) return { ok: false, latencyMs: 0, error: "whisper_base_url_missing" };
    const t0 = Date.now();
    try {
      const r = await fetch(`${base.replace(/\/+$/, "")}/inference`, { method: "GET", signal: AbortSignal.timeout(8000) });
      const ok = r.status < 500 || r.status === 501;
      return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : `http_${r.status}` };
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 120) }; }
  },
};
