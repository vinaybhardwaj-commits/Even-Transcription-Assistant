/**
 * lib/jev/translate.ts — Slice J0 step 3: one window's original-language transcript into English.
 *
 * ─── OFF QWEN (V, 22 Sep) ──────────────────────────────────────────────────────────────────────
 * This used to call qwen2.5:14b through `lib/qwen.ts` — 11.55 GB on the Mini, reached from Vercel
 * through the Cloudflare tunnel, reloaded at 08:12 IST on 22 Sep by exactly this path after the
 * router had already moved off it. It now speaks OpenRouter on the router's contract
 * (`~/eta-router/router_server.py`): the same system prompt, the same verified-English skip, ZDR on
 * every call. There is no qwen in the default or the fallback, and no import of `lib/qwen.ts`.
 *
 *   model     JEV_TRANSLATE_MODEL     default google/gemini-3.8-flash
 *   fallback  JEV_TRANSLATE_FALLBACK  default meta-llama/llama-4-scout (comma list, tried in order)
 *
 * (ETA-Refuter round 2, 22 Sep, D5): these are V's choice, matching the router. `lib/llm/gemini.ts`
 * (`routedChat`'s OpenRouter fallback) uses the same pair — only the Vertex primary models differ.
 *
 * ─── FAILURE IS NOT ABSENCE (Refuter round 2, unchanged) ───────────────────────────────────────
 * Every model failing returns `{ status: "failed", reason }` with a CLOSED code, so the kind records
 * source='failed' (retryable) with English NULL. Source text is never passed off as English.
 *
 * ─── THE LABEL IS DERIVED ──────────────────────────────────────────────────────────────────────
 * `model` is what the RESPONSE reported, so a fallback shows on the row. A skipped window carries
 * `skip:english`, so a skip is countable rather than looking like a translation.
 *
 * ─── TRUNCATION IS RECORDED, NOT SILENT (unchanged) ────────────────────────────────────────────
 * `input_chars` is the pre-truncation length, so a window clipped at TRANSLATE_CHAR_CAP is visible.
 *
 * ─── A SHARED DEADLINE BOUNDS THE WHOLE CHAIN (ETA-Refuter round 2, 22 Sep, D4) ─────────────────
 * The fallback used to give EVERY model in the chain its own full `timeoutMs` with no ceiling across
 * them — with JEV_TRANSLATE_BATCH (3, lib/jobs/kinds/jev-english.ts) windows per step and a 2-model
 * chain at 60 s each, the worst case was 3 x 2 x 60 s = 360 s against MAX_STEP_MS (200 s,
 * lib/jobs/types.ts). Now one window's ENTIRE translateToEnglish call — every model it tries — is
 * bounded by JEV_TRANSLATE_TOTAL_BUDGET_MS_DEFAULT (40 s), itself built from a per-call cap
 * (JEV_TRANSLATE_CALL_TIMEOUT_MS_DEFAULT, 20 s) that shrinks to whatever budget remains for a later
 * model in the chain. Worst case is now 3 x 40 s = 120 s, comfortably under 200 s with ~80 s left for
 * the step's DB reads and writes.
 *
 * Logs carry nothing: this module does not log at all, and every error is a code.
 */
import { openrouterChat, OpenRouterError } from "@/lib/openrouter";

export type TranslateOutcome =
  | { status: "ok"; english: string | null; model: string; latency_ms: number; input_chars: number }
  | { status: "failed"; reason: string };

/** The seam the tests share: the real implementation is `openrouterChat`. */
export type ChatFn = typeof openrouterChat;

export const JEV_TRANSLATE_MODEL_DEFAULT = "google/gemini-3.8-flash";
export const JEV_TRANSLATE_FALLBACK_DEFAULT = "meta-llama/llama-4-scout";
export const SKIP_ENGLISH_LABEL = "skip:english";

/**
 * D4 (ETA-Refuter round 2, 22 Sep): what ONE model call may spend, before the shared total budget
 * below shrinks it further for a later model in the chain.
 */
export const JEV_TRANSLATE_CALL_TIMEOUT_MS_DEFAULT = 20_000;
/**
 * D4: what the WHOLE chain — every model `translateChain` tries for one window — may spend. See the
 * module header for the arithmetic against MAX_STEP_MS. `JEV_TRANSLATE_BATCH * this` is pinned
 * against `MAX_STEP_MS` by a test (tests/unit/jev-translate.test.ts), the same pattern as the
 * LEASE_MS/MAX_STEP_MS invariant in lib/jobs/types.ts.
 */
export const JEV_TRANSLATE_TOTAL_BUDGET_MS_DEFAULT = 40_000;

/** Verbatim from the router's TRANSLATE_SYSTEM_PROMPT, so both paths translate the same way. */
export const TRANSLATE_SYSTEM_PROMPT =
  "You translate a clinic conversation transcript into English, faithfully.\n" +
  "- Leave English words and English sentences exactly as they are.\n" +
  "- Keep drug names, doses, numbers and units exact.\n" +
  "- Never summarise, and never add or drop any content.\n" +
  "- If the input is already English, return it unchanged.\n" +
  "- Output only the translation: no preamble, no notes, no quotation marks.";

/**
 * How much of the original we send in one call (unchanged). Long ordinary windows go in full; a
 * genuinely huge one is clipped, and `input_chars` records the real length.
 */
export const TRANSLATE_CHAR_CAP = 20_000;

/**
 * English function words — split-speaker's measured EN_STOP (scripts/split-speaker-pilot/je_bakeoff.py)
 * plus when/where/why, identical to the router's EN_FUNCTION_WORDS. Not extended: `me`, `hai`, `aap`
 * would let romanised Hindi through.
 */
export const EN_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "the", "is", "are", "and", "to", "of", "you", "your", "what", "have", "has", "it", "this", "that",
  "in", "for", "on", "with", "do", "does", "not", "be", "was", "can", "will", "i", "we", "he", "she",
  "they", "my", "a", "an", "please", "how", "any", "take", "no", "yes", "ok", "okay", "one", "two",
  "three", "day", "days", "times", "after", "before", "morning", "night", "once", "twice",
  "when", "where", "why",
]);

/**
 * D1 (ETA-Refuter round 2, 22 Sep): romanised-Indic tokens that VETO the English skip, ported
 * verbatim from the router's `ROMANISED_INDIC_VETO` (`~/eta-router/router_server.py:366-374`, live
 * at commit cd62569). The function-word ratio alone let Hindi homographs through (`the` = "were",
 * `is` = "this", `to` is a particle) and code-mix that borrows clinical English ("two days",
 * "morning", "take") — 6 of the Refuter's 10 synthetic non-English cases skipped. One hit here sends
 * the segment to the translator (whose prompt already returns English unchanged), so a false veto
 * costs one call and a missed one would store Indic text as English. Words that are ALSO common
 * English (`to`, `is`, `the`, `me`, `main`, `sir`) are deliberately absent: vetoing them would stop
 * true English from skipping.
 */
export const ROMANISED_INDIC_VETO: ReadonlySet<string> = new Set([
  "hai", "hain", "nahi", "nahin", "kya", "kaise", "aap", "aapko", "mujhe", "mera", "meri", "kitne",
  "din", "se", "ko", "ka", "ki", "ke", "bhi", "toh", "tho", "haan", "accha", "theek", "dard",
  "bukhar", "dawai", "goli", "beta", "amma", "appa", "illa", "beku", "maadi", "yenu", "hogi",
  "hoga", "raha", "rahi", "wala",
  "vo", "kal", "hum", "wahan", "subah", "karta", "hoon", "matlab",
]);

/**
 * Verified English only: at least 90% ASCII letters AND at least 20% English function words AND
 * zero romanised-Indic veto tokens (D1). The language label is not an argument, so it cannot decide
 * — it is unreliable in both directions (Whisper tags romanised Hindi `en`; sessions tagged
 * kn-IN/hi-IN have held English).
 */
export function verifiedEnglish(text: string): boolean {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length === 0) return false;
  const ascii = letters.filter((c) => c.charCodeAt(0) < 128).length;
  if (ascii / letters.length < 0.9) return false;
  const words = (text.match(/[A-Za-z']+/g) ?? []).map((w) => w.toLowerCase());
  if (words.length === 0) return false;
  // D1: any romanised-Indic token vetoes the skip, however English the rest of the segment looks.
  if (words.some((w) => ROMANISED_INDIC_VETO.has(w))) return false;
  return words.filter((w) => EN_FUNCTION_WORDS.has(w)).length / words.length >= 0.2;
}

type Env = Record<string, string | undefined>;

/** The models to try, in order. Defaults only when the env var is absent or empty. */
export function translateChain(env: Env = process.env): string[] {
  const primary = (env.JEV_TRANSLATE_MODEL ?? "").trim() || JEV_TRANSLATE_MODEL_DEFAULT;
  const fallbackRaw = env.JEV_TRANSLATE_FALLBACK;
  const fallback = (fallbackRaw === undefined || fallbackRaw.trim() === "" ? JEV_TRANSLATE_FALLBACK_DEFAULT : fallbackRaw)
    .split(",").map((m) => m.trim()).filter(Boolean);
  return [primary, ...fallback.filter((m) => m !== primary)];
}

/** A closed code — never an exception message (no transcript, no key). */
function codeFor(e: unknown): string {
  // The client rejects a blank answer as `openrouter_empty`; the kind has always recorded that
  // outcome as `empty_output`, so it keeps its name here whichever layer noticed it.
  if (e instanceof OpenRouterError) return e.code === "openrouter_empty" ? "empty_output" : e.code;
  if ((e as { name?: unknown } | null)?.name === "AbortError") return "translate_abort";
  return "translate_error";
}

/**
 * Translate one window. Returns a discriminated outcome and never throws. `langHint` is accepted for
 * the kind's call shape but deliberately NOT used: the prompt does not need it, and the skip must
 * not depend on a label.
 */
export async function translateToEnglish(
  original: string,
  _langHint: string,
  deps: { chat?: ChatFn; env?: Env; signal?: AbortSignal } = {},
): Promise<TranslateOutcome> {
  const input_chars = original.length;

  if (verifiedEnglish(original)) {
    return { status: "ok", english: original.trim() || null, model: SKIP_ENGLISH_LABEL, latency_ms: 0, input_chars };
  }

  const env = deps.env ?? process.env;
  const chat = deps.chat ?? openrouterChat;
  const perCallTimeoutMs = Number(env.JEV_TRANSLATE_TIMEOUT_MS) > 0 ? Number(env.JEV_TRANSLATE_TIMEOUT_MS) : JEV_TRANSLATE_CALL_TIMEOUT_MS_DEFAULT;
  const totalBudgetMs = Number(env.JEV_TRANSLATE_TOTAL_MS) > 0 ? Number(env.JEV_TRANSLATE_TOTAL_MS) : JEV_TRANSLATE_TOTAL_BUDGET_MS_DEFAULT;
  // D4: one deadline for the whole chain, not one per model. A later model's own timeoutMs shrinks
  // to whatever is left of it, and once it is gone no further model is tried at all.
  const deadline = Date.now() + totalBudgetMs;
  const codes: string[] = [];

  for (const model of translateChain(env)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { codes.push("translate_deadline_exceeded"); break; }
    try {
      const r = await chat({
        model,
        system: TRANSLATE_SYSTEM_PROMPT,
        user: original.slice(0, TRANSLATE_CHAR_CAP),
        timeoutMs: Math.min(perCallTimeoutMs, remaining),
        signal: deps.signal,
        env,
      });
      const english = r.content.trim();
      if (!english) { codes.push("empty_output"); continue; }
      return { status: "ok", english, model: r.model, latency_ms: r.latency_ms, input_chars };
    } catch (e) {
      // An abort is the runner cancelling the step — stop, do not spend the fallback on it.
      if (deps.signal?.aborted) return { status: "failed", reason: "translate_abort" };
      codes.push(codeFor(e));
    }
  }

  // Every model failed. One code when they all failed the same way (e.g. `empty_output`, which the
  // kind has always recorded as such), otherwise the distinct codes, bounded for the row.
  const distinct = [...new Set(codes)];
  const reason = distinct.length === 1 ? distinct[0]! : `all_failed:${distinct.join(",")}`.slice(0, 200);
  return { status: "failed", reason };
}
