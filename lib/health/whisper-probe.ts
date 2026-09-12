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

export const WHISPER_PROBE_FIXTURE = "fixtures/health-probe-0.5s-16k-mono.wav";

export type WhisperProbeResult = {
  ok: boolean;
  /** Named on every failure so an operator reads WHICH way it broke, not just `false`. */
  reason?: "not_configured" | "whisper_timeout" | "bad_status" | "unparseable_body" | "transport";
  status?: number;
  elapsed_ms: number;
  budget_ms: number;
  detail?: string;
};

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST the fixture and require a parseable 200. Never throws: a probe that throws is a health
 * route that 500s, which tells an operator less than `whisper: false` does.
 */
export async function probeWhisperTranscription(opts: {
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
    form.append("file", new Blob([bytes], { type: "audio/wav" }), "health-probe.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");

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
    } catch {
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
