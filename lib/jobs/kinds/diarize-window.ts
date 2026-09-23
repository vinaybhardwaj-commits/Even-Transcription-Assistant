/**
 * lib/jobs/kinds/diarize-window.ts — C2 Part B. Diarize one room window, as a job.
 *
 * TWO ENGINES FROM 23 SEP 2026. `DIARIZE_ENGINE` chooses (lib/diarize-engine.ts):
 *
 *   unset | local   ONE STEP, ONE /diarize CALL to the Mac Mini. Measured across four real 900 s
 *                   windows the service runs at 0.071-0.085x realtime (64-76 s wall), flat in
 *                   speech density, against a 240 s lease — so a whole window is one comfortable
 *                   step. There is no submit/poll because /diarize has none: it answers on the
 *                   same request. THIS PATH IS UNCHANGED, and that is the point of the default.
 *
 *   pyannoteai      THE HYBRID. pyannote.ai segments (V chose it 5 of 5 on the windows where the
 *                   two disagreed most); the Mini supplies the embeddings its turns lack, from the
 *                   SAME ECAPA model that produced every enrolled centroid, so identity still
 *                   comes from a voiceprint match and every downstream reader keeps its input.
 *                   Submit/poll, because pyannote.ai's API is asynchronous.
 *
 * ─── THE STEP MACHINE ──────────────────────────────────────────────────────────────────────────
 *   diarize        pick the engine; local answers here, pyannote.ai is submitted here
 *   pyannote_poll  poll the submission, embed its speakers, store the window
 *   local_label    (teacher labels only) run the local diarizer for COMPARISON and record what it
 *                  said — it writes no turns and cannot disturb what the hybrid already stored
 *
 * ─── THE POLL STEP DOES NOT READ THE ENV ───────────────────────────────────────────────────────
 * It reads the engine and the job id out of `progress`. A submission is PAID FOR the moment it is
 * accepted, so the engine that made it is the engine that finishes it — even if `DIARIZE_ENGINE`
 * is changed, or rolled back, while the row is in flight.
 *
 * ─── pyannote.ai IS A TEACHER ──────────────────────────────────────────────────────────────────
 * V's ruling of 23 Sep, with written permission from pyannote.ai to train on its outputs: both
 * engines' raw turns are kept in `diarize_window_label` (migration 0117) so the local diarizer can
 * be trained to match the teacher, and so the lab can measure the gap night by night. Labelling is
 * its own flag (`DIARIZE_TEACHER_LABELS`) and its failures never fail a window: a clinician's
 * window must not depend on whether a lab table was reachable.
 */
import { randomUUID } from "node:crypto";
import { deleteObject, getObjectBytes, headObject, putObjectBytes, signGetUrl } from "@/lib/r2";
import { sql } from "@/lib/db";
import { DEFAULT_MIN_SPEECH_MS, fetchWindowSpeech, speechGateEnabled, type WindowSpeech } from "@/lib/stt/speech-gate";
import {
  diarizeWindow,
  finishDiarizeWindow,
  loadClinicianCentroids,
  attributionFor,
  localModelLabel,
  recordDiarizeWindow,
  repairStaleDiarizeSegments,
  speakersFromLabels,
  DIARIZE_BATCH_THRESHOLD,
  type DiarizeEngineProvenance,
} from "@/lib/stt/diarize-window";
import { runDiarize } from "@/lib/diarize";
import { parseDiarizeSegments } from "@/lib/stt/speaker-clusters";
import { diarizeEngine, teacherLabelsEnabled, type DiarizeEngine } from "@/lib/diarize-engine";
import { PRESIGN_TTL_SECONDS, fetchJobRecord, pollDiarize, submitDiarize } from "@/lib/diarize-pyannoteai";
import { embedSpeakers, embeddedCount, longestSpanPerSpeaker, mergeEmbeddings } from "@/lib/diarize-embed";
import { writeWindowLabel } from "@/lib/diarize-labels";
import { judgeLevels } from "@/lib/diarize-level-gate";
import { readRoomLevelDay, type BenchLevelSample } from "@/lib/bench-levels";
import { observedQuietSpans, remapSegments, requestSpeechRegions, trimmedAudioKey, vadTrimEnabled, vadTrimParams, type RegionMap } from "@/lib/diarize-vad-trim";
import { windowStart, windowEnd } from "@/lib/stt/window-bounds";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext } from "../types";
import { jobError, type JobErrorCode } from "../errors";

export const DIARIZE_WINDOW_KIND = "diarize_window";

const STEPS = { diarize: "diarize", pyannotePoll: "pyannote_poll", localLabel: "local_label" } as const;

/**
 * What one claim may spend polling before handing the row back to the queue, and how long it
 * waits between polls. Both are overridable by env, exactly as DIARIZE_TIMEOUT_MS is: the right
 * cadence depends on how fast pyannote.ai is answering on the night, and that is not worth a
 * redeploy to change. The defaults are the shipped values.
 */
export const POLL_BUDGET_MS = 150_000;
export const POLL_INTERVAL_MS = 3_000;
export const POLL_BUDGET_MS_ENV = "DIARIZE_POLL_BUDGET_MS";
export const POLL_INTERVAL_MS_ENV = "DIARIZE_POLL_INTERVAL_MS";

const positiveMs = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const pollBudgetMs = (): number => positiveMs(process.env[POLL_BUDGET_MS_ENV], POLL_BUDGET_MS);
const pollIntervalMs = (): number => positiveMs(process.env[POLL_INTERVAL_MS_ENV], POLL_INTERVAL_MS);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type WindowRow = { id: string; room_day_id: string; start_ms: number; end_ms: number; clip_r2_key: string };

/**
 * ONE TABLE, exactly as this has always read it.
 *
 * It briefly joined `room_day` to fetch the room and IST date the level gate wants, and that broke
 * eleven e2e tests: the C2 harness builds a minimal schema in which `room_day` does not exist, so
 * the join made the load path of EVERY window — local included — depend on a table it never needed.
 * A cost guard for one engine must not be able to fail the other engine's query. The gate resolves
 * what it needs separately, and fails safe when it cannot.
 */
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

/**
 * The room and IST date a room-day belongs to — for the level gate, and nothing else.
 *
 * SEPARATE, AND IT SWALLOWS ITS OWN FAILURE. Returning null means "we could not find out", which
 * the gate treats exactly as it treats a level log with no readings: no verdict, no skip. A cost
 * guard that could not read its inputs must never stop a clinical window.
 */
async function resolveRoomDay(roomDayId: string): Promise<{ roomId: string; istDate: string } | null> {
  try {
    const rows = (await sql`
      SELECT room_id, ist_date::text AS ist_date FROM room_day WHERE id = ${roomDayId} LIMIT 1
    `) as Array<{ room_id: string | null; ist_date: string | null }>;
    const r = rows[0];
    if (!r?.room_id || !r.ist_date) return null;
    return { roomId: r.room_id, istDate: r.ist_date };
  } catch (e) {
    console.warn("[jobs] level gate: room_day unreadable", JSON.stringify({ room_day: roomDayId, err: String(e).slice(0, 120) }));
    return null;
  }
}

/** Window length from its own bounds — what we hand a paid engine, so cost is countable. */
export function windowAudioSeconds(w: { start_ms: number; end_ms: number }): number | null {
  const ms = w.end_ms - w.start_ms;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) / 1000 : null;
}

/**
 * The VAD cost guard, kept for the case where the speech gate is already on and has answered.
 *
 * True only when the VAD gave a REAL ANSWER holding less than the gate's own floor. `ok: false` —
 * either "we could not ask" or "we asked and it said nothing" — NEVER skips: lib/stt/speech-gate.ts
 * records that on this audio an empty VAD answer is more often a VAD failure than a quiet room.
 *
 * The LEVEL GATE is the primary guard now and runs whether or not that flag is on; this remains
 * because a VAD answer already in hand is better evidence than a level log, and free.
 */
export function vadSaysSilent(speech: WindowSpeech | undefined): boolean {
  if (!speech || speech.ok !== true) return false;
  let total = 0;
  for (const s of speech.spans) total += Math.max(0, s.end_ms - s.start_ms);
  return total < DEFAULT_MIN_SPEECH_MS;
}

export const diarizeWindowKind: JobKind = {
  name: DIARIZE_WINDOW_KIND,
  first: STEPS.diarize,
  scope: "invoke",

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
      case STEPS.pyannotePoll:
        return pollStep(ctx);
      case STEPS.localLabel:
        return localLabelStep(ctx);
      default:
        return failWith(jobError("unknown_step", ctx.step));
    }
  },
};

/**
 * Step 1 — decide the engine, and either do the local call outright or submit to pyannote.ai.
 *
 * `diarizeEngine()` THROWS on a value it does not recognise, and that throw is allowed to leave
 * this step. The runner counts it and retries, and three of them fail the job loudly — which is
 * the outcome a mistyped `DIARIZE_ENGINE` must have.
 */
async function diarizeStep(ctx: StepContext) {
  const windowId = String(ctx.args.window_id ?? "");
  const w = await loadWindow(windowId);
  if ("error" in w) return failWith(jobError(w.error, w.detail));

  const engine: DiarizeEngine = diarizeEngine();
  const runId = randomUUID();

  // ── THE LEVEL GATE, BEFORE ANY AUDIO IS FETCHED ────────────────────────────────────────────
  // It runs only for the paid engine, because it is a COST guard and the local path's behaviour is
  // not ours to change. It asks the level log, not a service, so it needs no flag and no clip: a
  // window skipped here costs one query and no download.
  const rd = engine === "pyannoteai" ? await resolveRoomDay(w.room_day_id) : null;
  // ONE read of the level log, used twice: the whole-window silence gate below, and the dead-air
  // trim's allowed cuts further down. An unreadable room_day leaves it empty, which the gate reads
  // as "no verdict" and the trim reads as "nothing may be cut".
  let levelSamples: BenchLevelSample[] = [];
  if (rd) {
    levelSamples = (await readRoomLevelDay(rd.roomId, rd.istDate)).samples;
    const level = judgeLevels(levelSamples, { start_ms: w.start_ms, end_ms: w.end_ms });
    if (level.verdict === "silent") {
      const provenance = // Nothing ran on this window, so nothing was compared. It says so rather than inheriting
      // a claim from an engine that never saw it.
      engineProvenance("pyannoteai", { attribution: "none", audio_seconds_sent: 0, skipped: `silent_window:${level.reason}` });
      await recordDiarizeWindow({
        windowId, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId,
        state: "no_speakers", error: null, speakers: [], segments: [], timing: { engine: provenance, level },
      });
      console.log("[jobs] diarize skipped, level log flat", JSON.stringify({ window: windowId, ...level }));
      return doneWith({
        window_id: windowId, engine: "pyannoteai", skipped: "silent_window",
        level_basis: level.basis, level_coverage: level.coverage, audio_seconds_sent: 0, spans: 0, speakers: 0,
      });
    }
  }

  const bytes = await getObjectBytes(w.clip_r2_key);
  if (!bytes) {
    await recordDiarizeWindow({
      windowId, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId,
      state: "failed", error: `clip_missing:${w.clip_r2_key}`, speakers: null, segments: null, timing: null,
    });
    return failWith(jobError("clip_missing_in_r2", w.clip_r2_key));
  }

  // THE SPEECH GATE'S ONE CALLER. Off, no VAD is called and nothing is paid for.
  const speech = speechGateEnabled() ? await fetchWindowSpeech(bytes, "audio/webm") : undefined;
  if (speech && !speech.ok) {
    console.warn("[jobs] speech gate: no VAD answer", JSON.stringify({ window: windowId, reason: speech.reason }));
  }

  if (engine === "local") return localRun({ w, runId, speech, fallback: null, audio: bytes });

  const audioSeconds = windowAudioSeconds(w);

  if (vadSaysSilent(speech)) {
    const provenance = engineProvenance("pyannoteai", { attribution: "none", audio_seconds_sent: 0, skipped: "silent_window:vad" });
    await recordDiarizeWindow({
      windowId, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId,
      state: "no_speakers", error: null, speakers: [], segments: [], timing: { engine: provenance },
    });
    return doneWith({ window_id: windowId, engine: "pyannoteai", skipped: "silent_window", audio_seconds_sent: 0, spans: 0, speakers: 0 });
  }

  // Prove the object is there BEFORE minting a URL for it.
  const head = await headObject(w.clip_r2_key);
  if (!head || head.size === null) return failWith(jobError("clip_missing_in_r2"));

  // ── DEAD-AIR TRIM (DIARIZE_VAD_TRIM, default off) ─────────────────────────────────────────
  // pyannote.ai bills per audio-hour and a room window is mostly silence. With the flag on, the Mini
  // runs Silero VAD and hands back the speech regions plus a speech-only WAV; that file is what
  // pyannote.ai fetches, and its timestamps are mapped back onto this clip in the poll step.
  //
  // EVERY failure here falls back to sending the WHOLE clip — the pre-trim behaviour. Only a REAL
  // answer that there is no speech may skip the paid call; an unreachable VAD, a malformed map or a
  // failed upload is "we could not trim", never "there was nothing to hear".
  let sendKey = w.clip_r2_key;
  let sentSeconds = audioSeconds;
  let trimProgress: Record<string, unknown> | null = null;
  let trimNote: string | null = null;
  if (vadTrimEnabled()) {
    const params = vadTrimParams();
    // RULING (b), Fable 23 Sep: a VAD-silent span is cut ONLY where the level log also showed no
    // activity. These are those spans. None means nothing may be cut — and then there is no point
    // spending a VAD pass on the Mini for a window it is not allowed to trim.
    const allowCut = observedQuietSpans(levelSamples, { start_ms: w.start_ms, end_ms: w.end_ms });
    const vr = allowCut.length === 0 ? null : await requestSpeechRegions(bytes, params, { label: windowId, allowCut });
    if (vr === null) {
      trimNote = "level_log_no_quiet";
    } else if (vr.ok && vr.regionsEmpty) {
      // RULING (a): Silero found no speech. That is NOT a skip, and NOT a trim — the window is
      // diarized WHOLE. On some rooms Silero confidently finds none through real, normal-level speech
      // (lab-mover: 19-91% of real speech lost on 4 of 20 windows), so "no speech" from VAD alone is
      // never allowed to decide what a clinician's window loses.
      trimNote = "vad_empty";
    } else if (vr.ok && vr.map.speechSeconds >= vr.map.originalSeconds) {
      // Once the level log had its say, nothing was cuttable: a WAV of the whole clip saves nothing.
      trimNote = "nothing_cuttable";
    } else if (vr.ok) {
      const key = trimmedAudioKey(windowId, runId);
      try {
        await putObjectBytes(key, vr.audio, "audio/wav");
        sendKey = key;
        sentSeconds = vr.map.speechSeconds;
        // The map travels to the poll step in progress: times and counts only, no audio.
        trimProgress = {
          key,
          regions: vr.map.regions,
          sample_rate: vr.map.sampleRate,
          speech_s: vr.map.speechSeconds,
          original_s: vr.map.originalSeconds,
          vad_model: vr.vadModel,
          params,
        };
      } catch (e) {
        console.warn("[jobs] vad-trim upload failed, sending whole clip", JSON.stringify({ window: windowId, err: String(e).slice(0, 120) }));
        trimNote = "upload_failed";
      }
    } else {
      console.warn("[jobs] vad-trim unavailable, sending whole clip", JSON.stringify({ window: windowId, reason: vr.error }));
      trimNote = vr.error;
    }
  }

  let audioUrl: string;
  try {
    // READ-ONLY, ONE OBJECT, MINUTES. It points at R2 — the audio never goes near the Mini tunnel —
    // and it is never logged, because for as long as it lives it is a bearer credential for
    // patient audio. With the trim on, the one object is the speech-only file.
    audioUrl = await signGetUrl({ key: sendKey, expiresInSeconds: PRESIGN_TTL_SECONDS });
  } catch (e) {
    console.error("[jobs] presign failed", JSON.stringify({ window: windowId, err: String(e).slice(0, 120) }));
    return localRun({ w, runId, speech, fallback: { from: "pyannoteai", reason: "presign_failed" }, audio: bytes });
  }

  const sub = await submitDiarize(audioUrl, { label: windowId });
  if (!sub.ok) return localRun({ w, runId, speech, fallback: { from: "pyannoteai", reason: sub.error }, audio: bytes });

  console.log("[jobs] pyannote.ai submitted", JSON.stringify({ window: windowId, job: sub.jobId, audio_seconds: sentSeconds, original_seconds: audioSeconds, trimmed: trimProgress !== null }));
  // The id is persisted before anything else can fail. Every later claim polls it; none resubmits.
  return nextStep(STEPS.pyannotePoll, {
    ...ctx.progress,
    engine: "pyannoteai",
    pyannoteai_job_id: sub.jobId,
    run_id: runId,
    window_id: windowId,
    // WHAT WE PAY FOR: the trimmed length when the trim applied, the whole window otherwise.
    audio_seconds_sent: sentSeconds,
    original_audio_seconds: audioSeconds,
    ...(trimProgress ? { vad_trim: trimProgress } : {}),
    ...(trimNote ? { vad_trim_skipped: trimNote } : {}),
    submitted_at: new Date().toISOString(),
  });
}

/**
 * The trim map, back out of progress. It was written by the submit step, so its shape is ours; a
 * progress row without one simply means the whole clip was sent, and the segments need no remap.
 */
function trimMapFromProgress(p: unknown): { map: RegionMap; key: string; info: Record<string, unknown> } | null {
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.key !== "string" || !Array.isArray(o.regions)) return null;
  return {
    key: o.key,
    map: {
      sampleRate: Number(o.sample_rate),
      regions: o.regions as RegionMap["regions"],
      speechSeconds: Number(o.speech_s),
      originalSeconds: Number(o.original_s),
    },
    info: {
      applied: true,
      // Ruling (c): kept out of the training set, and said so on the row a lab query will read.
      teacher_label: "excluded_trimmed",
      regions: (o.regions as unknown[]).length,
      speech_s: o.speech_s,
      original_s: o.original_s,
      vad_model: o.vad_model ?? null,
      params: o.params ?? null,
    },
  };
}

/** Step 2 — poll the submission this job made, under a budget. Never resubmits, never reads env. */
async function pollStep(ctx: StepContext) {
  const jobId = String(ctx.progress.pyannoteai_job_id ?? "");
  const windowId = String(ctx.progress.window_id ?? ctx.args.window_id ?? "");
  const runId = String(ctx.progress.run_id ?? "");
  if (!jobId || !runId) return failWith(jobError("progress_incomplete", "pyannote.ai job id"));

  const w = await loadWindow(windowId);
  if ("error" in w) return failWith(jobError(w.error, w.detail));
  const audioSeconds = typeof ctx.progress.audio_seconds_sent === "number" ? (ctx.progress.audio_seconds_sent as number) : null;
  const trim = trimMapFromProgress(ctx.progress.vad_trim);
  // The speech-only file is a derived copy of patient audio in our bucket. It lives exactly as long
  // as the job needs it: removed on every terminal path, kept only while the poll hands itself back.
  const dropTrimmed = async () => { if (trim) await deleteObject(trim.key); };

  const budget = pollBudgetMs();
  const interval = pollIntervalMs();
  const deadline = Date.now() + budget;
  let polls = 0;
  for (;;) {
    const st = await pollDiarize(jobId);
    polls += 1;

    if (!st.ok) {
      if (st.retryable && Date.now() + interval < deadline) {
        await sleep(interval);
        continue;
      }
      if (st.retryable) {
        return nextStep(STEPS.pyannotePoll, { ...ctx.progress, polls_so_far: Number(ctx.progress.polls_so_far ?? 0) + polls });
      }
      // Terminal on pyannote.ai's side — the window still deserves a diarization, so the local
      // service gets it, from the ORIGINAL clip, and the row says where it came from and why.
      await dropTrimmed();
      return localRun({ w, runId, speech: undefined, fallback: { from: "pyannoteai", reason: st.error }, pyannoteJobId: jobId });
    }

    if (st.state === "done") {
      // BACK ONTO THE ORIGINAL CLOCK, before anything reads a segment. pyannote.ai heard the
      // speech-only file; every reader below — the turn binding, the embeddings, the teacher label —
      // works in the original clip's time, so the remap happens once, here, and nothing downstream
      // ever sees trimmed time. A segment across a join comes back split (lib/diarize-vad-trim.ts).
      const segs = trim ? remapSegments(st.segments, trim.map) : st.segments;
      await dropTrimmed();
      if (segs.length === 0) {
        // pyannote.ai answered, but nothing it said lands inside a kept region. That is not a
        // result to store; the local diarizer gets the window, from the original clip.
        return localRun({ w, runId, speech: undefined, fallback: { from: "pyannoteai", reason: "vad_trim_remap_empty" }, pyannoteJobId: jobId });
      }

      // The model is read back from the job's own record, never echoed from what we asked for.
      const record = await fetchJobRecord(jobId);

      // ── THE HYBRID: pyannote.ai's turns, this system's identities ────────────────────────
      const bare = speakersFromLabels(st.speakerLabels, segs);
      const bytes = await getObjectBytes(w.clip_r2_key);
      let speakers: typeof bare = bare;
      let embedded = 0;
      let centroidsOffered = 0;
      let embedError: string | null = null;
      if (bytes) {
        const centroids = await loadClinicianCentroids();
        centroidsOffered = centroids.length;
        const spans = longestSpanPerSpeaker(segs);
        const emb = await embedSpeakers(bytes, spans, centroids, { batchThreshold: DIARIZE_BATCH_THRESHOLD, label: windowId });
        if (emb.ok) {
          speakers = mergeEmbeddings(bare, emb.speakers) as typeof bare;
          embedded = embeddedCount(speakers);
        } else {
          embedError = emb.error;
        }
      } else {
        embedError = "clip_missing_in_r2";
      }
      if (embedError) {
        // Named, never swallowed. A window with no embeddings is a window where nobody COULD be
        // named, and that must not read as "nobody matched".
        console.warn("[jobs] hybrid embeddings unavailable", JSON.stringify({ window: windowId, reason: embedError }));
      }

      const provenance = engineProvenance("pyannoteai", {
        model: record?.model ?? null,
        job_id: jobId,
        audio_seconds_sent: audioSeconds,
        // EARNED, NOT ASSUMED, and BOTH halves are required: embeddings to compare, and at least
        // one enrolled centroid to compare them against. Counting embeddings alone would claim a
        // voiceprint attribution on a day when nobody is enrolled.
        attribution: attributionFor(speakers, centroidsOffered),
        centroids_offered: centroidsOffered,
        ...(trim ? { vad_trim: trim.info } : {}),
        ...(embedError ? { embed_error: embedError } : {}),
      });
      const out = await finishDiarizeWindow(
        { windowId, roomDayId: w.room_day_id, window: { start: windowStart(w.start_ms), end: windowEnd(w.end_ms) }, runId },
        {
          speakers, rawSegments: segs,
          // The order's pair, at the top of timing_json: what pyannote.ai was sent against the
          // window it came from. Equal when the trim did not apply; the saving when it did.
          timing: {
            polls, provider_job_id: jobId,
            sent_seconds: audioSeconds,
            window_seconds: typeof ctx.progress.original_audio_seconds === "number" ? ctx.progress.original_audio_seconds : windowAudioSeconds(w),
          },
          latencyMs: null, provenance,
        },
      );

      // RULING (c): NO TEACHER LABEL FROM A TRIMMED RUN. pyannote.ai heard only what VAD kept; on the
      // windows where VAD is wrong that is exactly the speech missing from its answer, and a label
      // missing speech teaches the local model to miss it too. The run is still stored for production
      // — it is marked (timing_json.engine.vad_trim) and kept out of the training set.
      if (!trim) {
        await labelWindow({
          w, runId, engine: "pyannoteai", model: record?.model ?? null, providerJobId: jobId,
          segments: segs, speakerCount: st.speakerLabels.length, audioSeconds,
        });
      }

      const stored = await storeAndFinish({
        w, runId, out,
        extra: {
          engine: "pyannoteai", pyannoteai_job_id: jobId, polls, audio_seconds_sent: audioSeconds,
          speakers_embedded: embedded, ...(embedError ? { embed_error: embedError } : {}),
          ...(trim ? { teacher_label: "excluded_trimmed" } : {}),
        },
      });
      // The teacher needs something to be measured against, so the local diarizer runs too — in
      // its OWN step, after production is safely stored, writing a label and no turns.
      if (teacherLabelsEnabled() && stored.kind === "done") {
        return nextStep(STEPS.localLabel, { ...ctx.progress, run_id: runId, window_id: windowId, hybrid_result: stored.result });
      }
      return stored;
    }

    if (Date.now() + interval >= deadline) {
      return nextStep(STEPS.pyannotePoll, { ...ctx.progress, polls_so_far: Number(ctx.progress.polls_so_far ?? 0) + polls });
    }
    await sleep(interval);
  }
}

/**
 * Step 3 — run the LOCAL diarizer for comparison only.
 *
 * IT WRITES NO TURNS AND NO WINDOW ROW. `diarizeWindow` would bind and write `room_turn_speaker`,
 * overwriting the identities the hybrid just stored for this window; this calls the service
 * directly and keeps only what it said. That is the whole job: a second opinion, recorded.
 *
 * IT CANNOT FAIL THE JOB. Production's window is already stored by the time this runs, and a lab
 * comparison is not worth failing a clinician's window over — so every outcome here is `done`,
 * with the reason recorded in the result.
 */
async function localLabelStep(ctx: StepContext) {
  const windowId = String(ctx.progress.window_id ?? ctx.args.window_id ?? "");
  const runId = String(ctx.progress.run_id ?? "");
  const hybrid = (ctx.progress.hybrid_result ?? {}) as Record<string, unknown>;
  const w = await loadWindow(windowId);
  if ("error" in w) return doneWith({ ...hybrid, local_label: "window_gone" });

  try {
    const bytes = await getObjectBytes(w.clip_r2_key);
    if (!bytes) return doneWith({ ...hybrid, local_label: "clip_missing" });
    const res = await runDiarize(bytes, "audio/webm", {
      encounterId: windowId,
      // NO CENTROIDS. This run exists to compare SEGMENTATION; handing it voiceprints would spend
      // the match for an answer nobody reads, and this window's identities are already settled.
      clinicianCentroids: [],
      batchThreshold: DIARIZE_BATCH_THRESHOLD,
    });
    if (!res.ok) {
      console.warn("[jobs] local label run failed", JSON.stringify({ window: windowId, retryable: res.retryable }));
      return doneWith({ ...hybrid, local_label: "diarize_failed" });
    }
    const segments = parseDiarizeSegments(res.result.transcript_segments);
    await labelWindow({
      w, runId, engine: "local",
      model: localModelLabel(res.result.model_versions),
      providerJobId: null, segments,
      speakerCount: (res.result.speakers ?? []).length,
      audioSeconds: windowAudioSeconds(w),
    });
    return doneWith({ ...hybrid, local_label: "ok", local_spans: segments.length, local_speakers: (res.result.speakers ?? []).length });
  } catch (e) {
    console.warn("[jobs] local label step threw", JSON.stringify({ window: windowId, err: String(e).slice(0, 120) }));
    return doneWith({ ...hybrid, local_label: "threw" });
  }
}

/** Write a training label, never letting its failure reach the window. */
async function labelWindow(args: {
  w: WindowRow; runId: string; engine: DiarizeEngine; model: string | null; providerJobId: string | null;
  segments: ReadonlyArray<{ start_ms: number; end_ms: number; speaker_idx: number }>;
  speakerCount: number; audioSeconds: number | null;
}): Promise<void> {
  if (!teacherLabelsEnabled()) return;
  try {
    await writeWindowLabel({
      windowId: args.w.id, roomDayId: args.w.room_day_id, engine: args.engine, model: args.model,
      providerJobId: args.providerJobId, runId: args.runId, segments: args.segments,
      speakerCount: args.speakerCount, audioSeconds: args.audioSeconds,
    });
  } catch (e) {
    console.warn("[jobs] label write failed", JSON.stringify({ window: args.w.id, engine: args.engine, err: String(e).slice(0, 120) }));
  }
}

/**
 * Provenance with the fields this engine can actually fill, and nulls — never guesses — elsewhere.
 *
 * `attribution` IS REQUIRED, not defaulted. It began as `name === "local" ? "voiceprint" : "none"`
 * — asserted by construction — and ETA-Refuter showed that mutating it away killed nothing, because
 * the local arm had no test that it was earned. Giving it a default and always overriding it only
 * moves the problem: the default becomes unreachable code no mutation can be caught changing. So
 * there is no default. Every caller states what its window actually earned, and a caller that
 * forgets does not compile.
 */
function engineProvenance(
  name: DiarizeEngine,
  over: Partial<DiarizeEngineProvenance> & { attribution: "voiceprint" | "none"; skipped?: string; embed_error?: string; vad_trim?: Record<string, unknown> },
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

/** The local diarizer, as the chosen engine or as a fallback. Today's path, unchanged. */
async function localRun(args: {
  w: WindowRow;
  runId: string;
  speech: WindowSpeech | undefined;
  fallback: { from: DiarizeEngine; reason: string } | null;
  pyannoteJobId?: string;
  /** Already in hand when the same step fetched them. Re-fetched only across a step boundary. */
  audio?: Uint8Array;
}) {
  const { w, runId, speech, fallback } = args;
  const base = { windowId: w.id, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId };

  const bytes = args.audio ?? (await getObjectBytes(w.clip_r2_key));
  if (!bytes) {
    await recordDiarizeWindow({ ...base, state: "failed", error: `clip_missing:${w.clip_r2_key}`, speakers: null, segments: null, timing: null });
    return failWith(jobError("clip_missing_in_r2", w.clip_r2_key));
  }

  if (fallback) {
    console.warn("[jobs] diarize falling back to local", JSON.stringify({ window: w.id, from: fallback.from, reason: fallback.reason }));
  }

  // A fallback arriving from the POLL step crossed a step boundary, and the VAD's answer is not
  // carried across one. Ask again rather than hand `diarizeWindow` an absent answer: with the gate
  // ON, absent means "nobody asked", every segment lands `unjudged`, and the fallback row would
  // quietly differ from the row this same window would have produced had it gone local from the
  // start. The point of a fallback is that the window is not treated worse for having tried.
  const vad = speech ?? (speechGateEnabled() ? await fetchWindowSpeech(bytes, "audio/webm") : undefined);
  if (vad && !vad.ok) {
    console.warn("[jobs] speech gate: no VAD answer", JSON.stringify({ window: w.id, reason: vad.reason }));
  }

  const res = await diarizeWindow({
    windowId: w.id,
    roomDayId: w.room_day_id,
    window: { start: windowStart(w.start_ms), end: windowEnd(w.end_ms) },
    audio: bytes,
    runId,
    ...(vad ? { speech: vad } : {}),
    ...(fallback ? { fallback } : {}),
  });
  if (!res.ok) {
    console.error("[jobs] diarize failed", JSON.stringify({ window: w.id, err: String(res.error).slice(0, 200), retryable: res.retryable }));
    if (!res.retryable) {
      await recordDiarizeWindow({ ...base, state: "failed", error: res.error, speakers: null, segments: null, timing: res.timing });
    }
    return failWith(jobError(res.retryable ? "diarize_unavailable" : "diarize_failed"));
  }

  await labelWindow({
    w, runId, engine: "local",
    model: res.outcome.engine.model ?? null,
    providerJobId: null,
    segments: res.segments as ReadonlyArray<{ start_ms: number; end_ms: number; speaker_idx: number }>,
    speakerCount: res.speakers.length,
    audioSeconds: windowAudioSeconds(w),
  });

  return storeAndFinish({
    w,
    runId,
    out: res,
    extra: {
      engine: "local",
      ...(fallback ? { fell_back_from: fallback.from, fallback_reason: fallback.reason, fallbacks: 1 } : {}),
      ...(args.pyannoteJobId ? { pyannoteai_job_id: args.pyannoteJobId } : {}),
    },
  });
}

/** The write and the stale-segment repair, shared by both engines. */
async function storeAndFinish(args: {
  w: WindowRow;
  runId: string;
  out: Awaited<ReturnType<typeof finishDiarizeWindow>>;
  extra: Record<string, unknown>;
}) {
  const { w, runId, out, extra } = args;
  // UNCHANGED RULE: the state is decided by the SPEAKER LIST, exactly as it was before the second
  // engine arrived — not by the span count, and not by the outcome's `speakers` (which counts
  // roles, a different quantity that happens to agree today).
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
