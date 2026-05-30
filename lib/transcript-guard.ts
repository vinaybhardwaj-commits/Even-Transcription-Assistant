/**
 * transcript-guard.ts — submit-time cleanup that removes non-clinical lead-in
 * from a recording's transcripts before they become the note source and the
 * displayed "Original / English translation" boxes.
 *
 * Why: ASR engines (Whisper especially, but also Deepgram/Sarvam on real
 * foreign-language or non-speech audio) emit confident, fluent text that is
 * NOT clinical content — memorised ad jingles, "thanks for watching" ghost
 * phrases, or a foreign-language intro that played before the consult. See
 * ETA-BUG-LOG.md §B14 (Marathi test enc_g754qhq7z8: an Orient fan TV-ad intro
 * headed both transcript boxes). Left in, this fabricated text flows into
 * transcript_raw -> the LLM note -> the email — a clinical-safety concern.
 *
 * Two principled, CONSERVATIVE passes (leading-anchored + bounded — the body
 * of the consult is never inspected or altered):
 *   1. stripLeadingForeign  — for a non-English-Indic encounter, drop the
 *      leading run of pure-English (no Indic script) text before the first
 *      Indic character. Inline / code-mix English mid-consult is preserved.
 *   2. stripLeadingNoise    — within a bounded leading window, drop sentences
 *      that match a curated hallucination / ad blocklist.
 *
 * A length floor guarantees a transcript can never be over-stripped into
 * emptiness: if cleaning would drop > ~60% of the content (or leave < 40
 * chars), the original is kept untouched.
 */

// Devanagari..Sinhala (U+0900-U+0DFF) — Hindi/Marathi/Bengali/Gujarati/Tamil/
// Telugu/Kannada/Malayalam. Same range used elsewhere in the pipeline.
const INDIC = /[\u0900-\u0DFF]/;

export function hasIndic(s: string): boolean {
  return INDIC.test(s);
}

// Curated markers of NON-clinical ASR output. Case-insensitive, and only ever
// applied to a bounded LEADING window, so a real consult that happens to use
// one of these words later is never affected.
const NOISE_MARKERS: RegExp[] = [
  // Classic ASR / video ghost phrases
  /thanks?\s+for\s+watching/i,
  /(please\s+)?subscribe(\s+to)?\b/i,
  /don'?t\s+forget\s+to\s+(like|subscribe)/i,
  /like\s+and\s+subscribe/i,
  /see\s+you\s+(in\s+the\s+next|next\s+time)/i,
  /(subtitles?|captions?)\s+(by|provided)/i,
  /amara\.org/i,
  /\bpodcast\b/i,
  // Advertisement copy seen bleeding into a recording (Orient fan TV ad, B14)
  /\borient\b/i,
  /aero[\s-]?(foil|dynamic|silent)/i,
  /plate\s+design/i,
  /most\s+silent/i,
  /\b[pb]rdc\b/i,
];

function looksLikeNoise(sentence: string): boolean {
  return NOISE_MARKERS.some((re) => re.test(sentence));
}

// Split into rough sentences, keeping trailing punctuation, across Latin
// terminators + the Devanagari danda. Dependency-free and good enough for a
// leading-window scan.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * For a non-English-Indic encounter, drop a leading run of pure-English
 * (no-Indic) text that precedes the first Indic character. No-op for English
 * encounters, and no-op if the transcript has no Indic script at all (so we
 * never blank a transcript that was legitimately all-Latin).
 */
export function stripLeadingForeign(
  text: string,
  detectedLanguage: string | null | undefined,
): string {
  if (!text) return text;
  const lang = (detectedLanguage ?? "").toLowerCase();
  const isIndicLang = !!lang && !lang.startsWith("en");
  if (!isIndicLang) return text;
  const idx = text.search(INDIC);
  if (idx <= 0) return text; // no Indic, or already starts with Indic
  // Trim back to the start of the sentence containing the first Indic char so
  // we don't slice mid-sentence.
  const head = text.slice(0, idx);
  const lastBreak = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("। "),
    head.lastIndexOf("? "),
    head.lastIndexOf("! "),
    head.lastIndexOf("\n"),
  );
  const cut = lastBreak >= 0 ? lastBreak + 1 : idx;
  return text.slice(cut).trim();
}

const LEAD_WINDOW_CHARS = 700;
const LEAD_WINDOW_SENTENCES = 8;

/**
 * Within a bounded leading window, drop sentences that match the noise
 * blocklist. Sentences past the window are kept verbatim — the consult body is
 * never inspected.
 */
export function stripLeadingNoise(text: string): string {
  if (!text) return text;
  const sentences = splitSentences(text);
  if (sentences.length === 0) return text;
  const kept: string[] = [];
  let consumed = 0;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const withinWindow = consumed < LEAD_WINDOW_CHARS && i < LEAD_WINDOW_SENTENCES;
    consumed += s.length + 1;
    if (withinWindow && looksLikeNoise(s)) continue; // drop leading noise
    kept.push(s);
  }
  return kept.join(" ").trim();
}

/** Drop leading diarized entries (bounded) whose text is noise. */
export function trimLeadingNoiseEntries<T extends { transcript: string }>(entries: T[]): T[] {
  if (!entries || entries.length === 0) return entries;
  let i = 0;
  const limit = Math.min(entries.length, LEAD_WINDOW_SENTENCES);
  while (i < limit && looksLikeNoise(entries[i].transcript ?? "")) i++;
  return i > 0 ? entries.slice(i) : entries;
}

// Keep the cleaned text only if it retains enough of the original; otherwise
// the original (noisy but complete) is safer than a gutted transcript.
function applyFloor(before: string, after: string): string {
  const b = before.trim();
  const a = after.trim();
  if (a.length === 0) return before;
  if (a.length < 40 && b.length >= 40) return before;
  if (a.length < b.length * 0.4) return before;
  return a;
}

/** Clean an English transcript (translated or English-encounter): noise pass only. */
export function sanitizeEnglish(text: string | null | undefined): string {
  const before = text ?? "";
  if (!before) return before;
  return applyFloor(before, stripLeadingNoise(before));
}

/** Clean a vernacular / code-mix original: leading-foreign trim then noise pass. */
export function sanitizeOriginal(
  text: string | null | undefined,
  detectedLanguage: string | null | undefined,
): string {
  const before = text ?? "";
  if (!before) return before;
  const step1 = stripLeadingForeign(before, detectedLanguage);
  const step2 = stripLeadingNoise(step1);
  return applyFloor(before, step2);
}
