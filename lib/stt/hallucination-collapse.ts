/**
 * lib/stt/hallucination-collapse.ts — Whisper "triplicate"/loop hallucinations: the collapse rule and the
 * measures that prove it is safe. Ported from the router's fixed rule (`~/eta-router` `router_server.py`,
 * `vinay/router-stt-hygiene`, round 2, ETA-ROUTER-STT-HYGIENE-REFUTER-22-SEP-2026.md, Refuter PASS) so the
 * SAME behaviour this repo depends on for clinical safety is pinned by this repo's own test suite, not only
 * by a different repo's Python tests. It is a PORT, not the source of truth for the router — the router is
 * still what runs in production; lx's item-1 build (23 Sep, ~/dev/_fable/for-minibot-lexicon-23-sep.md) is
 * the parity check between the router's real number lexicon and the shim's. This module's own NUMBER_WORDS
 * is a small representative subset for these fixtures, not the 0-100 lexicon (see NUMBER_WORDS below).
 *
 * THE ONE RULE THAT MATTERS CLINICALLY (round 2's fix, replacing round 1's Jaccard-on-word-sets rule that
 * FAILED review): a segment is dropped as a duplicate only when it is IDENTICAL TO THE PREVIOUS ONE AFTER
 * FOLDING — case, ASCII punctuation, danda and whitespace only. Word order, repetition and every token still
 * count. "Take 2 tablets in the morning and 1 tablet at night" and "Take 1 tablet in the morning and 2
 * tablets at night" are NOT duplicates under this rule (round 1's Jaccard-on-sets rule merged them — the
 * swapped-dose finding). Within a line, a repeated word or phrase collapses only at 3+ repeats, and a
 * number word or digit is NEVER folded away — "one one one" (a spoken 1-1-1 regimen) survives untouched.
 *
 * WHAT THIS FILE DOES NOT DO: read or write any real transcript. Every fixture below is synthetic.
 */

// ── Folding — the one normalisation the duplicate test is allowed to use ─────────────────────────────────
const WS = /\s+/g;
// ASCII punctuation (the router's range) plus the Devanagari danda / double danda.
const PUNCT_FOLD = /[!-/:-@[-`{-~।॥]/g;

/** PURE. Case, ASCII punctuation, danda and whitespace folded away — nothing else. A broader fold would
 *  delete Indic vowel signs and merge distinct words (the router's own comment; ported verbatim). */
export function foldText(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(PUNCT_FOLD, " ").replace(WS, " ").trim();
}

/** PURE. The ONLY duplicate test. Word order, repetition and every token count; empty is never a duplicate. */
export function identicalAfterFold(a: string | null | undefined, b: string | null | undefined): boolean {
  const fa = foldText(a);
  const fb = foldText(b);
  return fa.length > 0 && fa === fb;
}

// ── Number words — a REPRESENTATIVE SUBSET for these fixtures, not the production 0-100 lexicon ──────────
/**
 * The router builds its real set from `number_lexicon()` (0-100, English/Hindi/Kannada, romanised and
 * native script) plus fraction/ordinal/magnitude extras. Porting that whole table here would duplicate lx's
 * parity job for no benefit — this file only needs enough words to prove the EXEMPTION RULE itself: that a
 * number token is never collapsed regardless of script or transliteration. Kept small and named per fixture.
 */
export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  // English, spelled
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  // Hindi, romanised and Devanagari (dose-relevant: one/two/three, and the 1-1-1 regimen word)
  "ek", "do", "teen", "एक", "दो", "तीन",
  // Kannada, romanised and script (dose-relevant: one/two/three)
  "ondu", "eradu", "moru", "mooru", "ಒಂದು", "ಎರಡು", "ಮೂರು",
]);

const NUMBER_PART_SPLIT = /[-/]/;
/** Any character with a Unicode numeric value: ASCII and Indic digits, ½, ¼, ¾, Roman numerals — same test
 *  the router runs, via the one JS gives an equivalent primitive for (`Number` on a single code point). */
function hasNumericChar(w: string): boolean {
  for (const ch of w) {
    if (/\p{Nd}/u.test(ch)) return true; // decimal digit, any script
    if ("½¼¾".includes(ch)) return true;
    if (/^[IVXLCDM]$/i.test(ch) && w.length === 1) return true; // a lone roman-numeral letter
  }
  return false;
}

/** PURE. True for a token holding any numeric character or a known number word, ignoring case and
 *  surrounding punctuation. A hyphen- or slash-joined token ("ek-ek", "1-0-1") is a number if any part is. */
export function isNumberToken(word: string, numberWords: ReadonlySet<string> = NUMBER_WORDS): boolean {
  const raw = (word ?? "").toLowerCase();
  for (const part of [raw, ...raw.split(NUMBER_PART_SPLIT)]) {
    const w = part.replace(PUNCT_FOLD, "").trim();
    if (w && (hasNumericChar(w) || numberWords.has(w))) return true;
  }
  return false;
}

// ── Within-line loop collapse ────────────────────────────────────────────────────────────────────────────
export const COLLAPSE_MIN_REPEATS = 3;

/** PURE. Collapses one line's word-level repeat loops. `plen` shrinks from a cap down to 1 so the LONGEST
 *  repeated phrase wins first (matches the router: a 2-word loop is collapsed before falling back to
 *  1-word). A hit restarts the scan (loops can nest); the function is idempotent — collapsing its own output
 *  changes nothing, because after one pass no run of `plen` words repeats 3+ times any more. */
function collapseLine(line: string, numberWords: ReadonlySet<string>): string {
  let cur = line;
  for (;;) {
    const words = cur.split(/\s+/).filter(Boolean);
    const n = words.length;
    let hitLine: string | null = null;
    for (let plen = Math.min(Math.floor(n / COLLAPSE_MIN_REPEATS), 24); plen >= 1; plen--) {
      const out: string[] = [];
      let i = 0;
      let hit = false;
      while (i < n) {
        const phrase = words.slice(i, i + plen);
        if (phrase.length < plen) {
          out.push(...words.slice(i));
          break;
        }
        let count = 1;
        let j = i + plen;
        while (j + plen <= n && words.slice(j, j + plen).join(" ") === phrase.join(" ")) {
          count += 1;
          j += plen;
        }
        const longEnough =
          plen === 1
            ? phrase[0]!.length >= 3 && !isNumberToken(phrase[0]!, numberWords)
            : phrase.join(" ").length >= 8 && !phrase.some((w) => isNumberToken(w, numberWords));
        if (count >= COLLAPSE_MIN_REPEATS && longEnough) {
          out.push(...phrase);
          i = j;
          hit = true;
          continue;
        }
        out.push(words[i]!);
        i += 1;
      }
      if (hit) {
        hitLine = out.join(" ");
        break;
      }
    }
    if (hitLine === null || hitLine === cur) return cur;
    cur = hitLine;
  }
}

/** PURE. Collapses within-text loops, line by line, so line structure survives. Idempotent — collapsing its
 *  own output changes nothing. A blank line passes through unchanged. */
export function collapsePhraseLoops(text: string | null | undefined, numberWords: ReadonlySet<string> = NUMBER_WORDS): string {
  if (!text) return text ?? "";
  return text.split("\n").map((ln) => (ln.trim() ? collapseLine(ln, numberWords) : ln)).join("\n");
}

// ── Cross-segment dedupe ─────────────────────────────────────────────────────────────────────────────────
export const DEDUPE_MAX_GAP_S = 1.5;

export type CollapseSegment = { text: string | null; start_s?: number; end_s?: number | null; speaker?: string | null };

/** PURE. Drops a segment only when it is identical after folding to the last KEPT segment, directly follows
 *  it (gap <= DEDUPE_MAX_GAP_S, using the KEPT segment's — possibly already extended — end_s) and is not
 *  from a different NAMED speaker (absent speaker on either side never blocks the drop). Its end_s is folded
 *  into the kept one. A segment with no text is kept and never compared (a refused/low-confidence row).
 *  Input is not mutated. Idempotent: one pass leaves no neighbouring pair meeting the rule. */
export function collapseSegments<T extends CollapseSegment>(segments: readonly T[]): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    const prev = kept.length ? kept[kept.length - 1]! : null;
    if (text && prev && identicalAfterFold(text, prev.text) && sameSpeaker(prev, seg)) {
      const gap = gapSeconds(prev, seg);
      if (gap !== null && gap <= DEDUPE_MAX_GAP_S) {
        if (seg.end_s != null && (prev.end_s == null || seg.end_s > prev.end_s)) {
          kept[kept.length - 1] = { ...prev, end_s: seg.end_s };
        }
        dropped += 1;
        continue;
      }
    }
    kept.push({ ...seg });
  }
  return { kept, dropped };
}

function sameSpeaker(a: CollapseSegment, b: CollapseSegment): boolean {
  return a.speaker == null || b.speaker == null || a.speaker === b.speaker;
}
function gapSeconds(prev: CollapseSegment, seg: CollapseSegment): number | null {
  if (typeof seg.start_s !== "number" || typeof prev.end_s !== "number") return null;
  return seg.start_s - prev.end_s;
}

// ── Diagnostic measures (item 1's live-data metrics, defined here so the pack can assert the SIGNAL is
//    trustworthy on synthetic fixtures, not only that the fix compiles) ────────────────────────────────────

/** PURE. Overlapping N-grams of whitespace-delimited tokens (folded, so punctuation never manufactures a
 *  false distinct gram). Empty for text shorter than N tokens. */
function ngrams(text: string, n: number): string[] {
  const words = foldText(text).split(" ").filter(Boolean);
  if (words.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  return out;
}

/**
 * PURE. `1 - distinct 3-grams / total 3-grams`: 0 for text with no repeated 3-word run at all, rising toward
 * 1 as the text becomes one repeated phrase. N=3 matches COLLAPSE_MIN_REPEATS — the same repeat count the
 * collapse rule itself treats as a loop, so this measure and the fix agree on what "repeats" means. Returns
 * 0 (not NaN) for text shorter than 3 tokens — nothing to repeat is not evidence of a loop.
 */
export function repeatRatio(text: string | null | undefined): number {
  const grams = ngrams(text ?? "", 3);
  if (grams.length === 0) return 0;
  return 1 - new Set(grams).size / grams.length;
}

/** PURE. The 4-gram → occurrence-count table (folded tokens), for spotting which specific phrase is
 *  looping. Empty for text shorter than 4 tokens. */
export function fourGramFrequency(text: string | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const g of ngrams(text ?? "", 4)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return counts;
}

/** PURE. The longest run of consecutive sentences that are identical after folding (splits on ., !, ? or a
 *  danda followed by whitespace/end; a sentence with no letters or digits is ignored, not counted as a run
 *  of its own). 0 or 1 for text with no repeated sentence. */
export function identicalSentenceRuns(text: string | null | undefined): number {
  const sentences = (text ?? "")
    .split(/[.!?।॥]+\s*/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
  let longest = sentences.length > 0 ? 1 : 0;
  let run = longest;
  for (let i = 1; i < sentences.length; i++) {
    run = identicalAfterFold(sentences[i], sentences[i - 1]) ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return longest;
}
