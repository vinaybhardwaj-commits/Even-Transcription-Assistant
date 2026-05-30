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
  "chief_complaint": string,                      // reason for today's review / the active problem in focus (one line)
  "history_present_illness": string,              // INTERVAL HISTORY — what has changed since the last review / since admission: events, response to treatment, new symptoms
  "past_medical_history": [string, ...],          // active/ongoing problems + relevant comorbidities
  "current_medications": [string, ...],           // current inpatient meds with dose + frequency; note recent starts/stops/dose changes
  "allergies": [string, ...],                     // empty array if NKDA or not discussed
  "examination": string,                          // today's exam findings, may include vital signs
  "assessment": string,                           // TODAY'S clinical impression / synthesis, per active problem
  "plan": {
    "investigations": [string, ...],              // labs, imaging, procedures ordered today
    "treatment": [string, ...],                   // treatment changes today (started/stopped/dose-adjusted) AND consultations requested (e.g. cardiology, neurology)
    "follow_up": string                           // plan for next review, disposition, red-flag advice
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

export type NoteResult =
  | { ok: true; note: EncounterNote; latency_ms: number; model: string; raw_response: string }
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
    let parsed: EncounterNote;
    try {
      parsed = JSON.parse(content) as EncounterNote;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `json_parse_failed: ${msg.slice(0, 100)}`,
        latency_ms,
        raw_response: content.slice(0, 400),
      };
    }
    // Soft-shape — fill in missing fields with sensible defaults
    const note: EncounterNote = {
      chief_complaint: typeof parsed.chief_complaint === "string" ? parsed.chief_complaint : "",
      history_present_illness:
        typeof parsed.history_present_illness === "string" ? parsed.history_present_illness : "",
      past_medical_history: Array.isArray(parsed.past_medical_history)
        ? parsed.past_medical_history.filter((s) => typeof s === "string")
        : [],
      current_medications: Array.isArray(parsed.current_medications)
        ? parsed.current_medications.filter((s) => typeof s === "string")
        : [],
      allergies: Array.isArray(parsed.allergies)
        ? parsed.allergies.filter((s) => typeof s === "string")
        : [],
      examination: typeof parsed.examination === "string" ? parsed.examination : "",
      assessment: typeof parsed.assessment === "string" ? parsed.assessment : "",
      plan: {
        investigations: Array.isArray(parsed.plan?.investigations)
          ? parsed.plan.investigations.filter((s) => typeof s === "string")
          : [],
        treatment: Array.isArray(parsed.plan?.treatment)
          ? parsed.plan.treatment.filter((s) => typeof s === "string")
          : [],
        follow_up: typeof parsed.plan?.follow_up === "string" ? parsed.plan.follow_up : "",
      },
    };
    opts.onEvent?.({ stage: "note", state: "done", ms: latency_ms, chief_complaint: note.chief_complaint });
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
