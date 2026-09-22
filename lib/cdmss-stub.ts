/**
 * Clinical Decision Support stub.
 *
 * This is the placeholder version of the CDMSS pipeline described in
 * PRD §4.11. Full version: HyDE → embed → retrieve from KB → draft →
 * critique → revise → cite. That requires the KB embeddings the CDMSS
 * project already has — wiring is its own sprint (Sprint 3.x in
 * ETA-BUILD-PLAN.md).
 *
 * For now: a single-pass routedChat call (cds surface, flash) on the structured note that
 * emits {differentials_to_consider, red_flags, evidence_based_suggestions,
 * follow_up_considerations}. Gives the doctor something useful in the
 * UI today; full retrieval-augmented version replaces this later
 * without changing the render shape.
 */

import type { EncounterNote, GeneralMedicalNote, AnyNote } from "@/lib/note-generation";

import { routedChat } from "@/lib/llm/gemini";

const CDS_TIMEOUT_MS = 60_000;
const CDS_TEMPERATURE = 0.1;

const SYSTEM = `You are a clinical decision support assistant reviewing a clinician's encounter note. Your job is to surface what an attentive senior physician would point out — things that might be missed, broader differentials to consider, red flags to rule out, and standard-of-care suggestions.

Return ONLY a JSON object matching exactly this schema (no preamble, no markdown fence):

{
  "differentials_to_consider": [
    { "dx": string, "why": string }  // dx = candidate diagnosis name, why = 1-line reason given this presentation
  ],
  "red_flags": [string, ...],         // findings that warrant urgent escalation
  "evidence_based_suggestions": [string, ...],   // standard-of-care additions to the plan
  "follow_up_considerations": [string, ...]      // safety-netting, return-precautions
}

Rules:
- Suggest at most 5 differentials, ordered by clinical likelihood given the presentation
- Be specific — "consider PE if pleuritic chest pain", not "consider DVT/PE"
- Red flags should be present-tense findings or absences that warrant urgent action
- evidence_based_suggestions are concrete actions, not vague recommendations
- Empty arrays are valid when nothing applies — never invent`;

export type CdmssOutput = {
  differentials_to_consider: { dx: string; why: string }[];
  red_flags: string[];
  evidence_based_suggestions: string[];
  follow_up_considerations: string[];
};

export type CdmssResult =
  | { ok: true; cdmss: CdmssOutput; latency_ms: number; model: string }
  | { ok: false; error: string; latency_ms: number };

export async function runCdmssStub(
  note: AnyNote,
  opts: { signal?: AbortSignal; noteType?: string } = {},
): Promise<CdmssResult> {
  // Format the note as a compact context block (note-type aware)
  const isGM = opts.noteType === "general_medical";
  const gm = note as GeneralMedicalNote;
  const cn = note as EncounterNote;
  const noteCtx = (isGM
    ? [
        `Reason for visit: ${gm.reason_for_visit || "—"}`,
        `Active problems: ${gm.active_problems.join(", ") || "—"}`,
        `Interval history: ${gm.interval_history || "—"}`,
        `Medications: ${gm.current_medications.join(", ") || "—"}`,
        `Allergies: ${gm.allergies.join(", ") || "NKDA"}`,
        `Examination: ${gm.examination || "—"}`,
        `Impression: ${gm.impression || "—"}`,
        `Investigations ordered: ${gm.plan.investigations_ordered.join(", ") || "—"}`,
        `Treatment changes: ${gm.plan.treatment_changes.join(", ") || "—"}`,
        `Consultations: ${gm.plan.consultations_requested.join(", ") || "—"}`,
        `Follow-up: ${gm.plan.follow_up || "—"}`,
      ]
    : [
        `Chief complaint: ${cn.chief_complaint || "—"}`,
        `HPI: ${cn.history_present_illness || "—"}`,
        `Past medical: ${cn.past_medical_history.join(", ") || "—"}`,
        `Medications: ${cn.current_medications.join(", ") || "—"}`,
        `Allergies: ${cn.allergies.join(", ") || "NKDA"}`,
        `Examination: ${cn.examination || "—"}`,
        `Assessment: ${cn.assessment || "—"}`,
        `Investigations: ${cn.plan.investigations.join(", ") || "—"}`,
        `Treatment: ${cn.plan.treatment.join(", ") || "—"}`,
        `Follow-up: ${cn.plan.follow_up || "—"}`,
      ]
  ).join("\n");

  // CDS stub through routedChat (cds surface, FLASH tier): Vertex Gemini, then OpenRouter. It used to
  // call llama3.1:8b on the Mini directly — a small, cheap model — so it stays on the cheap tier
  // rather than the pro tier the full CDMSS pipeline uses. `model` is the provider that answered.
  const rc = await routedChat({
    surface: "cds", tier: "flash",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: noteCtx },
    ],
    temperature: CDS_TEMPERATURE, responseJson: true, timeoutMs: CDS_TIMEOUT_MS, signal: opts.signal,
  });
  const latency_ms = rc.latency_ms;
  if (!rc.ok) return { ok: false, error: rc.error ?? "llm_failed", latency_ms };
  const content = rc.content.trim();
  if (!content) return { ok: false, error: "empty_response", latency_ms };
  let parsed: CdmssOutput;
  try {
    parsed = JSON.parse(content) as CdmssOutput;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `json_parse_failed: ${msg.slice(0, 100)}`, latency_ms };
  }
  const cdmss: CdmssOutput = {
    differentials_to_consider: Array.isArray(parsed.differentials_to_consider)
      ? parsed.differentials_to_consider
          .filter((d) => d && typeof d === "object")
          .map((d) => ({
            dx: typeof d.dx === "string" ? d.dx : "",
            why: typeof d.why === "string" ? d.why : "",
          }))
          .filter((d) => d.dx.length > 0)
          .slice(0, 5)
      : [],
    red_flags: Array.isArray(parsed.red_flags)
      ? parsed.red_flags.filter((s) => typeof s === "string")
      : [],
    evidence_based_suggestions: Array.isArray(parsed.evidence_based_suggestions)
      ? parsed.evidence_based_suggestions.filter((s) => typeof s === "string")
      : [],
    follow_up_considerations: Array.isArray(parsed.follow_up_considerations)
      ? parsed.follow_up_considerations.filter((s) => typeof s === "string")
      : [],
  };
  return { ok: true, cdmss, latency_ms, model: rc.provider };
}
