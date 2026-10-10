/**
 * lib/jev/prompts/timeline-v1.ts — the four Jev questions the pre-STT TIMELINE run asks about one segment
 * (epic #23, ticket f). prompt_version "u10-timeline-v1".
 *
 * INPUT IS ONLY THE TIMELINE STATE (lib/encounter-clock/timeline.ts): relative times, speaker letters, counts. No
 * transcript, no audio, no names. Jev may veto a boundary; it never decides whether sound exists (acoustics do).
 *
 * WORDING IS UNTRIALLED. PLAN v3.1 §1.6 requires 2–3 wordings benched on ~40 V-labelled segments before this text is
 * hard-coded. That trial has NOT been run (it needs the labelled segments and live Jev). This is the first wording,
 * the shadow flag ENCOUNTER_TIMELINE_SHADOW is off by default, and a stored answer carries this version string so the
 * rows are separable from a trialled wording later. Bumping the wording means bumping the version.
 *
 * u10_end_row  choice  options built per call: every row label of the segment + continues_past_segment + cannot_tell
 * u10_end_signal choice doctor_alone_then_quiet | voices_leave_then_new_voice | long_silence | tape_or_mic_loss | end_click_consistent | cannot_tell
 * u10_late_start noul   did the consultation start later than the anchor
 * u10_kind     choice  consultation | staff_or_admin | phone_call | empty_room | cannot_tell
 */
import { isJevQuestionRegistered, registerJevQuestion } from "../registry";
import type { JevChoiceQ, JevNoulQ } from "../types";

export const U10_PROMPT_VERSION = "u10-timeline-v1";
export const U10_END_ROW_ID = "u10_end_row";
export const U10_END_SIGNAL_ID = "u10_end_signal";
export const U10_LATE_START_ID = "u10_late_start";
export const U10_KIND_ID = "u10_kind";

export const U10_CONTINUES = "continues_past_segment";
export const U10_CANNOT_TELL = "cannot_tell";

export const U10_END_SIGNAL_OPTIONS = [
  "doctor_alone_then_quiet", "voices_leave_then_new_voice", "long_silence", "tape_or_mic_loss", "end_click_consistent", "cannot_tell",
] as const;
export type U10EndSignal = (typeof U10_END_SIGNAL_OPTIONS)[number];

export const U10_KIND_OPTIONS = ["consultation", "staff_or_admin", "phone_call", "empty_room", "cannot_tell"] as const;
export type U10Kind = (typeof U10_KIND_OPTIONS)[number];

const STATE_NOTE =
  "The state is a timeline of one clinic room, in 30-second rows, from sound and speaker-turn measurements only. " +
  "Each row has: sound (active, quiet, dead_mic, tape_off or unjudged), speech_s (seconds of speech; null means not measured, not zero), " +
  "spk (seconds per speaker; DOC is the consulting doctor, other letters are other voices), turns, overlap_s and new_spk (voices first heard in that row). " +
  "The header gives the Start-click row t+00:00 and any End click, weaker end signal and next Start.";

/** Options for u10_end_row come from the segment's own rows; labels are relative times like "t+11:30". */
export function u10EndRowQuestion(rowLabels: ReadonlyArray<string>): JevChoiceQ {
  const criteria: Record<string, string> = {};
  for (const l of rowLabels) criteria[l] = `The consultation's last exchange is in the row ${l}; the rows after it hold no consultation talk.`;
  criteria[U10_CONTINUES] = "The consultation is still going on at the end of the timeline, so its end is not inside it.";
  criteria[U10_CANNOT_TELL] = "The timeline does not give enough information to place the end.";
  return { type: "choice", instructions: `${STATE_NOTE} Decide in which row the consultation that begins at the Start click ends.`, criteria };
}

export function u10EndSignalQuestion(): JevChoiceQ {
  return {
    type: "choice",
    instructions: `${STATE_NOTE} Decide what kind of signal marks the end of the consultation that begins at the Start click.`,
    criteria: {
      doctor_alone_then_quiet: "Other voices stop and the doctor speaks alone briefly (dictating or finishing up), then the room goes quiet.",
      voices_leave_then_new_voice: "The voices of the consultation stop and, soon after, a voice not heard before starts.",
      long_silence: "Speech stops and a long stretch of quiet follows with no new voice.",
      tape_or_mic_loss: "The recording stops or the microphone goes dead.",
      end_click_consistent: "The End click in the header sits where the speech ends, within about two minutes.",
      cannot_tell: "The timeline does not give enough information to say.",
    },
  };
}

export function u10LateStartQuestion(): JevNoulQ {
  return {
    type: "noul",
    instructions: `${STATE_NOTE} The consultation started noticeably later than the Start click at t+00:00.`,
    criteria: {
      true: "Little or no speech involving the doctor and another voice happens for several minutes after the Start click, and the consultation talk begins well after t+00:00.",
      false: "The doctor and another voice are speaking at or soon after the Start click.",
    },
  };
}

export function u10KindQuestion(): JevChoiceQ {
  return {
    type: "choice",
    instructions: `${STATE_NOTE} Decide what kind of activity the stretch after the Start click is.`,
    criteria: {
      consultation: "The doctor and at least one other voice take turns speaking for a sustained stretch, as in a patient consultation.",
      staff_or_admin: "Several voices speak briefly and irregularly, as staff do when handling logistics, with no sustained doctor-and-one-voice exchange.",
      phone_call: "One voice speaks alone in long turns with gaps, as on a phone call.",
      empty_room: "There is little or no speech in the stretch.",
      cannot_tell: "The timeline does not give enough information to say.",
    },
  };
}

/** Idempotent: safe to call on every run. */
export function registerTimelineQuestions(): void {
  const all: Array<[string, () => JevChoiceQ | JevNoulQ]> = [
    [U10_END_SIGNAL_ID, u10EndSignalQuestion],
    [U10_LATE_START_ID, u10LateStartQuestion],
    [U10_KIND_ID, u10KindQuestion],
  ];
  for (const [qid, build] of all) if (!isJevQuestionRegistered(qid, U10_PROMPT_VERSION)) registerJevQuestion(qid, U10_PROMPT_VERSION, build);
  if (!isJevQuestionRegistered(U10_END_ROW_ID, U10_PROMPT_VERSION)) registerJevQuestion(U10_END_ROW_ID, U10_PROMPT_VERSION, u10EndRowQuestion);
}
