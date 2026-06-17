/**
 * Indic Comprehension Layer (PRD: ETA-INDIC-COMPREHENSION-LAYER-PRD.md).
 *
 * For non-English encounters, AFTER the native transcript + the English
 * translation exist, this produces a faithful NATIVE-LANGUAGE structured
 * analysis (saved for inspection/dissemination) and supplies the native
 * transcript as a ground-truth reference to the English note model.
 *
 * Flag ETA_INDIC_COMPREHENSION (default ON; set "0" to disable). Soft-fail:
 * any error leaves today's behaviour untouched (English note from Saaras).
 */
import { qwenJson } from "@/lib/qwen";
import { geminiChatIfOn } from "@/lib/llm/gemini";

export const INDIC_COMPREHENSION_ON = () => process.env.ETA_INDIC_COMPREHENSION !== "0";

export type NativeAnalysis = {
  language: string;
  chief_complaint?: string;
  symptoms?: string[];
  medications?: string[];      // as spoken, including doses/units
  negatives?: string[];        // explicitly stated negatives ("no fever")
  patient_concerns?: string[];
  summary?: string;            // short paragraph, in the native language
};

const SYSTEM_NATIVE = `You are a careful clinical scribe fluent in Indian languages. You are given a VERBATIM transcript of a doctor-patient encounter in its ORIGINAL language and script. Produce a FAITHFUL structured analysis IN THE SAME LANGUAGE AND SCRIPT as the transcript — do NOT translate to English. Rules: do not add, infer, or invent anything that was not said; preserve drug names, doses and units EXACTLY as spoken (keep English medical terms in English); capture explicitly stated negatives (e.g. patient denies fever). Return ONLY JSON: {"language","chief_complaint","symptoms":[],"medications":[],"negatives":[],"patient_concerns":[],"summary"}.`;

/** Faithful native-language analysis of the encounter. Null on empty/failure. */
export async function generateNativeAnalysis(nativeTranscript: string, lang: string | null): Promise<NativeAnalysis | null> {
  const t = (nativeTranscript || "").trim();
  if (t.length < 10) return null;
  const user = `Language: ${lang ?? "unknown"}\nTranscript:\n${t.slice(0, 9000)}`;
  // Native analysis on Gemini (native surface, flash) when GEMINI_ALL/GEMINI_NATIVE=1
  // + Vertex configured; falls through to local qwen otherwise / on failure.
  try {
    const g = await geminiChatIfOn("native", "flash", [
      { role: "system", content: SYSTEM_NATIVE }, { role: "user", content: user },
    ], { temperature: 0, responseJson: true, timeoutMs: 60_000 });
    if (g && g.ok && g.content) {
      try { const j = JSON.parse(g.content) as NativeAnalysis; if (j && !j.language) j.language = lang ?? "unknown"; return j; } catch { /* fall through to qwen */ }
    }
  } catch { /* fall through to qwen */ }
  try {
    const r = await qwenJson<NativeAnalysis>(SYSTEM_NATIVE, user, { temperature: 0, timeoutMs: 60_000 });
    const j = r.json ?? null;
    if (j && !j.language) j.language = lang ?? "unknown";
    return j;
  } catch { return null; }
}
