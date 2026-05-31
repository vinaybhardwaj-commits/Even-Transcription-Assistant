import type { SttAdapter } from "../types";

/** ElevenLabs Scribe v2 — POST /v1/speech-to-text (multipart model_id+file, xi-api-key).
 *  Transcribes (does not translate): `text` is in the source language. */
export const elevenlabsAdapter: SttAdapter = {
  key: "elevenlabs",
  capabilities: { tiers: ["asr"], stages: ["live", "note"], languages: ["multi"], streaming: true, translates: false, async: false },
  async transcribe(audio, opts) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return { original: null, english: null, language: null, latencyMs: 0, costUsd: null, error: "elevenlabs_key_missing" };
    const model = process.env.ELEVENLABS_STT_MODEL || "scribe_v2";
    const baseType = (opts.contentType.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
    const ext = baseType.includes("webm") ? "webm" : baseType.includes("mp4") ? "mp4" : baseType.includes("wav") ? "wav" : baseType.includes("ogg") ? "ogg" : "webm";
    const form = new FormData();
    form.append("model_id", model);
    form.append("file", new Blob([audio], { type: baseType }), `audio.${ext}`);
    const t0 = Date.now();
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form, signal: ctrl.signal, cache: "no-store" });
      clearTimeout(tid);
      const body = await res.text().catch(() => "");
      if (!res.ok) return { original: null, english: null, language: null, latencyMs: Date.now() - t0, costUsd: null, error: `http_${res.status}: ${body.slice(0, 140)}` };
      const j = JSON.parse(body) as { text?: string; language_code?: string };
      const tr = (j.text ?? "").trim();
      const lang = j.language_code ?? null;
      const isEn = !!lang && lang.toLowerCase().startsWith("en");
      return { original: tr || null, english: isEn ? (tr || null) : null, language: lang, latencyMs: Date.now() - t0, costUsd: null, error: tr ? null : "empty_transcript" };
    } catch (e) {
      clearTimeout(tid);
      return { original: null, english: null, language: null, latencyMs: Date.now() - t0, costUsd: null, error: ctrl.signal.aborted ? "timeout" : `network: ${String(e).slice(0, 120)}` };
    }
  },
  async health() {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return { ok: false, latencyMs: 0, error: "elevenlabs_key_missing" };
    const t0 = Date.now();
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/models", { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(8000) });
      const ok = r.status < 500; // 200 ok; 401 = key-scoped but reachable
      return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : `http_${r.status}` };
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 120) }; }
  },
};
