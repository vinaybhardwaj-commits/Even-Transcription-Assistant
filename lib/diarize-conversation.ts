/**
 * lib/diarize-conversation.ts — E31 batch 2, B1 (D-6): A DEGRADED CONVERSATION IS NOT SPELLED LIKE ONE THAT WAS
 * NEVER THERE.
 *
 * When diarization lands (diarize_status = 'complete') the speaker-tagged conversation that follows it can end three
 * ways, and they used to be indistinguishable — a speaker panel with no conversation and diarize_error NULL:
 *   - NOTHING TO TAG: a legitimate run with no utterances (the transcription service answered, with none; or a
 *     non-English encounter with no Sarvam entries). diarize_error stays NULL.
 *   - SOURCE UNAVAILABLE (round 1b): the transcription service did not answer — lib/transcribe.ts reports an outage
 *     as { ok: false }, it never throws. An upstream outage is DEGRADED, not empty.
 *   - LOST: the conversation was prepared but the write that records it did not land.
 *
 * The two degraded states are named in diarize_error with CLOSED CODES, and diarize_status stays 'complete' so its
 * two readers (the step gate needDiarize, and the EER matcher) are undisturbed. No migration: diarize_error is
 * nullable text, W1 sets it to NULL on success, and no reader treats it as contradicting 'complete'.
 *
 * Pure and dependency-free on purpose: the process route writes it, the doctor's encounter page reads it, and
 * neither may pull the other's imports in.
 */
export const DIARIZE_ERROR_CONVERSATION_NOT_RECORDED = "tagged_transcript_not_recorded";
export const DIARIZE_ERROR_CONVERSATION_SOURCE_UNAVAILABLE = "tagged_transcript_source_unavailable";

/** What the doctor's page may know about a degraded conversation. Null is "nothing is wrong" — including empty. */
export type ConversationState = "lost" | "source_unavailable" | null;

export function conversationState(diarizeStatus: string | null, diarizeError: string | null): ConversationState {
  if (diarizeStatus !== "complete") return null;
  if (diarizeError === DIARIZE_ERROR_CONVERSATION_NOT_RECORDED) return "lost";
  if (diarizeError === DIARIZE_ERROR_CONVERSATION_SOURCE_UNAVAILABLE) return "source_unavailable";
  return null;
}
