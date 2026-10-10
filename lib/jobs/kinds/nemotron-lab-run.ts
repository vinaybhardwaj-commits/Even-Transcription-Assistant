/**
 * lib/jobs/kinds/nemotron-lab-run.ts — `nemotron_lab_run`: run the Nemotron diarizer on named audio with allow-listed overrides, on the BOX, for the lab.
 * LAB ONLY. The app cannot run NeMo, so this job does not compute anything: it QUEUES the work (nemotron_lab_run / nemotron_lab_item, 0143) and waits for the box worker
 * (tools/nemotron-worker) to claim it through /api/diarize/nemotron/lab/claim and answer through /lab/ingest. The result lands in nemotron_lab_item and nowhere else:
 * this file's SQL is lib/room-access/nemotron-lab-store.ts, which names no production diarize table.
 *
 * Steps:  prepare (write the run + items; a window input takes its clip key)  ->  cut (a span is joined into a clip by the same service transcribe_range uses)
 *         ->  wait (poll the items; hand the row back before the lease; fail `lab_timeout` once the run's 24 h deadline passes).
 *
 * The overrides are an ALLOW-LIST (lib/diarize-nemotron/lab.ts): enum presets, bounded numbers, a flat key: number post-processing block, a bounded list of enum-tagged
 * front-end steps. No shell, no path, no URL, no model name reaches the worker from here. The job result is ids and counts only.
 */
import { guardSessionSpan } from "@/lib/room-access/check";
import { clipKeyHeldOut, sessionRangeHeldOut, windowHeldOut } from "@/lib/room-access/jobs";
import { listBenchChunks } from "@/lib/bench";
import { resolveRange } from "@/lib/bench-range";
import { buildJoinRequest, callJoinService } from "@/lib/bench-join";
import { LabArgsError, NEMOTRON_LAB_ENABLED_ENV, nemotronLabEnabled, parseLabArgs, type LabInput, type LabSpec } from "@/lib/diarize-nemotron/lab";
import { failLabItem, insertLabRun, labItemSummaries, labProgress, setItemClip, spansToCut, unresolvedWindowItems } from "@/lib/room-access/nemotron-lab-store";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";
import { jobError } from "../errors";

export const NEMOTRON_LAB_RUN_KIND = "nemotron_lab_run";

const STEPS = { prepare: "prepare", cut: "cut", wait: "wait" } as const;
/** Poll every 15 s for up to 150 s per claim, then hand the row back (the lease is 240 s). */
export const LAB_POLL_INTERVAL_MS = 15_000;
export const LAB_POLL_BUDGET_MS = 150_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The args as stored: windows / r2_keys / spans in the caller's own vocabulary, plus the normalised overrides. Re-parsing them gives the same object. */
function storedArgs(inputs: LabInput[], spec: LabSpec): Record<string, unknown> {
  const windows = inputs.filter((x) => x.kind === "window").map((x) => (x as { window_id: string }).window_id);
  const r2Keys = inputs.filter((x) => x.kind === "r2_key").map((x) => (x as { r2_key: string }).r2_key);
  const spans = inputs.filter((x) => x.kind === "span").map((x) => {
    const s = x as Extract<LabInput, { kind: "span" }>;
    return { session_id: s.session_id, start: s.start_ms, end: s.end_ms, source: s.source };
  });
  return { ...(windows.length ? { windows } : {}), ...(r2Keys.length ? { r2_keys: r2Keys } : {}), ...(spans.length ? { spans } : {}), overrides: spec };
}

/** Inputs in a fixed order (windows, r2_keys, spans), so item idx is the same however the job is re-read. */
function inputsOf(args: Record<string, unknown>): LabInput[] {
  return parseLabArgs(args).inputs;
}

export const nemotronLabRunKind: JobKind = {
  name: NEMOTRON_LAB_RUN_KIND,
  first: STEPS.prepare,
  roomData: true,
  scope: "invoke",

  /** Every input is checked against the held-out rule at submit and at the first step; a refusal queues nothing. */
  async heldOut(args) {
    for (const x of inputsOf(args)) {
      let v: Awaited<ReturnType<typeof windowHeldOut>> = null;
      if (x.kind === "window") v = await windowHeldOut(x.window_id);
      else if (x.kind === "r2_key") v = await clipKeyHeldOut({ clip_key: x.r2_key });
      else v = await sessionRangeHeldOut({ session_id: x.session_id, start: x.start_ms, end: x.end_ms });
      if (v) return v;
    }
    return null;
  },

  parseArgs(raw) {
    try {
      const { inputs, spec } = parseLabArgs(raw);
      return storedArgs(inputs, spec);
    } catch (e) {
      if (e instanceof LabArgsError) throw new JobArgsError(e.message);
      throw e;
    }
  },

  /** The lane is off until NEMOTRON_LAB_ENABLED is set: a job nobody could run never queues. */
  async precheck() {
    if (!nemotronLabEnabled()) throw new JobArgsError(`lab_disabled: ${NEMOTRON_LAB_ENABLED_ENV} is off`);
  },

  async run(ctx: StepContext): Promise<StepOutcome> {
    const jobId = ctx.job.id;
    switch (ctx.step) {
      case STEPS.prepare: {
        const { inputs, spec } = parseLabArgs(ctx.args);
        await insertLabRun(jobId, spec, inputs, ctx.job.actor ?? null);
        const bad = await unresolvedWindowItems(jobId);
        if (bad.length) return failWith(jobError("lab_input_unresolved", `items ${bad.join(",")}`));
        return nextStep(STEPS.cut, { items: inputs.length });
      }

      case STEPS.cut: {
        const todo = await spansToCut(jobId);
        for (const s of todo) {
          // the span's session is checked again here, immediately before any chunk is listed or any audio moves (as transcribe_range does)
          if ((await guardSessionSpan(s.session_id, { startMs: s.start_ms, endMs: s.end_ms })) === "blind_room_day") return failWith(jobError("blind_room_day"));
          const chunks = await listBenchChunks(s.session_id);
          const r = resolveRange(chunks, s.start_ms, s.end_ms, s.source);
          const covering = r.kind === "single" ? [r.covering] : r.kind === "multi" ? r.covering : [];
          if (!covering.length) {
            await failLabItem(jobId, s.idx, "no_audio_in_range");
            continue;
          }
          const joined = await callJoinService(buildJoinRequest(s.session_id, covering as never, s.start_ms, s.end_ms, s.source));
          if (!joined.ok) {
            console.error("[nemotron-lab] join failed", JSON.stringify({ job: jobId, idx: s.idx, hop: joined.hop ?? null }));
            await failLabItem(jobId, s.idx, "lab_cut_failed");
            continue;
          }
          await setItemClip(jobId, s.idx, joined.key);
        }
        return nextStep(STEPS.wait, { items: ctx.progress.items ?? null });
      }

      case STEPS.wait: {
        const deadline = Date.now() + LAB_POLL_BUDGET_MS;
        for (;;) {
          const p = await labProgress(jobId);
          if (!p) return failWith(jobError("lab_input_unresolved", "run row missing"));
          if (p.queued === 0) {
            const items = await labItemSummaries(jobId);
            return doneWith({ run_id: jobId, total: p.total, ok: p.ok, empty: p.empty, failed: p.failed, items });
          }
          if (p.deadline_passed) return failWith(jobError("lab_timeout", `${p.queued} of ${p.total} items unfinished`));
          if (Date.now() + LAB_POLL_INTERVAL_MS >= deadline) return nextStep(STEPS.wait, { queued: p.queued, total: p.total });
          await sleep(LAB_POLL_INTERVAL_MS);
        }
      }

      default:
        return failWith(jobError("unknown_step", ctx.step));
    }
  },
};
