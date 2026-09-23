/**
 * lib/jev/prompts/encounter-v1.ts — the three Jev questions the E-6 fusion asks about a 60 s probe.
 *
 * WORDING IS THE TRIALLED WINNER, VERBATIM (PLAN-v3 §1.6: trialled before it is hard-coded). Source:
 * eta-lab/studies/2026-09-23-jev-opp/TRIALS-23-SEP.md and its frames-U*.jsonl.
 *   U1 consult phase       choice   "phase_w1"   → prompt_version "u1-phase-w1"   (STRONG, w1 kept)
 *   U2 consult boundary    noul x2  "start_v1", "end_v1" → "u2-boundary-v1"      (STRONG, v1)
 *   U6 clinical or not     choice   "kind_v2"    → prompt_version "u6-kind-v2"    (STRONG, v2)
 *
 * STATE SHAPES ARE THE TRIALLED ONES, which is why there are two calls per probe and not one: U1 and U6
 * were trialled on {window_text} and share it (one call, fanned out — §1.7), while U2 was trialled on
 * {W1, W2, W3}, the probe with its neighbours. Folding U2 into the other state would change the wording
 * that was benched; per-use wording beats the fan-out principle (Fable's ruling on §1.7, 23 Sep).
 *
 * U1 IS NINE-WAY, NOT pre/consult/post/none. The order describes U1 as a four-way phase; the trialled
 * question is nine-way, and hard-coding an untrialled four-way question would break §1.6. The mapping to
 * four phases is done in code (lib/encounter-clock/fusion.ts, phaseOf) where it can be tested and
 * changed without re-trialling the wording.
 */
import { isJevQuestionRegistered, registerJevQuestion } from "../registry";
import type { JevChoiceQ, JevNoulQ } from "../types";

export const U1_QUESTION_ID = "u1_phase";
export const U1_PROMPT_VERSION = "u1-phase-w1";
export const U2_START_QUESTION_ID = "u2_start";
export const U2_END_QUESTION_ID = "u2_end";
export const U2_PROMPT_VERSION = "u2-boundary-v1";
export const U6_QUESTION_ID = "u6_kind";
export const U6_PROMPT_VERSION = "u6-kind-v2";

export const U1_OPTIONS = [
  "greeting", "history_taking", "examination", "diagnosis_explained", "prescribing",
  "counselling_or_advice", "closing", "not_a_consultation", "cannot_tell",
] as const;
export type U1Option = (typeof U1_OPTIONS)[number];

export const U6_OPTIONS = [
  "clinical_consultation", "staff_or_admin_talk", "phone_call", "social_chatter",
  "garbled_or_no_real_speech", "cannot_tell",
] as const;
export type U6Option = (typeof U6_OPTIONS)[number];

export function u1PhaseQuestion(): JevChoiceQ {
  return {
    type: "choice",
    instructions:
      "The state holds one short window of a doctor-patient consultation transcript in an Indian outpatient clinic. Decide which phase of the consultation this window is part of.",
    criteria: {
      greeting: "The doctor and patient are exchanging opening pleasantries, asking the patient's name, or inviting them to sit, before any medical complaint is discussed.",
      history_taking: "The doctor is asking about symptoms, their duration, or past medical history, and the patient is describing what they are experiencing.",
      examination: "The doctor is physically examining the patient or instructing them to reposition for examination (e.g. asking them to lie down, breathe, or describing what the doctor observes on exam).",
      diagnosis_explained: "The doctor is telling the patient what is wrong with them or naming the condition/diagnosis.",
      prescribing: "The doctor is naming a medicine, dose, frequency or duration to be taken.",
      counselling_or_advice: "The doctor is giving lifestyle, diet, follow-up, or general precaution advice not tied to a specific medicine's dose.",
      closing: "The doctor and patient are ending the visit, saying goodbye, or the patient is leaving.",
      not_a_consultation: "The window contains no doctor-patient medical exchange at all, such as staff talking to each other or empty room sounds.",
      cannot_tell: "The window's content does not give enough information to decide which phase this is.",
    },
  };
}

export function u2StartQuestion(): JevNoulQ {
  return {
    type: "noul",
    instructions:
      "A new patient's consultation STARTS within W2 (the current window), given W1 before it and W3 after it for context.",
    criteria: {
      true: "Within W2, a doctor begins interacting with a patient who was not being consulted in W1 -- e.g. greeting a new patient, calling them in, or beginning to ask about their complaint for the first time.",
      false: "No new patient's consultation begins within W2 -- the same consultation that was already underway in W1 continues, or no consultation is present at all in W2.",
    },
  };
}

export function u2EndQuestion(): JevNoulQ {
  return {
    type: "noul",
    instructions: "An ongoing patient's consultation ENDS within W2.",
    criteria: {
      true: "Within W2, the doctor and patient reach closure -- final instructions given, goodbyes said, or the patient is told to leave/next patient is called in -- ending that patient's visit.",
      false: "No consultation concludes within W2 -- the consultation that was underway continues past W2, or no consultation is present.",
    },
  };
}

export function u6KindQuestion(): JevChoiceQ {
  return {
    type: "choice",
    instructions:
      "Given this transcript window from a clinic room's always-on microphone, classify what kind of activity produced it.",
    criteria: {
      clinical_consultation: "A doctor and patient are engaged in a medical exchange -- discussing symptoms, examination, diagnosis, or treatment.",
      staff_or_admin_talk: "Clinic staff (nurses, assistants) are talking to each other about logistics, scheduling, supplies, or administrative matters, with no patient involved.",
      phone_call: "One side of a phone conversation is audible -- a single speaker's turns alone, addressed to someone not physically in the room, with phone-call conventions like greeting, holding, or ending the call.",
      social_chatter: "People are talking about non-clinical, non-administrative topics -- personal or informal conversation unrelated to patient care or clinic operations.",
      garbled_or_no_real_speech: "The transcript is dominated by filler sounds, fragments, or repeated meaningless syllables with no coherent information content, suggesting noise rather than a real conversation.",
      cannot_tell: "The window does not contain enough information to decide among the above.",
    },
  };
}

/** Idempotent: safe to call on every run and on every import path, never throws AlreadyRegistered. */
export function registerEncounterQuestions(): void {
  const all: Array<[string, string, () => JevChoiceQ | JevNoulQ]> = [
    [U1_QUESTION_ID, U1_PROMPT_VERSION, u1PhaseQuestion],
    [U2_START_QUESTION_ID, U2_PROMPT_VERSION, u2StartQuestion],
    [U2_END_QUESTION_ID, U2_PROMPT_VERSION, u2EndQuestion],
    [U6_QUESTION_ID, U6_PROMPT_VERSION, u6KindQuestion],
  ];
  for (const [qid, version, build] of all) {
    if (!isJevQuestionRegistered(qid, version)) registerJevQuestion(qid, version, build);
  }
}
