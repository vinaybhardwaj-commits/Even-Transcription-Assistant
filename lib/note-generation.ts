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

export type AnyNote = EncounterNote | GeneralMedicalNote;

/** One-line headline for an encounter (list titles, trace summaries, subject). */
export function noteHeadline(note: AnyNote | null | undefined, noteType?: string): string {
  if (!note) return "";
  if (noteType === "general_medical") return (note as GeneralMedicalNote).reason_for_visit ?? "";
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
  opts: { signal?: AbortSignal; onEvent?: (e: NoteEvent) => void; noteType?: string } = {},
): Promise<NoteResult> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) return { ok: false, error: "OLLAMA_BASE_URL not set", latency_ms: 0 };
  const cleanTranscript = transcript.trim();
  if (cleanTranscript.length === 0) {
    return { ok: false, error: "empty_transcript", latency_ms: 0 };
  }

  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), NOTE_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const system = opts.noteType === "general_medical" ? SYSTEM_GENERAL : SYSTEM;

  const t0 = Date.now();
  opts.onEvent?.({ stage: "note", state: "start" });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LLM_API_KEY ?? "ollama"}`,
      },
      body: JSON.stringify({
        model: NOTE_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Transcript:\n\n${cleanTranscript}` },
        ],
        temperature: NOTE_TEMPERATURE,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `http_${res.status}: ${text.slice(0, 150)}`, latency_ms };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = (json.choices?.[0]?.message?.content ?? "").trim();
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
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;
    const err =
      controller.signal.aborted
        ? `timeout_${NOTE_TIMEOUT_MS}ms`
        : e instanceof Error
        ? e.message.slice(0, 200)
        : String(e).slice(0, 200);
    opts.onEvent?.({ stage: "note", state: "error", message: err, ms: latency_ms });
    return { ok: false, error: err, latency_ms };
  }
}
