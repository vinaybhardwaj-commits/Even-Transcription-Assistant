/**
 * lib/emotion/store.ts — THE ONLY WRITER of room_span_emotion and room_emotion_window.
 * Called by the emotion_window job and nothing else.
 */
import { sql } from "@/lib/db";
import type { PlannedSegment, SkippedSpan } from "./segments";
import type { SegmentScore } from "./client";

export type SegmentWrite = {
  windowId: string;
  roomDayId: string | null;
  diarizeAttempt: number;
  clipR2Key: string | null;
  windowStartMs: number;
  cap_s: number;
  model: { model: string | null; model_key: string | null; subfolder: string | null; device: string | null };
};

// source_refs travel as a JSON array and are unpacked in SQL: one spelling that every driver binds the
// same way, rather than trusting each to map a JS array onto text[].

/** Idempotent per (window, diarize attempt, speaker, run start, chunk): a re-run writes nothing new. */
export async function writeScoredOrFailed(w: SegmentWrite, seg: PlannedSegment, score: SegmentScore): Promise<void> {
  const scored = score.ok ? score : null;
  const reason = score.ok ? null : score.reason;
  await sql`
    INSERT INTO room_span_emotion
      (window_id, diarize_attempt, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
       room_day_id, speaker_idx, source_refs, clip_r2_key, clip_start_s, clip_end_s, state, reason,
       anger, disgust, enthusiasm, fear, happiness, neutral, sadness, labels_json, top_label, top_score,
       model, model_key, subfolder, device, inference_s, duration_s, cap_s, scored_at)
    VALUES
      (${w.windowId}, ${w.diarizeAttempt}, ${seg.run_start_ms}, ${seg.run_end_ms}, ${seg.chunk_idx}, ${seg.chunk_count}, ${seg.start_ms}, ${seg.end_ms},
       ${w.roomDayId}, ${seg.speaker_idx}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(seg.source_refs)}::jsonb)), ${w.clipR2Key}, ${seg.clip_start_s}, ${seg.clip_end_s},
       ${scored ? "scored" : "failed"}, ${reason},
       ${scored?.labels.anger ?? null}, ${scored?.labels.disgust ?? null}, ${scored?.labels.enthusiasm ?? null}, ${scored?.labels.fear ?? null},
       ${scored?.labels.happiness ?? null}, ${scored?.labels.neutral ?? null}, ${scored?.labels.sadness ?? null},
       ${scored ? JSON.stringify(scored.labels) : null}::jsonb, ${scored?.top_label ?? null}, ${scored?.top_score ?? null},
       ${w.model.model}, ${w.model.model_key}, ${w.model.subfolder}, ${w.model.device},
       ${scored?.inference_s ?? null}, ${scored?.duration_s ?? null}, ${w.cap_s}, NOW())
    ON CONFLICT (window_id, diarize_attempt, speaker_idx, run_start_ms, chunk_idx) DO NOTHING
  `;
}

export async function writeSkipped(w: SegmentWrite, s: SkippedSpan): Promise<void> {
  await sql`
    INSERT INTO room_span_emotion
      (window_id, diarize_attempt, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
       room_day_id, speaker_idx, source_refs, clip_r2_key, clip_start_s, clip_end_s, state, reason, cap_s, scored_at)
    VALUES
      (${w.windowId}, ${w.diarizeAttempt}, ${s.start_ms}, ${s.end_ms}, 0, 1, ${s.start_ms}, ${s.end_ms},
       ${w.roomDayId}, ${s.speaker_idx}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(s.source_refs)}::jsonb)), ${w.clipR2Key},
       ${(s.start_ms - w.windowStartMs) / 1000}, ${(s.end_ms - w.windowStartMs) / 1000}, 'skipped', ${s.reason}, ${w.cap_s}, NOW())
    ON CONFLICT (window_id, diarize_attempt, speaker_idx, run_start_ms, chunk_idx) DO NOTHING
  `;
}

export type EmotionWindowRow = {
  windowId: string;
  roomDayId: string | null;
  state: "ok" | "failed" | "no_segments";
  diarizeAttempt: number;
  error: string | null;
  model?: string | null;
  model_key?: string | null;
  subfolder?: string | null;
  cap_s?: number | null;
  counts?: { planned: number; scored: number; skipped: number; failed: number; calls: number };
  warmup?: unknown;
  timing?: unknown;
};

/**
 * First write inserts. A later write replaces the row only when it FAILED, or when it was scored
 * against an older diarize attempt; a failed row being replaced is kept in failure_history. Retries
 * against the same diarize attempt count up; a new diarize attempt starts again at 1.
 */
export async function recordEmotionWindow(r: EmotionWindowRow): Promise<void> {
  const c = r.counts;
  await sql`
    INSERT INTO room_emotion_window
      (window_id, room_day_id, state, diarize_attempt, error, model, model_key, subfolder, cap_s,
       segments_planned, segments_scored, segments_skipped, segments_failed, calls, warmup_json, timing_json, scored_at)
    VALUES
      (${r.windowId}, ${r.roomDayId}, ${r.state}, ${r.diarizeAttempt}, ${r.error === null ? null : r.error.slice(0, 300)},
       ${r.model ?? null}, ${r.model_key ?? null}, ${r.subfolder ?? null}, ${r.cap_s ?? null},
       ${c?.planned ?? null}, ${c?.scored ?? null}, ${c?.skipped ?? null}, ${c?.failed ?? null}, ${c?.calls ?? null},
       ${r.warmup === undefined ? null : JSON.stringify(r.warmup)}::jsonb, ${r.timing === undefined ? null : JSON.stringify(r.timing)}::jsonb, NOW())
    ON CONFLICT (window_id) DO UPDATE SET
      room_day_id      = EXCLUDED.room_day_id,
      state            = EXCLUDED.state,
      error            = EXCLUDED.error,
      model            = EXCLUDED.model,
      model_key        = EXCLUDED.model_key,
      subfolder        = EXCLUDED.subfolder,
      cap_s            = EXCLUDED.cap_s,
      segments_planned = EXCLUDED.segments_planned,
      segments_scored  = EXCLUDED.segments_scored,
      segments_skipped = EXCLUDED.segments_skipped,
      segments_failed  = EXCLUDED.segments_failed,
      calls            = EXCLUDED.calls,
      warmup_json      = EXCLUDED.warmup_json,
      timing_json      = EXCLUDED.timing_json,
      scored_at        = EXCLUDED.scored_at,
      attempts         = CASE WHEN room_emotion_window.diarize_attempt = EXCLUDED.diarize_attempt THEN room_emotion_window.attempts + 1 ELSE 1 END,
      failure_history  = CASE WHEN room_emotion_window.state = 'failed'
                              THEN room_emotion_window.failure_history || jsonb_build_array(jsonb_build_object(
                                     'attempt', room_emotion_window.attempts, 'diarize_attempt', room_emotion_window.diarize_attempt,
                                     'error', room_emotion_window.error, 'scored_at', room_emotion_window.scored_at))
                              ELSE room_emotion_window.failure_history END,
      diarize_attempt  = EXCLUDED.diarize_attempt
    WHERE room_emotion_window.state = 'failed' OR room_emotion_window.diarize_attempt <> EXCLUDED.diarize_attempt
  `;
}
