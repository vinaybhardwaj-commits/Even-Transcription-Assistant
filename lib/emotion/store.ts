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
  diarizeRunId: string;
  clipR2Key: string | null;
  windowStartMs: number;
  cap_s: number;
  model: { model: string | null; model_key: string | null; subfolder: string | null; device: string | null };
};

// source_refs travel as a JSON array and are unpacked in SQL: one spelling that every driver binds the
// same way, rather than trusting each to map a JS array onto text[].

/**
 * WINDOW-AS-UNIT REPLACE (S1 FIX2). Every attempt removes the window's existing segment rows before it
 * writes its own — across every diarize run. Without this, a retry's writes collided with the previous
 * attempt's `failed` rows and did nothing, and the window was recorded `ok` over rows that all said
 * `failed`. The room drain does the same with a previous run's turns: replaced, never merged.
 */
export async function clearWindowSegments(windowId: string): Promise<void> {
  await sql`DELETE FROM room_span_emotion WHERE window_id = ${windowId}`;
}

/** Idempotent per (window, diarize run, speaker, run start, chunk) WITHIN one attempt: a retried step writes nothing new. */
export async function writeScoredOrFailed(w: SegmentWrite, seg: PlannedSegment, score: SegmentScore): Promise<void> {
  const scored = score.ok ? score : null;
  const reason = score.ok ? null : score.reason;
  await sql`
    INSERT INTO room_span_emotion
      (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
       room_day_id, speaker_idx, source_refs, clip_r2_key, clip_start_s, clip_end_s, state, reason,
       anger, disgust, enthusiasm, fear, happiness, neutral, sadness, labels_json, top_label, top_score,
       model, model_key, subfolder, device, inference_s, duration_s, cap_s, scored_at)
    VALUES
      (${w.windowId}, ${w.diarizeRunId}, ${seg.run_start_ms}, ${seg.run_end_ms}, ${seg.chunk_idx}, ${seg.chunk_count}, ${seg.start_ms}, ${seg.end_ms},
       ${w.roomDayId}, ${seg.speaker_idx}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(seg.source_refs)}::jsonb)), ${w.clipR2Key}, ${seg.clip_start_s}, ${seg.clip_end_s},
       ${scored ? "scored" : "failed"}, ${reason},
       ${scored?.labels.anger ?? null}, ${scored?.labels.disgust ?? null}, ${scored?.labels.enthusiasm ?? null}, ${scored?.labels.fear ?? null},
       ${scored?.labels.happiness ?? null}, ${scored?.labels.neutral ?? null}, ${scored?.labels.sadness ?? null},
       ${scored ? JSON.stringify(scored.labels) : null}::jsonb, ${scored?.top_label ?? null}, ${scored?.top_score ?? null},
       ${w.model.model}, ${w.model.model_key}, ${w.model.subfolder}, ${w.model.device},
       ${scored?.inference_s ?? null}, ${scored?.duration_s ?? null}, ${w.cap_s}, NOW())
    ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO NOTHING
  `;
}

export async function writeSkipped(w: SegmentWrite, s: SkippedSpan): Promise<void> {
  await sql`
    INSERT INTO room_span_emotion
      (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
       room_day_id, speaker_idx, source_refs, clip_r2_key, clip_start_s, clip_end_s, state, reason, cap_s, scored_at)
    VALUES
      (${w.windowId}, ${w.diarizeRunId}, ${s.start_ms}, ${s.end_ms}, 0, 1, ${s.start_ms}, ${s.end_ms},
       ${w.roomDayId}, ${s.speaker_idx}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(s.source_refs)}::jsonb)), ${w.clipR2Key},
       ${(s.start_ms - w.windowStartMs) / 1000}, ${(s.end_ms - w.windowStartMs) / 1000}, 'skipped', ${s.reason}, ${w.cap_s}, NOW())
    ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO NOTHING
  `;
}

export type EmotionWindowRow = {
  windowId: string;
  roomDayId: string | null;
  state: "ok" | "failed" | "no_segments";
  diarizeRunId: string;
  error: string | null;
  model?: string | null;
  model_key?: string | null;
  subfolder?: string | null;
  cap_s?: number | null;
  /**
   * WHERE THE COUNTS COME FROM (S1 FIX3b C10). Never a remembered number:
   *   - explicit counts: only the no_segments pass, whose counts are the plan itself (nothing planned).
   *   - `fromRows`: scored / skipped / failed are counted from room_span_emotion in this statement, for
   *     this window and diarize run. `planned` is the plan and `calls` the service calls made — neither is
   *     a row count.
   *   - omitted: every count is NULL — the failure came before this attempt's rows existed, or may be the
   *     write itself.
   */
  counts?: { planned: number; scored: number; skipped: number; failed: number; calls: number } | { fromRows: true; planned: number; calls: number };
  warmup?: unknown;
  timing?: unknown;
};

/**
 * First write inserts. A later write replaces the row when — and only when — something would change
 * (S1 FIX3b C9, ruling (b)):
 *   - the stored row FAILED: a retry always writes, so `attempts` counts it and the enqueue scan's
 *     EMOTION_MAX_ATTEMPTS bound (lib/emotion/enqueue.ts) is reached. A failed row being replaced is kept
 *     in failure_history;
 *   - it belongs to an older diarize run;
 *   - or its state, error or segment counts differ from what this write derives. A settled row is never
 *     left stale under segment rows that now say something else, and a re-run that reproduces the same
 *     result writes nothing — its `attempts` and `scored_at` do not move, because nothing changed.
 * Retries against the same diarize run count up; a new diarize run starts again at 1.
 */
export async function recordEmotionWindow(r: EmotionWindowRow): Promise<void> {
  const c = r.counts;
  const fromRows = c !== undefined && "fromRows" in c;
  const explicit = c !== undefined && !("fromRows" in c) ? c : undefined;
  // The counts are a FROM-subquery rather than a leading CTE: the same statement, and one that every
  // test harness in this repo (including tests/support/pg-harness.ts, which splits a leading WITH at its
  // last SELECT) executes whole. `WHERE TRUE` keeps ON CONFLICT from being read as part of the FROM.
  await sql`
    INSERT INTO room_emotion_window
      (window_id, room_day_id, state, diarize_run_id, error, model, model_key, subfolder, cap_s,
       segments_planned, segments_scored, segments_skipped, segments_failed, calls, warmup_json, timing_json, scored_at)
    SELECT ${r.windowId}::text, ${r.roomDayId}::text, ${r.state}::text, ${r.diarizeRunId}::text, ${r.error === null ? null : r.error.slice(0, 300)}::text,
           ${r.model ?? null}::text, ${r.model_key ?? null}::text, ${r.subfolder ?? null}::text, ${r.cap_s ?? null}::double precision,
           ${c?.planned ?? null}::int,
           CASE WHEN ${fromRows}::boolean THEN seg.scored  ELSE ${explicit?.scored ?? null}::int END,
           CASE WHEN ${fromRows}::boolean THEN seg.skipped ELSE ${explicit?.skipped ?? null}::int END,
           CASE WHEN ${fromRows}::boolean THEN seg.failed  ELSE ${explicit?.failed ?? null}::int END,
           ${c?.calls ?? null}::int,
           ${r.warmup === undefined ? null : JSON.stringify(r.warmup)}::jsonb, ${r.timing === undefined ? null : JSON.stringify(r.timing)}::jsonb, NOW()
      FROM (
        SELECT count(*) FILTER (WHERE state = 'scored')::int  AS scored,
               count(*) FILTER (WHERE state = 'failed')::int  AS failed,
               count(*) FILTER (WHERE state = 'skipped')::int AS skipped
          FROM room_span_emotion
         WHERE window_id = ${r.windowId}::text AND diarize_run_id = ${r.diarizeRunId}::text
      ) AS seg
     WHERE TRUE
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
      attempts         = CASE WHEN room_emotion_window.diarize_run_id = EXCLUDED.diarize_run_id THEN room_emotion_window.attempts + 1 ELSE 1 END,
      failure_history  = CASE WHEN room_emotion_window.state = 'failed'
                              THEN room_emotion_window.failure_history || jsonb_build_array(jsonb_build_object(
                                     'attempt', room_emotion_window.attempts, 'diarize_run_id', room_emotion_window.diarize_run_id,
                                     'error', room_emotion_window.error, 'scored_at', room_emotion_window.scored_at))
                              ELSE room_emotion_window.failure_history END,
      diarize_run_id   = EXCLUDED.diarize_run_id
    WHERE room_emotion_window.state = 'failed'
       OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
       OR (room_emotion_window.state, room_emotion_window.error, room_emotion_window.segments_planned,
           room_emotion_window.segments_scored, room_emotion_window.segments_skipped, room_emotion_window.segments_failed)
          IS DISTINCT FROM
          (EXCLUDED.state, EXCLUDED.error, EXCLUDED.segments_planned,
           EXCLUDED.segments_scored, EXCLUDED.segments_skipped, EXCLUDED.segments_failed)
  `;
}

export type EmotionWindowFinish = {
  windowId: string;
  roomDayId: string | null;
  diarizeRunId: string;
  /** The PLAN — how many segments were sent to be scored. Not a persisted count. */
  planned: number;
  calls: number;
  model: string | null;
  model_key: string | null;
  subfolder: string | null;
  cap_s: number;
  warmup?: unknown;
  timing?: unknown;
};

export type EmotionWindowFinished = {
  /** Counted from room_span_emotion for this window and diarize run. */
  scored: number;
  failed: number;
  skipped: number;
  /** planned > 0 and no persisted row is scored — decided in the statement, from the rows. */
  zero_scored: boolean;
  /** The state this statement wrote, or null when the stored row already said exactly this and was left as it is. */
  written_state: "ok" | "failed" | null;
};

/**
 * The finishing write, S1 FIX2. THE COUNTS ARE THE ROWS, NOT A MEMORY OF THEM: scored, failed and skipped
 * are counted from room_span_emotion in the same statement that writes the window, and the state follows
 * from those counts — planned > 0 with nothing scored is `failed` / `emotion_zero_scored`. An in-memory
 * counter can drift from the table; a count taken in the write cannot.
 *
 * The conflict rule is recordEmotionWindow's: the row is replaced when it FAILED, belongs to an older
 * diarize run, or differs from what the rows now derive — so a settled window is rewritten when its rows
 * say something new, and left untouched when they reproduce it (S1 FIX3b C9). Keep the two in step.
 */
export async function finishEmotionWindow(f: EmotionWindowFinish): Promise<EmotionWindowFinished> {
  const rows = (await sql`
    WITH seg AS (
      SELECT count(*) FILTER (WHERE state = 'scored')::int  AS scored,
             count(*) FILTER (WHERE state = 'failed')::int  AS failed,
             count(*) FILTER (WHERE state = 'skipped')::int AS skipped
        FROM room_span_emotion
       WHERE window_id = ${f.windowId}::text AND diarize_run_id = ${f.diarizeRunId}::text
    ),
    -- THE RULE, ONCE: segments were planned and none of the persisted rows is scored.
    v AS (SELECT seg.*, (${f.planned}::int > 0 AND seg.scored = 0) AS zero_scored FROM seg),
    rec AS (
      INSERT INTO room_emotion_window
        (window_id, room_day_id, state, diarize_run_id, error, model, model_key, subfolder, cap_s,
         segments_planned, segments_scored, segments_skipped, segments_failed, calls, warmup_json, timing_json, scored_at)
      SELECT ${f.windowId}::text, ${f.roomDayId}::text,
             CASE WHEN v.zero_scored THEN 'failed' ELSE 'ok' END,
             ${f.diarizeRunId}::text,
             CASE WHEN v.zero_scored THEN 'emotion_zero_scored' ELSE NULL END,
             ${f.model}::text, ${f.model_key}::text, ${f.subfolder}::text, ${f.cap_s}::double precision,
             ${f.planned}::int, v.scored, v.skipped, v.failed, ${f.calls}::int,
             ${f.warmup === undefined ? null : JSON.stringify(f.warmup)}::jsonb, ${f.timing === undefined ? null : JSON.stringify(f.timing)}::jsonb, NOW()
        FROM v
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
        attempts         = CASE WHEN room_emotion_window.diarize_run_id = EXCLUDED.diarize_run_id THEN room_emotion_window.attempts + 1 ELSE 1 END,
        failure_history  = CASE WHEN room_emotion_window.state = 'failed'
                                THEN room_emotion_window.failure_history || jsonb_build_array(jsonb_build_object(
                                       'attempt', room_emotion_window.attempts, 'diarize_run_id', room_emotion_window.diarize_run_id,
                                       'error', room_emotion_window.error, 'scored_at', room_emotion_window.scored_at))
                                ELSE room_emotion_window.failure_history END,
        diarize_run_id   = EXCLUDED.diarize_run_id
      WHERE room_emotion_window.state = 'failed'
         OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
         OR (room_emotion_window.state, room_emotion_window.error, room_emotion_window.segments_planned,
             room_emotion_window.segments_scored, room_emotion_window.segments_skipped, room_emotion_window.segments_failed)
            IS DISTINCT FROM
            (EXCLUDED.state, EXCLUDED.error, EXCLUDED.segments_planned,
             EXCLUDED.segments_scored, EXCLUDED.segments_skipped, EXCLUDED.segments_failed)
      RETURNING state
    )
    SELECT v.scored, v.failed, v.skipped, v.zero_scored, (SELECT state FROM rec) AS written_state FROM v
  `) as Array<{ scored: number; failed: number; skipped: number; zero_scored: boolean; written_state: "ok" | "failed" | null }>;
  const r = rows[0];
  if (!r) throw new Error("finishEmotionWindow: the count returned no row");
  return { scored: Number(r.scored), failed: Number(r.failed), skipped: Number(r.skipped), zero_scored: r.zero_scored === true, written_state: r.written_state ?? null };
}
