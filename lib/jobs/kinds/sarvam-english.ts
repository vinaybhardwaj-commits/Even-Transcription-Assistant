/**
 * lib/jobs/kinds/sarvam-english.ts — S8A4: the English track of a Sarvam transcription. PURE (no I/O).
 *
 * The English comes from the AUDIO (a second saaras:v3 pass in translate mode), not from trusting the file-level language_code, which saaras sets once per file
 * (en-IN for a consult that is mostly English even when a Kannada line is in it). The two passes have their own diarized entries and their own timelines:
 *   - the NATIVE entries (transcribe / codemix pass) stay exactly as Sarvam returned them, with the script of their own text recorded;
 *   - the ENGLISH entries (translate pass) are aligned to the native ones by time overlap, each to the native entry it overlaps most;
 *   - nothing is dropped: an English entry with no native partner stays in `english_entries` (native_idx null); a native entry with no English partner is
 *     handled by the caller (Latin script -> the entry is already English text; an Indic script -> mayura translates that one entry).
 *
 * G43 — NOTHING IS TRUSTED TO BE ENGLISH. If the API ignores mode "translate", or Sarvam writes Kannada in Latin letters, the "English" is Indic. Every English candidate,
 * from either pass or from mayura, goes through checkEnglish: NON-LATIN letters of any script above INDIC_LETTER_RATIO, or a romanised-Indic score above the whole-entry threshold,
 * and it is NOT English: a pass entry is refused (its native partner goes to mayura as "mayura_fallback"), a mayura result that still is not English is "untranslated",
 * a romanised native entry whose language cannot be told is "unverified". A lower non-zero romanised score only marks `mixed_language` (G45).
 */
import { detectScript, isNonLatinScript, nonLatinLetterRatio } from "@/lib/script-detect";
import { BCP47, scoreRomanized, verdictOf, type IndicLang } from "@/lib/romanized-indic";
import { drugCandidates, type Lexicon } from "@/lib/drug-match";
import type { EnglishEntry, ResultDoc, ResultEntry } from "./sarvam-common";

export type RawEntry = { speaker_id: string; start_s: number; end_s: number; text: string; language_code?: string | null };

/** Record each native entry's own script (and keep Sarvam's per-entry language if the response had one). */
export function tagNative(entries: RawEntry[]): ResultEntry[] {
  return entries.map((e) => ({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text: e.text, script: detectScript(e.text), language_code: e.language_code ?? null }));
}

/** More than this share of NON-LATIN letters (any script) and a text is not English. */
export const INDIC_LETTER_RATIO = 0.15;

export type EnglishCheck = { verdict: "english" | "non_latin_script" | "romanized" | "mixed"; lang: IndicLang | null };
export function checkEnglish(text: string): EnglishCheck {
  // ANY non-Latin letter counts (G52): Urdu / Arabic, Ol Chiki, Meitei and every other script are not English, not only the nine Indic ranges
  if (nonLatinLetterRatio(text) > INDIC_LETTER_RATIO) return { verdict: "non_latin_script", lang: null };
  const s = scoreRomanized(text);
  const v = verdictOf(s);
  return { verdict: v === "english" ? "english" : v, lang: s.lang };
}

const SCRIPT_LANG: Record<string, string> = { Kannada: "kn-IN", Tamil: "ta-IN", Telugu: "te-IN", Malayalam: "ml-IN", Bengali: "bn-IN", Gujarati: "gu-IN", Gurmukhi: "pa-IN", Odia: "od-IN" };
/** The language mayura is told: the entry's own code if Sarvam gave one; else what the script says (Devanagari is hi / mr / ne: "auto"); else the romanised score's language. */
export function sourceLangOf(e: ResultEntry, romanLang: IndicLang | null = null): string | null {
  if (e.language_code && e.language_code.includes("-") && !/^en-/i.test(e.language_code)) return e.language_code;
  if (e.script && SCRIPT_LANG[e.script]) return SCRIPT_LANG[e.script]!;
  return romanLang ? BCP47[romanLang] : null;
}

/** Text compared for "is this just the source again": case, punctuation and whitespace are ignored, letters of every script are kept. */
export const normalizeForEcho = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);

/**
 * The index of the native entry an English entry belongs to: the one it overlaps most in time (the first on a tie); for a point-like entry, the one that contains its midpoint; else null.
 * S8A8 D1: when the entry lies FULLY inside two or more native entries (a short translate-pass entry such as "Hi" inside both a long native line and the short native entry it really
 * belongs to) the overlap ties, and the first one used to win, which was the long line: the short native entry was left unpaired and was emitted AGAIN as native_latin. The tightest
 * containing native entry (the shortest) now wins. An entry that merely straddles a boundary keeps the old rule.
 */
function partnerOf(e: RawEntry, native: ResultEntry[]): number | null {
  const EPS = 1e-9;
  let best = -1;
  let bestOv = 0;
  native.forEach((n, i) => {
    const ov = overlap(e.start_s, e.end_s, n.start_s, n.end_s);
    if (ov > bestOv + EPS) { best = i; bestOv = ov; }
  });
  if (best >= 0) {
    const len = e.end_s - e.start_s;
    if (len > 0 && bestOv >= len - EPS) {
      // fully contained: among the native entries that contain it entirely, one with the SAME speaker_id first (T2: a long line's sentence inside another speaker's "Hi" span is not that speaker's), then the tightest fit
      const containing = native.map((n, i) => ({ n, i })).filter(({ n }) => overlap(e.start_s, e.end_s, n.start_s, n.end_s) >= len - EPS);
      const sameSpeaker = containing.filter(({ n }) => n.speaker_id === e.speaker_id);
      const pool = sameSpeaker.length > 0 ? sameSpeaker : containing;
      let tight = pool[0]!;
      for (const c of pool) if (c.n.end_s - c.n.start_s < tight.n.end_s - tight.n.start_s - EPS) tight = c;
      best = tight.i;
    }
  }
  if (best >= 0) return best;
  const mid = (e.start_s + e.end_s) / 2;
  const at = native.findIndex((n) => mid >= n.start_s && mid <= n.end_s);
  return at >= 0 ? at : null;
}

export type Aligned = { track: EnglishEntry[]; /** translate-pass entries that were not English */ rejected: number; /** their native partners */ rejectedNative: Set<number> };

/** Set `english` on the native entries from the ACCEPTED translate-pass entries and return the English track. Mutates `native`. */
export function alignEnglish(native: ResultEntry[], pass: RawEntry[]): Aligned {
  const track: EnglishEntry[] = [];
  const rejectedNative = new Set<number>();
  let rejected = 0;
  for (const e of pass) {
    if (!e.text.trim()) continue;
    const idx = partnerOf(e, native);
    const chk = checkEnglish(e.text);
    // G52: a pass entry that is the NON-LATIN native text again (the API echoed the source) is refused whatever its script table says; for a Latin native partner an identical text is just English speech
    // (defence in depth: an echo of a non-Latin native text is already refused by the script check above, so removing this clause changes no outcome — an EQUIVALENT mutant, not a surviving one)
    const echoOfNonLatin = idx !== null && isNonLatinScript(detectScript(native[idx]!.text)) && normalizeForEcho(e.text) === normalizeForEcho(native[idx]!.text);
    if (chk.verdict === "non_latin_script" || chk.verdict === "romanized" || echoOfNonLatin) {
      rejected += 1; // G43: the API did not translate this entry
      if (idx !== null) rejectedNative.add(idx);
      continue;
    }
    track.push({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text: e.text.trim(), source: "translate_pass", native_idx: idx, status: "ok", ...(chk.verdict === "mixed" ? { mixed_language: true } : {}) });
  }
  const byNative = new Map<number, EnglishEntry[]>();
  for (const t of track) if (t.native_idx !== null) byNative.set(t.native_idx, [...(byNative.get(t.native_idx) ?? []), t]);
  for (const [i, parts] of byNative) {
    if (rejectedNative.has(i)) {
      // G54: ONE accepted part and ONE refused part of the same native entry: the entry is NOT covered. Its accepted English is set aside (and its parts leave the track, so mayura's
      // whole-entry translation cannot duplicate them); settleUnpaired sends the entry to mayura as mayura_fallback, and addMayura restores the set-aside English as `partial` if mayura cannot deliver.
      native[i]!.partial_english = parts.map((p) => p.text).join(" ");
      for (const p of parts) track.splice(track.indexOf(p), 1);
      continue;
    }
    native[i]!.english = parts.map((p) => p.text).join(" ");
    native[i]!.english_source = "translate_pass";
    native[i]!.english_status = "ok";
    if (parts.some((p) => p.mixed_language)) native[i]!.mixed_language = true;
  }
  return { track, rejected, rejectedNative };
}

/**
 * Native entries still without English after the pass (or with no pass at all):
 *  - empty text -> empty English;
 *  - Indic script -> mayura for that entry ("mayura_fallback" when the pass text for it was refused);
 *  - Latin script: a romanised-Indic score above the whole-entry threshold -> mayura with the entry's language (or the score's), "unverified" when no language can be told;
 *    a lower non-zero score -> kept, mixed_language; otherwise taken as English (saaras transcribe mode writes Latin for English speech).
 * Returns the indexes that need mayura (their `english` stays undefined, english_source and mayura_lang are set).
 */
export function settleUnpaired(native: ResultEntry[], track: EnglishEntry[], rejectedNative: Set<number> = new Set()): number[] {
  const need: number[] = [];
  native.forEach((e, i) => {
    if (e.english !== undefined) return;
    if (!e.text.trim()) { e.english = ""; e.english_status = "empty"; return; }
    const fallback = rejectedNative.has(i);
    const script = detectScript(e.text);
    // ANY non-Latin script (G52) — or a text with a sizeable non-Latin share inside Latin letters — is never taken as English
    if (isNonLatinScript(script) || nonLatinLetterRatio(e.text) > INDIC_LETTER_RATIO) {
      e.english_source = fallback ? "mayura_fallback" : "mayura";
      e.mayura_lang = sourceLangOf(e);
      need.push(i);
      return;
    }
    const score = scoreRomanized(e.text);
    const verdict = verdictOf(score);
    if (verdict === "romanized") {
      const lang = sourceLangOf(e, score.lang);
      if (lang) {
        e.english_source = "mayura_fallback";
        e.mayura_lang = lang;
        need.push(i);
        return;
      }
      // romanised Indic, language unknown: never passed off as English
      e.english = e.text;
      e.english_source = "native_unverified";
      e.english_status = "unverified";
      track.push({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text: e.text, source: "native_unverified", native_idx: i, status: "unverified" });
      return;
    }
    e.english = e.text;
    e.english_source = "native_latin";
    e.english_status = "ok";
    if (verdict === "mixed") e.mixed_language = true;
    track.push({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text: e.text, source: "native_latin", native_idx: i, status: "ok", ...(verdict === "mixed" ? { mixed_language: true } : {}) });
  });
  return need;
}

/**
 * After mayura: each result is checked too. An empty result, one equal to the source, or one that is still not English is "untranslated" (english left empty, never the
 * Indic text); otherwise it joins the English track ("ok" for a plain mayura entry, "mayura_fallback" for one the pass should have covered).
 */
export function addMayura(native: ResultEntry[], track: EnglishEntry[], idxs: number[]): void {
  for (const i of idxs) {
    const e = native[i]!;
    if (e.english_source !== "mayura" && e.english_source !== "mayura_fallback") continue;
    const text = (e.english ?? "").trim();
    const chk = checkEnglish(text);
    // empty, the source again (compared without case / punctuation / spacing), or still not English
    if (!text || normalizeForEcho(text) === normalizeForEcho(e.text) || chk.verdict === "non_latin_script" || chk.verdict === "romanized") {
      if (e.partial_english) {
        // G54: mayura could not cover the entry; what the translate pass DID give is kept, and the entry says honestly that it is only part of it
        e.english = e.partial_english;
        e.english_status = "partial";
        track.push({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text: e.partial_english, source: "translate_pass", native_idx: i, status: "partial" });
      } else {
        e.english = "";
        e.english_status = "untranslated";
      }
      continue;
    }
    // mayura translated the WHOLE entry: it replaces the set-aside part
    e.english_status = e.english_source === "mayura_fallback" ? "mayura_fallback" : "ok";
    if (chk.verdict === "mixed") e.mixed_language = true;
    track.push({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text, source: e.english_source, native_idx: i, status: "ok", ...(chk.verdict === "mixed" ? { mixed_language: true } : {}) });
  }
}

/** The counts the job result carries. english_ok = English taken as English (pass, Latin, plain mayura); the rest say what was not. */
export function englishCounts(doc: ResultDoc): { entries: number; english_ok: number; mayura_fallback: number; unverified: number; untranslated: number; partial: number; mixed_language: number } {
  const c = { entries: doc.entries.length, english_ok: 0, mayura_fallback: 0, unverified: 0, untranslated: 0, partial: 0, mixed_language: 0 };
  for (const e of doc.entries) {
    if (e.english_status === "ok") c.english_ok += 1;
    else if (e.english_status === "mayura_fallback") c.mayura_fallback += 1;
    else if (e.english_status === "unverified") c.unverified += 1;
    else if (e.english_status === "untranslated") c.untranslated += 1;
    else if (e.english_status === "partial") c.partial += 1;
    if (e.mixed_language) c.mixed_language += 1;
  }
  return c;
}

/** Order the English track by time (stable), set doc.english, and compute the name candidates over the entries that are English. Never alters any text. */
export function finalizeEnglish(doc: ResultDoc, lex: Lexicon): void {
  const track = [...(doc.english_entries ?? [])]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.start_s - b.t.start_s || a.t.end_s - b.t.end_s || a.i - b.i)
    .map((x) => x.t);
  doc.english_entries = track;
  // G47: the FLAT text carries only English that can be taken as English (status ok, which includes the mayura_fallback source); unverified and partial entries stay in english_entries with their status, never silently in the flat string
  doc.english = track.filter((t) => t.status === undefined || t.status === "ok").map((t) => t.text).filter(Boolean).join(" ");
  doc.drug_candidates = track.flatMap((t, i) => (t.status === "unverified" ? [] : drugCandidates(t.text, i, lex)));
}
