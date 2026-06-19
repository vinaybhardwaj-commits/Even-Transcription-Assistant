/**
 * Medical Encounter Note generation per PRD §4.10.
 *
 * Input: cleaned transcript text (Whisper-preferred, Deepgram fallback).
 * Output: structured JSON document covering the clinical sections a
 * receiving physician needs — CC, HPI, exam, assessment, plan.
 *
 * Model: qwen2.5:14b on the Mac Mini Ollama (already used by CDMSS).
 * JSON mode via response_format. Temperature 0 for determinism.
 *
 * Fail mode: caller catches; encounter status stays "processing" and
 * can be re-triggered, OR the page surfaces the error and leaves the
 * row in failed state. Never blocks the rest of the app.
 */

import { routedChat } from "@/lib/llm/gemini";


export type NoteEvent =
  | { stage: "note"; state: "start" }
  | { stage: "note"; state: "done"; ms: number; chief_complaint?: string }
  | { stage: "note"; state: "error"; message: string; ms: number };

const NOTE_MODEL = process.env.NOTE_MODEL || "qwen2.5:14b";
const NOTE_TIMEOUT_MS = 240_000;
const NOTE_TEMPERATURE = 0;

const SYSTEM = `You are converting a clinician's voice-dictated patient encounter into a structured Medical Encounter Note. The transcript may be in English, an Indian language (e.g. Hindi, Kannada), or code-mixed — ALWAYS write the note in clear clinical English, translating faithfully and never adding content. Use ONLY information explicitly stated in the transcript — do not invent symptoms, medications, exam findings, doses, or follow-up plans. If a section was not discussed, return an empty string or empty array for that field.

Return ONLY a JSON object matching exactly this schema (no preamble, no markdown fence, no explanation):

{
  "chief_complaint": string,                      // one-line, patient's words when possible
  "history_present_illness": string,              // 2-6 sentence prose narrative
  "past_medical_history": [string, ...],          // each comorbidity/condition mentioned
  "current_medications": [string, ...],           // include dose + frequency when stated
  "allergies": [string, ...],                     // empty array if NKDA or not discussed
  "examination": string,                          // exam findings prose, may include vital signs
  "assessment": string,                           // provisional dx + clinical reasoning
  "plan": {
    "investigations": [string, ...],              // labs, imaging, procedures ordered
    "treatment": [string, ...],                   // medications started/changed + non-drug treatments
    "follow_up": string                           // when to return, red-flag advice
  }
}

Style rules:
- Preserve exact medication doses, frequencies, lab values, vital signs, exam findings
- Use clinical shorthand the doctor used (BD/TDS/QID/PRN/SOB/CP) — don't expand
- Prefer the doctor's wording over reformulation
- Do not add a diagnosis the doctor didn't state
- If the transcript is too short or non-clinical, fill what you can and leave the rest empty`;

// General Medical Note — inpatient round / ward consult framing (V2.S2). Outputs
// the SAME JSON shape as the clinic note so every downstream consumer (editor,
// email, CDMSS) is unchanged in S2a; V2.S2b splits this into a distinct schema.
const SYSTEM_GENERAL = `You are converting a clinician's voice-dictated INPATIENT ROUND or WARD CONSULT into a structured General Medical Note. The transcript may be in English, an Indian language (e.g. Hindi, Kannada), or code-mixed — ALWAYS write the note in clear clinical English, translating faithfully and never adding content. Use ONLY information explicitly stated in the transcript — do not invent problems, medications, exam findings, doses, or plans. If a section was not discussed, return an empty string or empty array for that field.

This is a FOLLOW-UP / round encounter, not a first outpatient visit. Focus on what is happening with the patient TODAY and what has CHANGED since they were last seen or since admission.

Return ONLY a JSON object matching exactly this schema (no preamble, no markdown fence, no explanation):

{
  "reason_for_visit": string,                      // why this clinician is seeing the patient today (one line)
  "active_problems": [string, ...],                // ongoing issues being addressed this admission/visit
  "interval_history": string,                      // what has changed since the last review / since admission: events, response to treatment, new symptoms
  "current_medications": [string, ...],            // current meds with dose + frequency; note recent starts/stops/dose changes
  "allergies": [string, ...],                      // empty array if NKDA or not discussed
  "examination": string,                           // today's exam findings, may include vital signs
  "impression": string,                            // today's clinical synthesis / impression
  "plan": {
    "investigations_ordered": [string, ...],       // labs, imaging, procedures ordered today
    "treatment_changes": [string, ...],            // started / stopped / dose-adjusted today
    "consultations_requested": [string, ...],      // referrals requested (e.g. cardiology, neurology)
    "follow_up": string                            // plan for next review, disposition, red-flag advice
  }
}

Style rules:
- Preserve exact medication doses, frequencies, lab values, vital signs, exam findings
- Use clinical shorthand the doctor used (BD/TDS/QID/PRN/SOB/CP) — don't expand
- Prefer the doctor's wording over reformulation
- Do not add a diagnosis the doctor didn't state
- If the transcript is too short or non-clinical, fill what you can and leave the rest empty`;

// Operative / Procedure Note (V2.S3) — surgeon's dictation. CDMSS is OFF for
// this note type (see noteTypeHasCdmss). Distinct schema per PRD §7.2.3.
const SYSTEM_OPERATIVE = `You are converting a surgeon's voice-dictated operative or procedure note into a structured Operative Note. The transcript may be in English, an Indian language, or code-mixed — ALWAYS write the note in clear clinical English, translating faithfully. Use ONLY information explicitly stated in the transcript — do not invent surgical findings, complications, EBL values, implants, or specimens. If a section was not discussed, return an empty string or empty array (or null for numeric/boolean fields).

Return ONLY a JSON object matching exactly this schema (no preamble, no markdown fence, no explanation):

{
  "procedure_date_time": string,                 // ISO if dictated, else free text; "" if not stated
  "surgical_specialty": string,                  // e.g. "general surgery", "orthopedics"; "" if not inferable
  "pre_op_diagnosis": string,
  "post_op_diagnosis": string,
  "procedure_performed": [string, ...],          // first entry = PRIMARY procedure, rest = secondary/incidental
  "surgeon": string,                             // primary surgeon
  "assistants": [string, ...],
  "anesthesiologist": string,                    // "" if not mentioned
  "anesthesia_type": string,                     // GA / regional / MAC / local; "" if not stated
  "indication": string,
  "findings": string,                            // intra-operative findings
  "procedure_narrative": string,                 // step-by-step prose
  "estimated_blood_loss_ml": number | null,
  "fluids_in": string,                           // free text, e.g. "1.5 L NS"; "" if not stated
  "urine_output_ml": number | null,
  "specimens": [{ "description": string, "sent_to": "pathology" | "discarded" | "other" }, ...],
  "implants": [{ "description": string, "catalog_or_serial": string }, ...],
  "drains_placed": [string, ...],
  "complications": string,                       // "None" if surgeon explicitly stated none
  "counts_correct": boolean | null,              // null if sponge/needle/instrument counts not addressed
  "antibiotic_given": string,                    // prophylactic abx + timing; "" if not stated
  "disposition": string                          // PACU / ICU / floor / home / other
}

Style rules:
- Preserve exact medication doses, anesthesia type, fluid volumes, EBL
- Use the surgeon's wording for the procedure name
- Do not add complications that were not stated
- If counts were not explicitly addressed, set counts_correct to null
- For implants prefer "manufacturer + product + catalog/serial" if stated, else just the product name`;

// Dietetic Consult Note (V2.S4) — clinical dietitian. CDMSS OFF. PRD §7.2.4.
const SYSTEM_DIETETIC = `You are converting a clinical dietitian's voice-dictated patient consultation into a structured Dietetic Consult Note. The transcript may be in English, an Indian language, or code-mixed — ALWAYS write the note in clear clinical English, translating faithfully. Use ONLY information explicitly stated in the transcript — do not invent diet recall details, anthropometric values, calorie targets, or dietary preferences. If a section was not discussed, return an empty string, empty array, or null (for numeric fields).

Return ONLY a JSON object matching exactly this schema (no preamble, no markdown fence, no explanation):

{
  "reason_for_consult": string,
  "relevant_medical_history": [string, ...],          // DM2, HTN, CKD, GI disease, etc.
  "current_medications": [string, ...],               // esp. those affecting weight/appetite/glucose
  "allergies_and_intolerances": [string, ...],        // food + drug (lactose, gluten, nut, etc.)
  "anthropometrics": {
    "weight_kg": number | null,
    "height_cm": number | null,
    "bmi": number | null,                             // compute from weight/height if not stated, round to 1 dp
    "waist_circumference_cm": number | null,
    "body_fat_percent": number | null,
    "other": string                                   // any other measurement, free text
  },
  "diet_recall": string,                              // 24-hour intake as a narrative paragraph
  "food_preferences_and_aversions": [string, ...],    // likes + dislikes / can't eat
  "nutritional_assessment": string,                   // dietitian's clinical synthesis
  "diet_plan": {
    "daily_calorie_target_kcal": number | null,
    "macronutrient_distribution": string,             // e.g. "50% CHO, 20% protein, 30% fat"
    "meal_pattern": [string, ...],                    // "Breakfast: ...", "Mid-morning: ..."
    "foods_to_emphasize": [string, ...],
    "foods_to_limit_or_avoid": [string, ...],
    "supplements_recommended": [string, ...],
    "behavioural_goals": [string, ...]                // e.g. "log meals daily", "walk 30 min/day"
  },
  "follow_up": string
}

Style rules:
- Preserve exact anthropometric values, calorie targets, and macro splits
- If BMI was not stated but weight and height were, compute BMI = weight_kg / (height_cm/100)^2, rounded to 1 decimal
- Do not invent a diet plan the dietitian didn't describe`;

// Physiotherapy Note (V2.S5) — physiotherapist assessment. CDMSS OFF. PRD §7.2.5.
const SYSTEM_PHYSIO = `You are converting a physiotherapist's voice-dictated patient assessment into a structured Physiotherapy Note. The transcript may be in English, an Indian language, or code-mixed — ALWAYS write the note in clear clinical English, translating faithfully. Use ONLY information explicitly stated in the transcript — do not invent ROM degrees, strength grades, pain scores, or exercises. If a section was not discussed, return an empty string, empty array, or null (for numeric fields).

Return ONLY a JSON object matching exactly this schema (no preamble, no markdown fence, no explanation):

{
  "reason_for_consult": string,
  "relevant_medical_history": [string, ...],
  "current_medications": [string, ...],
  "functional_status_baseline": string,
  "current_functional_status": string,
  "pain_assessment": {
    "location": string,
    "score_0_10": number | null,
    "quality": string,
    "aggravating_factors": [string, ...],
    "relieving_factors": [string, ...]
  },
  "rom_findings": string,
  "strength_findings": string,
  "special_tests": [string, ...],
  "posture_and_gait": string,
  "assessment": string,
  "treatment_plan": {
    "modalities": [string, ...],
    "exercises_prescribed": [string, ...],
    "home_program": [string, ...],
    "precautions": [string, ...],
    "expected_outcomes": string,
    "sessions_per_week": number | null,
    "expected_duration_weeks": number | null
  },
  "follow_up": string
}

Style rules:
- Preserve exact ROM degrees, MMT grades, pain scores, and exercise sets/reps
- Use the physiotherapist's wording for special tests
- Do not invent findings or a treatment plan that was not described`;

// Discharge Summary (NoteGen, V2.S6) — NABH 6th-ed AAC.14 discharge summary. CDMSS OFF.
const SYSTEM_DISCHARGE = `You are converting a clinician's typed or dictated input into a structured Hospital Discharge Summary. The input may be in English, an Indian language, or code-mixed — ALWAYS write the summary in clear clinical English, translating faithfully. Use ONLY information explicitly stated — never invent diagnoses, medications, doses, dates, investigation results, or findings. If a section was not provided, return an empty string or empty array.

Return ONLY a JSON object matching exactly this schema (no preamble, no markdown fence):

{
  "reason_for_admission": string,
  "significant_findings": string,
  "diagnosis": string,
  "hospital_course": string,
  "investigations": [string, ...],
  "procedures_performed": [string, ...],
  "medications_administered": [string, ...],
  "condition_at_discharge": string,
  "discharge_medications": [string, ...],
  "follow_up_advice": string,
  "patient_instructions": [string, ...],
  "urgent_care_instructions": string,
  "outcome": string
}`;

// OPD Prescription (NoteGen, V2.S7) — NABH 6th-ed MOM.4 prescription. CDMSS OFF.
const SYSTEM_RX = `You are converting a clinician's typed or dictated input into a structured OPD Prescription. The input may be in English, an Indian language, or code-mixed — ALWAYS write it in clear clinical English, translating faithfully. Use ONLY information explicitly stated — never invent a drug, dose, route, frequency, duration, diagnosis, or instruction. If a section was not provided, return an empty string or empty array. For each medication include the drug name, dose, route, frequency and duration when stated.

Return ONLY a JSON object matching exactly this schema (no preamble, no markdown fence):

{
  "diagnosis": string,
  "allergies": [string, ...],
  "medications": [string, ...],
  "investigations_advised": [string, ...],
  "follow_up": string,
  "general_advice": [string, ...]
}`;

export type EncounterNote = {
  chief_complaint: string;
  history_present_illness: string;
  past_medical_history: string[];
  current_medications: string[];
  allergies: string[];
  examination: string;
  assessment: string;
  plan: {
    investigations: string[];
    treatment: string[];
    follow_up: string;
  };
};

// GeneralMedicalNote — inpatient round / ward consult (V2.S2b). Distinct schema
// per PRD §7.2.2; discriminated at the consumer by encounter.note_type.
export type GeneralMedicalNote = {
  reason_for_visit: string;
  active_problems: string[];
  interval_history: string;
  current_medications: string[];
  allergies: string[];
  examination: string;
  impression: string;
  plan: {
    investigations_ordered: string[];
    treatment_changes: string[];
    consultations_requested: string[];
    follow_up: string;
  };
};

// OperativeProcedureNote — surgeon's op/procedure note (V2.S3, PRD §7.2.3). CDMSS OFF.
export type OperativeProcedureNote = {
  procedure_date_time: string;
  surgical_specialty: string;
  pre_op_diagnosis: string;
  post_op_diagnosis: string;
  procedure_performed: string[];
  surgeon: string;
  assistants: string[];
  anesthesiologist: string;
  anesthesia_type: string;
  indication: string;
  findings: string;
  procedure_narrative: string;
  estimated_blood_loss_ml: number | null;
  fluids_in: string;
  urine_output_ml: number | null;
  specimens: { description: string; sent_to: string }[];
  implants: { description: string; catalog_or_serial: string }[];
  drains_placed: string[];
  complications: string;
  counts_correct: boolean | null;
  antibiotic_given: string;
  disposition: string;
};

// DieteticConsultNote — clinical dietitian consult (V2.S4, PRD §7.2.4). CDMSS OFF.
export type DieteticConsultNote = {
  reason_for_consult: string;
  relevant_medical_history: string[];
  current_medications: string[];
  allergies_and_intolerances: string[];
  anthropometrics: {
    weight_kg: number | null;
    height_cm: number | null;
    bmi: number | null;
    waist_circumference_cm: number | null;
    body_fat_percent: number | null;
    other: string;
  };
  diet_recall: string;
  food_preferences_and_aversions: string[];
  nutritional_assessment: string;
  diet_plan: {
    daily_calorie_target_kcal: number | null;
    macronutrient_distribution: string;
    meal_pattern: string[];
    foods_to_emphasize: string[];
    foods_to_limit_or_avoid: string[];
    supplements_recommended: string[];
    behavioural_goals: string[];
  };
  follow_up: string;
};

// PhysiotherapyNote — physiotherapist assessment (V2.S5, PRD §7.2.5). CDMSS OFF.
export type PhysiotherapyNote = {
  reason_for_consult: string;
  relevant_medical_history: string[];
  current_medications: string[];
  functional_status_baseline: string;
  current_functional_status: string;
  pain_assessment: {
    location: string;
    score_0_10: number | null;
    quality: string;
    aggravating_factors: string[];
    relieving_factors: string[];
  };
  rom_findings: string;
  strength_findings: string;
  special_tests: string[];
  posture_and_gait: string;
  assessment: string;
  treatment_plan: {
    modalities: string[];
    exercises_prescribed: string[];
    home_program: string[];
    precautions: string[];
    expected_outcomes: string;
    sessions_per_week: number | null;
    expected_duration_weeks: number | null;
  };
  follow_up: string;
};

// DischargeSummaryNote (NoteGen) — NABH AAC.14. CDMSS OFF.
export type DischargeSummaryNote = {
  reason_for_admission: string;
  significant_findings: string;
  diagnosis: string;
  hospital_course: string;
  investigations: string[];
  procedures_performed: string[];
  medications_administered: string[];
  condition_at_discharge: string;
  discharge_medications: string[];
  follow_up_advice: string;
  patient_instructions: string[];
  urgent_care_instructions: string;
  outcome: string;
};

// PrescriptionNote (NoteGen) — NABH MOM.4 OPD prescription. CDMSS OFF.
export type PrescriptionNote = {
  diagnosis: string;
  allergies: string[];
  medications: string[];
  investigations_advised: string[];
  follow_up: string;
  general_advice: string[];
};

export type AnyNote = EncounterNote | GeneralMedicalNote | OperativeProcedureNote | DieteticConsultNote | PhysiotherapyNote | DischargeSummaryNote | PrescriptionNote;

/** Note types that get the CDMSS pipeline (clinic + general medical only). */
export function noteTypeHasCdmss(noteType?: string): boolean {
  return noteType === undefined || noteType === "clinic_encounter" || noteType === "general_medical";
}

/** One-line headline for an encounter (list titles, trace summaries, subject). */
export function noteHeadline(note: AnyNote | null | undefined, noteType?: string): string {
  if (!note) return "";
  if (noteType === "general_medical") return (note as GeneralMedicalNote).reason_for_visit ?? "";
  if (noteType === "operative_procedure") {
    const op = note as OperativeProcedureNote;
    return op.procedure_performed?.[0] || op.post_op_diagnosis || op.pre_op_diagnosis || "";
  }
  if (noteType === "dietetic_consult") return (note as DieteticConsultNote).reason_for_consult ?? "";
  if (noteType === "physiotherapy") return (note as PhysiotherapyNote).reason_for_consult ?? "";
  if (noteType === "discharge_summary") return (note as DischargeSummaryNote).diagnosis || (note as DischargeSummaryNote).reason_for_admission || "";
  if (noteType === "opd_prescription") return (note as PrescriptionNote).diagnosis ?? "";
  return (note as EncounterNote).chief_complaint ?? "";
}

/** True if the note has ANY clinical content (B10 send guard, both shapes). */
export function noteHasContent(note: AnyNote | null | undefined, noteType?: string): boolean {
  if (!note) return false;
  if (noteType === "general_medical") {
    const g = note as GeneralMedicalNote;
    return (
      (g.reason_for_visit ?? "").trim().length > 0 ||
      (g.interval_history ?? "").trim().length > 0 ||
      (g.examination ?? "").trim().length > 0 ||
      (g.impression ?? "").trim().length > 0 ||
      (g.active_problems?.length ?? 0) > 0 ||
      (g.current_medications?.length ?? 0) > 0 ||
      (g.allergies?.length ?? 0) > 0 ||
      (g.plan?.investigations_ordered?.length ?? 0) > 0 ||
      (g.plan?.treatment_changes?.length ?? 0) > 0 ||
      (g.plan?.consultations_requested?.length ?? 0) > 0 ||
      (g.plan?.follow_up ?? "").trim().length > 0
    );
  }
  if (noteType === "physiotherapy") {
    const pt = note as PhysiotherapyNote;
    return (
      (pt.reason_for_consult ?? "").trim().length > 0 ||
      (pt.assessment ?? "").trim().length > 0 ||
      (pt.current_functional_status ?? "").trim().length > 0 ||
      (pt.rom_findings ?? "").trim().length > 0 ||
      (pt.strength_findings ?? "").trim().length > 0 ||
      (pt.treatment_plan?.exercises_prescribed?.length ?? 0) > 0 ||
      (pt.treatment_plan?.modalities?.length ?? 0) > 0
    );
  }
  if (noteType === "dietetic_consult") {
    const dt = note as DieteticConsultNote;
    return (
      (dt.reason_for_consult ?? "").trim().length > 0 ||
      (dt.nutritional_assessment ?? "").trim().length > 0 ||
      (dt.diet_recall ?? "").trim().length > 0 ||
      (dt.relevant_medical_history?.length ?? 0) > 0 ||
      (dt.diet_plan?.meal_pattern?.length ?? 0) > 0 ||
      (dt.diet_plan?.foods_to_emphasize?.length ?? 0) > 0 ||
      dt.anthropometrics?.weight_kg != null ||
      dt.anthropometrics?.height_cm != null
    );
  }
  if (noteType === "operative_procedure") {
    const op = note as OperativeProcedureNote;
    return (
      (op.procedure_performed?.length ?? 0) > 0 ||
      (op.pre_op_diagnosis ?? "").trim().length > 0 ||
      (op.post_op_diagnosis ?? "").trim().length > 0 ||
      (op.indication ?? "").trim().length > 0 ||
      (op.findings ?? "").trim().length > 0 ||
      (op.procedure_narrative ?? "").trim().length > 0 ||
      (op.surgeon ?? "").trim().length > 0
    );
  }
  if (noteType === "discharge_summary") {
    const ds = note as DischargeSummaryNote;
    return (
      (ds.diagnosis ?? "").trim().length > 0 ||
      (ds.reason_for_admission ?? "").trim().length > 0 ||
      (ds.hospital_course ?? "").trim().length > 0 ||
      (ds.condition_at_discharge ?? "").trim().length > 0 ||
      (ds.discharge_medications?.length ?? 0) > 0 ||
      (ds.medications_administered?.length ?? 0) > 0 ||
      (ds.investigations?.length ?? 0) > 0 ||
      (ds.follow_up_advice ?? "").trim().length > 0
    );
  }
  if (noteType === "opd_prescription") {
    const rx = note as PrescriptionNote;
    return (
      (rx.medications?.length ?? 0) > 0 ||
      (rx.diagnosis ?? "").trim().length > 0 ||
      (rx.investigations_advised?.length ?? 0) > 0 ||
      (rx.follow_up ?? "").trim().length > 0
    );
  }
  const c = note as EncounterNote;
  return (
    (c.chief_complaint ?? "").trim().length > 0 ||
    (c.history_present_illness ?? "").trim().length > 0 ||
    (c.examination ?? "").trim().length > 0 ||
    (c.assessment ?? "").trim().length > 0 ||
    (c.past_medical_history?.length ?? 0) > 0 ||
    (c.current_medications?.length ?? 0) > 0 ||
    (c.allergies?.length ?? 0) > 0 ||
    (c.plan?.investigations?.length ?? 0) > 0 ||
    (c.plan?.treatment?.length ?? 0) > 0 ||
    (c.plan?.follow_up ?? "").trim().length > 0
  );
}

export type NoteResult =
  | { ok: true; note: AnyNote; latency_ms: number; model: string; raw_response: string }
  | { ok: false; error: string; latency_ms: number; raw_response?: string };

export async function generateNote(
  transcript: string,
  opts: { signal?: AbortSignal; onEvent?: (e: NoteEvent) => void; noteType?: string; nativeReference?: string } = {},
): Promise<NoteResult> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) return { ok: false, error: "OLLAMA_BASE_URL not set", latency_ms: 0 };
  const cleanTranscript = (transcript ?? "").trim();
  if (cleanTranscript.length === 0) {
    return { ok: false, error: "empty_transcript", latency_ms: 0 };
  }

  const system =
    opts.noteType === "general_medical" ? SYSTEM_GENERAL :
    opts.noteType === "operative_procedure" ? SYSTEM_OPERATIVE :
    opts.noteType === "dietetic_consult" ? SYSTEM_DIETETIC :
    opts.noteType === "physiotherapy" ? SYSTEM_PHYSIO :
    opts.noteType === "discharge_summary" ? SYSTEM_DISCHARGE :
    opts.noteType === "opd_prescription" ? SYSTEM_RX :
    SYSTEM;

  const userContent =
    (opts.nativeReference && opts.nativeReference.trim().length > 0)
      ? `Transcript (English, primary):\n\n${cleanTranscript}\n\n---\nOriginal-language transcript (REFERENCE ONLY — the English above is primary; consult this to resolve ambiguous wording, drug names, doses, and negations):\n${opts.nativeReference.trim().slice(0, 9000)}`
      : `Transcript:\n\n${cleanTranscript}`;

  const t0 = Date.now();
  opts.onEvent?.({ stage: "note", state: "start" });
  try {
    // Note generation: Gemini (note surface, flash tier) when GEMINI_ALL/GEMINI_NOTE=1
    // + Vertex configured; otherwise local qwen. Soft-fails to qwen on any error.
    const rc = await routedChat({
      surface: "note", tier: "flash", ollamaModel: NOTE_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      temperature: NOTE_TEMPERATURE, responseJson: true, timeoutMs: NOTE_TIMEOUT_MS, signal: opts.signal,
    });
    const latency_ms = rc.latency_ms;
    if (!rc.ok) {
      return { ok: false, error: rc.error ?? "llm_failed", latency_ms };
    }
    const content = rc.content;
    if (!content) {
      return { ok: false, error: "empty_response", latency_ms };
    }
    let parsedRaw: Record<string, unknown>;
    try {
      parsedRaw = JSON.parse(content) as Record<string, unknown>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `json_parse_failed: ${msg.slice(0, 100)}`,
        latency_ms,
        raw_response: content.slice(0, 400),
      };
    }
    // Soft-shape — coerce missing/wrong-typed fields to sensible defaults.
    const S = (v: unknown): string => (typeof v === "string" ? v : "");
    const A = (v: unknown): string[] =>
      Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const N = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
    const B = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    const pl = (parsedRaw.plan ?? {}) as Record<string, unknown>;
    let note: AnyNote;
    if (opts.noteType === "general_medical") {
      note = {
        reason_for_visit: S(parsedRaw.reason_for_visit),
        active_problems: A(parsedRaw.active_problems),
        interval_history: S(parsedRaw.interval_history),
        current_medications: A(parsedRaw.current_medications),
        allergies: A(parsedRaw.allergies),
        examination: S(parsedRaw.examination),
        impression: S(parsedRaw.impression),
        plan: {
          investigations_ordered: A(pl.investigations_ordered),
          treatment_changes: A(pl.treatment_changes),
          consultations_requested: A(pl.consultations_requested),
          follow_up: S(pl.follow_up),
        },
      };
    } else if (opts.noteType === "operative_procedure") {
      const specimens = Array.isArray(parsedRaw.specimens)
        ? (parsedRaw.specimens as unknown[]).map((x) => {
            const ob = (x ?? {}) as Record<string, unknown>;
            const sent = S(ob.sent_to).toLowerCase();
            return { description: S(ob.description), sent_to: sent === "pathology" || sent === "discarded" ? sent : "other" };
          }).filter((z) => z.description.trim().length > 0)
        : [];
      const implants = Array.isArray(parsedRaw.implants)
        ? (parsedRaw.implants as unknown[]).map((x) => {
            const ob = (x ?? {}) as Record<string, unknown>;
            return { description: S(ob.description), catalog_or_serial: S(ob.catalog_or_serial) };
          }).filter((z) => z.description.trim().length > 0)
        : [];
      note = {
        procedure_date_time: S(parsedRaw.procedure_date_time),
        surgical_specialty: S(parsedRaw.surgical_specialty),
        pre_op_diagnosis: S(parsedRaw.pre_op_diagnosis),
        post_op_diagnosis: S(parsedRaw.post_op_diagnosis),
        procedure_performed: A(parsedRaw.procedure_performed),
        surgeon: S(parsedRaw.surgeon),
        assistants: A(parsedRaw.assistants),
        anesthesiologist: S(parsedRaw.anesthesiologist),
        anesthesia_type: S(parsedRaw.anesthesia_type),
        indication: S(parsedRaw.indication),
        findings: S(parsedRaw.findings),
        procedure_narrative: S(parsedRaw.procedure_narrative),
        estimated_blood_loss_ml: N(parsedRaw.estimated_blood_loss_ml),
        fluids_in: S(parsedRaw.fluids_in),
        urine_output_ml: N(parsedRaw.urine_output_ml),
        specimens,
        implants,
        drains_placed: A(parsedRaw.drains_placed),
        complications: S(parsedRaw.complications),
        counts_correct: B(parsedRaw.counts_correct),
        antibiotic_given: S(parsedRaw.antibiotic_given),
        disposition: S(parsedRaw.disposition),
      };
    } else if (opts.noteType === "dietetic_consult") {
      const an = (parsedRaw.anthropometrics ?? {}) as Record<string, unknown>;
      const dp = (parsedRaw.diet_plan ?? {}) as Record<string, unknown>;
      note = {
        reason_for_consult: S(parsedRaw.reason_for_consult),
        relevant_medical_history: A(parsedRaw.relevant_medical_history),
        current_medications: A(parsedRaw.current_medications),
        allergies_and_intolerances: A(parsedRaw.allergies_and_intolerances),
        anthropometrics: {
          weight_kg: N(an.weight_kg),
          height_cm: N(an.height_cm),
          bmi: N(an.bmi),
          waist_circumference_cm: N(an.waist_circumference_cm),
          body_fat_percent: N(an.body_fat_percent),
          other: S(an.other),
        },
        diet_recall: S(parsedRaw.diet_recall),
        food_preferences_and_aversions: A(parsedRaw.food_preferences_and_aversions),
        nutritional_assessment: S(parsedRaw.nutritional_assessment),
        diet_plan: {
          daily_calorie_target_kcal: N(dp.daily_calorie_target_kcal),
          macronutrient_distribution: S(dp.macronutrient_distribution),
          meal_pattern: A(dp.meal_pattern),
          foods_to_emphasize: A(dp.foods_to_emphasize),
          foods_to_limit_or_avoid: A(dp.foods_to_limit_or_avoid),
          supplements_recommended: A(dp.supplements_recommended),
          behavioural_goals: A(dp.behavioural_goals),
        },
        follow_up: S(parsedRaw.follow_up),
      };
    } else if (opts.noteType === "physiotherapy") {
      const pa = (parsedRaw.pain_assessment ?? {}) as Record<string, unknown>;
      const tp = (parsedRaw.treatment_plan ?? {}) as Record<string, unknown>;
      note = {
        reason_for_consult: S(parsedRaw.reason_for_consult),
        relevant_medical_history: A(parsedRaw.relevant_medical_history),
        current_medications: A(parsedRaw.current_medications),
        functional_status_baseline: S(parsedRaw.functional_status_baseline),
        current_functional_status: S(parsedRaw.current_functional_status),
        pain_assessment: {
          location: S(pa.location),
          score_0_10: N(pa.score_0_10),
          quality: S(pa.quality),
          aggravating_factors: A(pa.aggravating_factors),
          relieving_factors: A(pa.relieving_factors),
        },
        rom_findings: S(parsedRaw.rom_findings),
        strength_findings: S(parsedRaw.strength_findings),
        special_tests: A(parsedRaw.special_tests),
        posture_and_gait: S(parsedRaw.posture_and_gait),
        assessment: S(parsedRaw.assessment),
        treatment_plan: {
          modalities: A(tp.modalities),
          exercises_prescribed: A(tp.exercises_prescribed),
          home_program: A(tp.home_program),
          precautions: A(tp.precautions),
          expected_outcomes: S(tp.expected_outcomes),
          sessions_per_week: N(tp.sessions_per_week),
          expected_duration_weeks: N(tp.expected_duration_weeks),
        },
        follow_up: S(parsedRaw.follow_up),
      };
    } else if (opts.noteType === "discharge_summary") {
      note = {
        reason_for_admission: S(parsedRaw.reason_for_admission),
        significant_findings: S(parsedRaw.significant_findings),
        diagnosis: S(parsedRaw.diagnosis),
        hospital_course: S(parsedRaw.hospital_course),
        investigations: A(parsedRaw.investigations),
        procedures_performed: A(parsedRaw.procedures_performed),
        medications_administered: A(parsedRaw.medications_administered),
        condition_at_discharge: S(parsedRaw.condition_at_discharge),
        discharge_medications: A(parsedRaw.discharge_medications),
        follow_up_advice: S(parsedRaw.follow_up_advice),
        patient_instructions: A(parsedRaw.patient_instructions),
        urgent_care_instructions: S(parsedRaw.urgent_care_instructions),
        outcome: S(parsedRaw.outcome),
      };
    } else if (opts.noteType === "opd_prescription") {
      note = {
        diagnosis: S(parsedRaw.diagnosis),
        allergies: A(parsedRaw.allergies),
        medications: A(parsedRaw.medications),
        investigations_advised: A(parsedRaw.investigations_advised),
        follow_up: S(parsedRaw.follow_up),
        general_advice: A(parsedRaw.general_advice),
      };
    } else {
      note = {
        chief_complaint: S(parsedRaw.chief_complaint),
        history_present_illness: S(parsedRaw.history_present_illness),
        past_medical_history: A(parsedRaw.past_medical_history),
        current_medications: A(parsedRaw.current_medications),
        allergies: A(parsedRaw.allergies),
        examination: S(parsedRaw.examination),
        assessment: S(parsedRaw.assessment),
        plan: {
          investigations: A(pl.investigations),
          treatment: A(pl.treatment),
          follow_up: S(pl.follow_up),
        },
      };
    }
    opts.onEvent?.({ stage: "note", state: "done", ms: latency_ms, chief_complaint: noteHeadline(note, opts.noteType) });
    return { ok: true, note, latency_ms, model: NOTE_MODEL, raw_response: content };
  } catch (e: unknown) {
    const latency_ms = Date.now() - t0;
    const err =
      e instanceof Error
        ? e.message.slice(0, 200)
        : String(e).slice(0, 200);
    opts.onEvent?.({ stage: "note", state: "error", message: err, ms: latency_ms });
    return { ok: false, error: err, latency_ms };
  }
}
