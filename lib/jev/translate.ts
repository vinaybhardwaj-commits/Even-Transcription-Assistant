/**
 * lib/jev/translate.ts — Slice J0 step 3. The ONLY module in J0 that can load a model.
 *
 * ─── THE SCHEDULING CONTRACT (read before touching this) ───────────────────────────────────────
 * Translation runs qwen2.5:14b on the Mini — ~11.5 GB of unified memory on a 24 GB box, the single
 * largest consumer on that machine. Therefore:
 *   • It is reached ONLY from lib/jobs/kinds/jev-english.ts step 3, and ONLY when
 *     ETA_JEV_TRANSLATE_ENABLED is set. Unset → the kind never calls this and the window lands
 *     source='not_ready' (re-eligible), never a terminal state. The flag is checked in the kind.
 *   • LOAD PER BATCH, NEVER HELD ACROSS THE JOB. We pass NO keep_alive, so Ollama uses its default
 *     idle expiry and unloads the model once the batch stops calling; the 11.5 GB is resident only
 *     while a batch is actively translating, never pinned for the life of the job.
 *   • It is INJECTABLE. `deps.qwenJson` defaults to the real client; every test passes a mock and no
 *     test ever reaches Ollama.
 *
 * ─── FAILURE IS NOT ABSENCE (Refuter round 2) ──────────────────────────────────────────────────
 * A qwen error, timeout or abort returns `{ status: "failed", reason }` — a CLOSED code, never the
 * exception text — so the caller records source='failed' (retryable), NOT 'empty'. The old bare
 * catch that returned null (→ persisted as 'empty', done, never retried) was the VAD-starvation
 * defect again: the caller discarding the status.
 *
 * ─── TRUNCATION IS RECORDED, NOT SILENT ────────────────────────────────────────────────────────
 * `input_chars` is the pre-truncation length of the text we send; the row carries it so a long
 * window that was clipped at TRANSLATE_CHAR_CAP is visible and quantifiable, never a 'translated'
 * row that quietly dropped a third of the window.
 *
 * LOCAL ONLY. This is the Mini's qwen leg, never TypeSafe — D1 does not gate J0 (spec §3A, §6).
 * Logs carry metadata only: never the transcript, never a key.
 */
import { qwenJson, QWEN_MODEL, QwenError } from "@/lib/qwen";

export type TranslateOutcome =
  | { status: "ok"; english: string | null; model: string; latency_ms: number; input_chars: number }
  | { status: "failed"; reason: string };

/** The seam the kind and the tests share. The real implementation is qwenJson; tests pass a fake. */
export type QwenJsonFn = <T = unknown>(
  system: string,
  user: string,
  opts?: { timeoutMs?: number; model?: string; temperature?: number; signal?: AbortSignal },
) => Promise<{ json: T; raw: string; latency_ms: number; model: string }>;

const SYSTEM =
  "You are a clinical translator. Translate the Indian-language clinical transcript to natural English. " +
  "CRITICAL: keep English medical terms, drug names, doses, units, and abbreviations exactly as a clinician writes them. " +
  "Do NOT add, omit, summarize, or invent content. Return JSON {\"english\":\"...\"}.";

/**
 * How much of the original we send in one call. Raised from 8,000 so ordinary long windows (the live
 * corpus has runs up to ~9.5k chars) are sent in FULL; a genuinely huge window (a phrase-loop
 * hallucination) is still clipped here, but `input_chars` records the real length so the clip is on
 * the row rather than hidden.
 */
export const TRANSLATE_CHAR_CAP = 20_000;

/** A closed code for the failure kind — never the exception message (no transcript/PII leakage). */
function reasonFor(e: unknown): string {
  if (e instanceof QwenError) {
    if (e.kind === "timeout") return "qwen_timeout";
    if (e.kind === "no_env") return "qwen_no_env";
    return "qwen_error"; // network | http | parse_error
  }
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "AbortError") return "qwen_abort";
  return "qwen_error";
}

/**
 * Translate one window's original-language transcript to English through the Mini's local qwen leg.
 * Returns a discriminated outcome; never throws. `status:"ok"` may carry an empty `english` (the
 * caller turns that into a failed/empty_output row, not 'empty'). Never loads a model in a test:
 * the caller injects `deps.qwenJson`.
 */
export async function translateToEnglish(
  original: string,
  langHint: string,
  deps: { qwenJson?: QwenJsonFn; signal?: AbortSignal } = {},
): Promise<TranslateOutcome> {
  const call = deps.qwenJson ?? (qwenJson as QwenJsonFn);
  const input_chars = original.length;
  try {
    const r = await call<{ english?: string }>(
      SYSTEM,
      `Language: ${langHint}\nTranscript:\n${original.slice(0, TRANSLATE_CHAR_CAP)}`,
      { temperature: 0, timeoutMs: 60_000, signal: deps.signal },
    );
    const english = typeof r.json?.english === "string" ? r.json.english.trim() : "";
    return { status: "ok", english: english || null, model: r.model || QWEN_MODEL, latency_ms: r.latency_ms, input_chars };
  } catch (e) {
    return { status: "failed", reason: reasonFor(e) };
  }
}
