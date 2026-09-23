/**
 * lib/jev/prompts/note-safety-v1.ts — U4 (note faithfulness) + U8 (completeness prompts), PLAN-v3
 * §F, order NOTE-SAFETY-SHADOW.md, prompt_version "jev-note-safety-v1".
 *
 * U4 wording matches ~/dev/eta-lab/studies/2026-09-23-jev-opp/TRIALS-23-SEP.md's own trial
 * verdict: "State {transcript_excerpt, note_sentence} ... Best wording: v1 (simplest, ties the
 * others)" — margin 0.94-0.95 between a true and a false case, the cleanest separation of all 8
 * uses trialled. The trial ran one fixture per call; production fans many sentences from one note
 * out against ONE shared state (the transcript excerpt) in one systemOne call instead — the same
 * {transcript, sentence} content, restructured to Jev's actual "one state, many questions" shape
 * (plan principle 7) rather than one call per sentence. The sentence text lives in the QUESTION's
 * own instructions (like lib/jev/prompts/arm-d-v1.ts's phaseQuestion(windowId) referencing a
 * specific window by id from shared state) — never a second copy of it anywhere state-shaped.
 *
 * No worked examples (leakage risk, spec convention already used by arm-d-v1.ts / role-v1.ts).
 */
import { registerJevQuestion } from "../registry";
import type { JevNoulQ } from "../types";

export const NOTE_FAITHFULNESS_PROMPT_VERSION = "jev-note-safety-v1";

/**
 * `sentenceId` keys this question within the fan-out batch (matches an answerKey lib/jev/ask.ts
 * builds); `sentenceText` is the actual note text being checked, embedded in the instructions
 * because JevQuestion carries no second state slot of its own.
 */
export function noteSentenceSupportedQuestion(sentenceId: string, sentenceText: string): JevNoulQ {
  return {
    type: "noul",
    instructions: `The transcript excerpt is in the shared state above. Is this note sentence (${sentenceId}) fully supported by it: "${sentenceText}"`,
    criteria: {
      true: "Every claim in the sentence — including any dose, frequency, drug name, or finding — matches what the transcript excerpt says.",
      false: "The sentence adds, changes, or contradicts something not supported by the transcript excerpt (a different dose, frequency, drug, or a finding not mentioned).",
    },
  };
}

export const NOTE_COMPLETENESS_PROMPT_VERSION = "jev-note-safety-v1";

/** PLAN-v3 §F: "U8 = completeness prompts (allergies, follow-up, red-flag advice, medication
 * instructions)". One noul per prompt, all against the shared state (the whole note + transcript
 * excerpt) — gentle prompts, never blockers (plan §F), and never shown to a clinician in this
 * shadow build (order NOTE-SAFETY-SHADOW.md: nothing shown, no change to the note). */
export const COMPLETENESS_CRITERIA = {
  allergies_addressed: {
    instructions: "Does the note record whether the patient has any known drug allergies (including an explicit 'no known allergies')?",
    criteria: { true: "Allergy status is recorded, positive or negative.", false: "Allergy status is not mentioned anywhere in the note." },
  },
  follow_up_stated: {
    instructions: "Does the note state a follow-up plan (a specific date, timeframe, or 'as needed'/'if symptoms persist' guidance)?",
    criteria: { true: "A follow-up plan of some kind is stated.", false: "No follow-up plan is stated anywhere in the note." },
  },
  red_flag_advice_given: {
    instructions: "Does the note advise the patient what warning signs should prompt them to seek care sooner (a red-flag / safety-net instruction)?",
    criteria: { true: "Red-flag or safety-net advice is present.", false: "No red-flag or safety-net advice is present." },
  },
  medication_instructions_complete: {
    instructions: "For every medication the note prescribes, does the note give a complete instruction — drug, dose, frequency and duration (not just a drug name alone)?",
    criteria: { true: "Every prescribed medication has a complete dose/frequency/duration instruction, or no medication is prescribed.", false: "At least one prescribed medication is missing a dose, frequency, or duration." },
  },
} as const;

export type CompletenessQuestionId = keyof typeof COMPLETENESS_CRITERIA;

export function completenessQuestion(id: CompletenessQuestionId): JevNoulQ {
  const c = COMPLETENESS_CRITERIA[id];
  return { type: "noul", instructions: c.instructions, criteria: c.criteria };
}

// Module-load registration (lib/jev/registry.ts) — "no caller builds its own request" (J-CORE-1):
// a caller resolves these by (question_id, prompt_version) rather than importing the builders
// directly, so a future prompt_version bump only needs a new registration, never a caller change.
registerJevQuestion("note_sentence_supported", NOTE_FAITHFULNESS_PROMPT_VERSION, noteSentenceSupportedQuestion);
for (const id of Object.keys(COMPLETENESS_CRITERIA) as CompletenessQuestionId[]) {
  registerJevQuestion(id, NOTE_COMPLETENESS_PROMPT_VERSION, () => completenessQuestion(id));
}
