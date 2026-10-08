/**
 * lib/jobs/kinds/sarvam-english.ts — S8A4: the English track of a Sarvam transcription. PURE (no I/O).
 *
 * The English comes from the AUDIO (a second saaras:v3 pass in translate mode), not from trusting the file-level language_code, which saaras sets once per file
 * (en-IN for a consult that is mostly English even when a Kannada line is in it). The two passes have their own diarized entries and their own timelines:
 *   - the NATIVE entries (transcribe / codemix pass) stay exactly as Sarvam returned them, with the script of their own text recorded;
 *   - the ENGLISH entries (translate pass) are aligned to the native ones by time overlap, each to the native entry it overlaps most;
 *   - nothing is dropped: an English entry with no native partner stays in `english_entries` (native_idx null); a native entry with no English partner is
 *     handled by the caller (Latin script -> the entry is already English text; an Indic script -> mayura translates that one entry).
 */
import { detectScript, isIndicScript } from "@/lib/script-detect";
import { drugCandidates, type Lexicon } from "@/lib/drug-match";
import type { EnglishEntry, ResultDoc, ResultEntry } from "./sarvam-common";

export type RawEntry = { speaker_id: string; start_s: number; end_s: number; text: string; language_code?: string | null };

/** Record each native entry's own script (and keep Sarvam's per-entry language if the response had one). */
export function tagNative(entries: RawEntry[]): ResultEntry[] {
  return entries.map((e) => ({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text: e.text, script: detectScript(e.text), language_code: e.language_code ?? null }));
}

const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);

/** The index of the native entry an English entry belongs to: the one it overlaps most in time; for a point-like entry, the one that contains its midpoint; else null. */
function partnerOf(e: RawEntry, native: ResultEntry[]): number | null {
  let best = -1;
  let bestOv = 0;
  native.forEach((n, i) => {
    const ov = overlap(e.start_s, e.end_s, n.start_s, n.end_s);
    if (ov > bestOv) { best = i; bestOv = ov; }
  });
  if (best >= 0) return best;
  const mid = (e.start_s + e.end_s) / 2;
  const at = native.findIndex((n) => mid >= n.start_s && mid <= n.end_s);
  return at >= 0 ? at : null;
}

/** Set `english` on the native entries from the translate-pass entries and return the English track. Mutates `native`. */
export function alignEnglish(native: ResultEntry[], pass: RawEntry[]): EnglishEntry[] {
  const track: EnglishEntry[] = pass
    .filter((e) => e.text.trim())
    .map((e) => ({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text: e.text.trim(), source: "translate_pass" as const, native_idx: partnerOf(e, native) }));
  const byNative = new Map<number, string[]>();
  for (const t of track) if (t.native_idx !== null) byNative.set(t.native_idx, [...(byNative.get(t.native_idx) ?? []), t.text]);
  for (const [i, parts] of byNative) {
    native[i]!.english = parts.join(" ");
    native[i]!.english_source = "translate_pass";
  }
  return track;
}

/**
 * Native entries still without English after the pass (or with no pass at all): a Latin-script entry is taken as already English (saaras transcribe mode writes
 * Latin for English speech; ROMANISED Kannada would be Latin too and cannot be told apart by script, which is why the translate pass is the real English source),
 * an Indic-script entry stays undefined for mayura. Returns the indexes that still need mayura.
 */
export function settleUnpaired(native: ResultEntry[], track: EnglishEntry[]): number[] {
  const need: number[] = [];
  native.forEach((e, i) => {
    if (e.english !== undefined) return;
    if (!e.text.trim()) { e.english = ""; return; }
    const script = detectScript(e.text);
    if (isIndicScript(script)) { need.push(i); return; }
    e.english = e.text;
    e.english_source = "native_latin";
    track.push({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text: e.text, source: "native_latin", native_idx: i });
  });
  return need;
}

/** After mayura: add the entries it translated to the English track. */
export function addMayura(native: ResultEntry[], track: EnglishEntry[], idxs: number[]): void {
  for (const i of idxs) {
    const e = native[i]!;
    if (e.english_source === "mayura" && e.english) track.push({ speaker_id: e.speaker_id, start_s: e.start_s, end_s: e.end_s, text: e.english, source: "mayura", native_idx: i });
  }
}

/** Order the English track by time (stable), set doc.english, and compute the drug-name candidates over it. Never alters any text. */
export function finalizeEnglish(doc: ResultDoc, lex: Lexicon): void {
  const track = [...(doc.english_entries ?? [])]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.start_s - b.t.start_s || a.t.end_s - b.t.end_s || a.i - b.i)
    .map((x) => x.t);
  doc.english_entries = track;
  doc.english = track.map((t) => t.text).filter(Boolean).join(" ");
  doc.drug_candidates = track.flatMap((t, i) => drugCandidates(t.text, i, lex));
}
