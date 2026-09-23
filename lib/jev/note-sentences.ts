/**
 * lib/jev/note-sentences.ts — U4/U8 (PLAN-v3 §F, order NOTE-SAFETY-SHADOW.md): turning a generated
 * note into the atomic units U4 checks, and giving each one a transcript excerpt to check against.
 *
 * PURE. No I/O, no Jev call — every function here is fixture-testable on its own.
 */

/**
 * Splits free text into rough sentences: Latin terminators plus the Devanagari danda, or a bare
 * newline. A local copy of the same technique lib/transcript-guard.ts's splitSentences uses
 * (module-private there, for a different purpose — noise-stripping a transcript's leading window,
 * not scoring a note) rather than exporting and reusing that one, so this file's contract is its
 * own and does not shift if that file's noise-stripping logic changes.
 */
export function splitNoteSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type FlatNoteItem = { path: string; text: string };

/**
 * Walks a generated note's JSON (any note_type's shape — EncounterNote, GeneralMedicalNote,
 * OperativeProcedureNote, ... — this never hardcodes a field name, so a new note_type or a field
 * added to an existing one is covered automatically) and returns every leaf worth checking:
 *   - a non-empty STRING leaf is split into sentences, one item per sentence
 *   - a non-empty item of a STRING ARRAY is kept whole (e.g. current_medications[i] is already
 *     one atomic clinical fact, not prose to split further)
 *   - numbers, booleans, nulls and empty strings/arrays are skipped — nothing to check
 * `path` is a dot/bracket path (e.g. "plan.treatment[1]") for a stable, traceable subject_id and
 * for a human reading jev_decision rows to see where a flagged sentence came from — no note or
 * transcript text is IN the path, only field names.
 */
export function flattenNoteText(note: unknown, prefix = ""): FlatNoteItem[] {
  const out: FlatNoteItem[] = [];
  if (typeof note === "string") {
    const trimmed = note.trim();
    if (!trimmed) return out;
    for (const sentence of splitNoteSentences(trimmed)) out.push({ path: prefix, text: sentence });
    return out;
  }
  if (Array.isArray(note)) {
    note.forEach((item, i) => {
      const itemPath = `${prefix}[${i}]`;
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed) out.push({ path: itemPath, text: trimmed }); // kept whole, not re-split
      } else {
        out.push(...flattenNoteText(item, itemPath));
      }
    });
    return out;
  }
  if (note !== null && typeof note === "object") {
    for (const [key, value] of Object.entries(note as Record<string, unknown>)) {
      out.push(...flattenNoteText(value, prefix ? `${prefix}.${key}` : key));
    }
  }
  return out;
}

/**
 * The "nearest window" fallback (order NOTE-SAFETY-SHADOW.md §1): no note sentence carries a real
 * transcript citation today (lib/note-generation.ts's generateNote takes the whole transcript as
 * one string with no span tracking), so there is nothing to cite FROM. When the whole transcript
 * fits the shared state comfortably, every sentence gets the SAME excerpt — the whole transcript
 * IS the nearest window in the degenerate case where there is only one window. When it does not
 * fit (JevStateTooLargeError's guard is ~100k chars for a WHOLE fan-out call, shared across every
 * sentence's question text too, so the safe per-excerpt budget is well under that), the transcript
 * is split into equal-sized windows and a sentence at position `index` of `total` in the note gets
 * the window at the SAME proportional position in the transcript — a positional heuristic, not a
 * semantic one, and the honest one available without real citations.
 */
export function excerptForIndex(transcript: string, index: number, total: number, maxChars: number): string {
  if (transcript.length <= maxChars || total <= 0) return transcript;
  const windowCount = Math.max(1, Math.ceil(transcript.length / maxChars));
  const windowSize = Math.ceil(transcript.length / windowCount);
  const windowIndex = Math.min(windowCount - 1, Math.floor((index / total) * windowCount));
  return transcript.slice(windowIndex * windowSize, (windowIndex + 1) * windowSize);
}

/**
 * Groups flattened note items by the excerpt they resolve to, so lib/jev/ask.ts can fan out every
 * sentence sharing ONE excerpt into a SINGLE systemOne call (plan principle 7: many questions,
 * one state) instead of one call per sentence. A short transcript produces exactly one group (the
 * whole transcript); a long one produces as many groups as excerptForIndex's window count.
 */
export function groupNoteItemsByExcerpt(items: FlatNoteItem[], transcript: string, maxChars: number): Array<{ excerpt: string; items: FlatNoteItem[] }> {
  const total = items.length;
  const byExcerpt = new Map<string, FlatNoteItem[]>();
  items.forEach((item, i) => {
    const excerpt = excerptForIndex(transcript, i, total, maxChars);
    const group = byExcerpt.get(excerpt) ?? [];
    group.push(item);
    byExcerpt.set(excerpt, group);
  });
  return [...byExcerpt.entries()].map(([excerpt, groupItems]) => ({ excerpt, items: groupItems }));
}
