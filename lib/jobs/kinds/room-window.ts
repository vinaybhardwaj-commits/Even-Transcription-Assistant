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
  ROUTER_JOB_LOST,
  type PhaseOutcome,
} from "@/lib/stt/room-drain";

const STEPS = { prepare: "prepare", segment: "segment", engine: "engine", poll: "poll", finish: "finish" } as const;

/** What one claim may spend polling the router before handing the row back to the queue. */
export const ROOM_POLL_BUDGET_MS = 150_000;
export const ROOM_POLL_INTERVAL_MS = 3_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A phase's failure becomes the job's failure, carrying the DrainStep as its detail — and, since
 * this morning's `cues_refused` (first attempt against https://evenscribe.app failed, the retry
 * against the cron's own deployment origin succeeded, and the row remembered only the phase name),
 * the phase's OWN detail too, so the actual reason is not unrecoverable from the row.
 *
 * THE PHASE STAYS WHERE IT WAS. `jobError`'s second argument becomes `<step>: <detail>` rather than
 * `<step>` alone, so the string still reads `room_window_failed: cues_refused...` — `errorCodeOf`
 * (lib/jobs/errors.ts) still finds `room_window_failed` as the leading code, and anything that reads
 * or matches on the phase immediately after the first colon is unaffected. An old row with a phase
 * and no detail is exactly what `o.detail` undefined already produces: `<step>` alone, unchanged.
 *
 * APPENDING THE DETAIL DOES NOT WIDEN WHO SEES IT. `read`-scope callers only ever get
 * `errorCodeOf(j.error)` — the leading code, full stop (lib/mcp/tools/jobs.ts's `jobView`). Only
 * `invoke`-scope callers see the raw `error` string at all, and they already saw the phase name;
 * this adds the detail to what they already had access to, not a new audience for it.
 */
export const failFromPhase = (o: PhaseOutcome) =>
  o.detail === ROUTER_JOB_LOST
    // Its own code, so a job list can tell "the router lost it" from every other engine failure at a glance.
    ? failWith(jobError("router_job_lost", `${o.step}: ${o.detail}`))
    : failWith(jobError("room_window_failed", o.detail ? `${o.step}: ${o.detail}` : o.step));

const actorOf = (ctx: StepContext) => ({
  actor: String(ctx.args.actor ?? ""),
  via: ctx.args.via as "mcp" | "admin_route" | "cron",
});

/**
 * A per-job choice must be the boolean `true` to count. Absent is false; a present value that is not a
 * boolean is REFUSED at submit rather than coerced, because one of these two args reaches a
 * cross-room override and a paid translation, and the string "false" must never be read as yes.
 */
function optionalBool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new JobArgsError(`${key} must be a boolean`);
  return v;
}

export const roomWindowKind: JobKind = {
  name: ROOM_WINDOW_KIND,
  first: STEPS.prepare,
  scope: "invoke",

  /**
   * `switch_override` NEEDS `write`, NOT JUST `invoke` (V's ruling, 21 Sep 2026, on the Reviewer's finding that any invoke
   * holder could otherwise make a job write an off room's live day for any window). `translate` stays at the kind's `invoke`:
   * it costs Mini time, it does not widen what may be written. Read on the PARSED args, where the flag exists only when it
   * was the boolean true (see parseArgs), so `switch_override:false` needs nothing.
   */
  scopeForArgs(args) {
    return args.switch_override === true ? { scope: "write", arg: "switch_override" } : null;
  },

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
    // Per-job choices (RoomWindowJobOptions in lib/stt/room-drain.ts), stored ONLY when true so a job
    // that asks for neither has exactly the args it always had — same shape, same row, same dedupe.
    const translate = optionalBool(o, "translate");
    const switch_override = optionalBool(o, "switch_override");
    return { window_id, origin, actor, via, ...(translate ? { translate: true } : {}), ...(switch_override ? { switch_override: true } : {}) };
  },

  async run(ctx: StepContext) {
    const windowId = String(ctx.args.window_id ?? "");
    const origin = String(ctx.args.origin ?? "");
    const who = actorOf(ctx);
    // Read from the persisted args at every step, so a job resumed after a lease expiry keeps its choices.
    const jobOpts = { translate: ctx.args.translate === true, switchOverride: ctx.args.switch_override === true };

    switch (ctx.step) {
      case STEPS.prepare: {
        const o = await roomWindowPrepare(windowId, who);
        if (!o.ok) return failFromPhase(o);
        return nextStep(STEPS.segment, { ...ctx.progress, ...(o.next_progress ?? {}) });
      }

      case STEPS.segment: {
        const o = await roomWindowSegment(windowId, origin, who, ctx.progress, jobOpts);
        if (!o.ok) return failFromPhase(o);
        const next = { ...(o.next_progress ?? ctx.progress) };
        // E11 — a SILENT window has nothing to route. Its silence and marker are already written, so
        // it skips `engine` entirely: no routed-engine call, and no paid engine reading 900 s of quiet.
        // This is a fact about the audio, not an engine branch.
        return nextStep(next.silent_window === true ? STEPS.finish : STEPS.engine, next);
      }

      case STEPS.engine: {
        const o = await roomWindowEngine(windowId, who, ctx.progress, jobOpts);
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
          silent_window: ctx.progress.silent_window === true,
        });
      }

      default:
        return failWith(jobError("unknown_step", ctx.step));
    }
  },
};
