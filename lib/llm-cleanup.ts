/**
 * Per-utterance cleanup via llama3.1:8b on the Mac Mini (Ollama).
 *
 * Receives a single transcribed utterance from Deepgram (or Whisper)
 * and returns it minus filler words, false starts, and common
 * mispronunciations. Critically — clinical content (drug, dose,
 * frequency, exam findings, numbers) is preserved verbatim.
 *
 * Target latency: <1s on llama3.1:8b warm. Soft-fail: on any error
 * the caller falls back to the raw text.
 *
 * Uses the OpenAI-compatible Ollama endpoint at $OLLAMA_BASE_URL (already includes /v1).
 */

const CLEANUP_MODEL = process.env.CLEANUP_MODEL || "llama3.1:8b";
const CLEANUP_TIMEOUT_MS = 8_000;
const CLEANUP_TEMPERATURE = 0;
const CLEANUP_MAX_TOKENS = 384;

const SYSTEM = `You clean up medical dictation transcribed from a clinician's voice during a patient encounter. Return ONLY the cleaned text on a single line — no preamble, no quotes, no explanation, no labels.

Rules:
- Remove filler words: um, uh, er, like, you know, sort of, kind of
- Remove false starts: "the patient is — the patient was" → "the patient was"
- Fix obvious mistranscriptions of common medical terms (Tylenol not "tyl null", metformin not "met form in", paracetamol not "para set um ol")
- Preserve all clinical content verbatim: drug names, doses, frequencies, lab values, symptoms, exam findings, vital signs, all numbers
- Do NOT add interpretation, expand abbreviations, change word order, or add punctuation that wasn't implied
- Preserve the source language(s): English, Hindi, Kannada, or any code-switching between them
- If the text is already clean, return it unchanged
- If the text is empty or unintelligible, return it unchanged`;

export type CleanupResult =
  | {
      ok: true;
      cleaned: string;
      latency_ms: number;
      model: string;
    }
  | {
      ok: false;
      error: string;
      latency_ms: number;
    };

export async function cleanUtterance(
  raw: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CleanupResult> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) {
    return { ok: false, error: "OLLAMA_BASE_URL not set", latency_ms: 0 };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, cleaned: "", latency_ms: 0, model: CLEANUP_MODEL };
  }

  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LLM_API_KEY ?? "ollama"}`,
      },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: trimmed },
        ],
        temperature: CLEANUP_TEMPERATURE,
        max_tokens: CLEANUP_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `http_${res.status}: ${text.slice(0, 120)}`,
        latency_ms,
      };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const cleaned = (json.choices?.[0]?.message?.content ?? "").trim();
    if (cleaned.length === 0) {
      return { ok: false, error: "empty_response", latency_ms };
    }
    return { ok: true, cleaned, latency_ms, model: CLEANUP_MODEL };
  } catch (e: unknown) {
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;
    if (controller.signal.aborted) {
      return { ok: false, error: `timeout_${CLEANUP_TIMEOUT_MS}ms`, latency_ms };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 200), latency_ms };
  }
}
