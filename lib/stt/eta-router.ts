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
import { endpointsFor, runPool, type Verdict } from "@/lib/service-pool";

export const ROUTER_DEFAULT_URL = "https://route.llmvinayminihome.uk";
const ROUTER_TIMEOUT_MS = 285_000; // background step has a 300s budget; cap under it
const ROUTER_SUBMIT_TIMEOUT_MS = 30_000;
const ROUTER_POLL_TIMEOUT_MS = 20_000;

const trimBase = (base: string) => base.replace(/\/+$/, "");

/**
 * The router a job was submitted to when the row does not say: the single URL production has always used.
 * Every job submitted before STT-STACK-PARITY lives there, and so does every job submitted with no pool set.
 */
const routerSingleBase = () => process.env.ETA_ROUTER_URL || ROUTER_DEFAULT_URL;

/**
 * STT-STACK-PARITY — which router answers mean "that endpoint is down, try the next": it could not be
 * reached, or it answered 5xx. NOT its own timeout: a router that timed out may still be working on the
 * audio (the sync call) or may have accepted the job (the submit, which has no idempotency key), and
 * failing over would put the same work on a second router. The whole pool still gets ONE timeout (R1).
 */
type Attempt<T> = { value: T; down: boolean };
const attemptVerdict = <T>(a: Attempt<T>): Verdict => (a.down ? "failover" : "final");
const isAbort = (e: unknown) => (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError";

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
): Promise<RouterResult & { served_by?: string }> {
  const { value, served_by } = await runPool(
    "router", endpointsFor("router", { fallback: ROUTER_DEFAULT_URL }),
    (base, budgetMs) => routeTranscribeAt(base, audio, contentType, opts, budgetMs),
    attemptVerdict,
    { budgetMs: ROUTER_TIMEOUT_MS },
  );
  return served_by ? { ...value.value, served_by } : value.value;
}

async function routeTranscribeAt(
  base: string,
  audio: Buffer | Uint8Array,
  contentType: string,
  opts: { candidates?: string; translate?: boolean; langHint?: string },
  timeoutMs: number,
): Promise<Attempt<RouterResult>> {
  const url = trimBase(base) + "/route";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType }), "audio.webm");
  if (opts.candidates) form.append("candidates", opts.candidates);
  form.append("translate", String(opts.translate !== false));
  if (opts.langHint) form.append("language_hint", opts.langHint); // optional; router may ignore
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", body: form, signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { value: { ok: false, error: `http_${res.status}: ${t.slice(0, 140)}` }, down: res.status >= 500 };
    }
    const j = (await res.json()) as RouterResult;
    return { value: j, down: false };
  } catch (e) {
    return { value: { ok: false, error: e instanceof Error ? e.message : String(e) }, down: !isAbort(e) };
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
  /**
   * THE DRAIN'S TRANSPORT IS THIS ONE, and until 19 Sep these two fields did not exist on it.
   *
   * `/route` answered with `status` and `segmentation` from the start; `run_job` built its own
   * reply out of a fixed key set that had neither, so a starved ROOM window — which only ever
   * reaches the router through run_job — still stored as a clean empty success however well the
   * synchronous path reported itself. The router now aggregates both across a job's sub-windows
   * (`job_verdict`), and they are declared here so the poll path is typed rather than cast.
   */
  status?: string | null;
  segmentation?: unknown;
  sec?: number;
  error?: string;
};

/**
 * `endpoint` is the router that ACCEPTED the job, and every poll of it must go there: a job id means nothing
 * to any other router. It is returned only when a router pool is configured (STT-STACK-PARITY), so with no
 * pool the answer has exactly the shape it always had and the poll goes where it always went.
 */
export async function submitRouteJob(
  audioUrl: string,
  opts: { candidates?: string; translate?: boolean; windowS?: number; singleOnly?: boolean } = {},
): Promise<{ ok: boolean; job_id?: string; error?: string; endpoint?: string; served_by?: string }> {
  // `singleOnly` is for a caller that can persist the job id but NOT the endpoint (the encounter route keeps
  // only `encounter.router_job_id`): its later polls go to the single URL, so its submit must go there too.
  if (opts.singleOnly) return (await submitRouteJobAt(routerSingleBase(), audioUrl, opts, ROUTER_SUBMIT_TIMEOUT_MS)).value;
  const { value, base, served_by } = await runPool(
    "router", endpointsFor("router", { fallback: ROUTER_DEFAULT_URL }),
    (b, budgetMs) => submitRouteJobAt(b, audioUrl, opts, budgetMs),
    attemptVerdict,
    { budgetMs: ROUTER_SUBMIT_TIMEOUT_MS },
  );
  if (!served_by) return value.value;
  return value.value.ok ? { ...value.value, endpoint: base, served_by } : { ...value.value, served_by };
}

async function submitRouteJobAt(
  base: string,
  audioUrl: string,
  opts: { candidates?: string; translate?: boolean; windowS?: number },
  timeoutMs: number,
): Promise<Attempt<{ ok: boolean; job_id?: string; error?: string }>> {
  const url = trimBase(base) + "/route/job";
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
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
    if (!res.ok) { const t = await res.text().catch(() => ""); return { value: { ok: false, error: `http_${res.status}: ${t.slice(0, 140)}` }, down: res.status >= 500 }; }
    const j = (await res.json()) as { ok?: boolean; job_id?: string };
    if (!j.job_id) return { value: { ok: false, error: "no_job_id" }, down: false };
    return { value: { ok: true, job_id: j.job_id }, down: false };
  } catch (e) {
    return { value: { ok: false, error: e instanceof Error ? e.message : String(e) }, down: !isAbort(e) };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * NEVER POOLED. A poll goes to the router that holds the job — `endpoint` from the submit — or, when the row
 * carries none, to the single URL, which is where every such job was submitted. Failing a poll over to
 * another router would ask it about a job it never had and read its 404 as "the router lost it".
 */
export async function pollRouteJob(jobId: string, endpoint?: string | null): Promise<RouterJobStatus> {
  const url = trimBase(endpoint || routerSingleBase()) + "/route/job/" + encodeURIComponent(jobId);
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), ROUTER_POLL_TIMEOUT_MS);
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
