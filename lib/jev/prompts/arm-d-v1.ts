/**
 * lib/jev/prompts/arm-d-v1.ts — Slice J2. The Arm-D question set, VERSIONED.
 *
 * These wordings are NOT invented here: each was trialled on synthetic fixtures and chosen for how its
 * probabilities SEPARATE the boundary cases (ETA-JEV-INTEGRATION §3; trial outputs 19 Sep). The AUCs
 * behind them are on synthetic text and are an UPPER BOUND — real code-mixed windows separate less
 * cleanly, which is why every threshold that reads these lives in env, movable without a code change.
 *
 * PROMPT_VERSION is stored on every answered row so results stay comparable when wording changes.
 * {W} is substituted with an ORDINAL label (W1, W2, …), never a window id or timestamp (programme
 * rule: all time arithmetic lives in code, not in what Jev sees). Criteria describe SITUATIONS and
 * carry no worked examples (models here copy examples verbatim — integration doc §7).
 */
import type { JevChoiceQ, JevNoulQ, JevQuestion } from "@/lib/jev/types";

export const PROMPT_VERSION = "jev-arm-d-v1";

/** The state framing sent with every batch — part of the versioned prompt. Describes the setting so
 *  Jev reads the windows in context, with no identity and no timestamps. */
export const ARM_D_SETTING =
  "Outpatient consultation room in an Indian hospital. Each window is a machine-translated English " +
  "transcript of what was said in one short, consecutive slice of the day, in order. Windows may be " +
  "empty (silence or noise). Judge each asked window in the context of its neighbours.";

export const PHASES = ["non_clinical", "arrival", "history", "examination", "plan", "closing"] as const;
export type Phase = (typeof PHASES)[number];

/** The 6-way phase question (spec §5.3 wording "v1"; phase-trial chose it, synthetic acc 1.000). */
const PHASE_INSTR =
  "Which phase of a patient consultation does window {W} mainly show? Consider the surrounding windows for context but answer for {W} only.";
const PHASE_CRITERIA: Record<Phase, string> = {
  non_clinical: "No patient consultation is happening: staff talking among themselves, phone calls, silence, noise, admin work, or unrelated chatter.",
  arrival: "A patient is arriving or being seated: greetings, names being confirmed, being asked to sit, small talk before any medical content.",
  history: "The patient or attendant is describing complaints, symptoms, duration, past illness, medicines, or the clinician is asking about them.",
  examination: "Physical examination is under way: instructions like breathe in, lie down, show me, or reading out findings and vitals.",
  plan: "The clinician is explaining the diagnosis, prescribing, ordering tests, or giving advice and instructions.",
  closing: "The consultation is ending: follow-up date, thanks, goodbyes, patient leaving, or the next patient being called.",
};

/** The four noul questions. start/end/clinician are the wordings the trial chose; `clinical` uses the
 *  spec §5.3 v1 wording — the brief did not name a chosen variant for it, so v1 stands (flagged). */
const NOUL_INSTR: Record<"start" | "end" | "clinician" | "clinical", string> = {
  start: "Does a new patient's consultation begin in window {W}, meaning a different patient from the one in the preceding windows starts being seen?",
  end: "Does the current patient's visit finish in window {W} — final advice or follow-up given, thanks or goodbye, or the patient leaving?",
  clinician: "In window {W}, does the treating clinician speak to the patient — asking about complaints, examining, explaining findings, or prescribing?",
  clinical: "Does window {W} contain any clinical conversation between a clinician and a patient or attendant?",
};

/** The five dimensions asked per target window. `clinical` is the fifth — spec §5.3 lists five ids
 *  even though its prose says "four"; the list is the specification (orchestrator ruling). */
export const ARM_D_DIMS = ["phase", "start", "end", "clinician", "clinical"] as const;
export type ArmDDim = (typeof ARM_D_DIMS)[number];

/** Question id = `<dim>__<label>`, e.g. `phase__W3`. The label is the ordinal, not the window id. */
export function qid(dim: ArmDDim, label: string): string {
  return `${dim}__${label}`;
}

/** Parse a question id back into its dim + label. Returns null for anything unrecognised. */
export function parseQid(id: string): { dim: ArmDDim; label: string } | null {
  const i = id.indexOf("__");
  if (i < 0) return null;
  const dim = id.slice(0, i) as ArmDDim;
  if (!(ARM_D_DIMS as readonly string[]).includes(dim)) return null;
  return { dim, label: id.slice(i + 2) };
}

/**
 * Build the five Arm-D questions for each target window label, as ONE record to hand jev_ask in a
 * single call (batch, never one call per question). 5 × labels.length questions; the caller keeps
 * batches within Jev's 200-question limit.
 */
export function buildArmDQuestions(labels: string[]): Record<string, JevQuestion> {
  const qs: Record<string, JevQuestion> = {};
  for (const w of labels) {
    const phaseQ: JevChoiceQ<Phase> = { type: "choice", instructions: PHASE_INSTR.replace("{W}", w), criteria: PHASE_CRITERIA };
    qs[qid("phase", w)] = phaseQ;
    for (const dim of ["start", "end", "clinician", "clinical"] as const) {
      const q: JevNoulQ = { type: "noul", instructions: NOUL_INSTR[dim].replace("{W}", w) };
      qs[qid(dim, w)] = q;
    }
  }
  return qs;
}
