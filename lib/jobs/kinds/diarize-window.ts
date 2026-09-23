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
 *   pyannoteai      SUBMIT then POLL, because pyannote.ai's API is asynchronous. The submit hands
 *                   over a short-lived presigned R2 URL and gets a job id; the poll step waits
 *                   under its own budget and hands the row back to the queue rather than outlive
 *                   its lease. The shape is `route_transcribe`'s, deliberately — that kind solved
 *                   this exact problem and a second idiom for it would be a second set of bugs.
 *
 * ─── THE POLL STEP DOES NOT READ THE ENV ───────────────────────────────────────────────────────
 * It reads the engine and the job id out of `progress`. A submission is PAID FOR the moment it is
 * accepted, so the engine that made it is the engine that finishes it — even if `DIARIZE_ENGINE`
 * is changed, or rolled back, while the row is in flight. Reading the env in the poll step would
 * mean a rollback silently abandoned work already bought, and a row whose two halves came from two
 * engines.
 *
 * ─── FALLBACK ──────────────────────────────────────────────────────────────────────────────────
 * If pyannote.ai errors, times out, or returns no spans, the LOCAL diarizer runs for that window
 * and the row records that it fell back and from what. A fallback is never silent: `timing_json`
 * carries `engine.fallback_from` and `engine.fallback_reason` (a code, never a provider message),
 * and the job result counts it.
 */
import { randomUUID } from "node:crypto";
import { getObjectBytes, headObject, signGetUrl } from "@/lib/r2";
import { sql } from "@/lib/db";
import { DEFAULT_MIN_SPEECH_MS, fetchWindowSpeech, speechGateEnabled, type WindowSpeech } from "@/lib/stt/speech-gate";
import {
  diarizeWindow,
  finishDiarizeWindow,
  recordDiarizeWindow,
  repairStaleDiarizeSegments,
  speakersFromLabels,
  type DiarizeEngineProvenance,
} from "@/lib/stt/diarize-window";
import { diarizeEngine, type DiarizeEngine } from "@/lib/diarize-engine";
import { PRESIGN_TTL_SECONDS, fetchJobRecord, pollDiarize, submitDiarize } from "@/lib/diarize-pyannoteai";
import { windowStart, windowEnd } from "@/lib/stt/window-bounds";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext } from "../types";
import { jobError, type JobErrorCode } from "../errors";

export const DIARIZE_WINDOW_KIND = "diarize_window";

const STEPS = { diarize: "diarize", pyannotePoll: "pyannote_poll" } as const;

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

/** Window length from its own bounds — what we hand a paid engine, so cost is countable. */
export function windowAudioSeconds(w: { start_ms: number; end_ms: number }): number | null {
  const ms = w.end_ms - w.start_ms;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) / 1000 : null;
}

/**
 * THE COST GUARD, and the narrowest honest version of it.
 *
 * True only when the VAD gave a REAL ANSWER and that answer holds less than the speech gate's own
 * floor across the whole window. `ok: false` — either "we could not ask" or "we asked and it said
 * nothing" — NEVER skips: lib/stt/speech-gate.ts records that on this audio an empty VAD answer is
 * more often a VAD failure than a quiet room, and convicting a window of silence on evidence that
 * file says must not convict would buy a few cents by throwing away consultations.
 *
 * It uses DEFAULT_MIN_SPEECH_MS, the constant the local path's own gate judges segments by, rather
 * than a second threshold of its own.
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
 * the outcome a mistyped `DIARIZE_ENGINE` must have. The alternative, reading an unrecognised
 * value as "local", would leave an operator believing they had switched engines when they had not.
 */
async function diarizeStep(ctx: StepContext) {
  const windowId = String(ctx.args.window_id ?? "");
  const w = await loadWindow(windowId);
  if ("error" in w) return failWith(jobError(w.error, w.detail));

  const engine: DiarizeEngine = diarizeEngine();

  // ONE ID PER RUN, on every turn row and on the window row (0090). A successful re-run gets a new
  // one, so a reader that planned from the old turns can tell they were rewritten. On the two-step
  // path it is minted HERE and carried in progress, so both steps of one run share one id.
  const runId = randomUUID();

  const bytes = await getObjectBytes(w.clip_r2_key);
  if (!bytes) {
    await recordDiarizeWindow({
      windowId, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId,
      state: "failed", error: `clip_missing:${w.clip_r2_key}`, speakers: null, segments: null, timing: null,
    });
    return failWith(jobError("clip_missing_in_r2", w.clip_r2_key));
  }

  // THE SPEECH GATE'S ONE CALLER. `diarizeWindow` takes the VAD's answer rather than fetching it,
  // so it stays testable without a service — which means SOMEBODY has to fetch it, and this is the
  // only place holding the audio. Without this the flag would be inert: every segment `unjudged`.
  //
  // Only when the gate is on. Off, no VAD is called, nothing is paid for, and the row is the row
  // production writes today.
  const speech = speechGateEnabled() ? await fetchWindowSpeech(bytes, "audio/webm") : undefined;
  if (speech && !speech.ok) {
    // Named, not swallowed: a gate that silently judges nothing looks exactly like a gate that is
    // working, and the difference is the whole point of the flag being on.
    console.warn("[jobs] speech gate: no VAD answer", JSON.stringify({ window: windowId, reason: speech.reason }));
  }

  if (engine === "local") return localRun({ w, runId, speech, fallback: null, audio: bytes });

  // ── pyannote.ai ────────────────────────────────────────────────────────────────────────────
  const audioSeconds = windowAudioSeconds(w);

  if (vadSaysSilent(speech)) {
    // Not sent, not paid for, and SAID SO on the row: `skipped` distinguishes a window the engine
    // found empty from one the engine never saw.
    const provenance = engineProvenance("pyannoteai", { audio_seconds_sent: 0, skipped: "silent_window" });
    await recordDiarizeWindow({
      windowId, roomDayId: w.room_day_id, clipR2Key: w.clip_r2_key, runId,
      state: "no_speakers", error: null, speakers: [], segments: [], timing: { engine: provenance },
    });
    console.log("[jobs] diarize skipped, VAD found no speech", JSON.stringify({ window: windowId, audio_seconds: audioSeconds }));
    return doneWith({ window_id: windowId, engine: "pyannoteai", skipped: "silent_window", audio_seconds_sent: 0, spans: 0, speakers: 0 });
  }

  // Prove the object is there BEFORE minting a URL for it. A presigned URL to a missing key is a
  // 404 that pyannote.ai reports as its own failure, which sends the reader to the wrong service.
  const head = await headObject(w.clip_r2_key);
  if (!head || head.size === null) return failWith(jobError("clip_missing_in_r2"));

  let audioUrl: string;
  try {
    // READ-ONLY, ONE OBJECT, MINUTES. signGetUrl builds a GetObject signature for this key alone:
    // it grants no listing, no write, and nothing about any other key. It points at R2 — the audio
    // never goes near the Mini tunnel — and it is never logged, because for as long as it lives it
    // is a bearer credential for patient audio.
    audioUrl = await signGetUrl({ key: w.clip_r2_key, expiresInSeconds: PRESIGN_TTL_SECONDS });
  } catch (e) {
    console.error("[jobs] presign failed", JSON.stringify({ window: windowId, err: String(e).slice(0, 120) }));
    return localRun({ w, runId, speech, fallback: { from: "pyannoteai", reason: "presign_failed" }, audio: bytes });
  }

  const sub = await submitDiarize(audioUrl, { label: windowId });
  if (!sub.ok) return localRun({ w, runId, speech, fallback: { from: "pyannoteai", reason: sub.error }, audio: bytes });

  console.log("[jobs] pyannote.ai submitted", JSON.stringify({ window: windowId, job: sub.jobId, audio_seconds: audioSeconds }));
  // The id is persisted before anything else can fail. Every later claim polls it; none resubmits.
  return nextStep(STEPS.pyannotePoll, {
    ...ctx.progress,
    engine: "pyannoteai",
    pyannoteai_job_id: sub.jobId,
    run_id: runId,
    window_id: windowId,
    audio_seconds_sent: audioSeconds,
    // The VAD's answer is NOT carried across the step boundary: it is a span list, it would bloat
    // progress, and the local fallback re-fetches the clip anyway. A fallback run re-asks.
    submitted_at: new Date().toISOString(),
  });
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
      // service gets it, and the row says where it came from and why.
      return localRun({ w, runId, speech: undefined, fallback: { from: "pyannoteai", reason: st.error }, pyannoteJobId: jobId });
    }

    if (st.state === "done") {
      // The model is read back from the job's own record, never echoed from what we asked for.
      // `null` when the record cannot be found: an unknown model is recorded as unknown.
      const record = await fetchJobRecord(jobId);
      const speakers = speakersFromLabels(st.speakerLabels, st.segments);
      const provenance = engineProvenance("pyannoteai", {
        model: record?.model ?? null,
        job_id: jobId,
        audio_seconds_sent: audioSeconds,
      });
      const out = await finishDiarizeWindow(
        {
          windowId,
          roomDayId: w.room_day_id,
          window: { start: windowStart(w.start_ms), end: windowEnd(w.end_ms) },
          runId,
          // No embeddings come back from pyannote.ai, so the losing-score control has nothing to
          // recompute against. An empty list says that outright and skips a pointless query.
          centroids: [],
        },
        { speakers, rawSegments: st.segments, timing: { polls, provider_job_id: jobId }, latencyMs: null, provenance },
      );
      return storeAndFinish({ w, runId, out, extra: { engine: "pyannoteai", pyannoteai_job_id: jobId, polls, audio_seconds_sent: audioSeconds } });
    }

    if (Date.now() + interval >= deadline) {
      return nextStep(STEPS.pyannotePoll, { ...ctx.progress, polls_so_far: Number(ctx.progress.polls_so_far ?? 0) + polls });
    }
    await sleep(interval);
  }
}

/** Provenance with the fields this engine can actually fill, and nulls — never guesses — elsewhere. */
function engineProvenance(
  name: DiarizeEngine,
  over: Partial<DiarizeEngineProvenance> & { skipped?: string } = {},
): DiarizeEngineProvenance {
  return {
    name,
    model: null,
    job_id: null,
    // Only the local service matches enrolled voiceprints; pyannote.ai returns no embeddings, so a
    // pyannote.ai window's every turn is `no_match` because nothing tried, not because nobody won.
    attribution: name === "local" ? "voiceprint" : "none",
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
    // The service's message can describe the audio; the row gets a code. `retryable` means we
    // never reached it (no slot) — no state row, exactly as the pass did, so the window is
    // picked up again rather than recorded as a failure it did not have.
    console.error("[jobs] diarize failed", JSON.stringify({ window: w.id, err: String(res.error).slice(0, 200), retryable: res.retryable }));
    if (!res.retryable) {
      await recordDiarizeWindow({ ...base, state: "failed", error: res.error, speakers: null, segments: null, timing: res.timing });
    }
    return failWith(jobError(res.retryable ? "diarize_unavailable" : "diarize_failed"));
  }

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
  // E24 R10 — if the emotion job already recorded this window `diarize_stale`, this fresh run is the cure:
  // the named repair path accepts its segments for that window, and only that window — and only when this
  // run ended ok (E25 R13). Otherwise it changes nothing and the keep-rule above stands.
  const repaired = await repairStaleDiarizeSegments({
    windowId: w.id, runId, runState, speakers: out.speakers, segments: out.segments,
  });

  // Counts and ids only — the spans carry no text and neither does this.
  return doneWith({ window_id: w.id, ...out.outcome, ...extra, ...(repaired ? { stale_segments_repaired: true } : {}) });
}
