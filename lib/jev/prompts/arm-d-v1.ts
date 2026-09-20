/**
 * lib/jev/prompts/arm-d-v1.ts — Slice J2 (ETA-JEV-ARM-D §5.3), prompt_version "jev-arm-d-v1".
 *
 * THE WORDINGS HERE ARE THE ONES THE TRIAL MEASURED, not the spec's first draft. Each was run against
 * synthetic fixtures and chosen for how its probabilities SEPARATE the boundary cases
 * (ETA-JEV-INTEGRATION §3; trial outputs 19 Sep). The earlier module on vinay/jev-arm-d shipped the
 * spec's §5.3 v1 text because its author could not find the trial results; measured beats assumed, so
 * this version stands (orchestrator ruling, 20 Sep). Those AUCs are on synthetic text and are an UPPER
 * BOUND — real code-mixed windows separate less cleanly, which is why every threshold reading these
 * lives in env, movable without a code change.
 *
 * CALL SURFACE. The five `*Question(w)` builders, `SETTING` and the `qid` map are the shape the job
 * kinds (jev-window, jev-role) already import; `buildArmDQuestions` batches all five per window for a
 * single jev_ask call. Window ids reaching Jev are ORDINAL labels (W1, W2, …), never a window id or a
 * timestamp: all time arithmetic lives in code. No worked examples in any instructions (models here
 * copy them verbatim — integration doc §7); criteria describe SITUATIONS, never degrees.
 */
import type { JevChoiceQ, JevNoulQ, JevQuestion } from "@/lib/jev/types";

export const PROMPT_VERSION = "jev-arm-d-v1";

export const PHASES = ["non_clinical", "arrival", "history", "examination", "plan", "closing"] as const;
export type Phase = (typeof PHASES)[number];
export const ARM_D_DIMS = ["phase", "start", "end", "clinician", "clinical"] as const;
export type ArmDDim = (typeof ARM_D_DIMS)[number];

/** The state framing sent with every batch — part of the versioned prompt: the setting, with no
 *  identity and no timestamps. */
export const SETTING =
  "Outpatient consultation room in an Indian hospital. Each window is a machine-translated English " +
  "transcript of what was said in one short, consecutive slice of the day, in order. Windows may be " +
  "empty (silence or noise). Judge each asked window in the context of its neighbours.";
/** Long-form alias for callers that prefer the qualified name. */
export const ARM_D_SETTING = SETTING;

export const PHASE_CRITERIA: Record<Phase, string> = {
  non_clinical: "No patient consultation is happening: staff talking among themselves, phone calls, silence, noise, admin work, or unrelated chatter.",
  arrival: "A patient is arriving or being seated: greetings, names being confirmed, being asked to sit, small talk before any medical content.",
  history: "The patient or attendant is describing complaints, symptoms, duration, past illness, medicines, or the clinician is asking about them.",
  examination: "Physical examination is under way: instructions like breathe in, lie down, show me, or reading out findings and vitals.",
  plan: "The clinician is explaining the diagnosis, prescribing, ordering tests, or giving advice and instructions.",
  closing: "The consultation is ending: follow-up date, thanks, goodbyes, patient leaving, or the next patient being called.",
};

/**
 * Question id = `<dim>__<label>`, e.g. `phase__W3`. DOUBLE underscore: it is the separator the
 * wording trial ran under, and matching the evidence beats matching anything else (ruling, 20 Sep).
 * The label is the ordinal (W1, W2, …), never the window id.
 */
const SEP = "__";
export const qid = {
  phase: (w: string) => `phase${SEP}${w}`,
  start: (w: string) => `start${SEP}${w}`,
  end: (w: string) => `end${SEP}${w}`,
  clinician: (w: string) => `clinician${SEP}${w}`,
  clinical: (w: string) => `clinical${SEP}${w}`,
};

/** Parse a question id back into its dim + label. Null for anything unrecognised. */
export function parseQid(id: string): { dim: ArmDDim; label: string } | null {
  const i = id.indexOf(SEP);
  if (i < 0) return null;
  const dim = id.slice(0, i) as ArmDDim;
  if (!(ARM_D_DIMS as readonly string[]).includes(dim)) return null;
  return { dim, label: id.slice(i + SEP.length) };
}

// ── The five questions. One atomic judgement each (integration doc §7). ─────────────────────────

/** The 6-way phase choice. Trial wording "v1", which the phase trial chose (synthetic acc 1.000). */
export function phaseQuestion(w: string): JevChoiceQ<Phase> {
  return {
    type: "choice",
    instructions: `Which phase of a patient consultation does window ${w} mainly show? Consider the surrounding windows for context but answer for ${w} only.`,
    criteria: { ...PHASE_CRITERIA },
  };
}

/** Trial-chosen "v1": AUC 1.000, margin +0.290 — kept over the shorter variant for its
 *  "different patient from the one in the preceding windows" clause. */
export function startQuestion(w: string): JevNoulQ {
  return {
    type: "noul",
    instructions: `Does a new patient's consultation begin in window ${w}, meaning a different patient from the one in the preceding windows starts being seen?`,
  };
}

/** Trial-chosen "marker": AUC 1.000, margin +0.500. */
export function endQuestion(w: string): JevNoulQ {
  return {
    type: "noul",
    instructions: `Does the current patient's visit finish in window ${w} — final advice or follow-up given, thanks or goodbye, or the patient leaving?`,
  };
}

/** Trial-chosen "action": the action-based wording beat v1, whose margin was only +0.103. */
export function clinicianQuestion(w: string): JevNoulQ {
  return {
    type: "noul",
    instructions: `In window ${w}, does the treating clinician speak to the patient — asking about complaints, examining, explaining findings, or prescribing?`,
  };
}

/** Spec §5.3 v1: the brief named chosen wordings for start/end/clinician, but none for `clinical`. */
export function clinicalQuestion(w: string): JevNoulQ {
  return {
    type: "noul",
    instructions: `Does window ${w} contain any clinical conversation between a clinician and a patient or attendant?`,
  };
}

/**
 * All five questions for each target window label, as ONE record to hand jev_ask in a single call
 * (batch, never one call per question). 5 × labels.length; the caller keeps each batch inside Jev's
 * 200-question limit.
 */
export function buildArmDQuestions(labels: string[]): Record<string, JevQuestion> {
  const qs: Record<string, JevQuestion> = {};
  for (const w of labels) {
    qs[qid.phase(w)] = phaseQuestion(w);
    qs[qid.start(w)] = startQuestion(w);
    qs[qid.end(w)] = endQuestion(w);
    qs[qid.clinician(w)] = clinicianQuestion(w);
    qs[qid.clinical(w)] = clinicalQuestion(w);
  }
  return qs;
}
