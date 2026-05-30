/**
 * Diarize bridge — server-side client for the Mac Mini pyannote diarization
 * service (v2.1). At submit, /process POSTs the canonical recording and gets
 * back speaker clusters, role labels, overlap windows, and speech-time
 * aggregates (PRD §20.3.2 contract).
 *
 * Non-critical: diarization never blocks an encounter. Callers soft-fail.
 *
 * Env: DIARIZE_BASE_URL (e.g. https://diarize.llmvinayminihome.uk),
 *      DIARIZE_TIMEOUT_MS (default 90000).
 */

const DIARIZE_BASE = process.env.DIARIZE_BASE_URL;
const TIMEOUT_MS = Number(process.env.DIARIZE_TIMEOUT_MS || 90_000);

export type DiarizeSpeaker = {
  idx: number;
  label: string;
  type: string; // clinician|patient|attender|nurse|other (forward-compatible)
  total_speech_sec?: number;
  first_heard_at_sec?: number;
  manually_relabeled?: boolean;
  source?: string;
  clinician_id?: string;
  confidence?: number;
};
export type DiarizeResult = {
  speakers: DiarizeSpeaker[];
  transcript_segments: unknown[];
  overlap_windows: unknown[];
  aggregates: unknown;
  latency_ms?: number;
  model_versions?: unknown;
};
export type DiarizeOutcome =
  | { ok: true; result: DiarizeResult; latencyMs: number }
  | { ok: false; error: string; latencyMs: number };

export async function runDiarize(
  audio: Buffer | Uint8Array,
  contentType: string,
  opts: {
    encounterId: string;
    clinicianCentroids?: unknown[];
    manualRelabels?: unknown[];
    batchThreshold?: number;
    signal?: AbortSignal;
  },
): Promise<DiarizeOutcome> {
  if (!DIARIZE_BASE) return { ok: false, error: "diarize_base_url_missing", latencyMs: 0 };
  const baseType = (contentType.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
  const ext = baseType.includes("webm") ? "webm" : baseType.includes("mp4") ? "mp4" : baseType.includes("wav") ? "wav" : "webm";

  const form = new FormData();
  form.append("audio", new Blob([audio], { type: baseType }), `audio.${ext}`);
  form.append("encounter_id", opts.encounterId);
  form.append("clinician_centroids", JSON.stringify(opts.clinicianCentroids ?? []));
  form.append("manual_relabels", JSON.stringify(opts.manualRelabels ?? []));
  if (typeof opts.batchThreshold === "number") form.append("batch_threshold", String(opts.batchThreshold));

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const t0 = Date.now();
  try {
    const res = await fetch(`${DIARIZE_BASE.replace(/\/+$/, "")}/diarize`, {
      method: "POST", body: form, signal: controller.signal, cache: "no-store",
    });
    clearTimeout(tid);
    const latencyMs = Date.now() - t0;
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, error: `http_${res.status}: ${text.slice(0, 180)}`, latencyMs };
    const j = JSON.parse(text) as Partial<DiarizeResult>;
    return {
      ok: true,
      latencyMs,
      result: {
        speakers: Array.isArray(j.speakers) ? (j.speakers as DiarizeSpeaker[]) : [],
        transcript_segments: Array.isArray(j.transcript_segments) ? j.transcript_segments : [],
        overlap_windows: Array.isArray(j.overlap_windows) ? j.overlap_windows : [],
        aggregates: j.aggregates ?? {},
        latency_ms: typeof j.latency_ms === "number" ? j.latency_ms : undefined,
        model_versions: j.model_versions,
      },
    };
  } catch (e: unknown) {
    clearTimeout(tid);
    const latencyMs = Date.now() - t0;
    if (controller.signal.aborted) return { ok: false, error: `timeout_${TIMEOUT_MS}ms`, latencyMs };
    return { ok: false, error: `network: ${e instanceof Error ? e.message : String(e)}`, latencyMs };
  }
}
