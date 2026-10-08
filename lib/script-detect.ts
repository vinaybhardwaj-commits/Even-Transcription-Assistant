/**
 * lib/script-detect.ts — S8A4: which writing system a piece of text is in, from its letters alone. PURE.
 *
 * Sarvam returns ONE language_code for a whole file, so it cannot say that a Kannada line sits inside an English consult. The script of each entry's own text can:
 * Devanagari / Kannada / Tamil / Telugu / Malayalam / Bengali / Gujarati / Gurmukhi / Odia letters are never English, and neither is ANY other non-Latin letter ("Other": Urdu / Arabic, Ol Chiki, Meitei, ...). Latin letters are ambiguous (English, but
 * also ROMANISED Kannada or Hindi, which saaras transcribe mode produces), so "Latin" proves nothing about the language: callers treat it as "not proven non-English".
 */
export type Script = "Latin" | "Devanagari" | "Kannada" | "Tamil" | "Telugu" | "Malayalam" | "Bengali" | "Gujarati" | "Gurmukhi" | "Odia" | "Other" | "None";

const RANGES: Array<[Script, number, number]> = [
  ["Devanagari", 0x0900, 0x097f], ["Bengali", 0x0980, 0x09ff], ["Gurmukhi", 0x0a00, 0x0a7f], ["Gujarati", 0x0a80, 0x0aff], ["Odia", 0x0b00, 0x0b7f],
  ["Tamil", 0x0b80, 0x0bff], ["Telugu", 0x0c00, 0x0c7f], ["Kannada", 0x0c80, 0x0cff], ["Malayalam", 0x0d00, 0x0d7f],
];

const LATIN_LETTER = /\p{Script=Latin}/u;
const ANY_LETTER = /\p{L}/u;
function scriptOf(cp: number): Script | null {
  for (const [s, lo, hi] of RANGES) if (cp >= lo && cp <= hi) return s; // the nine Indic blocks, vowel signs and all (as before)
  const ch = String.fromCodePoint(cp);
  if (!ANY_LETTER.test(ch)) return null; // digits, punctuation, spaces and combining marks of any other script are not counted
  if (LATIN_LETTER.test(ch)) return "Latin"; // the whole Latin script (Latin-1, Extended-A/B, Extended Additional ...), not a hand-picked range
  return "Other"; // Arabic (Urdu), Ol Chiki, Meitei, Cyrillic, Greek, CJK, ... every other letter
}

/**
 * G58 — Greek letters used as medical / unit SYMBOLS: alpha, beta, gamma, kappa, mu (and the micro sign U+00B5), as in "beta-hCG", "5 mu g", "alpha-fetoprotein", "kappa light chains". Next to Latin
 * letters or digits they are not a second language, so they are left out of the script counts when the rest of the text is Latin; a text made of nothing but such glyphs (no Latin
 * letter, no digit) and every other non-Latin letter (Greek words included) still counts.
 */
const SYMBOL_GLYPHS = new Set(["\u03b1", "\u03b2", "\u03b3", "\u03ba", "\u03bc", "\u00b5"]);
const HAS_LATIN_OR_DIGIT = /[\p{Script=Latin}0-9]/u;

/** The script of every counted letter of the text, in order (symbol glyphs skipped when the line is otherwise Latin). */
function scriptsOfText(text: string): Script[] {
  const skipSymbols = HAS_LATIN_OR_DIGIT.test(text);
  const out: Script[] = [];
  for (const ch of text) {
    if (skipSymbols && SYMBOL_GLYPHS.has(ch.toLowerCase())) continue;
    const s = scriptOf(ch.codePointAt(0)!);
    if (s) out.push(s);
  }
  return out;
}

/** The script that holds most of the text's letters ("None" when it has no letter). Deterministic: ties go to the non-Latin script. */
export function detectScript(text: string): Script {
  const n = new Map<Script, number>();
  for (const s of scriptsOfText(text)) n.set(s, (n.get(s) ?? 0) + 1);
  let best: Script = "None";
  let bestN = 0;
  for (const [s, c] of n) if (c > bestN || (c === bestN && best === "Latin")) { best = s; bestN = c; }
  return best;
}

/** True when the text's own script proves it is not English (any Indic script). Latin-script text is never proven non-English here. */
export const isIndicScript = (s: Script): boolean => s !== "Latin" && s !== "None" && s !== "Other";

/** True when the script is anything but Latin: an Indic script OR any other (Arabic / Urdu, Ol Chiki, Meitei, ...). "None" (no letter) is neither. */
export const isNonLatinScript = (s: Script): boolean => s !== "Latin" && s !== "None";

/** Share of the text's letters that are NOT Latin letters, of whatever script (0..1; 0 for a text with no letter). The English check uses this, not the Indic share (G52). */
export function nonLatinLetterRatio(text: string): number {
  const all = scriptsOfText(text);
  const non = all.filter((s) => s !== "Latin").length;
  return all.length ? non / all.length : 0;
}

/** Is a whole text mostly in an Indic script? */
export const hasIndicScript = (text: string): boolean => isIndicScript(detectScript(text));

/** Share of the text's letters that are written in an Indic script (0..1; 0 for a text with no letter). */
export function indicLetterRatio(text: string): number {
  let indic = 0, letters = 0;
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!);
    if (!s) continue;
    letters += 1;
    if (isIndicScript(s)) indic += 1;
  }
  return letters ? indic / letters : 0;
}
