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
 *   · a loop whose repeats STRAIN ACROSS a line break (the router joins segments with newlines, and a
 *     segment boundary rarely falls on a unit boundary) is collapsed too, layout kept (stage 3, below);
 *   · a unit that is or contains a NUMBER is never collapsed, in either script — see NUMBER EXEMPTION.
 *
 * 24 SEP CHANGE (Fable rulings 116 and 141). Measured on production, 24 Sep: 13 of 168 window transcripts
 * still held a canonical loop AFTER this guard, 12 of them blocked by ONE rule: any unit containing a lexicon
 * number word was exempt, and the lexicon holds everyday words (`do`, `one`, `half`), so a 6-12 word phrase
 * with one such word in it was never collapsed. Two more gaps hid behind that one: loops across a line break
 * (12 of 13) and units of 9-12 words (5 of 13). Fixing any one alone cleared 0 of 13.
 *
 * NUMBER EXEMPTION, as it is now. Clinical content beats dedupe (Fable, ruling 141): repeated numbers and
 * dosing are never removed.
 *   · a unit containing a DIGIT of any script is NEVER collapsed, whatever else is in it;
 *   · a unit is exempt when number WORDS are at least NUMBER_EXEMPT_FRACTION (a third) of it, so a short
 *     dose phrase ("ek goli subah", "पचास milligram", "quarter tablet") is exempt while a long phrase that
 *     happens to hold one everyday word is not;
 *   · a single word that is a number is exempt, as before ("one one one" is 1-1-1).
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
/** The longest repeated unit considered. Was 8; production loops of 9 and 12 words slipped past it (24 Sep). */
export const MAX_PHRASE_WORDS = 12;
/** A unit is number-exempt when number WORDS are at least this share of its words (digits always exempt). */
export const NUMBER_EXEMPT_FRACTION = 1 / 3;

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

/**
 * WARNING — foldToken DELETES punctuation, so "1.5" folds to "15" and two doses a factor of ten apart compare EQUAL here.
 * Nothing but the digit rule in isNumberExemptUnit (a unit containing a digit is never collapsed) keeps them apart.
 * Do not "tidy" this fold, and do not narrow that digit rule, without re-reading this line. (Line comparison uses
 * foldText, which turns punctuation into a space, so that path is safe on its own.) ETA-Refuter, 24 Sep.
 */
const foldToken = (w: string): string => w.toLowerCase().replace(PUNCT, "");

/** True when the word carries a digit of any script or a vulgar fraction. */
const hasNumericChar = (w: string): boolean => NUMERIC_CHAR.test(w);

/**
 * PURE — is this repeated unit protected from collapse because of the numbers in it?
 * A digit anywhere protects it, absolutely. Otherwise it is protected when number WORDS are a third or more of it.
 */
export function isNumberExemptUnit(unit: readonly string[]): boolean {
  if (unit.length === 0) return false;
  if (unit.some(hasNumericChar)) return true;
  return unit.filter((w) => isNumberToken(w)).length / unit.length >= NUMBER_EXEMPT_FRACTION;
}

/**
 * PURE — collapse consecutive repeats over a list of items, where `word(item)` is the text of one word. Runs to a
 * fixed point. Generic so the same rules serve one line (items are words) and a whole text (items carry their line).
 * Returns the ORIGINAL array when nothing was collapsed.
 */
function collapseUnits<T>(items: readonly T[], word: (t: T) => string): readonly T[] {
  let current: readonly T[] = items;
  for (let guard = 0; guard < 16; guard++) {
    if (current.length < MIN_REPEATS) return current;
    let changed = false;
    for (let plen = Math.min(Math.floor(current.length / MIN_REPEATS), MAX_PHRASE_WORDS); plen >= 1 && !changed; plen--) {
      const out: T[] = [];
      let i = 0;
      while (i < current.length) {
        const unit = current.slice(i, i + plen);
        if (unit.length < plen) {
          out.push(...current.slice(i));
          break;
        }
        const unitWords = unit.map(word);
        let count = 1;
        let rawSame = true; // every copy is byte-identical to the unit, not merely identical after folding
        let j = i + plen;
        while (j + plen <= current.length) {
          const copy = current.slice(j, j + plen);
          if (!copy.every((w, k) => foldToken(word(w)) === foldToken(unitWords[k]!))) break;
          if (rawSame && !copy.every((w, k) => word(w) === unitWords[k])) rawSame = false;
          count++;
          j += plen;
        }
        const longEnough = plen === 1 ? unitWords[0]!.replace(PUNCT, "").length >= MIN_WORD_CHARS : unitWords.join(" ").length >= MIN_PHRASE_CHARS;
        if (count >= MIN_REPEATS) {
          if (longEnough && !isNumberExemptUnit(unitWords)) {
            out.push(...unit);
            i = j;
            changed = true;
            continue;
          }
          // A real run that is PROTECTED (a number in it, or too short to trust). When every copy is BYTE-IDENTICAL to the
          // unit, every window that lies ENTIRELY inside the run is a rotation of it: the same raw words, so the same digits,
          // number share and length, protected for the same reason. Stepping through them one at a time re-scanned the rest
          // of the run at each step: quadratic, and a digit-protected 8,000-word loop took ~9 s (measured 24 Sep, ETA-Refuter
          // F2). So step past them in one go. Two limits, each found by a differential test against the previous version:
          //  · NOT past the whole run: windows that START in its last plen-1 words reach beyond it, and a collapsible run can
          //    begin there ("1.5 wait 1.5 wait wait wait wait": the waits).
          //  · ONLY when the copies are raw-identical. Runs are matched on FOLDED tokens but protection reads the RAW words
          //    (isNumberToken splits on - and / before stripping, so "one-more" is a number word and "onemore" is not; the
          //    length test counts punctuation), so copies that differ in raw form can be protected in one window and not the
          //    next, and a window after a protected one may collapse ("wait one-more" x2 then "wait onemore" x3). Then step one
          //    word at a time, as before: quadratic in the run, but real loops are small (ETA-Refuter #550).
          const skipTo = rawSame ? Math.max(i + 1, j - plen + 1) : i + 1;
          for (let k = i; k < skipTo; k++) out.push(current[k]!);
          i = skipTo;
          continue;
        }
        out.push(current[i]!);
        i++;
      }
      if (changed) current = out;
    }
    if (!changed) return current;
  }
  return current;
}

/** PURE — one line with its consecutive repeats collapsed. Runs to a fixed point. */
export function collapseLine(line: string): string {
  const words = line.split(/\s+/u).filter((w) => w.length > 0);
  const kept = collapseUnits(words, (w) => w);
  return kept === words ? line : kept.join(" ");
}

/**
 * PURE — STAGE 3: loops whose repeats strain across a line break. The router joins segments with newlines and a
 * segment boundary rarely falls on a unit boundary, so a 6-word phrase said ten times is often 3-4 lines that no
 * per-line pass can see whole. The words of the whole text are collapsed as one stream (same rules, same
 * exemptions) and put back on their own lines. A line none of whose words were removed comes back BYTE-IDENTICAL;
 * a line that lost every word is dropped; blank lines stay as layout.
 */
export function collapseAcrossLines(lines: readonly string[]): { lines: string[]; touched: number } {
  type Tok = { w: string; line: number };
  const toks: Tok[] = [];
  lines.forEach((ln, line) => {
    for (const w of ln.split(/\s+/u)) if (w.length > 0) toks.push({ w, line });
  });
  const kept = collapseUnits(toks, (t) => t.w);
  if (kept === toks) return { lines: [...lines], touched: 0 };
  const keptPerLine = new Map<number, string[]>();
  for (const t of kept) keptPerLine.set(t.line, [...(keptPerLine.get(t.line) ?? []), t.w]);
  const before = new Map<number, number>();
  for (const t of toks) before.set(t.line, (before.get(t.line) ?? 0) + 1);
  const out: string[] = [];
  let touched = 0;
  lines.forEach((ln, line) => {
    const had = before.get(line) ?? 0;
    const now = keptPerLine.get(line)?.length ?? 0;
    if (had === 0) out.push(ln); // blank line: layout
    else if (now === had) out.push(ln); // untouched: byte-identical
    else {
      touched++;
      if (now > 0) out.push(keptPerLine.get(line)!.join(" "));
    }
  });
  return { lines: out, touched };
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
  // STAGE 3 — loops across a line break, on what stages 1 and 2 left. Counted as collapsed units (lines touched).
  const across = collapseAcrossLines(kept);
  const out = across.lines.join("\n");
  return { text: out, units_collapsed: units + across.touched, lines_dropped: dropped, changed: out !== raw };
}

/**
 * PURE — segment texts joined with one separator, collapsed as one body. This is the call site's shape:
 * the loop only becomes visible after the join, so the join happens first and the collapse second.
 */
export function joinAndCollapse(segments: readonly string[], separator = " "): CollapseResult {
  return collapseAssembled(segments.join(separator).trim());
}
