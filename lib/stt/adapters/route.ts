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
import { routeTranscribe, type RouterResult } from "../eta-router";
import type { SttAdapter, SttTranscribeResult } from "../types";

/**
 * The ceiling for the synchronous transport, from the Slice C spec. Above this the router's own
 * windowing (180 s outer, Silero VAD inner) is doing real work and the answer takes longer than a
 * request may live.
 */
export const ROUTE_SYNC_MAX_MS = 30_000;

/** Returned when the caller states a duration this transport cannot serve. Named, not a timeout. */
export const ROUTE_TOO_LONG_FOR_SYNC = "route_sync_limit_exceeded";

export const ROUTE_ADAPTER_KEY = "route";

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
  return {
    original: native,
    english,
    language: r.dominant_language ?? null,
    latencyMs,
    // Local hardware on the Mini. Zero, not null: null means "unknown", and this one is known.
    costUsd: 0,
    engineVersion: null,
    languageTimeline: Array.isArray(r.language_timeline) ? r.language_timeline : null,
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
   * ENV ONLY, WITH NO LITERAL FALLBACK — and that is a repo rule, not a preference. This repo is
   * public and a pre-commit hook refuses any staged file naming the unauthenticated tunnel host.
   * `lib/stt/eta-router.ts` carries that literal from before the rule and production depends on
   * it, so it is left exactly as it is; this file may not repeat it. The consequence is worth
   * stating plainly: until ETA_ROUTER_URL is set in the environment, `health()` reports
   * not-configured while `transcribe()` still works through the existing client's own default.
   * Flagged in the build report as the one manual step this slice needs.
   */
  async health() {
    const t0 = Date.now();
    const base = (process.env.ETA_ROUTER_URL ?? "").replace(/\/+$/, "");
    if (!base) return { ok: false, latencyMs: 0, error: "route_health_needs_eta_router_url" };
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
      // Parsed `ok` is the authority. A body that does not parse, or parses without an `ok`, is
      // not a healthy router — it is something answering on the router's port.
      const body: unknown = await res.json().catch(() => null);
      const ok = !!(body && typeof body === "object" && !Array.isArray(body) && (body as { ok?: unknown }).ok === true);
      return { ok, latencyMs: Date.now() - t0, ...(ok ? {} : { error: `route_unhealthy_http_${res.status}` }) };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 120) };
    }
  },
};
