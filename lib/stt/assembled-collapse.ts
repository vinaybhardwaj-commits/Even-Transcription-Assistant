/**
 * lib/stt/assembled-collapse.ts — the loop collapse run on ASSEMBLED transcript text, and on Indic
 * engine output, which nothing collapsed before.
 *
 * WHY IT EXISTS. Measured on production, 23 Sep: 14 of 136 stored window transcripts still held a loop
 * the router's own guard would have removed. Two causes, both structural, neither a decoding fault:
 *
 *   1. THE COLLAPSE RAN PER SEGMENT, THE TEXT IS STORED ASSEMBLED. The router collapses each segment's
 *      text, then the segments are joined (the router by newline, room-drain's shadow path by space).
 *      Three consecutive short segments each holding the same word are individually loop-free; the join
 *      makes "<word> <word> <word>" and nothing looked at the text again. 13 of the 17 residual lines
 *      were exactly this: a single word repeated, no number in it.
 *   2. INDIC ENGINE OUTPUT WAS NEVER COLLAPSED AT ALL. The router collapses only whisper text, and
 *      IndicConformer and SraVaani never pass the whisper-shim. 9 of the 14 rows were Indic script.
 *
 * WHAT IT DOES, and nothing more:
 *   · within a line, a unit (word or phrase up to MAX_PHRASE_WORDS) repeated 3+ times IN A ROW keeps one
 *     copy — identical after folding only, never fuzzy;
 *   · across lines, a line identical after folding to the line before it is dropped;
 *   · a unit that is or contains a NUMBER is never collapsed, in either script.
 *
 * WHY IDENTICAL-ONLY AND NUMBER-EXEMPT. A word-set rule merged "2 in the morning and 1 at night" with
 * its dose swap (refuted 22 Sep); a repeated number is a regimen read aloud, not a loop ("one one one"
 * is 1-1-1, "पचास milligram" three times is three doses). Applying this to Indic output is only safe
 * BECAUSE the lexicon now protects native-script numbers — that was the precondition for (2).
 *
 * The lexicon is number-words.json, generated from the router's own NUMBER_WORDS (772 words, English,
 * Hindi and Kannada, romanised and native script) and carrying its own sha256, which a test recomputes.
 * The same list is live in the whisper-shim, so one dose number is protected the same way everywhere.
 *
 * IDEMPOTENT: every pass runs to a fixed point, so collapsing twice changes nothing. PURE — no database,
 * no network, no clock.
 */
import lexicon from "./number-words.json";

export const NUMBER_WORDS: ReadonlySet<string> = new Set(lexicon.words as string[]);
export const NUMBER_WORDS_SHA: string = lexicon.lexicon_sha256 as string;

/** A word shorter than this is never collapsed on its own ("ok ok ok" survives; "okay okay okay" does not). */
export const MIN_WORD_CHARS = 3;
/** A multi-word phrase shorter than this in characters is not treated as a loop. */
export const MIN_PHRASE_CHARS = 8;
/** Repeats needed before anything is collapsed. */
export const MIN_REPEATS = 3;
/** The longest repeated unit considered. */
export const MAX_PHRASE_WORDS = 8;

/** ASCII punctuation and the danda. Nothing else: a broader strip would delete Indic vowel signs. */
const PUNCT = /[!-/:-@[-`{-~।॥]/gu;
const WS = /\s+/gu;
/** Any character with a Unicode numeric value: every script's digits, and ½ ¼ ¾ (which \d misses). */
const NUMERIC_CHAR = /[\p{Nd}\p{Nl}\p{No}]/u;
const JOINER = /[-/]/u;

/** PURE — case, ASCII punctuation, danda and whitespace folded away. */
export function foldText(s: string): string {
  return (s ?? "").toLowerCase().replace(PUNCT, " ").replace(WS, " ").trim();
}

/**
 * PURE — is this token a number? A digit of any script, a vulgar fraction, or a number word from the
 * shared lexicon. A hyphen- or slash-joined token counts if any part does ("ek-ek", "1-0-1"), which is
 * how a regimen is written; "follow-up" and "and/or" do not.
 */
export function isNumberToken(word: string): boolean {
  const raw = (word ?? "").toLowerCase();
  for (const part of [raw, ...raw.split(JOINER)]) {
    const w = part.replace(PUNCT, "").trim();
    if (!w) continue;
    if (NUMERIC_CHAR.test(w) || NUMBER_WORDS.has(w)) return true;
  }
  return false;
}

const foldToken = (w: string): string => w.toLowerCase().replace(PUNCT, "");

/** PURE — one line with its consecutive repeats collapsed. Runs to a fixed point. */
export function collapseLine(line: string): string {
  let current = line;
  for (let guard = 0; guard < 16; guard++) {
    const words = current.split(/\s+/u).filter((w) => w.length > 0);
    if (words.length < MIN_REPEATS) return current;
    let changed = false;
    for (let plen = Math.min(Math.floor(words.length / MIN_REPEATS), MAX_PHRASE_WORDS); plen >= 1 && !changed; plen--) {
      const out: string[] = [];
      let i = 0;
      while (i < words.length) {
        const unit = words.slice(i, i + plen);
        if (unit.length < plen) {
          out.push(...words.slice(i));
          break;
        }
        let count = 1;
        let j = i + plen;
        while (j + plen <= words.length && words.slice(j, j + plen).every((w, k) => foldToken(w) === foldToken(unit[k]!))) {
          count++;
          j += plen;
        }
        const longEnough = plen === 1 ? unit[0]!.replace(PUNCT, "").length >= MIN_WORD_CHARS : unit.join(" ").length >= MIN_PHRASE_CHARS;
        const hasNumber = unit.some(isNumberToken);
        if (count >= MIN_REPEATS && longEnough && !hasNumber) {
          out.push(...unit);
          i = j;
          changed = true;
          continue;
        }
        out.push(words[i]!);
        i++;
      }
      if (changed) current = out.join(" ");
    }
    if (!changed) return current;
  }
  return current;
}

export type CollapseResult = {
  text: string;
  /** How many repeated units were collapsed inside lines. */
  units_collapsed: number;
  /** How many whole lines were dropped as identical to the line before. */
  lines_dropped: number;
  changed: boolean;
};

/**
 * PURE — the collapse for assembled transcript text, whatever joined it and whatever script it is in.
 * Idempotent: the result of collapsing a collapsed text is that same text.
 */
export function collapseAssembled(text: string | null | undefined): CollapseResult {
  const raw = text ?? "";
  if (!raw.trim()) return { text: raw, units_collapsed: 0, lines_dropped: 0, changed: false };

  let units = 0;
  const lines = raw.split("\n").map((line) => {
    const collapsed = collapseLine(line);
    if (collapsed !== line) units++;
    return collapsed;
  });

  // A line identical (after folding) to the one before it is a duplicate of it. Blank lines are kept as
  // layout, and a line holding a number is never dropped: "1-0-1" twice is a regimen written twice.
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    const folded = foldText(line);
    const previous = kept.length ? foldText(kept[kept.length - 1]!) : null;
    const isNumeric = line.split(/\s+/u).filter(Boolean).some(isNumberToken);
    if (folded && folded === previous && !isNumeric) {
      dropped++;
      continue;
    }
    kept.push(line);
  }
  const out = kept.join("\n");
  return { text: out, units_collapsed: units, lines_dropped: dropped, changed: out !== raw };
}

/**
 * PURE — segment texts joined with one separator, collapsed as one body. This is the call site's shape:
 * the loop only becomes visible after the join, so the join happens first and the collapse second.
 */
export function joinAndCollapse(segments: readonly string[], separator = " "): CollapseResult {
  return collapseAssembled(segments.join(separator).trim());
}
