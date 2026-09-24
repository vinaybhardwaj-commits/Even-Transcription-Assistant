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
 * ─── E31 A1/A2 — THE SPANS ARE ONE WRITE, AND THEY ARE NEVER DELETED BEFORE THEIR REPLACEMENT EXISTS ────
 *
 * WHAT CHANGED AND WHY. Two defects, one shape, both proven by the E31 survey:
 *   A1  the caller wrote one INSERT per segment in a loop. A loop of autocommitted statements has a
 *       half-state after every one of them, and the Neon HTTP handle autocommits every statement — so a
 *       window could hold four of its nine spans with nothing anywhere saying so.
 *   A2  `clearWindowSegments` deleted EVERY span for the window in the `prepare` step, a whole job step
 *       before any replacement existed. `prepare` and `score` are separate invocations of the job machine
 *       (lib/jobs/runner.ts persists progress between them), so that gap is a DURABLE crash boundary: the
 *       window could rest indefinitely with zero span rows under a `room_emotion_window` row still saying
 *       `ok` with a count of twelve.
 *
 * THE CURE, per the E31 PRD D-2: ONE STATEMENT. `writeSpans` inserts every row of an attempt in a single
 * multi-row insert, and the delete of the previous run's rows moves into `finishEmotionWindow`'s own CTE,
 * where it lands with the window row that describes what replaced them. Until then the window keeps the
 * earlier run's spans AND the earlier window row — a consistent earlier state, which is the whole point.
 *
 * ONE PARAMETER, NOT N. The rows travel as a single jsonb array unpacked by `jsonb_to_recordset`, so the
 * statement's shape does not depend on how many spans an attempt produced. Binding N rows as N*36
 * parameters would make the statement text itself variable, and the Neon HTTP driver would have a
 * different prepared statement for every batch size.
 */

/** One span row, flattened to exactly what the table stores. Built by the three helpers below, never by hand. */
type SpanRowValues = {
  window_id: string; diarize_run_id: string; run_start_ms: number; run_end_ms: number;
  chunk_idx: number; chunk_count: number; segment_start_ms: number; segment_end_ms: number;
  room_day_id: string | null; speaker_idx: number; source_refs: string[]; clip_r2_key: string | null;
  clip_start_s: number | null; clip_end_s: number | null; state: string; reason: string | null;
  anger: number | null; disgust: number | null; enthusiasm: number | null; fear: number | null;
  happiness: number | null; neutral: number | null; sadness: number | null;
  labels_json: string | null; top_label: string | null; top_score: number | null;
  model: string | null; model_key: string | null; subfolder: string | null; device: string | null;
  inference_s: number | null; duration_s: number | null; cap_s: number;
  speech_ms: number | null; service_speech_ms: number | null; speech_basis: string;
};

/**
 * EVERY SPAN OF ONE ATTEMPT, IN ONE STATEMENT (A1).
 *
 * ON CONFLICT DO UPDATE, not DO NOTHING — and this is FORCED by A2, not chosen. While the delete lived in
 * `prepare`, a retry of the same diarize run met an empty table and `DO NOTHING` never fired. With the
 * delete moved to finish, a retry of the same run meets the PREVIOUS ATTEMPT's rows on the same key, and
 * `DO NOTHING` would silently drop the new answer and leave the old one to be counted — which is exactly
 * the defect S1 FIX2 fixed by introducing the delete in the first place. DO UPDATE keeps that guarantee
 * without needing a delete to have happened first: the newest attempt's answer always wins its key.
 */
export async function writeSpans(rows: SpanRowValues[]): Promise<number> {
  if (rows.length === 0) return 0;
  const out = (await sql`
    INSERT INTO room_span_emotion
      (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
       room_day_id, speaker_idx, source_refs, clip_r2_key, clip_start_s, clip_end_s, state, reason,
       anger, disgust, enthusiasm, fear, happiness, neutral, sadness, labels_json, top_label, top_score,
       model, model_key, subfolder, device, inference_s, duration_s, cap_s,
       speech_ms, service_speech_ms, speech_basis, scored_at)
    SELECT r.window_id, r.diarize_run_id, r.run_start_ms, r.run_end_ms, r.chunk_idx, r.chunk_count,
           r.segment_start_ms, r.segment_end_ms, r.room_day_id, r.speaker_idx,
           ARRAY(SELECT jsonb_array_elements_text(r.source_refs)), r.clip_r2_key, r.clip_start_s, r.clip_end_s,
           r.state, r.reason,
           r.anger, r.disgust, r.enthusiasm, r.fear, r.happiness, r.neutral, r.sadness,
           r.labels_json, r.top_label, r.top_score,
           r.model, r.model_key, r.subfolder, r.device, r.inference_s, r.duration_s, r.cap_s,
           r.speech_ms, r.service_speech_ms, r.speech_basis, NOW()
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(
        window_id text, diarize_run_id text, run_start_ms bigint, run_end_ms bigint,
        chunk_idx integer, chunk_count integer, segment_start_ms bigint, segment_end_ms bigint,
        room_day_id text, speaker_idx integer, source_refs jsonb, clip_r2_key text,
        clip_start_s double precision, clip_end_s double precision, state text, reason text,
        anger double precision, disgust double precision, enthusiasm double precision, fear double precision,
        happiness double precision, neutral double precision, sadness double precision,
        labels_json jsonb, top_label text, top_score double precision,
        model text, model_key text, subfolder text, device text,
        inference_s double precision, duration_s double precision, cap_s double precision,
        speech_ms integer, service_speech_ms integer, speech_basis text
      )
    ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO UPDATE SET
      run_end_ms = EXCLUDED.run_end_ms, chunk_count = EXCLUDED.chunk_count,
      segment_start_ms = EXCLUDED.segment_start_ms, segment_end_ms = EXCLUDED.segment_end_ms,
      room_day_id = EXCLUDED.room_day_id, source_refs = EXCLUDED.source_refs,
      clip_r2_key = EXCLUDED.clip_r2_key, clip_start_s = EXCLUDED.clip_start_s, clip_end_s = EXCLUDED.clip_end_s,
      state = EXCLUDED.state, reason = EXCLUDED.reason,
      anger = EXCLUDED.anger, disgust = EXCLUDED.disgust, enthusiasm = EXCLUDED.enthusiasm, fear = EXCLUDED.fear,
      happiness = EXCLUDED.happiness, neutral = EXCLUDED.neutral, sadness = EXCLUDED.sadness,
      labels_json = EXCLUDED.labels_json, top_label = EXCLUDED.top_label, top_score = EXCLUDED.top_score,
      model = EXCLUDED.model, model_key = EXCLUDED.model_key, subfolder = EXCLUDED.subfolder, device = EXCLUDED.device,
      inference_s = EXCLUDED.inference_s, duration_s = EXCLUDED.duration_s, cap_s = EXCLUDED.cap_s,
      speech_ms = EXCLUDED.speech_ms, service_speech_ms = EXCLUDED.service_speech_ms,
      speech_basis = EXCLUDED.speech_basis, scored_at = EXCLUDED.scored_at
    RETURNING window_id
  `) as Array<{ window_id: string }>;
  return out.length;
}

/** The state a service answer is written as. `unscorable` is its own state, never `failed` (E16 P5). */
export const stateFor = (score: SegmentScore): "scored" | "unscorable" | "failed" =>
  score.ok ? "scored" : score.unscorable === true ? "unscorable" : "failed";

const spanBase = (w: SegmentWrite, seg: { run_start_ms: number; run_end_ms: number; chunk_idx: number; chunk_count: number; start_ms: number; end_ms: number; speaker_idx: number; source_refs: string[]; clip_start_s: number | null; clip_end_s: number | null }) => ({
  window_id: w.windowId, diarize_run_id: w.diarizeRunId,
  run_start_ms: seg.run_start_ms, run_end_ms: seg.run_end_ms,
  chunk_idx: seg.chunk_idx, chunk_count: seg.chunk_count,
  segment_start_ms: seg.start_ms, segment_end_ms: seg.end_ms,
  room_day_id: w.roomDayId, speaker_idx: seg.speaker_idx, source_refs: seg.source_refs,
  clip_r2_key: w.clipR2Key, clip_start_s: seg.clip_start_s, clip_end_s: seg.clip_end_s,
  cap_s: w.cap_s,
});
const NO_LABELS = {
  anger: null, disgust: null, enthusiasm: null, fear: null, happiness: null, neutral: null, sadness: null,
  labels_json: null, top_label: null, top_score: null,
  model: null, model_key: null, subfolder: null, device: null, inference_s: null, duration_s: null,
} as const;

/**
 * A SENT span's row, as values.
 *
 * BOTH SPEECH NUMBERS where both exist (ETA-E16-RULING §4): `speech_ms` is the diarizer's speech for
 * this speaker, on every row; `service_speech_ms` is the service gate's own estimate, which it returns
 * only when it refuses. They measure different things and are kept apart on purpose.
 */
export function scoredOrFailedRow(w: SegmentWrite, seg: MeasuredSegment, score: SegmentScore): SpanRowValues {
  const scored = score.ok ? score : null;
  const unscorable = !score.ok && score.unscorable === true ? score : null;
  const serviceSpeechMs = unscorable && unscorable.service_speech_s !== null ? Math.round(unscorable.service_speech_s * 1000) : null;
  const durationS = scored ? scored.duration_s : unscorable ? unscorable.duration_s : null;
  const sp = speechFields(seg.speech_ms);
  return {
    ...spanBase(w, seg),
    state: stateFor(score), reason: score.ok ? null : score.reason,
    anger: scored?.labels.anger ?? null, disgust: scored?.labels.disgust ?? null,
    enthusiasm: scored?.labels.enthusiasm ?? null, fear: scored?.labels.fear ?? null,
    happiness: scored?.labels.happiness ?? null, neutral: scored?.labels.neutral ?? null,
    sadness: scored?.labels.sadness ?? null,
    labels_json: scored ? JSON.stringify(scored.labels) : null,
    top_label: scored?.top_label ?? null, top_score: scored?.top_score ?? null,
    model: w.model.model, model_key: w.model.model_key, subfolder: w.model.subfolder, device: w.model.device,
    inference_s: scored?.inference_s ?? null, duration_s: durationS,
    speech_ms: sp.speech_ms, service_speech_ms: serviceSpeechMs, speech_basis: sp.speech_basis,
  };
}

/** A span NEVER SENT: its speaker's diarized speech is under min_speech_s. Written unscorable with that speech. */
export function unscorableRow(w: SegmentWrite, seg: MeasuredSegment): SpanRowValues {
  const sp = speechFields(seg.speech_ms);
  return {
    ...spanBase(w, seg), ...NO_LABELS,
    state: "unscorable", reason: PREFILTER_REASON,
    speech_ms: sp.speech_ms, service_speech_ms: null, speech_basis: sp.speech_basis,
  };
}

export function skippedRow(w: SegmentWrite, s: SkippedSpan, speechMs: number): SpanRowValues {
  const sp = speechFields(speechMs);
  return {
    ...spanBase(w, {
      run_start_ms: s.start_ms, run_end_ms: s.end_ms, chunk_idx: 0, chunk_count: 1,
      start_ms: s.start_ms, end_ms: s.end_ms, speaker_idx: s.speaker_idx, source_refs: s.source_refs,
      clip_start_s: (s.start_ms - w.windowStartMs) / 1000, clip_end_s: (s.end_ms - w.windowStartMs) / 1000,
    }),
    ...NO_LABELS,
    state: "skipped", reason: s.reason,
    speech_ms: sp.speech_ms, service_speech_ms: null, speech_basis: sp.speech_basis,
  };
}

/**
 * ONE ROW PER KEY, BEFORE THE STATEMENT (fixes the 20 windows that exhausted on Postgres's "ON CONFLICT DO UPDATE
 * command cannot affect row a second time", 19-21 Sep).
 *
 * A multi-row INSERT ... ON CONFLICT DO UPDATE refuses a batch in which two rows carry the same conflict key,
 * and no retry can change that: prepare's rows are a pure function of the window's turns. Two straddle turns of
 * one speaker that start on the same millisecond each become a `skipped` row at chunk 0 (skippedRow is per
 * turn, not per run), and a skipped row can share (speaker, start, chunk 0) with an `unscorable` chunk of a run
 * that starts there. Nothing is lost by collapsing them: same speaker, same start, same chunk is the same
 * span of audio.
 *
 * Collapse rule: an `unscorable` row beats a `skipped` one (it carries a measured speech fraction; a skipped
 * row carries a reason only); otherwise the first row stays. Either way the winner's end is the later end and
 * its source_refs the union, so no turn reference is dropped. The order of the surviving rows is the order of
 * their first appearance. `collapsed` is how many rows were folded away, for the caller to log.
 */
export function dedupeSpanRows(rows: SpanRowValues[]): { rows: SpanRowValues[]; collapsed: number } {
  const byKey = new Map<string, SpanRowValues>();
  for (const r of rows) {
    const key = `${r.window_id}|${r.diarize_run_id}|${r.speaker_idx}|${r.run_start_ms}|${r.chunk_idx}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, r); continue; }
    const winner = r.state === "unscorable" && prev.state === "skipped" ? r : prev;
    const loser = winner === r ? prev : r;
    byKey.set(key, {
      ...winner,
      run_end_ms: Math.max(winner.run_end_ms, loser.run_end_ms),
      segment_end_ms: Math.max(winner.segment_end_ms, loser.segment_end_ms),
      clip_end_s: winner.clip_end_s === null || loser.clip_end_s === null ? winner.clip_end_s : Math.max(winner.clip_end_s, loser.clip_end_s),
      source_refs: Array.from(new Set([...winner.source_refs, ...loser.source_refs])),
    });
  }
  return { rows: Array.from(byKey.values()), collapsed: rows.length - byKey.size };
}

// The single-row spellings. Every caller that writes ONE span goes through the same statement as a caller
// that writes sixteen; there is no second INSERT anywhere in this module to drift from the first.
export const writeScoredOrFailed = (w: SegmentWrite, seg: MeasuredSegment, score: SegmentScore) => writeSpans([scoredOrFailedRow(w, seg, score)]);
export const writeUnscorable = (w: SegmentWrite, seg: MeasuredSegment) => writeSpans([unscorableRow(w, seg)]);
export const writeSkipped = (w: SegmentWrite, s: SkippedSpan, speechMs: number) => writeSpans([skippedRow(w, s, speechMs)]);

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

/**
 * ─── E31 A1 — THE `no_segments` TERMINAL PATH, AS ONE STATEMENT ─────────────────────────────────────
 *
 * `prepare` ends here when nothing the service could score was planned. It is TERMINAL — the job never
 * reaches `finish` — so this is the one other place a window row is written over span rows, and the two
 * used to be two statements: the skipped/unscorable rows, then the row describing them. A crash between
 * left a window whose row said `no_segments, skipped 3` over three rows that were never written, or
 * three rows nobody had recorded.
 *
 * THE COUNTS ARE THE ROWS, as everywhere else in this module: `skipped` and `unscorable` are counted from
 * the rows THIS statement inserted, not from the caller's arithmetic. That is what makes the window row
 * genuinely fed by the span insert rather than merely adjacent to it.
 *
 * It also carries finish's delete, because a window that ends here never reaches finish and would
 * otherwise keep an earlier run's spans for ever.
 *
 * THE CONFLICT RULE IS THE THIRD COPY of the one in `recordEmotionWindow` and `finishEmotionWindow`, and
 * the module already carries a "keep the two in step" note on the second. Keep all three in step. The
 * shared part is the WHERE: rewrite when the stored row FAILED, belongs to another diarize run, or says
 * something the rows now contradict.
 */
export async function writeNoSegmentsWindow(a: {
  rows: SpanRowValues[]; windowId: string; roomDayId: string | null; diarizeRunId: string;
  cap_s: number | null; skipped: number; unscorable: number;
}): Promise<{ spans: number; spans_removed: number; written_state: string | null }> {
  const out = (await sql`
    WITH
    gone AS (
      DELETE FROM room_span_emotion
       WHERE window_id = ${a.windowId}::text
         AND diarize_run_id IS DISTINCT FROM ${a.diarizeRunId}::text
      RETURNING 1
    ),
    ins AS (
      INSERT INTO room_span_emotion
        (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms,
         room_day_id, speaker_idx, source_refs, clip_r2_key, clip_start_s, clip_end_s, state, reason,
         anger, disgust, enthusiasm, fear, happiness, neutral, sadness, labels_json, top_label, top_score,
         model, model_key, subfolder, device, inference_s, duration_s, cap_s,
         speech_ms, service_speech_ms, speech_basis, scored_at)
      SELECT r.window_id, r.diarize_run_id, r.run_start_ms, r.run_end_ms, r.chunk_idx, r.chunk_count,
             r.segment_start_ms, r.segment_end_ms, r.room_day_id, r.speaker_idx,
             ARRAY(SELECT jsonb_array_elements_text(r.source_refs)), r.clip_r2_key, r.clip_start_s, r.clip_end_s,
             r.state, r.reason,
             r.anger, r.disgust, r.enthusiasm, r.fear, r.happiness, r.neutral, r.sadness,
             r.labels_json, r.top_label, r.top_score,
             r.model, r.model_key, r.subfolder, r.device, r.inference_s, r.duration_s, r.cap_s,
             r.speech_ms, r.service_speech_ms, r.speech_basis, NOW()
        FROM jsonb_to_recordset(${JSON.stringify(a.rows)}::jsonb) AS r(
          window_id text, diarize_run_id text, run_start_ms bigint, run_end_ms bigint,
          chunk_idx integer, chunk_count integer, segment_start_ms bigint, segment_end_ms bigint,
          room_day_id text, speaker_idx integer, source_refs jsonb, clip_r2_key text,
          clip_start_s double precision, clip_end_s double precision, state text, reason text,
          anger double precision, disgust double precision, enthusiasm double precision, fear double precision,
          happiness double precision, neutral double precision, sadness double precision,
          labels_json jsonb, top_label text, top_score double precision,
          model text, model_key text, subfolder text, device text,
          inference_s double precision, duration_s double precision, cap_s double precision,
          speech_ms integer, service_speech_ms integer, speech_basis text
        )
      ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO UPDATE SET
        state = EXCLUDED.state, reason = EXCLUDED.reason, room_day_id = EXCLUDED.room_day_id,
        source_refs = EXCLUDED.source_refs, clip_r2_key = EXCLUDED.clip_r2_key,
        clip_start_s = EXCLUDED.clip_start_s, clip_end_s = EXCLUDED.clip_end_s,
        speech_ms = EXCLUDED.speech_ms, speech_basis = EXCLUDED.speech_basis, scored_at = EXCLUDED.scored_at
      RETURNING state
    ),
    counted AS (
      SELECT count(*) FILTER (WHERE state = 'skipped')::int    AS skipped,
             count(*) FILTER (WHERE state = 'unscorable')::int AS unscorable,
             count(*)::int AS spans
        FROM ins
    ),
    rec AS (
      INSERT INTO room_emotion_window
        (window_id, room_day_id, state, diarize_run_id, error, cap_s,
         segments_planned, segments_scored, segments_skipped, segments_failed, segments_unscorable, calls, scored_at)
      SELECT ${a.windowId}::text, ${a.roomDayId}::text, 'no_segments', ${a.diarizeRunId}::text, NULL::text,
             ${a.cap_s}::double precision, 0, 0, counted.skipped, 0, counted.unscorable, 0, NOW()
        FROM counted
      ON CONFLICT (window_id) DO UPDATE SET
        room_day_id = EXCLUDED.room_day_id, state = EXCLUDED.state, error = EXCLUDED.error,
        cap_s = EXCLUDED.cap_s,
        segments_planned = EXCLUDED.segments_planned, segments_scored = EXCLUDED.segments_scored,
        segments_skipped = EXCLUDED.segments_skipped, segments_failed = EXCLUDED.segments_failed,
        segments_unscorable = EXCLUDED.segments_unscorable, calls = EXCLUDED.calls, scored_at = EXCLUDED.scored_at,
        attempts = CASE WHEN room_emotion_window.diarize_run_id = EXCLUDED.diarize_run_id
                        THEN room_emotion_window.attempts ELSE 1 END,
        failure_history = CASE WHEN room_emotion_window.state = 'failed'
                               THEN room_emotion_window.failure_history || jsonb_build_array(jsonb_build_object(
                                      'attempt', room_emotion_window.attempts, 'diarize_run_id', room_emotion_window.diarize_run_id,
                                      'error', room_emotion_window.error, 'scored_at', room_emotion_window.scored_at))
                               ELSE room_emotion_window.failure_history END,
        diarize_run_id = EXCLUDED.diarize_run_id,
        stale_segments_run_id = NULL
      WHERE room_emotion_window.state = 'failed'
         OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
         OR (room_emotion_window.state, room_emotion_window.segments_skipped, room_emotion_window.segments_unscorable,
             room_emotion_window.cap_s, room_emotion_window.room_day_id)
            IS DISTINCT FROM
            (EXCLUDED.state, EXCLUDED.segments_skipped, EXCLUDED.segments_unscorable,
             EXCLUDED.cap_s, EXCLUDED.room_day_id)
      RETURNING state
    )
    SELECT (SELECT spans FROM counted) AS spans,
           (SELECT count(*)::int FROM gone) AS spans_removed,
           (SELECT state FROM rec) AS written_state
  `) as Array<{ spans: number; spans_removed: number; written_state: string | null }>;
  const r = out[0];
  return { spans: Number(r?.spans ?? 0), spans_removed: Number(r?.spans_removed ?? 0), written_state: r?.written_state ?? null };
}

/**
 * ─── E31 A1 — THE BOOKKEEPING WRITE THAT SURVIVES WHAT KILLED THE PRIMARY ONE ───────────────────────
 *
 * THE CASE THIS EXISTS FOR, proven in production (E26 / ETA-E31 survey A1). A deploy reached the code
 * before migration 0097 reached the database. The span write died on `room_span_emotion.speech_ms`, the
 * job's failure bookkeeping then tried to record that death — and died too, on 0097's OTHER column,
 * `room_emotion_window.segments_unscorable`. The second error escaped the kind. No failed row, no attempt
 * counted, no error text. The window retried for ever with an attempt counter that never moved, and every
 * operator view read it as a window nobody had got to yet.
 *
 * WHY A SECOND, NARROWER STATEMENT AND NOT JUST THE FIRST ONE AGAIN. A bookkeeping write that shares the
 * primary write's column surface dies of the primary write's cause. That is not bad luck; it is the same
 * statement wearing a different name. This one touches ONLY columns that 0089 created with the table —
 * window_id, room_day_id, state, diarize_run_id, error, attempts, failure_history, scored_at — and no
 * column any later migration added. It would have survived both 0097 and 0099 unapplied.
 *
 * IT IS NOT A SPLIT WRITE. It is an ALTERNATIVE to `recordEmotionWindow`, tried only when that one threw,
 * and it is itself one statement. Nothing is left half-written by choosing between them.
 *
 * WHAT IT GIVES UP, said plainly: the segment counts, the model fields, the cap, the warm-up and the
 * timing. A failure row written by this path carries the state, the reason and the attempt — the three
 * facts the retry bound and an operator actually need — and nothing it cannot be sure it can write.
 */
export async function recordEmotionFailureNarrow(r: {
  windowId: string; roomDayId: string | null; diarizeRunId: string; error: string;
}): Promise<number> {
  const rows = (await sql`
    INSERT INTO room_emotion_window (window_id, room_day_id, state, diarize_run_id, error, scored_at)
    VALUES (${r.windowId}::text, ${r.roomDayId}::text, 'failed', ${r.diarizeRunId}::text, ${r.error.slice(0, 300)}::text, NOW())
    ON CONFLICT (window_id) DO UPDATE SET
      room_day_id = EXCLUDED.room_day_id,
      state       = EXCLUDED.state,
      error       = EXCLUDED.error,
      scored_at   = EXCLUDED.scored_at,
      -- The same attempt rule as the full write: a retry against the SAME diarize run counts up, a new
      -- run starts again at 1. This is the number whose never moving was the defect.
      attempts    = CASE WHEN room_emotion_window.diarize_run_id = EXCLUDED.diarize_run_id
                         THEN room_emotion_window.attempts + 1 ELSE 1 END,
      failure_history = CASE WHEN room_emotion_window.state = 'failed'
                             THEN room_emotion_window.failure_history || jsonb_build_array(jsonb_build_object(
                                    'attempt', room_emotion_window.attempts, 'diarize_run_id', room_emotion_window.diarize_run_id,
                                    'error', room_emotion_window.error, 'scored_at', room_emotion_window.scored_at))
                             ELSE room_emotion_window.failure_history END,
      diarize_run_id = EXCLUDED.diarize_run_id
    RETURNING attempts
  `) as Array<{ attempts: number }>;
  return Number(rows[0]?.attempts ?? 0);
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
  /** E31 A2 — previous runs' span rows removed BY THIS STATEMENT, so the delete is observable to a caller. */
  spans_removed: number;
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
    WITH
    -- ─── E31 A2 — THE DELETE LANDS HERE, WITH THE ROW THAT DESCRIBES WHAT REPLACED IT ───────────────
    -- It used to run in prepare, a whole job step earlier, so a crash in between left the window with
    -- NO spans under a window row still claiming ok and a count. Now the rows of the previous run go in
    -- same statement as the window row: either the window is described by the spans of THIS run, or it
    -- is still described by those of the last one. There is no third state.
    -- NO APOSTROPHE IN ANY SQL COMMENT HERE, and that is not style: tests/support/pg-harness.ts
    -- scans for string literals without skipping -- comments, so one apostrophe in a comment puts it in a
    -- string for the rest of the statement, it cannot find the final SELECT, and it wraps a data-modifying
    -- CTE inside another WITH, which Postgres refuses. The rest of this file already avoids them.
    -- SCOPED TO OTHER RUNS. IS DISTINCT FROM and not a plain inequality, because a NULL diarize_run_id on a
    -- legacy row belongs to another run as surely as a named one does, and inequality would silently keep
    -- it. The rows of THIS run are never in range, so the count below is unaffected by this delete.
    gone AS (
      DELETE FROM room_span_emotion
       WHERE window_id = ${f.windowId}::text
         AND diarize_run_id IS DISTINCT FROM ${f.diarizeRunId}::text
      RETURNING 1
    ),
    seg AS (
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
    SELECT v.scored, v.failed, v.skipped, v.unscorable, v.zero_scored,
           (SELECT count(*)::int FROM gone) AS spans_removed,
           (SELECT state FROM rec) AS written_state FROM v
  `) as Array<{ scored: number; failed: number; skipped: number; unscorable: number; zero_scored: boolean; spans_removed: number; written_state: "ok" | "failed" | null }>;
  const r = rows[0];
  if (!r) throw new Error("finishEmotionWindow: the count returned no row");
  return { scored: Number(r.scored), failed: Number(r.failed), skipped: Number(r.skipped), unscorable: Number(r.unscorable), zero_scored: r.zero_scored === true, spans_removed: Number(r.spans_removed ?? 0), written_state: r.written_state ?? null };
}
