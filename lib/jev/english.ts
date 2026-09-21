/**
 * lib/jev/english.ts — Slice J0 (ETA-JEV-ARM-D §3A). PURE. The "is this window already English?"
 * rule and the source-decision, decided from metrics_json — NEVER from detected_language, which is
 * NULL on every bench window (see the amendment banner in the spec).
 *
 * THE MAJORITY-OF-PRESENT RULE (V, 21 Sep 2026 — supersedes the three-way agreement rule).
 * An ABSENT language signal ABSTAINS; it does not veto. A PRESENT signal that disagrees still does.
 * Three signals vote:
 *   1. metrics_json.full_window_language === "english"   (Whisper on the whole window)
 *   2. metrics_json.sarvam_language starts with "en"     (the router's ASR language)
 *   3. metrics_json.language_timeline.language_mix has no key other than "en" / "und"
 * native_en requires ALL of:
 *   (a) at least TWO of the three signals present,
 *   (b) every PRESENT signal says English,
 *   (c) transcript_original non-empty (enforced in classifyWindow).
 * The rule stays conservative where it counts: a code-mixed window ({"en":2,"hi":1,"und":1}) still
 * translates, and one lone signal is never enough. What changed is that a window whose other two
 * signals say English is no longer sent to translation merely because a third metric was never
 * written — the situation that left 135 of 139 fixture windows not_ready on 21 Sep.
 *
 * An EMPTY mix ({}) ABSTAINS too (V, 21 Sep): a language claim that names no language carries no
 * information, so it is treated exactly like a metric that was never written.
 *
 * "und" (undetermined) is tolerated in the mix because it is silence/noise spans, not another
 * language — a window that is English plus some untagged silence is still English to translate-past.
 *
 * No I/O, no clock, no model. This module decides WHAT a window is; lib/jobs/kinds/jev-english.ts
 * acts on it and lib/jev/translate.ts is the only thing that can load a model.
 */

/** The metrics_json fields J0 reads. Everything is optional and untrusted — the row may predate any of it. */
export type WindowMetrics = {
  full_window_language?: unknown;
  sarvam_language?: unknown;
  language_timeline?: { language_mix?: unknown } | unknown;
} | null | undefined;

/** The three languages that do not, on their own, force a translation. */
const ENGLISH_OR_UNDETERMINED = new Set(["en", "und"]);

/** metrics_json.language_timeline.language_mix, when it is a plain string→number map; else null. */
export function languageMix(metrics: WindowMetrics): Record<string, number> | null {
  if (!metrics || typeof metrics !== "object") return null;
  const tl = (metrics as { language_timeline?: unknown }).language_timeline;
  if (!tl || typeof tl !== "object") return null;
  const mix = (tl as { language_mix?: unknown }).language_mix;
  if (!mix || typeof mix !== "object" || Array.isArray(mix)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(mix as Record<string, unknown>)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

/** How one language signal voted. `absent` abstains; `other` vetoes. */
export type LanguageVote = "english" | "other" | "absent";

/** The three votes, in the order the banner lists them. Recorded so a decision can be explained later. */
export type NativeEnglishVotes = { full: LanguageVote; sarvam: LanguageVote; mix: LanguageVote };

/** `full_window_language`: absent when the key is missing or not a string. */
function voteFull(metrics: WindowMetrics): LanguageVote {
  const v = (metrics as { full_window_language?: unknown } | null | undefined)?.full_window_language;
  if (v === undefined || v === null) return "absent";
  if (typeof v !== "string" || v.trim() === "") return "other";
  return v.trim().toLowerCase() === "english" ? "english" : "other";
}

/** `sarvam_language`: absent when the key is missing or not a string. */
function voteSarvam(metrics: WindowMetrics): LanguageVote {
  const v = (metrics as { sarvam_language?: unknown } | null | undefined)?.sarvam_language;
  if (v === undefined || v === null) return "absent";
  if (typeof v !== "string" || v.trim() === "") return "other";
  return v.trim().toLowerCase().startsWith("en") ? "english" : "other";
}

/**
 * `language_timeline.language_mix`: absent when the timeline or the mix was never written, and ALSO
 * when the mix is empty (V, 21 Sep) — a language claim that names no language carries no
 * information, so it abstains rather than vetoes.
 */
function voteMix(metrics: WindowMetrics): LanguageVote {
  const mix = languageMix(metrics);
  if (mix === null) return "absent";
  const keys = Object.keys(mix);
  if (keys.length === 0) return "absent";
  for (const k of keys) {
    if (!ENGLISH_OR_UNDETERMINED.has(k.trim().toLowerCase())) return "other";
  }
  return "english";
}

/** The three votes for one window. Pure; safe on null, undefined and malformed metrics. */
export function nativeEnglishVotes(metrics: WindowMetrics): NativeEnglishVotes {
  return { full: voteFull(metrics), sarvam: voteSarvam(metrics), mix: voteMix(metrics) };
}

/**
 * A stable one-line record of who voted and who abstained, for the J0 row and for reports:
 * `full=english,sarvam=english,mix=absent`. Key order is fixed so it can be compared across rows.
 */
export function votesRecord(votes: NativeEnglishVotes): string {
  return `full=${votes.full},sarvam=${votes.sarvam},mix=${votes.mix}`;
}

/**
 * TRUE when at least two of the three signals are present and every present signal says English.
 * An absent signal abstains; a present one that disagrees vetoes; one signal alone is never enough.
 */
export function isNativeEnglish(metrics: WindowMetrics): boolean {
  const votes = nativeEnglishVotes(metrics);
  const all = [votes.full, votes.sarvam, votes.mix];
  if (all.some((v) => v === "other")) return false;
  return all.filter((v) => v === "english").length >= 2;
}

/**
 * The provenance of a window's English, as a CLOSED vocabulary that keeps an absence and a failure
 * apart (Refuter round 2):
 *   run_english | native_en | translated — terminal successes.
 *   empty      — a run exists and its source text is genuinely empty. Terminal.
 *   not_ready  — no run yet, or translation gated off with text still to do. NOT terminal: the job
 *                re-evaluates it every run and it turns into a real source on its own.
 *   failed     — translation attempted and failed. Terminal for the attempt, RETRYABLE, reason in `error`.
 */
export type JevSource = "run_english" | "native_en" | "translated" | "empty" | "not_ready" | "failed";

/** Sources the job treats as done and skips on a normal re-run. not_ready and failed are re-processed. */
export const TERMINAL_SOURCES: ReadonlySet<JevSource> = new Set(["run_english", "native_en", "translated", "empty"]);

/** The persisted shape (mirrors the jev_window_text columns the kind writes). */
export type JevWindowText = {
  window_id: string;
  room_day_id: string;
  english: string | null;
  source: JevSource;
  char_count: number;
  model: string | null;
  /** Closed-code reason for source='failed' (never an exception string); NULL otherwise. */
  error: string | null;
  /** Pre-truncation length sent to translate for source='translated'; NULL otherwise. */
  input_chars: number | null;
  latency_ms: number | null;
};

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

/**
 * The non-translation part of §3A's per-window rule, PURE, so it is decidable and testable without a
 * database or a model:
 *   1. transcript_english non-empty            → run_english
 *   2. else isNativeEnglish(metrics)           → native_en   (store transcript_original as-is)
 *   3. else                                    → needs_translation (the kind decides, gated by the flag)
 *
 * Step 3/4 (translate, or empty when gated off / empty result) belong to the kind, because only they
 * touch a model. This returns either a finished row (steps 1–2) or the signal that translation is
 * required, along with the original text to translate.
 */
export function classifyWindow(input: {
  window_id: string;
  room_day_id: string;
  transcript_english: string | null | undefined;
  transcript_original: string | null | undefined;
  metrics: WindowMetrics;
}): { done: JevWindowText } | { needsTranslation: true; original: string | null } {
  const { window_id, room_day_id } = input;

  if (nonEmpty(input.transcript_english)) {
    const english = input.transcript_english.trim();
    return { done: { window_id, room_day_id, english, source: "run_english", char_count: english.length, model: null, error: null, input_chars: null, latency_ms: null } };
  }

  if (isNativeEnglish(input.metrics) && nonEmpty(input.transcript_original)) {
    const english = input.transcript_original.trim();
    return { done: { window_id, room_day_id, english, source: "native_en", char_count: english.length, model: null, error: null, input_chars: null, latency_ms: null } };
  }

  return { needsTranslation: true, original: nonEmpty(input.transcript_original) ? input.transcript_original : null };
}

/** (b) A run exists and its source text is genuinely empty. Terminal. */
export function emptyRow(window_id: string, room_day_id: string): JevWindowText {
  return { window_id, room_day_id, english: null, source: "empty", char_count: 0, model: null, error: null, input_chars: null, latency_ms: null };
}

/** (a) No run yet, or translation gated off with text to do. NOT terminal — re-evaluated on the next run. */
export function notReadyRow(window_id: string, room_day_id: string): JevWindowText {
  return { window_id, room_day_id, english: null, source: "not_ready", char_count: 0, model: null, error: null, input_chars: null, latency_ms: null };
}

/** (c) Translation was attempted and failed. Terminal for the attempt, RETRYABLE; reason is a closed code. */
export function failedRow(window_id: string, room_day_id: string, reason: string): JevWindowText {
  return { window_id, room_day_id, english: null, source: "failed", char_count: 0, model: null, error: reason, input_chars: null, latency_ms: null };
}

/**
 * The row for a completed local translation. A translation that ATTEMPTED and produced nothing is a
 * `failed` (empty_output), never `empty` — an empty source (b) and a failed translation (c) must not
 * share a value. `input_chars` (pre-truncation length) is recorded so a clipped long window shows.
 */
export function translatedRow(
  window_id: string,
  room_day_id: string,
  result: { english: string | null; model: string; latency_ms: number; input_chars: number },
): JevWindowText {
  if (!nonEmpty(result.english)) return failedRow(window_id, room_day_id, "empty_output");
  const english = result.english.trim();
  return { window_id, room_day_id, english, source: "translated", char_count: english.length, model: result.model, error: null, input_chars: result.input_chars, latency_ms: result.latency_ms };
}
