/**
 * lib/script-detect.ts — S8A4: which writing system a piece of text is in, from its letters alone. PURE.
 *
 * Sarvam returns ONE language_code for a whole file, so it cannot say that a Kannada line sits inside an English consult. The script of each entry's own text can:
 * Devanagari / Kannada / Tamil / Telugu / Malayalam / Bengali / Gujarati / Gurmukhi / Odia letters are never English. Latin letters are ambiguous (English, but
 * also ROMANISED Kannada or Hindi, which saaras transcribe mode produces), so "Latin" proves nothing about the language: callers treat it as "not proven non-English".
 */
export type Script = "Latin" | "Devanagari" | "Kannada" | "Tamil" | "Telugu" | "Malayalam" | "Bengali" | "Gujarati" | "Gurmukhi" | "Odia" | "Other" | "None";

const RANGES: Array<[Script, number, number]> = [
  ["Devanagari", 0x0900, 0x097f], ["Bengali", 0x0980, 0x09ff], ["Gurmukhi", 0x0a00, 0x0a7f], ["Gujarati", 0x0a80, 0x0aff], ["Odia", 0x0b00, 0x0b7f],
  ["Tamil", 0x0b80, 0x0bff], ["Telugu", 0x0c00, 0x0c7f], ["Kannada", 0x0c80, 0x0cff], ["Malayalam", 0x0d00, 0x0d7f],
];

function scriptOf(cp: number): Script | null {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) return "Latin";
  for (const [s, lo, hi] of RANGES) if (cp >= lo && cp <= hi) return s;
  if (/\p{L}/u.test(String.fromCodePoint(cp))) return "Other";
  return null; // digits, punctuation, spaces, combining marks of any script are not counted
}

/** The script that holds most of the text's letters ("None" when it has no letter). Deterministic: ties go to the non-Latin script. */
export function detectScript(text: string): Script {
  const n = new Map<Script, number>();
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!);
    if (s) n.set(s, (n.get(s) ?? 0) + 1);
  }
  let best: Script = "None";
  let bestN = 0;
  for (const [s, c] of n) if (c > bestN || (c === bestN && best === "Latin")) { best = s; bestN = c; }
  return best;
}

/** True when the text's own script proves it is not English (any Indic script). Latin-script text is never proven non-English here. */
export const isIndicScript = (s: Script): boolean => s !== "Latin" && s !== "None" && s !== "Other";

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
