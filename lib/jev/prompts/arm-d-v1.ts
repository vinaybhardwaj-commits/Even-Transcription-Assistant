/**
 * lib/jev/prompts/arm-d-v1.ts — Slice J2 (ETA-JEV-ARM-D §5.3), prompt_version "jev-arm-d-v1".
 *
 * The spec's §5.3 wording VERBATIM. No settled alternative was found: the wording trial script
 * (scripts/jev-trial/wording_trial.py on vinay/jev-armd-wording-trial) is written and its
 * fixtures exist, but there is no results file recorded under docs/handoff/scratch/ or anywhere
 * else this Builder could find (checked `docs/handoff/scratch/*jev-prompt-trial*` — none) — see
 * the build report. Absent a recorded pick, this module ships the spec's "v1" wording, which is
 * also the "v1" wording pack in the trial's own fixtures.py, so it is at least the candidate the
 * trial itself would have measured first.
 *
 * No worked examples in any instructions (leakage risk, spec §5.3 / INTEGRATION §7).
 */
import type { JevChoiceQ, JevNoulQ } from "../types";

export const PROMPT_VERSION = "jev-arm-d-v1";

export const SETTING =
  "Outpatient consultation room in an Indian hospital. Transcript is machine-translated to English from Kannada, Hindi or English speech and may contain recognition errors. Windows are consecutive 30-second slices in order.";

export const PHASE_CRITERIA = {
  non_clinical: "No patient consultation is happening: staff talking among themselves, phone calls, silence, noise, admin work, or unrelated chatter.",
  arrival: "A patient is arriving or being seated: greetings, names being confirmed, being asked to sit, small talk before any medical content.",
  history: "The patient or attendant is describing complaints, symptoms, duration, past illness, medicines, or the clinician is asking about them.",
  examination: "Physical examination is under way: instructions like breathe in, lie down, show me, or reading out findings and vitals.",
  plan: "The clinician is explaining the diagnosis, prescribing, ordering tests, or giving advice and instructions.",
  closing: "The consultation is ending: follow-up date, thanks, goodbyes, patient leaving, or the next patient being called.",
} as const;

export function phaseQuestion(windowId: string): JevChoiceQ {
  return {
    type: "choice",
    instructions: `Which phase of a patient consultation does window ${windowId} mainly show? Consider the surrounding windows for context but answer for ${windowId} only.`,
    criteria: { ...PHASE_CRITERIA },
  };
}

export function startQuestion(windowId: string): JevNoulQ {
  return {
    type: "noul",
    instructions: `Does a new patient's consultation begin in window ${windowId}, meaning a different patient from the one in the preceding windows starts being seen?`,
    criteria: { true: "A different patient's visit clearly starts here.", false: "Same patient continues, or no consultation is happening." },
  };
}

export function endQuestion(windowId: string): JevNoulQ {
  return {
    type: "noul",
    instructions: `Does the patient consultation that was in progress end in window ${windowId}?`,
    criteria: { true: "The visit wraps up here: final instructions, goodbye, patient leaves.", false: "The visit continues after this window, or there was no visit." },
  };
}

export function clinicianQuestion(windowId: string): JevNoulQ {
  return {
    type: "noul",
    instructions: `Is the treating doctor speaking in window ${windowId}?`,
    criteria: { true: "A doctor is asking, examining, explaining or prescribing.", false: "Only patients, attendants, nurses or other staff speak, or nobody." },
  };
}

export function clinicalQuestion(windowId: string): JevNoulQ {
  return {
    type: "noul",
    instructions: `Does window ${windowId} contain any clinical conversation between a clinician and a patient or attendant?`,
  };
}

export const qid = {
  phase: (w: string) => `phase_${w}`,
  start: (w: string) => `start_${w}`,
  end: (w: string) => `end_${w}`,
  clinician: (w: string) => `clinician_${w}`,
  clinical: (w: string) => `clinical_${w}`,
};
