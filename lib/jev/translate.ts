/**
 * lib/jev/translate.ts — Slice J0 step 3. The ONLY module in J0 that can load a model.
 *
 * ─── THE SCHEDULING CONTRACT (read before touching this) ───────────────────────────────────────
 * Translation runs qwen2.5:14b on the Mini — ~11.5 GB of unified memory on a 24 GB box, the single
 * largest consumer on that machine. Therefore:
 *   • It is reached ONLY from lib/jobs/kinds/jev-english.ts step 3, and ONLY when
 *     ETA_JEV_TRANSLATE_ENABLED is set. Unset → the kind never calls this and the window lands
 *     source='empty'. The flag is checked in the kind, not here, so this stays a pure leaf.
 *   • LOAD PER BATCH, NEVER HELD ACROSS THE JOB. We pass NO keep_alive, so Ollama uses its default
 *     idle expiry (~5 min) and unloads the model once the batch stops calling. The kind runs
 *     translation one bounded step-batch at a time; between the runner's claims the model may expire
 *     and reload — which is the point: the 11.5 GB is resident only while a batch is actively
 *     translating, never pinned for the life of the job. We deliberately do not set keep_alive:-1.
 *   • It is INJECTABLE. `deps.qwenJson` defaults to the real client; every test passes a mock and no
 *     test ever reaches Ollama. A test proves that with the flag unset this is never called at all.
 *
 * LOCAL ONLY. This is the Mini's qwen leg, never TypeSafe — D1 does not gate J0 (spec §3A, §6).
 * Logs carry metadata only: never the transcript, never a key.
 */
import { qwenJson, QWEN_MODEL } from "@/lib/qwen";

export type TranslateResult = { english: string | null; model: string; latency_ms: number };

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

/** How much of the original we send in one call — matches the existing indic translate leg's cap. */
export const TRANSLATE_CHAR_CAP = 8000;

/**
 * Translate one window's original-language transcript to English through the Mini's local qwen leg.
 * Returns null on any failure (the kind records that window as source='empty' — D-11, never a throw).
 * Never loads a model in a test: the caller injects `deps.qwenJson`.
 */
export async function translateToEnglish(
  original: string,
  langHint: string,
  deps: { qwenJson?: QwenJsonFn; signal?: AbortSignal } = {},
): Promise<TranslateResult | null> {
  const call = deps.qwenJson ?? (qwenJson as QwenJsonFn);
  try {
    const r = await call<{ english?: string }>(
      SYSTEM,
      `Language: ${langHint}\nTranscript:\n${original.slice(0, TRANSLATE_CHAR_CAP)}`,
      { temperature: 0, timeoutMs: 60_000, signal: deps.signal },
    );
    const english = typeof r.json?.english === "string" ? r.json.english.trim() : "";
    return { english: english || null, model: r.model || QWEN_MODEL, latency_ms: r.latency_ms };
  } catch {
    // Soft-fail: a translation error is an evidenced empty for this window, not a job failure.
    return null;
  }
}
