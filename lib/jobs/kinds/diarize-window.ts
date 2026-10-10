/**
 * lib/jobs/kinds/diarize-window.ts — Diarize one room window, as a job. NEMOTRON IS THE ONLY ROOM ENGINE.
 *
 * V, 10 Oct 2026: pyannote is gone from production. The GPU-box Nemotron worker posts a window's turns to
 * /api/diarize/nemotron/ingest, which stores them (diarize_nemotron_window, untouched) and SUBMITS this job.
 * THIS JOB is the one writer of `room_diarize_window` and `room_turn_speaker`: the ingest route never writes them.
 *
 * ─── THE STEP ───────────────────────────────────────────────────────────────────────────────────
 *   diarize   engine check → the stored Nemotron answer → (empty: `no_speakers`) → the clip → one ECAPA embedding
 *             per speaker (the Mini's /embed_speakers, the SAME model that produced every enrolled centroid) →
 *             enrolled-voiceprint match → finishDiarizeWindow + recordDiarizeWindow + storeAndFinish.
 *
 * ─── NOTHING ELSE CAN RUN ───────────────────────────────────────────────────────────────────────
 * `pushEngine()` returns `nemotron` or throws; `local` and `pyannoteai` are REFUSED here by name, before the
 * clip, the Mini or any provider is touched (`diarize_engine_refused`). There is no pyannote.ai call, no local
 * /diarize call and no comparison step in this file: they were removed, not switched off.
 *
 * ─── OTHER ENGINES' ROWS ARE HISTORY ───────────────────────────────────────────────────────────
 * A window whose room diarize row is already `ok` / `no_speakers` from ANOTHER engine (pyannote era) is NOT
 * touched: recordDiarizeWindow would keep its content but the turn rows below would be rewritten under a new run
 * id, which makes the emotion job report `diarize_stale`. The job answers `skipped: already_diarized` and writes
 * nothing. A `failed` row is replaced, as it always was; a row this engine wrote follows the unchanged keep-rule.
 *
 * ─── ATTRIBUTION IS EARNED ─────────────────────────────────────────────────────────────────────
 * Nemotron outputs turns and nothing else. Identity comes from the embeddings this job fetches, matched against
 * the enrolled centroids; `attribution` is `voiceprint` only when an embedding AND a centroid were both present
 * (attributionFor). A NON-retryable embed answer is recorded as `embed_error` (ok, attribution none), never as "nobody
 * matched". A RETRYABLE one (Mini down, timeout, 5xx, network) throws so the runner retries; on the last attempt the
 * window is written `failed`, never `ok` (R2-1).
 */
import { randomUUID } from "node:crypto";
import { getObjectBytes } from "@/lib/r2";
import { sql } from "@/lib/db";
import { fetchWindowSpeech, speechGateEnabled } from "@/lib/stt/speech-gate";
import {
  finishDiarizeWindow,
  loadClinicianCentroids,
  attributionFor,
  recordDiarizeWindow,
  repairStaleDiarizeSegments,
  speakersFromLabels,
  DIARIZE_BATCH_THRESHOLD,
  type DiarizeEngineProvenance,
} from "@/lib/stt/diarize-window";
import { DiarizeEngineError, pushEngine, type DiarizeEngine } from "@/lib/diarize-engine";
import { embedSpeakers, embeddedCount, longestSpanPerSpeaker, mergeEmbeddings } from "@/lib/diarize-embed";
import { nemotronToSegments } from "@/lib/diarize-nemotron/segments";
import { windowStart, windowEnd } from "@/lib/stt/window-bounds";
import { JobArgsError, MAX_FAILURES, doneWith, failWith, type JobKind, type StepContext } from "../types";
import { jobError, type JobErrorCode } from "../errors";
import { windowArgHeldOut } from "@/lib/room-access/jobs";
import { loadNemotronResult, roomDiarizeRow } from "@/lib/room-access/nemotron-store";

export const DIARIZE_WINDOW_KIND = "diarize_window";

const STEPS = { diarize: "diarize" } as const;

type WindowRow = { id: string; room_day_id: string; start_ms: number; end_ms: number; clip_r2_key: string };

async function loadWindow(windowId: string): Promise<WindowRow | { error: JobErrorCode; detail?: string }> {
  const rows = (await sql`
    SELECT id, room_day_id, start_ms, end_ms, clip_r2_key
      FROM bench_window WHERE id = ${windowId} LIMIT 1
  `) as Array<{ id: string; room_day_id: string | null; start_ms: string | number; end_ms: string | number; clip_r2_key: string | null }>;
  const w = rows[0];
  if (!w) return { error: "progress_incomplete", detail: "no such window" };
  if (!w.room_day_id) return { error: "progress_incomplete", detail: "window has no room_day" };
  if (!w.clip_r2_key) return { error: "clip_missing_in_r2", detail: "window has no clip" };
  return { id: w.id, room_day_id: w.room_day_id, start_ms: Number(w.start_ms), end_ms: Number(w.end_ms), clip_r2_key: w.clip_r2_key };
}

export const diarizeWindowKind: JobKind = {
  name: DIARIZE_WINDOW_KIND,
  first: STEPS.diarize,
  roomData: true,
  heldOut: windowArgHeldOut,
  scope: "invoke",
  // ONE open job per window: a re-post of the same Nemotron answer never queues a second.
  dedupeOn: (args) => [["window_id", String(args.window_id ?? "")]],

  parseArgs(raw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const window_id = typeof o.window_id === "string" ? o.window_id.trim() : "";
    if (!window_id) throw new JobArgsError("window_id is required");
    return { window_id };
  },

  async run(ctx: StepContext) {
    switch (ctx.step) {
      case STEPS.diarize:
        return diarizeStep(ctx);
      default:
        return failWith(jobError("unknown_step", ctx.step));
    }
  },
};

/**
 * Provenance with the fields this engine can actually fill, and nulls — never guesses — elsewhere.
 * `attribution` is REQUIRED, not defaulted: every caller states what its window actually earned.
 */
function engineProvenance(
  name: DiarizeEngine,
  over: Partial<DiarizeEngineProvenance> & { attribution: "voiceprint" | "none"; skipped?: string; embed_error?: string },
): DiarizeEngineProvenance {
  return {
    name,
    model: null,
    job_id: null,
    fallback_from: null,
    fallback_reason: null,
    audio_seconds_sent: null,
    ...over,
  };
}

async function diarizeStep(ctx: StepContext) {
  const windowId = String(ctx.args.window_id ?? "");

  // THE ENGINE CHECK COMES FIRST: a refused engine makes no read of the clip, no Mini call, no provider call.
  try {
    pushEngine();
  } catch (e) {
    if (e instanceof DiarizeEngineError) return failWith(jobError("diarize_engine_refused", e.message.slice(0, 200)));
    throw e;
  }

  const w = await loadWindow(windowId);
  if ("error" in w) return failWith(jobError(w.error, w.detail));

  // An ok / no_speakers row written by ANOTHER engine is history (see the header): nothing is written. A row this
  // engine wrote itself follows the unchanged keep-rule in recordDiarizeWindow (and the R10 repair), exactly as before.
  const existing = await roomDiarizeRow(windowId);
  if (existing && (existing.state === "ok" || existing.state === "no_speakers") && existing.engine !== "nemotron") {
    return doneWith({ window_id: windowId, engine: "nemotron", skipped: "already_diarized", state: existing.state, written_by: existing.engine });
  }

  const nem = await loadNemotronResult(windowId);
  if (!nem) return failWith(jobError("progress_incomplete", "no stored nemotron result"));

  const runId = randomUUID();
  const { labels, segments } = nemotronToSegments(nem.turns);
  const answered = { model: nem.model, model_rev: nem.model_rev, config_hash: nem.config_hash };

  // An `empty` answer — or one with no usable turn — is a real finding of no speech, recorded like the
  // pyannote level-gate path did: `no_speakers`, and the provenance says it was Nemotron that found it empty.
  if (nem.status === "empty" || segments.length === 0) {
    const provenance = engineProvenance("nemotron", { ...answered, attribution: "none", skipped: "nemotron_empty" });
    await recordDiarizeWindow({
      windowId, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId,
      state: "no_speakers", error: null, speakers: [], segments: [], timing: { engine: provenance },
    });
    return doneWith({ window_id: windowId, engine: "nemotron", skipped: "nemotron_empty", spans: 0, speakers: 0 });
  }

  const bytes = await getObjectBytes(w.clip_r2_key);
  if (!bytes) {
    await recordDiarizeWindow({
      windowId, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId,
      state: "failed", error: `clip_missing:${w.clip_r2_key}`, speakers: null, segments: null, timing: null,
    });
    return failWith(jobError("clip_missing_in_r2", w.clip_r2_key));
  }

  // THE SPEECH GATE'S ONE CALLER. Off, no VAD is called.
  const speech = speechGateEnabled() ? await fetchWindowSpeech(bytes, "audio/webm") : undefined;
  if (speech && !speech.ok) {
    console.warn("[jobs] speech gate: no VAD answer", JSON.stringify({ window: windowId, reason: speech.reason }));
  }

  // ── IDENTITY: Nemotron's turns, this system's voiceprints (the same hybrid pyannote.ai used) ──────────
  const bare = speakersFromLabels(labels, segments);
  const centroids = await loadClinicianCentroids();
  let speakers: typeof bare = bare;
  let embedded = 0;
  let embedError: string | null = null;
  let embedMs: number | null = null;
  const emb = await embedSpeakers(bytes, longestSpanPerSpeaker(segments), centroids, { batchThreshold: DIARIZE_BATCH_THRESHOLD, label: windowId });
  if (emb.ok) {
    speakers = mergeEmbeddings(bare, emb.speakers) as typeof bare;
    embedded = embeddedCount(speakers);
    embedMs = emb.latencyMs;
  } else {
    embedError = emb.error;
    // Named, never swallowed: a window with no embeddings is one where nobody COULD be named.
    console.warn("[jobs] nemotron embeddings unavailable", JSON.stringify({ window: windowId, reason: emb.error, retryable: emb.retryable }));
    if (emb.retryable) {
      // R2-1: a Mini outage / timeout / 5xx / network error is NOT "nobody matched". The step THROWS, so the runner retries
      // it (up to MAX_FAILURES). The attempt that would be the last first records the window `failed` — never `ok` — so the
      // sweeper (lib/stt/diarize-job.ts) can re-drive it once the Mini is back; a throw alone would leave no row at all.
      if (ctx.job.failures + 1 >= MAX_FAILURES) {
        const failedProv = engineProvenance("nemotron", { ...answered, attribution: "none", centroids_offered: centroids.length, embed_error: emb.error });
        await recordDiarizeWindow({
          windowId, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId,
          state: "failed", error: `embed_failed:${emb.error}`, speakers: null, segments: null, timing: { engine: failedProv },
        });
      }
      throw new Error(`embed_retryable:${emb.error}`);
    }
    // A NON-retryable answer (e.g. no span long enough to embed) is a real finding: ok, attribution none, embed_error recorded.
  }

  const provenance = engineProvenance("nemotron", {
    ...answered,
    // EARNED, NOT ASSUMED: embeddings to compare AND at least one enrolled centroid to compare against.
    attribution: attributionFor(speakers, centroids.length),
    centroids_offered: centroids.length,
    ...(embedError ? { embed_error: embedError } : {}),
  });
  const out = await finishDiarizeWindow(
    { windowId, roomDayId: w.room_day_id, window: { start: windowStart(w.start_ms), end: windowEnd(w.end_ms) }, centroids, runId, ...(speech ? { speech } : {}) },
    {
      speakers, rawSegments: segments,
      timing: { machine: nem.machine, audio_ms: nem.audio_ms, embed_ms: embedMs },
      latencyMs: embedMs, provenance,
    },
  );
  return storeAndFinish({
    w, runId, out,
    extra: { engine: "nemotron", model_rev: nem.model_rev, speakers_embedded: embedded, ...(embedError ? { embed_error: embedError } : {}) },
  });
}

/** The write and the stale-segment repair. */
async function storeAndFinish(args: {
  w: WindowRow;
  runId: string;
  out: Awaited<ReturnType<typeof finishDiarizeWindow>>;
  extra: Record<string, unknown>;
}) {
  const { w, runId, out, extra } = args;
  // The state is decided by the SPEAKER LIST, exactly as it always was.
  const runState = out.speakers.length === 0 ? "no_speakers" : "ok";
  await recordDiarizeWindow({
    windowId: w.id, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId,
    state: runState, error: null, speakers: out.speakers, segments: out.segments, timing: out.timing,
  });
  // E24 R10 — if the emotion job already recorded this window `diarize_stale`, this fresh run is the cure.
  const repaired = await repairStaleDiarizeSegments({
    windowId: w.id, runId, runState, speakers: out.speakers, segments: out.segments,
  });
  // Counts and ids only — the spans carry no text and neither does this.
  return doneWith({ window_id: w.id, ...out.outcome, ...extra, ...(repaired ? { stale_segments_repaired: true } : {}) });
}
