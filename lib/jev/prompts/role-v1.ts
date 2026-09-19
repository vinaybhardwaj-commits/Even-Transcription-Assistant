/**
 * lib/jev/prompts/role-v1.ts — Slice J3 (ETA-JEV-ARM-D §6.2), prompt_version "jev-role-v1". The
 * spec's wording verbatim; no worked examples (leakage risk).
 */
import type { JevChoiceQ } from "../types";

export const ROLE_PROMPT_VERSION = "jev-role-v1";

export const ROLE_CRITERIA = {
  clinician: "Asks about symptoms, examines, explains diagnosis, prescribes, gives medical advice.",
  patient: "Describes their own symptoms, answers questions about their own body and history.",
  attendant: "A relative or companion speaking about the patient in the third person, or helping the patient answer.",
  nurse_or_staff: "Handles vitals, files, tokens, calling patients, room logistics, or talks to the doctor about other patients.",
  other: "Cannot be determined from these lines, or none of the above.",
} as const;

export function roleQuestion(speakerId: string): JevChoiceQ {
  return {
    type: "choice",
    instructions: `What is speaker ${speakerId}'s role in this consultation, judged only from what they say?`,
    criteria: { ...ROLE_CRITERIA },
  };
}

export const roleQid = (s: string) => `role_${s}`;
