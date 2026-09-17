/**
 * lib/diarize-conversation.ts — E31 batch 2, B1 (D-6): A CONVERSATION THAT WAS LOST IS NOT SPELLED LIKE ONE THAT
 * NEVER EXISTED.
 *
 * When diarization lands (diarize_status = 'complete') but the speaker-tagged conversation that follows it does
 * not, the row used to look exactly like a legitimate run with nothing to tag — a non-English encounter with no
 * Sarvam entries, or a Deepgram answer that was not ok. The doctor saw a speaker panel with no conversation, and
 * nothing anywhere could tell "there was nothing to show" from "we lost it".
 *
 * The degraded state is named in diarize_error with this CLOSED CODE, and diarize_status stays 'complete' so its
 * two readers (the step gate needDiarize, and the EER matcher) are undisturbed. No migration: diarize_error is
 * nullable text, W1 sets it to NULL on success, and no reader treats it as contradicting 'complete'.
 *
 * Pure and dependency-free on purpose: the process route writes it, the doctor's encounter page reads it, and
 * neither may pull the other's imports in.
 */
export const DIARIZE_ERROR_CONVERSATION_NOT_RECORDED = "tagged_transcript_not_recorded";

/** True only for the named degraded state — never for a legitimate run that had no conversation to tag. */
export function conversationUnavailable(diarizeStatus: string | null, diarizeError: string | null): boolean {
  return diarizeStatus === "complete" && diarizeError === DIARIZE_ERROR_CONVERSATION_NOT_RECORDED;
}
