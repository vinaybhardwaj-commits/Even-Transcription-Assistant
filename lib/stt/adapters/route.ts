/**
 * lib/stt/adapters/route.ts — Slice C1 step 2. The per-segment language router as an STT engine.
 *
 * WHY THIS ENGINE EXISTS AT ALL. Every room window today is transcribed by an English-only model
 * (whisper large-v3-turbo) and a single-language batch engine, on consultations that are spoken in
 * Kannada, Hindi and English, frequently inside one sentence. That is wrong by construction, not by
 * measurement — which matters, because there is no Indic gold corpus to measure against (stt_gold:
 * 3 rows, 0 Indic) and none can be built by writing code. The router segments on speech boundaries,
 * picks a language per span from the candidate set, and sends each span to the engine that handles
 * it, so a code-mixed window stops being forced through one model's single guess.
 *
 * ─── TRANSPORT IS DECIDED BY DURATION, AND THIS FILE OWNS ONLY THE SHORT HALF ──────────────────
 * <= ROUTE_SYNC_MAX_MS  -> `POST /route`, multipart, answered inline. That is this adapter.
 * >  ROUTE_SYNC_MAX_MS  -> `POST /route/job` with a presigned URL, then poll. That is a JOB KIND
 *                          (lib/jobs/kinds/route-transcribe.ts), NOT this function.
 *
 * The split is not stylistic. The router runs at roughly 1.3x realtime with translation off, so a
 * long clip outlasts any single request budget this system has; the job kind exists so the polling
 * spans claims instead of blocking one. `transcribe()` therefore REFUSES audio it knows is too long
 * rather than starting a call it cannot finish — a named refusal on the row beats a timeout, and
 * silently blocking for minutes is how one slow engine takes a whole drain with it.
 *
 * It refuses only when the caller TELLS it the duration. `durationMs` is optional and byte length
 * is not a duration for a compressed container, so a caller that does not know gets the sync call
 * it asked for, bounded by the client's own timeout.
 *
 * ─── BRANCH ON `ok`, NEVER ON STATUS ───────────────────────────────────────────────────────────
 * A sibling service on the same Mini (`/enroll`) answers HTTP 200 with `ok:false`, and our own
 * health probe shipped for months asserting "something answered" because it read a status. Every
 * decision below reads the parsed `ok` field.
 */
import { routeTranscribe, submitRouteJob, pollRouteJob, ROUTER_JOB_ON, type RouterResult } from "../eta-router";
import type { SttAdapter, SttTranscribeResult, RouterSegmentation } from "../types";
import { isRouterSegmentation } from "../types";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WHISPER_PROBE_FIXTURE } from "@/lib/health/whisper-probe";
import { withServiceAccess } from "@/lib/service-access";

/**
 * The ceiling for the synchronous transport, from the Slice C spec. Above this the router's own
 * windowing (180 s outer, Silero VAD inner) is doing real work and the answer takes longer than a
 * request may live.
 */
export const ROUTE_SYNC_MAX_MS = 30_000;

/**
 * Returned when the caller states a duration this transport cannot serve.
 *
 * IT IS A REFUSAL, AND IT MUST STAY ONE. There is no fallback behind it — not a truncated call,
 * not a best-effort attempt at the first thirty seconds, not a null result that a caller could
 * read as "nothing was said". A silent fallback here would produce a partial transcript of a
 * consultation that reads exactly like a complete one, which is the worst failure this system has.
 *
 * ─── C2 WILL REMOVE THE NEED FOR THIS ──────────────────────────────────────────────────────────
 * The real problem is that `SttAdapter` cannot express submit-and-poll: it is
 * `transcribe(Buffer) => result`, so an engine whose long form is asynchronous has nowhere to put
 * that, and the room job calls the router's client directly while using this adapter only for its
 * DECLARED CAPABILITY (`capabilities.async`). Extending the interface is the FIRST task of Slice
 * C2, before diarize and emotion exist to work around it. Until then this constant is the seam,
 * and it is deliberately loud. Do not widen the ceiling here to make a caller's life easier.
 */
export const ROUTE_TOO_LONG_FOR_SYNC = "route_sync_limit_exceeded";

export const ROUTE_ADAPTER_KEY = "route";

/** Env first, literal behind it — the indicconformer.ts:11 idiom, shared with lib/stt/eta-router.ts. */
const ROUTER_BASE = () => (process.env.ETA_ROUTER_URL || "https://route.llmvinayminihome.uk").replace(/\/+$/, "");

/**
 * PURE. The router's answer, in the flat shape `SttAdapter` speaks, plus the timeline.
 *
 * `engineVersion` stays NULL deliberately. The router reports `engine_versions` as a MAP — whisper,
 * indicconformer and sravaani each with their own string — because several engines may have run
 * inside one window. Picking one of them would caption the run with an engine that transcribed part
 * of it, which is the typed-provider-label failure this codebase has already shipped twice. The map
 * rides in the timeline's metadata instead, where it stays a map.
 */
export function toSttResult(r: RouterResult, latencyMs: number): SttTranscribeResult {
  if (!r.ok) {
    return {
      original: null, english: null, language: null,
      latencyMs, costUsd: 0, engineVersion: null, languageTimeline: null,
      error: r.error ? String(r.error).slice(0, 200) : "route_failed",
    };
  }
  const native = typeof r.transcript_native === "string" ? r.transcript_native : null;
  const english = typeof r.transcript_english === "string" ? r.transcript_english : null;
  // The router puts `outcome` INSIDE `segmentation`, never beside it (router_server.py's
  // window_outcome()/job_verdict()). `r.segmentation` is typed `unknown` on RouterResult, so it is
  // narrowed with a real type guard here — never cast past into a top-level key the reply never
  // carries, which is the bug that left every stored route_outcome's `outcome` null.
  const segmentation: RouterSegmentation | undefined = isRouterSegmentation(r.segmentation) ? r.segmentation : undefined;
  return {
    original: native,
    english,
    language: r.dominant_language ?? null,
    latencyMs,
    // Local hardware on the Mini. Zero, not null: null means "unknown", and this one is known.
    costUsd: 0,
    engineVersion: null,
    languageTimeline: Array.isArray(r.language_timeline) ? r.language_timeline : null,
    // Carried VERBATIM and no further. This adapter does not decide what an outcome MEANS; it only
    // stops throwing away the sentence in which the router said it, which is what left the corpus
    // unable to tell "never heard" from "heard nothing".
    routerOutcome: {
      status: (r as Record<string, unknown>).status,
      segmentation,
      outcome: segmentation?.outcome,
    },
    error: null,
  };
}

export const routeAdapter: SttAdapter = {
  key: ROUTE_ADAPTER_KEY,
  /**
   * `stages` includes "room" — the stage it is being adopted for — unlike `sarvam`, which serves
   * the room stage today while declaring only ["live","note"]. That inconsistency is why
   * `resolveRouting` must NOT start enforcing capabilities: switching the check on would break the
   * current default the moment it landed. Logged as debt; this adapter simply declares the truth.
   */
  capabilities: {
    tiers: ["asr"],
    stages: ["room", "live", "note"],
    languages: ["multi"],
    streaming: false,
    // It returns transcript_english alongside the native text when asked.
    translates: true,
    // The long transport is a job. True here is a statement about the engine, not this function.
    async: true,
  },

  async transcribe(audio, opts) {
    const t0 = Date.now();
    const durationMs = typeof opts.durationMs === "number" && Number.isFinite(opts.durationMs) ? opts.durationMs : null;
    if (durationMs !== null && durationMs > ROUTE_SYNC_MAX_MS) {
      return {
        original: null, english: null, language: null,
        latencyMs: 0, costUsd: 0, engineVersion: null, languageTimeline: null,
        error: `${ROUTE_TOO_LONG_FOR_SYNC}: ${Math.round(durationMs / 1000)}s > ${ROUTE_SYNC_MAX_MS / 1000}s — use the route_transcribe job`,
      };
    }
    // `mode` is the room drain's vocabulary: 'transcribe' wants the source language back,
    // 'translate' wants English. The router produces both in one pass, so `translate` is asked for
    // only when English is actually wanted — an Ollama call per non-English span is not free.
    const r = await routeTranscribe(audio, opts.contentType, { translate: opts.mode === "translate" });
    return toSttResult(r, Date.now() - t0);
  },

  /**
   * Same shape as every other local-tunnel adapter (indicconformer.ts:11): env var first, literal
   * default behind it, so health() and transcribe() agree about where the router is without
   * anything having to be configured. C1 shipped this env-only, which left health() reporting
   * not-configured while transcribe() worked through the client's own default — an asymmetry
   * caused by a pre-commit hook, now retired, and not by any design intent.
   */
  /**
   * ─── THE ASYNC TRANSPORT, NOW BEHIND THE INTERFACE (C2 Part A) ───────────────────────────────
   * The router pulls its own audio, so this takes a URL and never bytes: `audio_url` is fetched
   * server-side (`requests.get`), which is why the caller presigns a short-lived, single-object
   * R2 link rather than uploading fifteen minutes over the tunnel twice.
   *
   * ONE SUBMIT PER REF, and the caller's job is to persist the ref before anything else can fail —
   * the router has no idempotency key, so a resubmit is a second job doing the same work and
   * billing the same minutes of the Mini.
   */
  async submit(input) {
    if (!ROUTER_JOB_ON()) return { ok: false, error: "router_job_disabled" };
    if (!input.audioUrl) return { ok: false, error: "route_submit_needs_audio_url" };
    const sub = await submitRouteJob(input.audioUrl, {
      translate: input.translate === true,
      ...(input.durationMs ? {} : {}),
    });
    // Branch on `ok`, never on transport.
    if (!sub.ok || !sub.job_id) return { ok: false, error: String(sub.error ?? "route_submit_failed").slice(0, 200) };
    return sub.endpoint ? { ok: true, jobRef: sub.job_id, endpoint: sub.endpoint } : { ok: true, jobRef: sub.job_id };
  },

  async poll(jobRef, opts) {
    const st = await pollRouteJob(jobRef, opts?.endpoint);
    // An expired or unknown job is TERMINAL: the router's job files live an hour, and polling a
    // ref that no longer exists can never start succeeding. Anything else is worth another claim.
    // A 404 for the id is the same fact whatever the body says (a restarted router that lost its job
    // file answers FastAPI's own 404), so the status decides, not the wording.
    if (!st.ok && (/unknown job/i.test(String(st.error ?? "")) || /^http_404\b/.test(String(st.error ?? "")))) {
      return { ok: false, error: "route_job_unknown", terminal: true };
    }
    if (st.state === "failed" || (st.ok === false && st.state === undefined)) {
      return { ok: false, error: String(st.error ?? "route_job_failed").slice(0, 200), terminal: st.state === "failed" };
    }
    if (st.state !== "done") {
      return {
        ok: true,
        state: st.state === "queued" ? "queued" : "running",
        progress: st.progress && typeof st.progress === "object"
          ? { done: Number(st.progress.done ?? 0), total: Number(st.progress.total ?? 0) }
          : null,
      };
    }
    return { ok: true, state: "done", result: toSttResult(st as RouterResult, typeof st.sec === "number" ? Math.round(st.sec * 1000) : 0) };
  },

  /**
   * ─── THE PROBE TRANSCRIBES ───────────────────────────────────────────────────────────────────
   * It used to GET `/health`. The router (FastAPI, eta-router 3.1) serves `/healthz`, `/route`,
   * `/route/job` and `/route/job/{id}` — `/health` is FastAPI's 404 — so production reported
   * `route_unhealthy_http_404` for a router that was transcribing. It could never have said true.
   *
   * Pointing it at `/healthz` would only prove the router process is up. This does what the
   * whisper probe does (lib/health/whisper-probe.ts): a real multipart POST of the same half-second
   * webm fixture to `POST /route`, exactly as routeTranscribe sends it, translation off, and a
   * parsed `ok: true` — the router's own verdict on its pipeline, never a status code.
   */
  async health() {
    const r = await probeRouteTranscription();
    return { ok: r.ok, latencyMs: r.elapsed_ms, ...(r.ok ? {} : { error: r.error }) };
  },
};

// ---------------------------------------------------------------------------
// The health probe
// ---------------------------------------------------------------------------

/** Warm, the router answers the half-second fixture in 4-5 s; a cold start or a busy Mini is slower. */
export const ROUTE_PROBE_BUDGET_MS = 12_000;
/** At most one probe transcription per minute per instance — the Mini is the thing being observed. */
export const ROUTE_PROBE_CACHE_MS = 60_000;

export type RouteProbeResult = { ok: boolean; elapsed_ms: number; error?: string; cached?: boolean };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

let LAST_PROBE: { at: number; result: RouteProbeResult } | null = null;
/** Test seam: module state must be resettable. */
export function __resetRouteProbeCache(): void { LAST_PROBE = null; }

/** Never throws. Every failure is named. */
export async function runRouteProbe(opts: { baseUrl?: string; fetchImpl?: Fetcher; readFixture?: () => Promise<Uint8Array>; budgetMs?: number } = {}): Promise<RouteProbeResult> {
  const t0 = Date.now();
  const base = (opts.baseUrl ?? ROUTER_BASE()).replace(/\/+$/, "");
  const budget = opts.budgetMs ?? ROUTE_PROBE_BUDGET_MS;
  const doFetch: Fetcher = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budget);
  try {
    const bytes = opts.readFixture ? await opts.readFixture() : new Uint8Array(await readFile(path.join(process.cwd(), WHISPER_PROBE_FIXTURE)));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/webm" }), "audio.webm");
    form.append("translate", "false");
    const probeUrl = `${base}/route`;
    const res = await doFetch(probeUrl, withServiceAccess(probeUrl, { method: "POST", body: form, signal: ac.signal, cache: "no-store" }));
    const body: unknown = await res.json().catch(() => null);
    const elapsed_ms = Date.now() - t0;
    // Parsed `ok` is the authority. A 404 from FastAPI parses too — as {"detail":"Not Found"}.
    if (body && typeof body === "object" && !Array.isArray(body) && (body as { ok?: unknown }).ok === true) {
      return { ok: true, elapsed_ms };
    }
    if (ac.signal.aborted) return { ok: false, elapsed_ms, error: `route_probe_timeout_${budget}ms` };
    const why = body && typeof body === "object" && "error" in (body as object) ? String((body as { error?: unknown }).error).slice(0, 80) : null;
    return { ok: false, elapsed_ms, error: `route_probe_http_${res.status}${why ? `: ${why}` : ""}` };
  } catch (e) {
    const elapsed_ms = Date.now() - t0;
    if (ac.signal.aborted || (e as Error)?.name === "AbortError") return { ok: false, elapsed_ms, error: `route_probe_timeout_${budget}ms` };
    return { ok: false, elapsed_ms, error: `route_probe_transport: ${String((e as Error)?.message ?? e).slice(0, 100)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeRouteTranscription(opts: Parameters<typeof runRouteProbe>[0] & { now?: () => number } = {}): Promise<RouteProbeResult> {
  const now = opts.now ?? Date.now;
  if (LAST_PROBE && now() - LAST_PROBE.at < ROUTE_PROBE_CACHE_MS) return { ...LAST_PROBE.result, cached: true };
  const result = await runRouteProbe(opts);
  LAST_PROBE = { at: now(), result };
  return result;
}

