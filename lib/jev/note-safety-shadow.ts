/**
 * lib/jev/note-safety-shadow.ts — U4 + U8 shadow wiring (order NOTE-SAFETY-SHADOW.md).
 *
 * runNoteSafetyShadow is the fire-and-forget entry point: every note-write call site in
 * app/[slug]/api/encounters/[id]/process/route.ts calls it, unconditionally, right after a
 * successful note_json write. It checks its OWN flag first and returns immediately when off —
 * "flag off => zero Jev calls" holds before any DB read, let alone any Jev call. When on, it
 * reads the encounter back, splits the note into atomic units (lib/jev/note-sentences.ts), fans
 * U4 out per group of sentences sharing one transcript excerpt, asks U8 once per encounter, and
 * lets lib/jev/ask.ts do the rest — confidence bands, counters, and persistence to jev_decision.
 * Nothing here reads a result back to change anything: results exist only in jev_decision.
 *
 * NEVER THROWS TO ITS CALLER. A pipeline step's response must never depend on this succeeding.
 */
import "./prompts/note-safety-v1"; // module-load registration side effect
import { parseFlag } from "@/lib/flags";
import { sql } from "@/lib/db";
import { askJev, type JevAsk } from "./ask";
import { safeJevErrorMessage } from "./safe-error";
import { flattenNoteText, groupNoteItemsByExcerpt } from "./note-sentences";
import { NOTE_COMPLETENESS_PROMPT_VERSION, NOTE_FAITHFULNESS_PROMPT_VERSION, type CompletenessQuestionId } from "./prompts/note-safety-v1";

export const NOTE_SAFETY_FLAG = "JEV_NOTE_FAITHFULNESS";

/** Well under lib/jev/client.ts's ~100k-char JevStateTooLargeError guard, leaving room in the
 * same call for every fanned-out sentence's own question instructions text. */
const EXCERPT_MAX_CHARS = 20_000;

const COMPLETENESS_QUESTION_IDS: CompletenessQuestionId[] = [
  "allergies_addressed",
  "follow_up_stated",
  "red_flag_advice_given",
  "medication_instructions_complete",
];

type EncounterRow = { id: string; note_json: unknown; transcript_clean: string | null };

export type NoteSafetyShadowOutcome = { ran: boolean; u4Sentences: number; u8Questions: number };

/**
 * The awaited half. Exported separately from runNoteSafetyShadow because the replay command
 * (order §3) wants the outcome, not a fire-and-forget void — the pipeline hook below is the only
 * caller that deliberately does not await it.
 */
export async function runNoteSafetyShadowAsync(encounterId: string): Promise<NoteSafetyShadowOutcome> {
  if (!parseFlag(NOTE_SAFETY_FLAG)) return { ran: false, u4Sentences: 0, u8Questions: 0 };

  const rows = (await sql`
    SELECT id, note_json, transcript_clean FROM encounter WHERE id = ${encounterId}
  `) as EncounterRow[];
  const row = rows[0];
  if (!row || !row.note_json || !row.transcript_clean) return { ran: false, u4Sentences: 0, u8Questions: 0 };

  const transcript = row.transcript_clean;

  // U4 — fan out every note sentence, grouped by the excerpt it resolves to (the "nearest
  // window" fallback, lib/jev/note-sentences.ts), so sentences sharing an excerpt share one call.
  const items = flattenNoteText(row.note_json);
  const groups = groupNoteItemsByExcerpt(items, transcript, EXCERPT_MAX_CHARS);
  let u4Sentences = 0;
  for (const group of groups) {
    if (group.items.length === 0) continue;
    const asks: JevAsk[] = group.items.map((item, i) => ({
      answerKey: `s${i}`,
      subjectType: "note_sentence",
      subjectId: `${encounterId}:${item.path}`,
      questionId: "note_sentence_supported",
      promptVersion: NOTE_FAITHFULNESS_PROMPT_VERSION,
      args: [`s${i}`, item.text],
    }));
    await askJev({ transcript_excerpt: group.excerpt }, asks);
    u4Sentences += asks.length;
  }

  // U8 — one ask per encounter, fanned out over the four completeness questions. Simple head
  // truncation rather than positional windowing: unlike U4's many discrete, ordered sentences,
  // there is no meaningful "position" to map a completeness question onto.
  const u8Excerpt = transcript.length <= EXCERPT_MAX_CHARS ? transcript : transcript.slice(0, EXCERPT_MAX_CHARS);
  const u8Asks: JevAsk[] = COMPLETENESS_QUESTION_IDS.map((id) => ({
    answerKey: id,
    subjectType: "encounter",
    subjectId: encounterId,
    questionId: id,
    promptVersion: NOTE_COMPLETENESS_PROMPT_VERSION,
  }));
  await askJev({ note: row.note_json, transcript_excerpt: u8Excerpt }, u8Asks);

  return { ran: true, u4Sentences, u8Questions: u8Asks.length };
}

/** Fire-and-forget: never awaited, never throws. Every note-write call site calls this one line,
 * unconditionally — the flag check and all error handling live here, not at each call site. */
export function runNoteSafetyShadow(encounterId: string): void {
  void runNoteSafetyShadowAsync(encounterId).catch((e) => {
    console.warn(
      "[jev] note-safety shadow failed",
      JSON.stringify({ encounter_id: encounterId, error: safeJevErrorMessage(e) }),
    );
  });
}
