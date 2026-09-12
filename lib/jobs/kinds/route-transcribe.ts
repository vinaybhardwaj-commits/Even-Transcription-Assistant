/**
 * lib/jobs/kinds/route-transcribe.ts — Slice C1 step 2, the LONG transport.
 *
 * ─── WHY THIS IS A JOB AND NOT A LONGER TIMEOUT ────────────────────────────────────────────────
 * The router runs at roughly 1.3x realtime with translation off. A fifteen-minute room window is
 * therefore about twenty minutes of work — four times the drain route's entire 300 s ceiling and
 * five times a step's MAX_STEP_MS. No request budget in this system can hold it.
 *
 * The router's own async API is what makes that a non-problem: submit returns in ~93 ms with a
 * job_id, and each poll costs ~100 ms. So OUR step is never the long thing — it is a submit, or a
 * poll. `MAX_STEP_MS` stops constraining audio length entirely, which is the single reason the
 * spec says not to build our own windowing beyond 30 s. The router already windows internally
 * (180 s outer, Silero VAD inner with a 30 s / 1 s-overlap fallback), and it cuts on speech
 * boundaries where ours cuts on a clock — every clock cut is a transcription error at the seam.
 *
 * ─── THE POLL IS BOUNDED TWICE ─────────────────────────────────────────────────────────────────
 * Inside one step it polls under POLL_BUDGET_MS, well under MAX_STEP_MS, so a short job finishes in
 * the claim that submitted it. If the router is still working when that budget is spent, the step
 * returns ITSELF as the next step: the row goes back to the queue and the next claim carries on
 * polling. A twenty-minute job is then a handful of cheap claims, none of which is ever at risk of
 * outliving its lease.
 *
 * ─── IDEMPOTENCE, HONESTLY ─────────────────────────────────────────────────────────────────────
 * The router has no idempotency key: resubmitting the same audio mints a second job and does the
 * work twice. So `submit` runs ONCE and the id it returns is persisted in progress before anything
 * else can fail; every later claim polls that id and never resubmits. A step replayed after a crash
 * between the submit and the save WILL duplicate one job — bounded, reported, and the price of an
 * API with no dedupe. It is called out rather than papered over.
 */

import { signGetUrl } from "@/lib/r2";
import { headObject } from "@/lib/r2";
import { submitRouteJob, pollRouteJob } from "@/lib/stt/eta-router";
import { buildRouteMetrics, charsPerAudioSecond } from "@/lib/stt/route-run";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext } from "../types";
import { jobError } from "../errors";

const STEPS = { submit: "submit", poll: "poll" } as const;

/** What one claim may spend polling before handing the row back to the queue. Under MAX_STEP_MS. */
export const POLL_BUDGET_MS = 150_000;
/** Between polls. The router answers a poll in ~100 ms; this is about not hammering it. */
export const POLL_INTERVAL_MS = 3_000;

/**
 * Presigned-URL lifetime: twice the expected job duration, never under ten minutes.
 *
 * The expectation is 1.3x realtime measured with translation OFF; translation adds a serialised
 * Ollama call per non-English span, so the multiplier below is deliberately more pessimistic than
 * the measurement. A URL that expires mid-job is a job that fails after doing most of the work.
 */
export const TTL_FLOOR_S = 600;
export const REALTIME_MULTIPLIER = 3;
export function presignTtlSeconds(durationMs: number | null): number {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return TTL_FLOOR_S;
  return Math.max(TTL_FLOOR_S, Math.ceil((durationMs / 1000) * REALTIME_MULTIPLIER * 2));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const routeTranscribeKind: JobKind = {
  name: "route_transcribe",
  first: STEPS.submit,
  scope: "invoke",

  parseArgs(raw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const clip_key = typeof o.clip_key === "string" ? o.clip_key.trim() : "";
    if (!clip_key) throw new JobArgsError("clip_key is required");
    const duration_ms = typeof o.duration_ms === "number" && Number.isFinite(o.duration_ms) ? o.duration_ms : null;
    return {
      clip_key,
      ...(duration_ms !== null ? { duration_ms } : {}),
      // Translation is OFF by default and that is a cost decision: every non-English span becomes a
      // serialised Ollama call, roughly tripling the job. The native transcript is what the
      // tripwires measure.
      translate: o.translate === true,
      ...(typeof o.candidates === "string" && o.candidates.trim() ? { candidates: o.candidates.trim().slice(0, 80) } : {}),
    };
  },

  async run(ctx: StepContext) {
    switch (ctx.step) {
      case STEPS.submit: return submitStep(ctx);
      case STEPS.poll: return pollStep(ctx);
      default: return failWith(jobError("unknown_step", ctx.step));
    }
  },
};

/** Step 1 — presign the object and hand the router its URL. Fast: ~93 ms of router time. */
async function submitStep(ctx: StepContext) {
  const { clip_key, translate, candidates } = ctx.args as { clip_key: string; translate: boolean; candidates?: string };
  const durationMs = typeof ctx.args.duration_ms === "number" ? (ctx.args.duration_ms as number) : null;

  // Prove the object is there BEFORE minting a URL for it. A presigned URL to a missing key is a
  // 404 the router reports as its own failure, which sends the reader to the wrong service.
  const head = await headObject(clip_key);
  if (!head || head.size === null) return failWith(jobError("clip_missing_in_r2"));

  let audioUrl: string;
  try {
    // READ-ONLY, ONE OBJECT, SHORT-LIVED. signGetUrl builds a GetObject signature for this key
    // alone; it grants no listing, no write, and nothing about any other key.
    audioUrl = await signGetUrl({ key: clip_key, expiresInSeconds: presignTtlSeconds(durationMs) });
  } catch (e) {
    console.error("[jobs] presign failed", JSON.stringify({ key: clip_key, err: String(e).slice(0, 120) }));
    return failWith(jobError("presign_failed"));
  }

  const sub = await submitRouteJob(audioUrl, { translate, ...(candidates ? { candidates } : {}) });
  // Branch on `ok`, never on status.
  if (!sub.ok || !sub.job_id) {
    console.error("[jobs] route submit failed", JSON.stringify({ err: String(sub.error ?? "unknown").slice(0, 200) }));
    return failWith(jobError("route_submit_failed"));
  }

  // The id is persisted before anything else can fail. Every later claim polls it; none resubmits.
  return nextStep(STEPS.poll, {
    ...ctx.progress,
    router_job_id: sub.job_id,
    clip_key,
    audio_seconds: durationMs !== null ? Math.round(durationMs / 100) / 10 : null,
    submitted_at: new Date().toISOString(),
  });
}

/** Step 2 — poll under a budget; hand the row back to the queue rather than outlive the lease. */
async function pollStep(ctx: StepContext) {
  const jobId = String(ctx.progress.router_job_id ?? "");
  if (!jobId) return failWith(jobError("progress_incomplete", "router job id"));
  const audioSeconds = typeof ctx.progress.audio_seconds === "number" ? (ctx.progress.audio_seconds as number) : null;

  const deadline = Date.now() + POLL_BUDGET_MS;
  let polls = 0;
  for (;;) {
    const st = await pollRouteJob(jobId);
    polls += 1;

    // A router job vanishes after its TTL (3600 s). Say so with its own code: "unknown job" and
    // "the job failed" send a reader to different places.
    if (!st.ok && /unknown job/i.test(String(st.error ?? ""))) return failWith(jobError("route_job_unknown"));

    if (st.state === "failed" || (st.ok === false && st.state === undefined)) {
      // The router's error is a truncated repr of whatever threw and can quote the audio's own
      // filename or contents. It goes to the log; the row gets the code alone.
      console.error("[jobs] route job failed", JSON.stringify({ job: jobId, err: String(st.error ?? "unknown").slice(0, 200) }));
      return failWith(jobError("route_job_failed"));
    }

    if (st.state === "done") {
      const native = typeof st.transcript_native === "string" ? st.transcript_native : "";
      const english = typeof st.transcript_english === "string" ? st.transcript_english : "";
      const chars = native.length || english.length;
      const metrics = buildRouteMetrics(st.language_timeline, {
        router_sec: typeof st.sec === "number" ? st.sec : null,
        dominant_language: st.dominant_language ?? null,
        translated: english.length > 0,
      });
      const timeline = metrics.language_timeline as { span_count: number; engine_mix: Record<string, number>; language_mix: Record<string, number>; chars: number };

      // POINTERS AND COUNTS ONLY — no transcript text in the result, exactly as Slice B's rule
      // requires, and no text in progress at any point either.
      return doneWith({
        router_job_id: jobId,
        clip_key: ctx.progress.clip_key ?? null,
        chars,
        span_count: timeline.span_count,
        engine_mix: timeline.engine_mix,
        language_mix: timeline.language_mix,
        dominant_language: st.dominant_language ?? null,
        chars_per_audio_second: charsPerAudioSecond(chars, audioSeconds),
        // `empty_transcript` on the whisper path is a FACT ABOUT THE ROOM, not a failure, and the
        // same reasoning holds here: a quiet window read correctly is a success with zero chars.
        silent_window: chars === 0,
        polls,
        router_sec: typeof st.sec === "number" ? st.sec : null,
      });
    }

    // queued | running — keep going until the budget is spent, then hand it back.
    if (Date.now() + POLL_INTERVAL_MS >= deadline) {
      return nextStep(STEPS.poll, {
        ...ctx.progress,
        polls_so_far: Number(ctx.progress.polls_so_far ?? 0) + polls,
        last_state: st.state ?? "unknown",
        last_progress: st.progress ?? null,
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
