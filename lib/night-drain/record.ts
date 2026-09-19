/**
 * lib/night-drain/record.ts — the two things the drain does that touch the app's own writers.
 *
 * Nothing here invents a row shape. The terminal row is written by `recordDiarizeWindow`, the ONLY writer of
 * room_diarize_window, exactly as the `diarize_window` job kind calls it; the only differences are the ones the
 * rulings ask for: `clipR2Key: null` (these windows have no clip), and a `timing_json` carrying the producer and
 * `diarize_only` (see producer.ts).
 *
 * `diarizeWindow` writes room_turn_speaker rows only for turns that already exist. For an un-transcribed window
 * there are none, so it writes nothing but returns the speakers and segments — which this file then records.
 */
import { randomUUID } from "node:crypto";
import { runDiarize } from "@/lib/diarize";
import {
  DIARIZE_BATCH_THRESHOLD, diarizeWindow, loadClinicianCentroids, recordDiarizeWindow, repairStaleDiarizeSegments,
} from "@/lib/stt/diarize-window";
import { windowEnd, windowStart } from "@/lib/stt/window-bounds";
import { mapDiarizeFailure, type FailedCode, type Outcome } from "./outcome";
import { producerStamp, stampTiming, type AudioFacts, type Phases } from "./producer";
import type { ClaimedWindow } from "./store";
import type { Mode, StageCtx } from "./worker";
import type { WindowAudio } from "./audio";

const phasesOf = (ctx: StageCtx, diarizeMs: number | null, totalMs: number | null): Phases => ({ ...ctx.phases, diarize_ms: diarizeMs, total_ms: totalMs });
const audioFacts = (w: ClaimedWindow, a: WindowAudio): AudioFacts => ({ pieces: a.pieces, bytes: a.bytes, seconds: Math.round(a.seconds * 10) / 10, source: w.source });

/** Write a `failed` row for a window-specific failure. Never throws: a write that fails is a `deferred` outcome. */
export async function recordFailedRow(w: ClaimedWindow, code: FailedCode, ctx: StageCtx, device: string | null, clientTiming: unknown = null): Promise<Outcome> {
  try {
    await recordDiarizeWindow({
      windowId: w.id, roomDayId: w.room_day_id, state: "failed", error: code, speakers: null, segments: null,
      clipR2Key: null, runId: randomUUID(),
      timing: stampTiming(clientTiming, producerStamp(device), phasesOf(ctx, null, null), null),
    });
    return { kind: "recorded", state: "failed", code };
  } catch (e) {
    console.warn(`[night-drain] window ${w.id}: could not write the failed row (${(e as Error)?.name ?? "error"})`);
    return { kind: "deferred", code: "record_write_failed" };
  }
}

/**
 * Diarize one window's audio and, in `run` mode, write the terminal row. In `dry-run` it makes the same /diarize
 * call (same centroids, same threshold) and writes nothing at all.
 */
export async function diarizeAndRecord(
  w: ClaimedWindow, a: WindowAudio, ctx: StageCtx, mode: Mode, device: string | null,
): Promise<{ outcome: Outcome; diarize_ms: number | null }> {
  const start = Date.now();
  if (mode === "dry-run") {
    const centroids = await loadClinicianCentroids();
    const r = await runDiarize(a.clip, "audio/webm", { encounterId: w.id, clinicianCentroids: centroids, batchThreshold: DIARIZE_BATCH_THRESHOLD, signal: ctx.signal });
    const ms = Date.now() - start;
    if (!r.ok) return { outcome: mapDiarizeFailure({ error: r.error, retryable: r.retryable === true }), diarize_ms: ms };
    const n = r.result.speakers.length;
    return { outcome: { kind: "recorded", state: n === 0 ? "no_speakers" : "ok", speakers: n, segments: r.result.transcript_segments.length }, diarize_ms: ms };
  }

  const runId = randomUUID();
  const res = await diarizeWindow({
    windowId: w.id, roomDayId: w.room_day_id, window: { start: windowStart(w.start_ms), end: windowEnd(w.end_ms) },
    audio: a.clip, contentType: "audio/webm", runId, signal: ctx.signal,
  });
  const diarizeMs = Date.now() - start;
  const producer = producerStamp(device);

  if (!res.ok) {
    const m = mapDiarizeFailure({ error: res.error, retryable: res.retryable });
    if (m.kind !== "recorded" || m.state !== "failed") return { outcome: m, diarize_ms: diarizeMs };
    // The service's message can describe the audio; the row gets the code.
    try {
      await recordDiarizeWindow({
        windowId: w.id, roomDayId: w.room_day_id, state: "failed", error: m.code, speakers: null, segments: null,
        clipR2Key: null, runId, timing: stampTiming(res.timing, producer, phasesOf(ctx, diarizeMs, null), audioFacts(w, a)),
      });
      return { outcome: m, diarize_ms: diarizeMs };
    } catch (e) {
      console.warn(`[night-drain] window ${w.id}: could not write the failed row (${(e as Error)?.name ?? "error"})`);
      return { outcome: { kind: "deferred", code: "record_write_failed" }, diarize_ms: diarizeMs };
    }
  }

  const state = res.speakers.length === 0 ? "no_speakers" : "ok";
  try {
    await recordDiarizeWindow({
      windowId: w.id, roomDayId: w.room_day_id, state, error: null, speakers: res.speakers, segments: res.segments,
      clipR2Key: null, runId, timing: stampTiming(res.timing, producer, phasesOf(ctx, diarizeMs, null), audioFacts(w, a)),
    });
    // The job kind calls this after every run that wrote turns; it changes nothing unless the window's emotion row is stale.
    await repairStaleDiarizeSegments({ windowId: w.id, runId, runState: state, speakers: res.speakers, segments: res.segments });
  } catch (e) {
    console.warn(`[night-drain] window ${w.id}: could not write the terminal row (${(e as Error)?.name ?? "error"})`);
    return { outcome: { kind: "deferred", code: "record_write_failed" }, diarize_ms: diarizeMs };
  }
  return { outcome: { kind: "recorded", state, speakers: res.speakers.length, segments: res.segments.length }, diarize_ms: diarizeMs };
}
