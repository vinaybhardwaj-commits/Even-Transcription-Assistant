/**
 * lib/consult-index/palimpsest-view.ts — PURE: the palimpsest's Sarvam tracks of a cut, expressed in EXACTLY the shapes scribe_sarvam's own results use, so a caller cannot tell the two apart except by `source`.
 *
 * It builds the two things the normal path already has: a ConsultResult (the stored-result row: models, counts, language, duration) and a ResultDoc (the stored R2 document: entries, English track,
 * transcript, English text). The tools then run the SAME code on them (existingSummary, the consult_result head, consultResultView), so the key sets match by construction; the parity test pins it.
 *
 * Field mapping: speaker_id <- the track's speaker label ("" when the stt track has none); language_code <- the segment's lang; transcript / english <- the segment texts joined; speakers <- distinct labels;
 * english_pass "done" when a translate track exists, else "not_requested"; model_stt / model_rev <- the track's model / version; model_translate <- the translate track's model (the English pass is saaras translate
 * mode), else mayura:v1 as for our own results; job_id null (no job ran); created_at null (the track carries no time we can vouch for).
 */
import type { ResultDoc, ResultEntry, EnglishEntry } from "@/lib/jobs/kinds/sarvam-common";
import type { ConsultResult, StoredIndexRow } from "@/lib/room-access/consult-index-store";
import type { SarvamTrack } from "@/lib/room-access/readers/reb-consult";

export const PALIMPSEST_SOURCE = "palimpsest";

export type PalimpsestAsResult = { result: ConsultResult & { source: "palimpsest" }; doc: ResultDoc };

const text = (t: SarvamTrack | null): string => (t ? t.segments.map((g) => g.text).join(" ").trim() : "");

export function palimpsestAsResult(row: Pick<StoredIndexRow, "consult_uid" | "cut_version" | "t0_ms" | "t1_ms">, stt: SarvamTrack, translate: SarvamTrack | null): PalimpsestAsResult {
  const rel = (ms: number): number => (ms - row.t0_ms) / 1000;
  const entries: ResultEntry[] = stt.segments.map((g) => ({ speaker_id: g.speaker ?? "", start_s: rel(g.t0_ms), end_s: rel(g.t1_ms), text: g.text, language_code: g.lang }));
  // PAIR the English with the native entries BY TIME, as our own English-on result does (every entry carries its `english`): each translate segment goes to the stt entry it overlaps most (the earlier on a tie);
  // an entry that no translate segment overlaps gets "" (it is still present, like our own unpaired entries). Without a translate track no entry carries `english`, exactly like our english:false results.
  const pairedTo: Array<number | null> = (translate?.segments ?? []).map((t) => {
    let best = -1, bestOverlap = 0;
    stt.segments.forEach((g, i) => {
      const ov = Math.min(g.t1_ms, t.t1_ms) - Math.max(g.t0_ms, t.t0_ms);
      if (ov > bestOverlap) { bestOverlap = ov; best = i; }
    });
    return best >= 0 ? best : null;
  });
  if (translate) {
    const bucket: string[][] = entries.map(() => []);
    translate.segments.forEach((t, j) => { const i = pairedTo[j]; if (i !== null && i !== undefined) bucket[i]!.push(t.text); });
    entries.forEach((e, i) => { e.english = bucket[i]!.join(" ").trim(); });
  }
  const english_entries: EnglishEntry[] = (translate?.segments ?? []).map((g, j) => ({ speaker_id: g.speaker ?? "", start_s: rel(g.t0_ms), end_s: rel(g.t1_ms), text: g.text, source: "translate_pass", native_idx: pairedTo[j] ?? null }));
  const speakers = [...new Set(entries.map((e) => e.speaker_id).filter((s) => s !== ""))].sort();
  const transcript = text(stt);
  const english = text(translate);
  const language_code = stt.segments.find((g) => g.lang)?.lang ?? null;
  const duration_s = Math.round(((row.t1_ms - row.t0_ms) / 1000) * 100) / 100;
  const doc: ResultDoc = {
    language_code, duration_s, speakers, entries, transcript, ...(translate ? { english, english_entries } : {}),
    english_pass: translate ? "done" : "not_requested",
  };
  const result = {
    consult_uid: row.consult_uid, cut_version: row.cut_version, mode: "transcribe", english: translate !== null, num_speakers: null, job_id: "", result_r2_key: stt.r2_key,
    model_stt: stt.model ?? "saaras:v3", model_translate: translate?.model ?? "mayura:v1", model_rev: stt.version ?? stt.model ?? "saaras-v3", pipeline_rev: "palimpsest",
    language_code, duration_s, speaker_count: speakers.length, transcript_chars: transcript.length, english_chars: english.length, english_pass: doc.english_pass ?? "not_requested", t0_ms: row.t0_ms, created_at: "",
    source: PALIMPSEST_SOURCE,
  } as ConsultResult & { source: "palimpsest" };
  return { result, doc };
}
