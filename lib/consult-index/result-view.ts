/**
 * lib/consult-index/result-view.ts — PURE: a stored Sarvam result (the R2 ResultDoc of a consult job) as the MCP returns it: transcript, English, and segments with ABSOLUTE UTC times
 * (the clip's t0 from consult_index + the entry's offset in seconds). Times only; no clip key, no Sarvam job id, no doctor field.
 */
import type { EnglishEntry, ResultDoc, ResultEntry } from "@/lib/jobs/kinds/sarvam-common";

export type AbsSegment = { speaker_id: string; t0_ms: number; t1_ms: number; text: string; english?: string; language_code?: string | null };
export type AbsEnglish = { speaker_id: string; t0_ms: number; t1_ms: number; text: string; source: EnglishEntry["source"] };

const abs = (t0: number, s: number): number => Math.round(t0 + (Number.isFinite(s) ? s : 0) * 1000);

export function consultResultView(doc: ResultDoc, clipT0Ms: number): { transcript: string; english: string | null; language_code: string | null; duration_s: number; segments: AbsSegment[]; english_segments: AbsEnglish[] } {
  const segments = (doc.entries ?? []).map((e: ResultEntry): AbsSegment => ({
    speaker_id: e.speaker_id, t0_ms: abs(clipT0Ms, e.start_s), t1_ms: abs(clipT0Ms, e.end_s), text: e.text,
    ...(e.english !== undefined ? { english: e.english } : {}), ...(e.language_code !== undefined ? { language_code: e.language_code } : {}),
  }));
  const english_segments = (doc.english_entries ?? []).map((e: EnglishEntry): AbsEnglish => ({ speaker_id: e.speaker_id, t0_ms: abs(clipT0Ms, e.start_s), t1_ms: abs(clipT0Ms, e.end_s), text: e.text, source: e.source }));
  return { transcript: doc.transcript ?? "", english: doc.english ?? null, language_code: doc.language_code ?? null, duration_s: doc.duration_s, segments, english_segments };
}
