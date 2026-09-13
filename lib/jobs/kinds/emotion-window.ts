/**
 * lib/jobs/kinds/emotion-window.ts — Slice C3. The emotion model's scores for one diarized window.
 *
 * ITS OWN JOB, NEVER PART OF DIARIZE. Attribution is the valuable output and emotion is optional,
 * so they are separate failure domains: nothing here writes a diarize table, and nothing a diarize
 * job does waits on this. It runs only for a window whose room_diarize_window row is `ok`, and reads
 * its speakers from room_turn_speaker.
 *
 * STEPS
 *   prepare  EMOTION_ENABLED (throws on an unrecognised value) · the window and its diarize attempt
 *            · the cap from the service's /health (never a constant) · turns → runs → segments ·
 *            straddled turns written as skipped
 *   warm     a throwaway one-second segment, so the first real batch does not pay the model's cold
 *            start, and a record of whether /health said the model was already loaded
 *   score    one call per step, at most SEGMENTS_PER_CALL segments; every result written, scored or
 *            failed with the service's reason; aborts if diarize re-ran underneath
 *   finish   the window row, with counts
 *
 * EVERY FAILURE IS RECORDED AND NAMED. A step never throws out of this kind: an unexpected error is
 * written to room_emotion_window as failed and the job fails with a code. That is what bounds
 * retries — the enqueue scan retries a failed window up to EMOTION_MAX_ATTEMPTS, and a job that
 * died without a row would otherwise be re-enqueued for ever.
 */
import { sql } from "@/lib/db";
import { signGetUrl } from "@/lib/r2";
import { emotionEnabled } from "@/lib/emotion/gate";
import { emotionHealth, scoreSegments, EMOTION_MODEL_KEY } from "@/lib/emotion/client";
import { buildRuns, planSegments, SEGMENTS_PER_CALL, type AttributedTurn, type PlannedSegment } from "@/lib/emotion/segments";
import { recordEmotionWindow, writeScoredOrFailed, writeSkipped, type SegmentWrite } from "@/lib/emotion/store";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";
import { jobError, type JobErrorCode } from "../errors";

export const EMOTION_WINDOW_KIND = "emotion_window";
const PRESIGN_SECONDS = 900;

type Progress = {
  window_id: string;
  room_day_id: string | null;
  window_start_ms: number;
  window_end_ms: number;
  clip_r2_key: string;
  diarize_attempt: number;
  cap_s: number;
  loaded_before: boolean | "unknown";
  segments: PlannedSegment[];
  skipped: number;
  batch: number;
  calls: number;
  scored: number;
  failed: number;
  model: string | null;
  subfolder: string | null;
  device: string | null;
  warmup?: { loaded_before: boolean | "unknown"; ok: boolean; inference_s: number | null; wall_ms: number };
  started_ms: number;
};

const P = (ctx: StepContext) => ctx.progress as unknown as Progress;

async function fail(p: Pick<Progress, "window_id" | "room_day_id" | "diarize_attempt"> & Partial<Progress>, code: JobErrorCode, detail: string): Promise<StepOutcome> {
  await recordEmotionWindow({
    windowId: p.window_id,
    roomDayId: p.room_day_id,
    state: "failed",
    diarizeAttempt: p.diarize_attempt,
    error: `${code}: ${detail}`,
    cap_s: p.cap_s ?? null,
    counts: p.segments ? { planned: p.segments.length, scored: p.scored ?? 0, skipped: p.skipped ?? 0, failed: p.failed ?? 0, calls: p.calls ?? 0 } : undefined,
    warmup: p.warmup,
  });
  return failWith(jobError(code, detail));
}

async function prepare(ctx: StepContext): Promise<StepOutcome> {
  let on: boolean;
  try { on = emotionEnabled(); } catch (e) { return failWith(jobError("emotion_disabled", String((e as Error).message).slice(0, 160))); }
  if (!on) return failWith(jobError("emotion_disabled", "EMOTION_ENABLED is off"));

  const windowId = String(ctx.args.window_id ?? "");
  const rows = (await sql`
    SELECT w.id, w.room_day_id, w.start_ms, w.end_ms, w.clip_r2_key, d.state AS diarize_state, d.attempts AS diarize_attempt
      FROM bench_window w LEFT JOIN room_diarize_window d ON d.window_id = w.id
     WHERE w.id = ${windowId} LIMIT 1
  `) as Array<{ id: string; room_day_id: string | null; start_ms: string | number; end_ms: string | number; clip_r2_key: string | null; diarize_state: string | null; diarize_attempt: number | null }>;
  const w = rows[0];
  if (!w) return failWith(jobError("progress_incomplete", "no such window"));
  // Nothing to score and nothing to retry: the scan only picks diarized windows, so no window row.
  if (w.diarize_state !== "ok" || w.diarize_attempt === null) return failWith(jobError("diarize_not_ok", String(w.diarize_state)));
  if (!w.clip_r2_key) return failWith(jobError("clip_missing_in_r2", "window has no clip"));

  const base = { window_id: w.id, room_day_id: w.room_day_id, diarize_attempt: Number(w.diarize_attempt) };
  const health = await emotionHealth();
  if (!health.ok) return fail(base, "emotion_unavailable", health.error);

  const turns = (await sql`
    SELECT t.source_ref, t.speaker_idx, t.no_role_reason,
           (c.payload->>'start_ms')::bigint AS start_ms, (c.payload->>'end_ms')::bigint AS end_ms
      FROM room_turn_speaker t
      JOIN cue c ON c.source_ref = t.source_ref AND c.type = 'stt_turn' AND c.room_day_id = t.room_day_id
     WHERE t.window_id = ${w.id}
  `) as Array<{ source_ref: string; speaker_idx: number; no_role_reason: string | null; start_ms: string | number; end_ms: string | number }>;
  const attributed: AttributedTurn[] = turns.map((t) => ({ source_ref: t.source_ref, speaker_idx: Number(t.speaker_idx), no_role_reason: t.no_role_reason, start_ms: Number(t.start_ms), end_ms: Number(t.end_ms) }));
  const { runs, skipped } = buildRuns(attributed);
  const windowStart = Number(w.start_ms);
  let segments: PlannedSegment[];
  try { segments = planSegments(runs, windowStart, health.cap_s); } catch (e) { return fail(base, "emotion_unavailable", String((e as Error).message).slice(0, 160)); }

  const writeCtx: SegmentWrite = { windowId: w.id, roomDayId: w.room_day_id, diarizeAttempt: base.diarize_attempt, clipR2Key: w.clip_r2_key, windowStartMs: windowStart, cap_s: health.cap_s, model: { model: null, model_key: null, subfolder: null, device: null } };
  for (const s of skipped) await writeSkipped(writeCtx, s);

  if (segments.length === 0) {
    await recordEmotionWindow({ ...{ windowId: w.id, roomDayId: w.room_day_id, diarizeAttempt: base.diarize_attempt }, state: "no_segments", error: null, cap_s: health.cap_s, counts: { planned: 0, scored: 0, skipped: skipped.length, failed: 0, calls: 0 } });
    return doneWith({ window_id: w.id, segments: 0, skipped: skipped.length, turns: attributed.length });
  }

  const progress: Progress = {
    ...base, window_start_ms: windowStart, window_end_ms: Number(w.end_ms), clip_r2_key: w.clip_r2_key,
    cap_s: health.cap_s, loaded_before: health.loaded, segments, skipped: skipped.length,
    batch: 0, calls: 0, scored: 0, failed: 0, model: null, subfolder: health.subfolder, device: null, started_ms: Date.now(),
  };
  return nextStep("warm", progress as unknown as Record<string, unknown>);
}

async function warm(ctx: StepContext): Promise<StepOutcome> {
  const p = P(ctx);
  const url = await signGetUrl({ key: p.clip_r2_key, expiresInSeconds: PRESIGN_SECONDS });
  const t0 = Date.now();
  const end = Math.min(1, (p.window_end_ms - p.window_start_ms) / 1000);
  const res = await scoreSegments(url, [{ start_s: 0, end_s: end }]);
  const wall_ms = Date.now() - t0;
  if (!res.ok) return fail(p, res.retryable ? "emotion_unavailable" : "emotion_refused", `warm-up: ${res.error}`);
  const first = res.results[0];
  const warmup = { loaded_before: p.loaded_before, ok: first?.ok === true, inference_s: first && first.ok ? first.inference_s : null, wall_ms };
  return nextStep("score", { ...p, warmup, calls: p.calls + 1, model: res.model, subfolder: res.subfolder, device: res.device } as unknown as Record<string, unknown>);
}

async function score(ctx: StepContext): Promise<StepOutcome> {
  const p = P(ctx);
  const batch = p.segments.slice(p.batch * SEGMENTS_PER_CALL, (p.batch + 1) * SEGMENTS_PER_CALL);
  if (batch.length === 0) return nextStep("finish", ctx.progress);

  // DIARIZE RE-RAN UNDERNEATH: these segments came from speakers that no longer exist. Stop.
  const now = (await sql`SELECT state, attempts FROM room_diarize_window WHERE window_id = ${p.window_id}`) as Array<{ state: string; attempts: number }>;
  if (!now[0] || now[0].state !== "ok" || Number(now[0].attempts) !== p.diarize_attempt) {
    return fail(p, "diarize_changed", `planned against attempt ${p.diarize_attempt}, now ${now[0]?.attempts ?? "none"} (${now[0]?.state ?? "no row"})`);
  }

  const url = await signGetUrl({ key: p.clip_r2_key, expiresInSeconds: PRESIGN_SECONDS });
  const res = await scoreSegments(url, batch.map((s) => ({ start_s: s.clip_start_s, end_s: s.clip_end_s })));
  if (!res.ok) return fail({ ...p, calls: p.calls + 1 }, res.retryable ? "emotion_unavailable" : "emotion_refused", res.error);

  const writeCtx: SegmentWrite = {
    windowId: p.window_id, roomDayId: p.room_day_id, diarizeAttempt: p.diarize_attempt, clipR2Key: p.clip_r2_key,
    windowStartMs: p.window_start_ms, cap_s: res.cap_s,
    model: { model: res.model, model_key: res.model_key ?? EMOTION_MODEL_KEY, subfolder: res.subfolder, device: res.device },
  };
  let scored = 0, failed = 0;
  for (const [i, seg] of batch.entries()) {
    const r = res.results[i]!;
    await writeScoredOrFailed(writeCtx, seg, r);
    if (r.ok) scored += 1; else failed += 1;
  }
  const next = { ...p, batch: p.batch + 1, calls: p.calls + 1, scored: p.scored + scored, failed: p.failed + failed, cap_s: res.cap_s, model: res.model, subfolder: res.subfolder, device: res.device };
  return nextStep((p.batch + 1) * SEGMENTS_PER_CALL >= p.segments.length ? "finish" : "score", next as unknown as Record<string, unknown>);
}

async function finish(ctx: StepContext): Promise<StepOutcome> {
  const p = P(ctx);
  const counts = { planned: p.segments.length, scored: p.scored, skipped: p.skipped, failed: p.failed, calls: p.calls };
  await recordEmotionWindow({
    windowId: p.window_id, roomDayId: p.room_day_id, state: "ok", diarizeAttempt: p.diarize_attempt, error: null,
    model: p.model, model_key: EMOTION_MODEL_KEY, subfolder: p.subfolder, cap_s: p.cap_s, counts, warmup: p.warmup,
    timing: { wall_ms: Date.now() - p.started_ms },
  });
  return doneWith({ window_id: p.window_id, ...counts, loaded_before: p.loaded_before });
}

const STEPS: Record<string, (ctx: StepContext) => Promise<StepOutcome>> = { prepare, warm, score, finish };

export const emotionWindowKind: JobKind = {
  name: EMOTION_WINDOW_KIND,
  first: "prepare",
  scope: "invoke",

  parseArgs(raw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const window_id = typeof o.window_id === "string" ? o.window_id.trim() : "";
    if (!window_id) throw new JobArgsError("window_id is required");
    return { window_id };
  },

  async run(ctx) {
    const step = STEPS[ctx.step];
    if (!step) return failWith(jobError("unknown_step", ctx.step));
    try {
      return await step(ctx);
    } catch (e) {
      const p = ctx.progress as Partial<Progress>;
      const detail = `${ctx.step}: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      if (p.window_id && typeof p.diarize_attempt === "number") {
        return fail(p as Progress, "emotion_window_failed", detail);
      }
      // prepare threw before a plan existed: record against the window id the job was given, if its
      // diarize row can still be read; otherwise the failure is the job's own.
      const windowId = String(ctx.args.window_id ?? "");
      let d: Array<{ room_day_id: string | null; attempts: number }> = [];
      try {
        d = (await sql`SELECT room_day_id, attempts FROM room_diarize_window WHERE window_id = ${windowId}`) as typeof d;
      } catch (readErr) {
        console.error("[emotion_window] could not read the diarize row to record a failure", JSON.stringify({ window: windowId, err: String((readErr as Error)?.message ?? readErr).slice(0, 160) }));
      }
      if (d[0]) return fail({ window_id: windowId, room_day_id: d[0].room_day_id, diarize_attempt: Number(d[0].attempts) }, "emotion_window_failed", detail);
      return failWith(jobError("emotion_window_failed", detail));
    }
  },
};
