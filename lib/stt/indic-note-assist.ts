/**
 * Submit-time Indic "parallel pick-best" for the NOTE transcript (flag-gated).
 *
 * Today /process translates non-English audio with Sarvam batch (transcribe +
 * translate) and feeds that English into note-gen. This helper optionally runs
 * AI4Bharat IndicConformer in parallel on the SAME audio (native script, local,
 * fast), translates it to English (preserving English medical terms), and picks
 * the better English basis for the note. It is:
 *   - OFF by default (env ETA_NOTE_PARALLEL_INDIC=1 to enable),
 *   - Indic-only (the adapter no-ops on English/null),
 *   - fully soft-failing: ANY error/uncertainty -> keep Sarvam. It can never
 *     produce a worse note than today, only override when it's clearly better.
 *
 * Why pick (not merge): a merge could hallucinate; for clinical text a
 * conservative pick with a strong Sarvam default is safer. IndicConformer wins
 * mainly on monolingual-Indic speech; Sarvam keeps its edge on code-mix (where
 * the clinically-critical English terms live).
 */
import { indicconformerAdapter } from "./adapters/indicconformer";
import { qwenJson } from "@/lib/qwen";

export const INDIC_NOTE_ASSIST_ON = () => process.env.ETA_NOTE_PARALLEL_INDIC === "1";

export type IndicAssist = {
  used: "sarvam" | "indicconformer";
  english: string;
  indicNative?: string;
  reason?: string;
};

async function translateNativeToEnglish(native: string, lang: string): Promise<string | null> {
  const sys =
    "You are a clinical translator. Translate the Indian-language clinical transcript to natural English. " +
    "CRITICAL: keep English medical terms, drug names, doses, units, and abbreviations exactly as a clinician writes them. " +
    "Do NOT add, omit, summarize, or invent content. Return JSON {\"english\":\"...\"}.";
  try {
    const r = await qwenJson<{ english?: string }>(sys, `Language: ${lang}\nTranscript:\n${native.slice(0, 8000)}`, { temperature: 0, timeoutMs: 60_000 });
    const t = (r.json?.english ?? "").trim();
    return t || null;
  } catch { return null; }
}

async function pickBetter(sarvamEn: string, indicEn: string): Promise<{ winner: "sarvam" | "indicconformer"; reason: string }> {
  const sys =
    "You compare two English transcripts of the SAME Indian-language clinical encounter (A from one engine, B from another). " +
    "Pick the one that is more COMPLETE and clinically FAITHFUL: better preserves findings, drug names, doses and units, more coherent, fewer dropped segments. " +
    "Do NOT reward length alone. If they are equivalent or you are unsure, pick A. Return JSON {\"winner\":\"A\"|\"B\",\"reason\":\"...\"}.";
  try {
    const r = await qwenJson<{ winner?: string; reason?: string }>(sys, `TRANSCRIPT A:\n${sarvamEn.slice(0, 6000)}\n\nTRANSCRIPT B:\n${indicEn.slice(0, 6000)}`, { temperature: 0, timeoutMs: 60_000 });
    const w = (r.json?.winner ?? "A").trim().toUpperCase().startsWith("B") ? "indicconformer" : "sarvam";
    return { winner: w, reason: (r.json?.reason ?? "").slice(0, 200) };
  } catch { return { winner: "sarvam", reason: "pick_failed" }; }
}

/** Returns the chosen English transcript for the note. Soft-fails to Sarvam. */
export async function indicNoteAssist(args: {
  bytes: Buffer | Uint8Array;
  contentType: string;
  detectedLanguage: string | null;
  sarvamEnglish: string;
  emit?: (o: unknown) => void;
}): Promise<IndicAssist> {
  const sarvam: IndicAssist = { used: "sarvam", english: args.sarvamEnglish };
  if (!INDIC_NOTE_ASSIST_ON()) return sarvam;

  // IndicConformer native-script ASR. Indic-only: no-ops (skipped) on non-Indic.
  const asr = await indicconformerAdapter.transcribe(args.bytes as Buffer, {
    contentType: args.contentType,
    language: args.detectedLanguage ?? undefined,
    longForm: true,
  });
  if (asr.error || !asr.original) return sarvam;
  args.emit?.({ stage: "progress", msg: "IndicConformer transcript ready; comparing for the note…" });

  const indicEn = await translateNativeToEnglish(asr.original, asr.language ?? args.detectedLanguage ?? "hi");
  if (!indicEn) return { ...sarvam, indicNative: asr.original };

  // If Sarvam came back empty/very thin (a real failure mode), prefer IndicConformer outright.
  if (args.sarvamEnglish.trim().length < 40 && indicEn.length >= 40) {
    args.emit?.({ stage: "progress", msg: "Sarvam output thin; using IndicConformer for the note" });
    return { used: "indicconformer", english: indicEn, indicNative: asr.original, reason: "sarvam_thin" };
  }

  const { winner, reason } = await pickBetter(args.sarvamEnglish, indicEn);
  if (winner === "indicconformer") {
    args.emit?.({ stage: "progress", msg: "IndicConformer transcript chosen for the note" });
    return { used: "indicconformer", english: indicEn, indicNative: asr.original, reason };
  }
  return { used: "sarvam", english: args.sarvamEnglish, indicNative: asr.original, reason };
}
