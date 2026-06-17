/**
 * Transcript fusion (ensemble + Gemini-2.5-Pro synthesis).
 *
 * Code-mixed clinical speech (English + Hindi/Kannada/…) defeats any single ASR:
 * Deepgram nails English but not Indic; Sarvam is Indic-aware but its translation
 * hallucinates; IndicConformer gives clean native script per segment; the
 * eta-router stitches per-segment. Instead of PICKING one (lossy), we PRESERVE
 * every engine's output (English + native script) and let Gemini 2.5 Pro
 * reconcile them into the single most faithful English clinical transcript,
 * using the native-script versions as ground truth.
 *
 * Soft-fail: if Gemini is off/unconfigured or errors, returns ok:false and the
 * caller keeps the best single candidate — behaviour never regresses.
 */
import { geminiChatIfOn } from "@/lib/llm/gemini";

export type TranscriptCandidate = {
  engine: string;
  english: string;
  native: string | null;
  language: string | null;
};

/** Master flag (default ON). Only ACTS when Gemini is configured + flagged on
 *  (GEMINI_ALL=1 or GEMINI_FUSION=1), since fusion routes to gemini-2.5-pro. */
export function TRANSCRIPT_FUSION_ON(): boolean {
  return process.env.TRANSCRIPT_FUSION !== "0";
}

const FUSION_SYSTEM = `You are a clinical transcription FUSION expert for an Indian hospital. You receive several machine transcriptions of the SAME doctor–patient encounter audio, produced by different speech engines. Some are English translations; some are the ORIGINAL Indian-language text in native script (Devanagari/Kannada/Tamil/etc.). Each engine is strong in different languages and ALL are imperfect — mishearings, dropped segments, mistranslations, and hallucination loops (a word or token repeated many times).

Your job: reconstruct the SINGLE most faithful, complete ENGLISH clinical transcript of the actual conversation.

Rules:
- Treat the NATIVE-SCRIPT candidates as ground truth for what was said; use them to correct and disambiguate the English candidates.
- Cross-check the engines against each other; where they agree, trust it; where they differ, choose the clinically coherent reading.
- PRESERVE every clinical detail exactly: drug names, doses, units, frequencies, routes, negations ("no fever"), durations, anatomy, lab values, vitals, and numbers.
- REMOVE obvious hallucination artifacts (e.g. the same token repeated many times in a row) — do not carry them into the output.
- Do NOT invent content that no source supports. Do NOT summarize — produce a full verbatim-style transcript of the dialogue, in English.
- Keep the natural back-and-forth flow of the conversation. Output English only (translate native portions faithfully).

Return ONLY a JSON object: {"transcript": "<the fused English transcript>", "uncertainty_notes": "<short note on any low-confidence spots, or empty>"}.`;

const PER_CAND_CAP = 24000;

export async function fuseTranscript(
  candidates: TranscriptCandidate[],
  opts: { languageTimeline?: unknown; durationSeconds?: number | null } = {},
): Promise<{ ok: boolean; english: string; provider: string; notes?: string; engines: number }> {
  const cands = candidates.filter((c) => c.english && c.english.trim().length > 0);
  if (cands.length === 0) return { ok: false, english: "", provider: "none", engines: 0 };

  const parts: string[] = [];
  cands.forEach((c, i) => {
    parts.push(
      `### Candidate ${i + 1} — engine "${c.engine}"${c.language ? ` (detected ${c.language})` : ""} — ENGLISH:\n${c.english.trim().slice(0, PER_CAND_CAP)}`,
    );
    if (c.native && c.native.trim().length > 0) {
      parts.push(
        `### Candidate ${i + 1} — engine "${c.engine}" — ORIGINAL NATIVE SCRIPT (ground truth):\n${c.native.trim().slice(0, PER_CAND_CAP)}`,
      );
    }
  });

  const user = `Encounter duration: ${opts.durationSeconds ?? "?"} seconds. ${cands.length} parallel machine transcription(s) of ONE clinical encounter follow. Reconcile them into the single best, faithful English transcript per the rules.\n\n${parts.join("\n\n")}`;

  const res = await geminiChatIfOn(
    "fusion",
    "pro",
    [
      { role: "system", content: FUSION_SYSTEM },
      { role: "user", content: user },
    ],
    { temperature: 0, responseJson: true, timeoutMs: 120_000 },
  );

  // geminiChatIfOn returns null when Gemini is off/unconfigured -> caller keeps best candidate.
  if (!res) return { ok: false, english: "", provider: "off", engines: cands.length };
  if (!res.ok || !res.content) return { ok: false, english: "", provider: "error", engines: cands.length };
  try {
    const j = JSON.parse(res.content) as { transcript?: string; uncertainty_notes?: string };
    const t = (j.transcript ?? "").trim();
    if (!t) return { ok: false, english: "", provider: "empty", engines: cands.length };
    return { ok: true, english: t, provider: "gemini", notes: j.uncertainty_notes, engines: cands.length };
  } catch {
    return { ok: false, english: "", provider: "parse_error", engines: cands.length };
  }
}
