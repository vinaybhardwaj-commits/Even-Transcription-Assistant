/**
 * lib/jobs/kinds/room-window.ts — C1b. The room window, as a step machine.
 *
 * ONE PATH FOR EVERY ENGINE. whisper, sarvam and route all walk prepare → segment → engine →
 * [poll] → finish. `poll` is not an engine branch: it is entered only when the engine step says it
 * started something asynchronous, which it decides from the adapter's declared `capabilities.async`
 * and never from an engine name. A synchronous engine writes its run in `engine` and goes straight
 * to `finish`; whisper at ~0.2x realtime finishes a 900 s window inside its first engine step.
 *
 * Two control flows chosen by engine identity is precisely the shape that produced the
 * silent-window defect, where the sync path handled a case the job path had silently dropped. One
 * path means a case handled anywhere is handled everywhere.
 */
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext } from "../types";
import { jobError } from "../errors";
import { ROOM_WINDOW_KIND } from "./room-window-kind";
import {
  roomWindowPrepare, roomWindowSegment, roomWindowEngine, roomWindowPoll, roomWindowFinish,
  type PhaseOutcome,
} from "@/lib/stt/room-drain";

const STEPS = { prepare: "prepare", segment: "segment", engine: "engine", poll: "poll", finish: "finish" } as const;

/** What one claim may spend polling the router before handing the row back to the queue. */
export const ROOM_POLL_BUDGET_MS = 150_000;
export const ROOM_POLL_INTERVAL_MS = 3_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A phase's failure becomes the job's failure, carrying the DrainStep as its detail.
 *
 * The detail is safe by construction: `DrainStep` is a closed union of our own names, so nothing a
 * service said about the audio can reach the row through it.
 */
const failFromPhase = (o: PhaseOutcome) => failWith(jobError("room_window_failed", o.step));

const actorOf = (ctx: StepContext) => ({
  actor: String(ctx.args.actor ?? ""),
  via: ctx.args.via as "mcp" | "admin_route" | "cron",
});

export const roomWindowKind: JobKind = {
  name: ROOM_WINDOW_KIND,
  first: STEPS.prepare,
  scope: "invoke",

  parseArgs(raw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const window_id = typeof o.window_id === "string" ? o.window_id.trim() : "";
    if (!window_id) throw new JobArgsError("window_id is required");
    const origin = typeof o.origin === "string" ? o.origin.trim() : "";
    if (!origin) throw new JobArgsError("origin is required");
    const actor = typeof o.actor === "string" ? o.actor.trim() : "";
    if (!actor) throw new JobArgsError("actor is required");
    const via = o.via === "mcp" || o.via === "admin_route" || o.via === "cron" ? o.via : null;
    if (!via) throw new JobArgsError("via must be mcp, admin_route or cron");
    return { window_id, origin, actor, via };
  },

  async run(ctx: StepContext) {
    const windowId = String(ctx.args.window_id ?? "");
    const origin = String(ctx.args.origin ?? "");
    const who = actorOf(ctx);

    switch (ctx.step) {
      case STEPS.prepare: {
        const o = await roomWindowPrepare(windowId, who);
        if (!o.ok) return failFromPhase(o);
        return nextStep(STEPS.segment, { ...ctx.progress, ...(o.next_progress ?? {}) });
      }

      case STEPS.segment: {
        const o = await roomWindowSegment(windowId, origin, who, ctx.progress);
        if (!o.ok) return failFromPhase(o);
        return nextStep(STEPS.engine, { ...(o.next_progress ?? ctx.progress) });
      }

      case STEPS.engine: {
        const o = await roomWindowEngine(windowId, who, ctx.progress);
        if (!o.ok) return failFromPhase(o);
        const next = o.next_progress ?? ctx.progress;
        // `done_engine` is the SYNCHRONOUS transport reporting that the run is already written.
        // Anything else started something we must wait on.
        return nextStep(next.done_engine === true ? STEPS.finish : STEPS.poll, next);
      }

      case STEPS.poll: {
        const deadline = Date.now() + ROOM_POLL_BUDGET_MS;
        let progress = ctx.progress;
        for (;;) {
          const o = await roomWindowPoll(windowId, who, progress);
          if (!o.ok) return failFromPhase(o);
          progress = o.next_progress ?? progress;
          if (!o.still_running) return nextStep(STEPS.finish, progress);
          // Still working. Hand the row back rather than outlive the lease; the next claim polls
          // the SAME router job id, which is already on the row.
          if (Date.now() + ROOM_POLL_INTERVAL_MS >= deadline) return nextStep(STEPS.poll, progress);
          await sleep(ROOM_POLL_INTERVAL_MS);
        }
      }

      case STEPS.finish: {
        const o = await roomWindowFinish(windowId, who, ctx.progress);
        if (!o.ok) return failFromPhase(o);
        return doneWith({
          window_id: windowId,
          run_id: o.run_id ?? null,
          engine: ctx.progress.engine_key ?? null,
          shadow_run_id: ctx.progress.shadow_run_id ?? null,
          segment_count: ctx.progress.segment_count ?? null,
          audio_seconds: ctx.progress.audio_seconds ?? null,
        });
      }

      default:
        return failWith(jobError("unknown_step", ctx.step));
    }
  },
};
