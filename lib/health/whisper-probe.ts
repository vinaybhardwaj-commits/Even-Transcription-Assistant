/**
 * lib/health/whisper-probe.ts — hotfix defect 2.
 *
 * ─── WHAT THE OLD PROBE ACTUALLY ASSERTED ─────────────────────────────────────────────────────
 * `GET {WHISPER_BASE_URL}/inference`, passing unless the status was >= 500 and not 501. The Mini's
 * shim answers a static 404 to any GET that is not `/healthz` WITHOUT contacting whisper.cpp on
 * :8080 at all — so `whisper: true` meant "the tunnel is up and a Python process is answering".
 * It could not have failed if transcription were completely dead, which is what it exists to catch.
 *
 * ─── WHAT THIS ONE ASSERTS ────────────────────────────────────────────────────────────────────
 * A real multipart POST of a half-second WAV to `/inference`, as `transcribeWithWhisper` posts,
 * and a 200 whose body PARSES as JSON. It deliberately does NOT assert any transcript: a 0.5 s
 * tone may legitimately transcribe to nothing, and "did it hear words" is not a question a health
 * route can ask. What it proves is that the request reached whisper.cpp and came back decoded.
 *
 * ─── WHY THE FIXTURE IS HALF A SECOND ─────────────────────────────────────────────────────────
 * VAD alone costs roughly ten seconds on a thirty-second clip. A health route that blocks for that
 * long is a health route nobody runs. Half a second keeps the probe inside a budget the route can
 * afford and still exercises the whole path.
 *
 * ─── TIMEOUT IS A NAMED ANSWER, NOT A HANG ────────────────────────────────────────────────────
 * The budget is enforced with an AbortSignal, and a timeout is reported as `whisper_timeout` with
 * the elapsed and budget numbers — the shape lib/mcp/budgets.ts already uses. A probe that hangs
 * takes the whole health route with it, which is how one slow service makes every reading useless.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** Well inside the health route's own budget, and far above a healthy round trip. */
export const WHISPER_PROBE_BUDGET_MS = 12_000;

/**
 * WEBM, not WAV (Refuter flag 1). The job path posts `audio/webm` and the shim transcodes it with
 * ffmpeg before whisper.cpp sees a sample. A `.wav` probe skips that leg entirely, so a broken
 * ffmpeg would 415 every real transcription while health reported true — the same "passed because
 * something answered" failure this probe was written to end, one component further in.
 */
export const WHISPER_PROBE_FIXTURE = "fixtures/health-probe-0.5s-16k-mono.webm";

/**
 * Item 1 — ONE REAL INFERENCE PER MINUTE, AT MOST.
 *
 * whisper.cpp serialises inference, and the Mini is often mid-recording. A health route that ran a
 * fresh inference on every call would queue behind a live transcription window, add load to the
 * box it is meant to be observing, and then report the queue as a fault. The verdict is cached and
 * the payload carries `checked_at` and `age_s`, so the answer is never mistaken for fresher than
 * it is.
 */
export const WHISPER_PROBE_CACHE_MS = 60_000;

/**
 * How long a past SUCCESS stands as evidence that transcription works. Within this window a probe
 * that times out is reported as BUSY rather than broken — see `busy_recent_ok` below.
 */
export const WHISPER_RECENT_OK_MS = 10 * 60_000;

export type WhisperProbeResult = {
  ok: boolean;
  /** Named on every failure so an operator reads WHICH way it broke, not just `false`. */
  reason?:
    | "not_configured"
    | "whisper_timeout"
    /**
     * Item 1 — the probe did not finish inside its budget, but a real inference SUCCEEDED within
     * `WHISPER_RECENT_OK_MS`. whisper.cpp serialises, so a timeout while the Mini is transcribing a
     * clinic window is contention, not death — and we hold direct evidence it transcribes. Reported
     * `ok: true` with this reason and `last_ok_age_s`, because paging someone for a busy server is
     * how a health signal stops being read. Without that evidence a timeout stays `whisper_timeout`
     * and `ok: false`.
     */
    | "busy_recent_ok"
    | "bad_status"
    | "unparseable_body"
    | "transport";
  status?: number;
  elapsed_ms: number;
  budget_ms: number;
  detail?: string;
  /** When the underlying inference actually ran. Cached answers carry the ORIGINAL time. */
  checked_at?: string;
  /** Seconds since that inference. 0 on a fresh run; up to WHISPER_PROBE_CACHE_MS/1000 on a hit. */
  age_s?: number;
  /** Seconds since the last SUCCESSFUL inference, when one is known. */
  last_ok_age_s?: number;
  /** True when this verdict was served from cache rather than re-measured. */
  cached?: boolean;
};

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST the fixture and require a parseable 200. Never throws: a probe that throws is a health
 * route that 500s, which tells an operator less than `whisper: false` does.
 */
export async function runWhisperProbe(opts: {
  baseUrl?: string | null;
  budgetMs?: number;
  fetchImpl?: Fetcher;
  readFixture?: () => Promise<Uint8Array>;
  now?: () => number;
} = {}): Promise<WhisperProbeResult> {
  const budget_ms = opts.budgetMs ?? WHISPER_PROBE_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const base = opts.baseUrl ?? process.env.WHISPER_BASE_URL;
  if (!base) return { ok: false, reason: "not_configured", elapsed_ms: 0, budget_ms };

  const doFetch: Fetcher = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budget_ms);
  try {
    const bytes = opts.readFixture
      ? await opts.readFixture()
      : new Uint8Array(await readFile(path.join(process.cwd(), WHISPER_PROBE_FIXTURE)));

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/webm" }), "health-probe.webm");
    // Item 4 — EXACTLY what transcribeWithWhisper sends. "The same shape" has to be true, or the
    // probe exercises a decoder configuration production never uses.
    form.append("response_format", "verbose_json");
    form.append("temperature", "0.0");
    form.append("beam_size", "1");
    form.append("best_of", "1");
    form.append("max_context", "0");

    const res = await doFetch(`${base}/inference`, { method: "POST", body: form, signal: ac.signal });
    const elapsed_ms = now() - started;
    if (res.status !== 200) {
      return { ok: false, reason: "bad_status", status: res.status, elapsed_ms, budget_ms };
    }
    // A 200 is not enough: the shim's 404 body and an HTML error page are both "a response".
    // Requiring the body to PARSE is what proves whisper.cpp answered rather than something
    // sitting in front of it.
    try {
      const text = await res.text();
      const parsed: unknown = JSON.parse(text);
      // An OBJECT specifically: whisper.cpp answers `{"text": …}`, never an array and never a
      // bare scalar. Accepting an array would let any JSON-shaped thing in front of the service
      // pass — and `typeof [] === "object"` is exactly how that slips through.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "unparseable_body", status: 200, elapsed_ms, budget_ms };
      }
      return { ok: true, status: 200, elapsed_ms, budget_ms };
    } catch (e) {
      // Item 4 — an abort DURING the body read is a timeout, not a malformed body. The inner catch
      // used to swallow it and misname it `unparseable_body`, which points an operator at the
      // service's output when the real fact is that it never finished sending.
      if (ac.signal.aborted || (e as Error)?.name === "AbortError") {
        return { ok: false, reason: "whisper_timeout", elapsed_ms: now() - started, budget_ms };
      }
      return { ok: false, reason: "unparseable_body", status: 200, elapsed_ms, budget_ms };
    }
  } catch (e) {
    const elapsed_ms = now() - started;
    if ((e as Error)?.name === "AbortError") {
      return { ok: false, reason: "whisper_timeout", elapsed_ms, budget_ms };
    }
    return { ok: false, reason: "transport", elapsed_ms, budget_ms, detail: String((e as Error)?.message ?? e).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Item 1 — the cache, and the busy rule
// ---------------------------------------------------------------------------

type CacheEntry = { at: number; result: WhisperProbeResult };
/** Module state: one lambda instance answers from its own last measurement. */
let LAST: CacheEntry | null = null;
let LAST_OK_AT: number | null = null;

/** Test seam — module state must be resettable or every test inherits the last one's verdict. */
export function __resetWhisperProbeCache(): void {
  LAST = null;
  LAST_OK_AT = null;
}

/**
 * The probe the health route calls. At most ONE real inference per `WHISPER_PROBE_CACHE_MS`.
 *
 * Between runs the previous verdict is served verbatim, with `cached: true`, the ORIGINAL
 * `checked_at`, and an `age_s` that grows — so a reader can always tell how old the answer is and
 * is never invited to mistake it for a fresh one.
 *
 * THE BUSY RULE. A timeout with a successful inference inside `WHISPER_RECENT_OK_MS` is reported
 * `ok: true, reason: "busy_recent_ok"` with `last_ok_age_s`. whisper.cpp serialises, so a probe
 * queued behind a clinic window times out on a server that is provably working — we have the
 * earlier success as evidence. Calling that `false` pages someone for load, and a health signal
 * that cries wolf stops being read. With no recent success a timeout stays `whisper_timeout`.
 */
export async function probeWhisperTranscription(
  opts: Parameters<typeof runWhisperProbe>[0] & { cacheMs?: number } = {},
): Promise<WhisperProbeResult> {
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? WHISPER_PROBE_CACHE_MS;
  const t = now();

  if (LAST && t - LAST.at < cacheMs) {
    return { ...LAST.result, cached: true, checked_at: new Date(LAST.at).toISOString(), age_s: Math.round((t - LAST.at) / 1000) };
  }

  const fresh = await runWhisperProbe(opts);
  const at = now();
  let result = fresh;

  if (fresh.ok) {
    LAST_OK_AT = at;
  } else if (fresh.reason === "whisper_timeout" && LAST_OK_AT !== null && at - LAST_OK_AT < WHISPER_RECENT_OK_MS) {
    result = { ...fresh, ok: true, reason: "busy_recent_ok", last_ok_age_s: Math.round((at - LAST_OK_AT) / 1000) };
  }

  result = { ...result, checked_at: new Date(at).toISOString(), age_s: 0, cached: false };
  LAST = { at, result };
  return result;
}
