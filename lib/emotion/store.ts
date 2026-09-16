/**
 * lib/emotion/store.ts — THE ONLY WRITER of room_span_emotion and room_emotion_window.
 * Called by the emotion_window job and nothing else.
 */
import { sql } from "@/lib/db";
import type { MeasuredSegment, SkippedSpan } from "./segments";
import type { SegmentScore } from "./client";

/**
 * E16 (0097) — where `speech_ms` came from. Every row this code writes says so explicitly; a row that
 * does not falls to the column DEFAULT `pre_speech_fraction`, which marks it as scored without a speech
 * measure. So a pre-fix row can never read as a post-fix one.
 */
export const SPEECH_BASIS = "diarize_segments";
/** The column DEFAULT, and what a row with no speech measure must say. */
export const PRE_FIX_BASIS = "pre_speech_fraction";

/**
 * E16(iii) — THE BASIS FOLLOWS THE MEASURE, it is never stamped beside a missing one. A job whose `prepare`
 * ran on pre-E16 code and whose `score` runs on E16 code carries segments with no speech_ms; stamping
 * SPEECH_BASIS on those rows would label a post-fix score that has no speech measure (Refuter §2.4, the
 * deploy straddle). 0097's CHECK refuses that combination as well.
 */
export function speechFields(speechMs: unknown): { speech_ms: number | null; speech_basis: string } {
  return typeof speechMs === "number" && Number.isFinite(speechMs) && speechMs >= 0
    ? { speech_ms: Math.round(speechMs), speech_basis: SPEECH_BASIS }
    : { speech_ms: null, speech_basis: PRE_FIX_BASIS };
}

/**
 * E16 — the reason on a span that was NEVER SENT: its speaker's diarized speech is under the service's
 * min_speech_s. The zero-scored rule tells these apart from spans the service refused, because only a
 * refused span is part of `planned`. One spelling, bound into the SQL, never retyped there.
 */
export const PREFILTER_REASON = "diarized_speech_below_min_speech_s";

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

/** The state a service answer is written as. `unscorable` is its own state, never `failed` (E16 P5). */
export const stateFor = (score: SegmentScore): "scored" | "unscorable" | "failed" =>
  score.ok ? "scored" : score.unscorable === true ? "unscorable" : "failed";

/**
 * A SENT span's row. Idempotent per (window, diarize run, speaker, run start, chunk) WITHIN one attempt:
 * a retried step writes nothing new.
 *
 * BOTH SPEECH NUMBERS where both exist (ETA-E16-RULING §4): `speech_ms` is the diarizer's speech for
 * this speaker, on every row; `service_speech_ms` is the service gate's own estimate, which it returns
 * only when it refuses. They measure different things and are kept apart on purpose.
 */
export async function writeScoredOrFailed(w: SegmentWrite, seg: MeasuredSegment, score: SegmentScore): Promise<void> {
  const scored = score.ok ? score : null;
  const unscorable = !score.ok && score.unscorable === true ? score : null;
  const reason = score.ok ? null : score.reason;
  const serviceSpeechMs = unscorable && unscorable.service_speech_s !== null ? Math.round(unscorable.service_speech_s * 1000) : null;
  const durationS = scored ? scored.duration_s : unscorable ? unscorable.duration_s : null;
  const sp = speechFields(seg.speech_ms);
  await sql`
    INSERT INTO room_span_emotion
      (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
       room_day_id, speaker_idx, source_refs, clip_r2_key, clip_start_s, clip_end_s, state, reason,
       anger, disgust, enthusiasm, fear, happiness, neutral, sadness, labels_json, top_label, top_score,
       model, model_key, subfolder, device, inference_s, duration_s, cap_s,
       speech_ms, service_speech_ms, speech_basis, scored_at)
    VALUES
      (${w.windowId}, ${w.diarizeRunId}, ${seg.run_start_ms}, ${seg.run_end_ms}, ${seg.chunk_idx}, ${seg.chunk_count}, ${seg.start_ms}, ${seg.end_ms},
       ${w.roomDayId}, ${seg.speaker_idx}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(seg.source_refs)}::jsonb)), ${w.clipR2Key}, ${seg.clip_start_s}, ${seg.clip_end_s},
       ${stateFor(score)}, ${reason},
       ${scored?.labels.anger ?? null}, ${scored?.labels.disgust ?? null}, ${scored?.labels.enthusiasm ?? null}, ${scored?.labels.fear ?? null},
       ${scored?.labels.happiness ?? null}, ${scored?.labels.neutral ?? null}, ${scored?.labels.sadness ?? null},
       ${scored ? JSON.stringify(scored.labels) : null}::jsonb, ${scored?.top_label ?? null}, ${scored?.top_score ?? null},
       ${w.model.model}, ${w.model.model_key}, ${w.model.subfolder}, ${w.model.device},
       ${scored?.inference_s ?? null}, ${durationS}, ${w.cap_s},
       ${sp.speech_ms}, ${serviceSpeechMs}, ${sp.speech_basis}, NOW())
    ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO NOTHING
  `;
}

/** A span NEVER SENT: its speaker's diarized speech is under min_speech_s. Written unscorable with that speech. */
export async function writeUnscorable(w: SegmentWrite, seg: MeasuredSegment): Promise<void> {
  const sp = speechFields(seg.speech_ms);
  await sql`
    INSERT INTO room_span_emotion
      (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
       room_day_id, speaker_idx, source_refs, clip_r2_key, clip_start_s, clip_end_s, state, reason, cap_s,
       speech_ms, service_speech_ms, speech_basis, scored_at)
    VALUES
      (${w.windowId}, ${w.diarizeRunId}, ${seg.run_start_ms}, ${seg.run_end_ms}, ${seg.chunk_idx}, ${seg.chunk_count}, ${seg.start_ms}, ${seg.end_ms},
       ${w.roomDayId}, ${seg.speaker_idx}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(seg.source_refs)}::jsonb)), ${w.clipR2Key}, ${seg.clip_start_s}, ${seg.clip_end_s},
       'unscorable', ${PREFILTER_REASON}, ${w.cap_s},
       ${sp.speech_ms}, NULL, ${sp.speech_basis}, NOW())
    ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO NOTHING
  `;
}

export async function writeSkipped(w: SegmentWrite, s: SkippedSpan, speechMs: number): Promise<void> {
  const sp = speechFields(speechMs);
  await sql`
    INSERT INTO room_span_emotion
      (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
       room_day_id, speaker_idx, source_refs, clip_r2_key, clip_start_s, clip_end_s, state, reason, cap_s,
       speech_ms, service_speech_ms, speech_basis, scored_at)
    VALUES
      (${w.windowId}, ${w.diarizeRunId}, ${s.start_ms}, ${s.end_ms}, 0, 1, ${s.start_ms}, ${s.end_ms},
       ${w.roomDayId}, ${s.speaker_idx}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(s.source_refs)}::jsonb)), ${w.clipR2Key},
       ${(s.start_ms - w.windowStartMs) / 1000}, ${(s.end_ms - w.windowStartMs) / 1000}, 'skipped', ${s.reason}, ${w.cap_s},
       ${sp.speech_ms}, NULL, ${sp.speech_basis}, NOW())
    ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO NOTHING
  `;
}

export type EmotionWindowRow = {
  windowId: string;
  roomDayId: string | null;
  /** diarize_stale (0099): the window's segments are another diarize run's. Terminal, not a failure — see recordStaleWindow. */
  state: "ok" | "failed" | "no_segments" | "diarize_stale";
  diarizeRunId: string;
  error: string | null;
  /** E25 R15 (0099): on a diarize_stale row, the segments_run_id the stale decision was made against. Omitted (NULL) on every other state. */
  staleSegmentsRunId?: string | null;
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
  counts?: { planned: number; scored: number; skipped: number; failed: number; unscorable: number; calls: number } | { fromRows: true; planned: number; calls: number };
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
 *   - or anything the segment rows can contradict differs from what this write derives — state, error,
 *     segment counts, model, model_key, subfolder, cap_s, room_day_id (S1 FIX4 C16). A settled row is never
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
       segments_planned, segments_scored, segments_skipped, segments_failed, segments_unscorable, calls, warmup_json, timing_json, scored_at,
       stale_segments_run_id)
    SELECT ${r.windowId}::text, ${r.roomDayId}::text, ${r.state}::text, ${r.diarizeRunId}::text, ${r.error === null ? null : r.error.slice(0, 300)}::text,
           ${r.model ?? null}::text, ${r.model_key ?? null}::text, ${r.subfolder ?? null}::text, ${r.cap_s ?? null}::double precision,
           ${c?.planned ?? null}::int,
           CASE WHEN ${fromRows}::boolean THEN seg.scored  ELSE ${explicit?.scored ?? null}::int END,
           CASE WHEN ${fromRows}::boolean THEN seg.skipped ELSE ${explicit?.skipped ?? null}::int END,
           CASE WHEN ${fromRows}::boolean THEN seg.failed  ELSE ${explicit?.failed ?? null}::int END,
           CASE WHEN ${fromRows}::boolean THEN seg.unscorable ELSE ${explicit?.unscorable ?? null}::int END,
           ${c?.calls ?? null}::int,
           ${r.warmup === undefined ? null : JSON.stringify(r.warmup)}::jsonb, ${r.timing === undefined ? null : JSON.stringify(r.timing)}::jsonb, NOW(),
           ${r.staleSegmentsRunId ?? null}::text
      FROM (
        SELECT count(*) FILTER (WHERE state = 'scored')::int  AS scored,
               count(*) FILTER (WHERE state = 'failed')::int  AS failed,
               count(*) FILTER (WHERE state = 'skipped')::int AS skipped,
               count(*) FILTER (WHERE state = 'unscorable')::int AS unscorable
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
      segments_unscorable = EXCLUDED.segments_unscorable,
      calls            = EXCLUDED.calls,
      warmup_json      = EXCLUDED.warmup_json,
      timing_json      = EXCLUDED.timing_json,
      scored_at        = EXCLUDED.scored_at,
      -- E24 R8: a diarize_stale write spends NO attempt, even rewritten against the same run. Staleness is a fact
      -- about our own bookkeeping that no retry can change; the attempt budget is for weather.
      attempts         = CASE WHEN EXCLUDED.state = 'diarize_stale' THEN room_emotion_window.attempts
                              WHEN room_emotion_window.diarize_run_id = EXCLUDED.diarize_run_id THEN room_emotion_window.attempts + 1 ELSE 1 END,
      failure_history  = CASE WHEN room_emotion_window.state = 'failed'
                              THEN room_emotion_window.failure_history || jsonb_build_array(jsonb_build_object(
                                     'attempt', room_emotion_window.attempts, 'diarize_run_id', room_emotion_window.diarize_run_id,
                                     'error', room_emotion_window.error, 'scored_at', room_emotion_window.scored_at))
                              ELSE room_emotion_window.failure_history END,
      diarize_run_id   = EXCLUDED.diarize_run_id,
      stale_segments_run_id = EXCLUDED.stale_segments_run_id
    WHERE room_emotion_window.state = 'failed'
       OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
       -- COMPARED, S1 FIX4 C16: state, error, the segment counts (segments_unscorable added by E16 — rule 15), model, model_key, subfolder, cap_s, room_day_id,
       --   and stale_segments_run_id (E26 R32 / M1). It was written by the DO UPDATE but missing from this tuple, so a
       --   MARK-ONLY rewrite — same run, same state, same counts, a different judged segments_run_id — wrote nothing and
       --   the row kept the older mark. The mark is what permits exactly one repair (E25 R15), so a stale mark naming
       --   segments that are no longer stored is a cure aimed at the wrong run. No caller reaches it today; it is one
       --   line on the same column the cure reads, and the last thing called latent took 98-100 of 117 drain slots.
       -- What each identifying field protects against, corrected in S1 MERGE C19:
       --   model, model_key - the emotion client refuses any service answer whose model or model_key is not its
       --     own constant, lib/emotion/client.ts:91 emotion_unexpected_model, so within one deployment no segment
       --     row can carry a different value and these never decide a write. They matter across a deploy that
       --     changes those constants: the stored row has the old value, the new write the new one, and the row is
       --     correctly rewritten.
       --   subfolder - no such guard. The service resolves EMOTION_WAVLM_SUBFOLDER from auto, so it can change with
       --     no deploy at all; this is the field by which X1 was actually reachable.
       --   cap_s, room_day_id - carried by every segment row, so a segment row can contradict them.
       -- NOT COMPARED, each on purpose:
       --   calls, warmup_json, timing_json - per-run telemetry with no segment counterpart; comparing them
       --     would rewrite on every re-run and undo C9
       --   scored_at, attempts, failure_history - write bookkeeping, derived from this write itself
       --   diarize_run_id - already its own arm above
       -- IS DISTINCT FROM on the row constructor counts NULL against a value as a difference and NULL against
       -- NULL as equal, so a nullable cap_s and the all-NULL counts of a failure with no rows compare correctly.
       OR (room_emotion_window.state, room_emotion_window.error, room_emotion_window.segments_planned,
           room_emotion_window.segments_scored, room_emotion_window.segments_skipped, room_emotion_window.segments_failed, room_emotion_window.segments_unscorable,
           room_emotion_window.model, room_emotion_window.model_key, room_emotion_window.subfolder,
           room_emotion_window.cap_s, room_emotion_window.room_day_id, room_emotion_window.stale_segments_run_id)
          IS DISTINCT FROM
          (EXCLUDED.state, EXCLUDED.error, EXCLUDED.segments_planned,
           EXCLUDED.segments_scored, EXCLUDED.segments_skipped, EXCLUDED.segments_failed, EXCLUDED.segments_unscorable,
           EXCLUDED.model, EXCLUDED.model_key, EXCLUDED.subfolder,
           EXCLUDED.cap_s, EXCLUDED.room_day_id, EXCLUDED.stale_segments_run_id)
  `;
}

/**
 * E24 R8/R9 — the window's diarize segments belong to another run (segments_run_id is not last_run_id), or to
 * an unknown one (NULL: no writer run is recorded). Recorded `diarize_stale` with its reason:
 *   - NOT a failure: the enqueue scan retries only `failed` rows, so no attempt is spent and nothing is re-offered;
 *   - the window is offered again only when last_run_id moves — a fresh diarize run, which the named repair
 *     path (repairStaleDiarizeSegments) turns into the cure.
 * Counts are omitted: nothing was planned, and the earlier rows are left as they were.
 * E25 R15: the mark records the segments it judged (`segmentsRunId`, NULL when unrecorded), so it permits
 * exactly one repair — the one that replaces those segments.
 */
export async function recordStaleWindow(r: { windowId: string; roomDayId: string | null; diarizeRunId: string; segmentsRunId: string | null; reason: string }): Promise<void> {
  await recordEmotionWindow({ windowId: r.windowId, roomDayId: r.roomDayId, diarizeRunId: r.diarizeRunId, state: "diarize_stale", error: r.reason, staleSegmentsRunId: r.segmentsRunId });
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
  /** E16 — rows the window recorded unscorable: never sent, or refused by the service. */
  unscorable: number;
  /** planned minus service-refused rows > 0, and no persisted row is scored — decided in the statement, from the rows. */
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
             count(*) FILTER (WHERE state = 'skipped')::int AS skipped,
             count(*) FILTER (WHERE state = 'unscorable')::int AS unscorable,
             -- Unscorable rows the SERVICE refused: they were sent, so they are inside planned. Spans never
             -- sent carry PREFILTER_REASON and were never part of planned, so they are not subtracted.
             count(*) FILTER (WHERE state = 'unscorable' AND reason IS DISTINCT FROM ${PREFILTER_REASON}::text)::int AS unscorable_sent
        FROM room_span_emotion
       WHERE window_id = ${f.windowId}::text AND diarize_run_id = ${f.diarizeRunId}::text
    ),
    -- THE RULE, ONCE (E16): segments the service COULD score were planned, and none of the persisted rows is
    -- scored. A span the service refused as unscorable is a fact about the audio, not a failure, so it is
    -- taken out of planned here — a window whose every sent span came back unscorable is not zero-scored,
    -- and does not spend an attempt. A span the service FAILED stays in, and still fails the window.
    v AS (SELECT seg.*, (${f.planned}::int - seg.unscorable_sent > 0 AND seg.scored = 0) AS zero_scored FROM seg),
    rec AS (
      INSERT INTO room_emotion_window
        (window_id, room_day_id, state, diarize_run_id, error, model, model_key, subfolder, cap_s,
         segments_planned, segments_scored, segments_skipped, segments_failed, segments_unscorable, calls, warmup_json, timing_json, scored_at)
      SELECT ${f.windowId}::text, ${f.roomDayId}::text,
             CASE WHEN v.zero_scored THEN 'failed' ELSE 'ok' END,
             ${f.diarizeRunId}::text,
             CASE WHEN v.zero_scored THEN 'emotion_zero_scored' ELSE NULL END,
             ${f.model}::text, ${f.model_key}::text, ${f.subfolder}::text, ${f.cap_s}::double precision,
             ${f.planned}::int, v.scored, v.skipped, v.failed, v.unscorable, ${f.calls}::int,
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
        segments_unscorable = EXCLUDED.segments_unscorable,
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
        diarize_run_id   = EXCLUDED.diarize_run_id,
        -- E25 R15: a finished window is ok or failed, never stale; the mark it replaces is spent.
        stale_segments_run_id = NULL
      WHERE room_emotion_window.state = 'failed'
         OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
         -- The same comparison as recordEmotionWindow, S1 FIX4 C16 - see the comment there for what is out and why.
         OR (room_emotion_window.state, room_emotion_window.error, room_emotion_window.segments_planned,
             room_emotion_window.segments_scored, room_emotion_window.segments_skipped, room_emotion_window.segments_failed, room_emotion_window.segments_unscorable,
             room_emotion_window.model, room_emotion_window.model_key, room_emotion_window.subfolder,
             room_emotion_window.cap_s, room_emotion_window.room_day_id)
            IS DISTINCT FROM
            (EXCLUDED.state, EXCLUDED.error, EXCLUDED.segments_planned,
             EXCLUDED.segments_scored, EXCLUDED.segments_skipped, EXCLUDED.segments_failed, EXCLUDED.segments_unscorable,
             EXCLUDED.model, EXCLUDED.model_key, EXCLUDED.subfolder,
             EXCLUDED.cap_s, EXCLUDED.room_day_id)
      RETURNING state
    )
    SELECT v.scored, v.failed, v.skipped, v.unscorable, v.zero_scored, (SELECT state FROM rec) AS written_state FROM v
  `) as Array<{ scored: number; failed: number; skipped: number; unscorable: number; zero_scored: boolean; written_state: "ok" | "failed" | null }>;
  const r = rows[0];
  if (!r) throw new Error("finishEmotionWindow: the count returned no row");
  return { scored: Number(r.scored), failed: Number(r.failed), skipped: Number(r.skipped), unscorable: Number(r.unscorable), zero_scored: r.zero_scored === true, written_state: r.written_state ?? null };
}
