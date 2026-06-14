/**
 * transcript-quality — patient-safety guardrail. A transcription failure must
 * NEVER silently become a confident clinical note (the Poornima failure: a
 * garbled/thin transcript still produced a finished note missing the findings).
 *
 * assessTranscriptQuality flags a transcript as empty / short / low_quality so
 * the UI can warn the clinician to review the recording. It is advisory (flag,
 * not block) — we still keep whatever was captured. Pure + unit-tested.
 */

export type TranscriptFlag = "empty" | "short" | "low_quality" | null;

export type TranscriptQuality = {
  flag: TranscriptFlag;
  reason: string | null;
  chars: number;
  words: number;
  cpm: number | null;          // chars per minute (null if duration unknown)
  unique_ratio: number | null; // unique words / total words
};

// Tunable thresholds (deliberately err toward flagging — a false warning is
// cheap, a silently-incomplete clinical note is not).
const MIN_CHARS = 120;          // below this for a non-trivial recording = basically nothing
const MIN_CPM = 300;            // chars/minute floor; real consults run far higher
const MIN_DURATION_S = 45;      // don't judge very short clips by volume
const MIN_WORDS_FOR_RATIO = 12; // need enough words before the repetition check is meaningful
const MIN_UNIQUE_RATIO = 0.2;   // hallucination loops ("I am pregnant" x20 ~0.05) collapse this; real long transcripts stay ~0.3+

export function assessTranscriptQuality(
  text: string | null | undefined,
  durationSeconds: number | null | undefined,
): TranscriptQuality {
  const t = (text ?? "").trim();
  const chars = t.length;
  const dur = typeof durationSeconds === "number" && durationSeconds > 0 ? durationSeconds : null;
  const wordList = t.length ? t.split(/\s+/).filter(Boolean) : [];
  const words = wordList.length;
  const cpm = dur ? Math.round(chars / (dur / 60)) : null;
  const norm = wordList.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const unique_ratio = norm.length ? new Set(norm).size / norm.length : null;

  const base = { chars, words, cpm, unique_ratio };

  if (chars === 0) {
    return { ...base, flag: "empty", reason: "No transcript was produced from the audio." };
  }
  // Hallucination / degenerate loop: lots of words but very few distinct ones.
  if (norm.length >= MIN_WORDS_FOR_RATIO && unique_ratio !== null && unique_ratio < MIN_UNIQUE_RATIO) {
    return { ...base, flag: "low_quality", reason: `Transcript looks degraded (only ${Math.round((unique_ratio ?? 0) * 100)}% distinct words) — likely a transcription failure.` };
  }
  // Implausibly short for the recording length.
  const longEnough = dur === null || dur >= MIN_DURATION_S;
  if (longEnough && chars < MIN_CHARS) {
    return { ...base, flag: "short", reason: `Only ${chars} characters captured${dur ? ` for ${Math.round(dur / 60)} min of audio` : ""} — the transcription may be incomplete.` };
  }
  if (cpm !== null && dur !== null && dur >= 60 && cpm < MIN_CPM) {
    return { ...base, flag: "short", reason: `Transcript is sparse (${cpm} chars/min over ${Math.round(dur / 60)} min) — the transcription may be incomplete.` };
  }
  return { ...base, flag: null, reason: null };
}
