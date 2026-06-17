/**
 * eta-router client — the Mac-Mini per-segment language-routed transcription
 * service (route.llmvinayminihome.uk). For Indic / code-mixed encounters it
 * segments (silero-VAD), detects language per segment, routes each to the best
 * engine (whisper for English, IndicConformer for Indic), stitches, and returns
 * BOTH a native-script transcript and a qwen English translation + a per-segment
 * language timeline. Replaces the single-engine Sarvam batch-translate for Indic.
 *
 * Default ON (kill-switch: ETA_ROUTER=0). Soft-fail: callers fall back to Sarvam.
 */
const ROUTER_URL = process.env.ETA_ROUTER_URL || "https://route.llmvinayminihome.uk";
const ROUTER_TIMEOUT_MS = 285_000; // background step has a 300s budget; cap under it

export const ETA_ROUTER_ON = () => process.env.ETA_ROUTER !== "0";

export type RouterResult = {
  ok: boolean;
  dominant_language?: string | null;
  language_timeline?: unknown;
  transcript_native?: string;
  transcript_english?: string;
  segments?: unknown;
  segmentation?: unknown;
  engine_versions?: unknown;
  sec?: number;
  error?: string;
};

export async function routeTranscribe(
  audio: Buffer | Uint8Array,
  contentType: string = "audio/webm",
  opts: { candidates?: string; translate?: boolean; langHint?: string } = {},
): Promise<RouterResult> {
  const url = ROUTER_URL.replace(/\/+$/, "") + "/route";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType }), "audio.webm");
  if (opts.candidates) form.append("candidates", opts.candidates);
  form.append("translate", String(opts.translate !== false));
  if (opts.langHint) form.append("language_hint", opts.langHint); // optional; router may ignore
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", body: form, signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `http_${res.status}: ${t.slice(0, 140)}` };
    }
    const j = (await res.json()) as RouterResult;
    return j;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(tid);
  }
}

// --- Async CHUNKED job (long recordings) ---
// The Mini splits the audio into ~180s windows, runs the per-window pipeline,
// and exposes an async job (submit -> poll). The app sends an R2 presigned URL
// so there's no large multipart upload. Default ON once the endpoint exists;
// kill-switch ETA_ROUTER_JOB=0.
export const ROUTER_JOB_ON = () => process.env.ETA_ROUTER_JOB !== "0";

export type RouterJobStatus = {
  ok: boolean;
  state?: "queued" | "running" | "done" | "failed";
  progress?: { done?: number; total?: number };
  dominant_language?: string | null;
  language_timeline?: unknown;
  transcript_native?: string;
  transcript_english?: string;
  segments?: unknown;
  sec?: number;
  error?: string;
};

export async function submitRouteJob(
  audioUrl: string,
  opts: { candidates?: string; translate?: boolean; windowS?: number } = {},
): Promise<{ ok: boolean; job_id?: string; error?: string }> {
  const url = ROUTER_URL.replace(/\/+$/, "") + "/route/job";
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: audioUrl,
        candidates: opts.candidates ?? "en,kn,hi,ta,te,ml,mr,bn",
        translate: opts.translate !== false,
        window_s: opts.windowS ?? 180,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) { const t = await res.text().catch(() => ""); return { ok: false, error: `http_${res.status}: ${t.slice(0, 140)}` }; }
    const j = (await res.json()) as { ok?: boolean; job_id?: string };
    if (!j.job_id) return { ok: false, error: "no_job_id" };
    return { ok: true, job_id: j.job_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(tid);
  }
}

export async function pollRouteJob(jobId: string): Promise<RouterJobStatus> {
  const url = ROUTER_URL.replace(/\/+$/, "") + "/route/job/" + encodeURIComponent(jobId);
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) { const t = await res.text().catch(() => ""); return { ok: false, error: `http_${res.status}: ${t.slice(0, 120)}` }; }
    return (await res.json()) as RouterJobStatus;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(tid);
  }
}
