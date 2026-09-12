/**
 * lib/jobs/runner.ts — Tier 2 §3. Claim, run ONE step, persist, release.
 *
 * The loop lives here and nowhere else. A kind author writes a step; this decides how many jobs to
 * take, how long to hold them, when to give up, and what a cancellation means. Keeping that in one
 * place is why a new kind cannot accidentally hold a lease open or run past the route ceiling.
 */

import { KIND_BY_NAME } from "./kinds";
import {
  cancelJob,
  claimJobs,
  failJob,
  finishJob,
  overFailureCap,
  recordFailure,
  readJob,
  saveStep,
} from "./store";
import { MAX_FAILURES, type JobRow } from "./types";

export type StepReport = {
  job_id: string;
  kind: string;
  step: string | null;
  /** What the row now holds, when a step threw. */
  failures?: number;
  outcome: "advanced" | "done" | "failed" | "cancelled" | "failures_exceeded" | "unknown_kind";
  ms: number;
};

/**
 * Run exactly one step of one already-claimed job.
 *
 * ORDER MATTERS AND IT IS DELIBERATE:
 *  1. The attempt cap is checked FIRST, before the kind runs. A job that has already burned its
 *     three attempts must not do the work a fourth time and then be failed — it is failed now.
 *  2. The kind runs.
 *  3. The row is RE-READ before anything is written. That is the cancel boundary (§3: "running
 *     honoured at the next step boundary"): a cancel that arrived while the step was in flight is
 *     seen here, and the step's outcome is discarded rather than overwriting `cancelled`.
 */
export async function runOneStep(job: JobRow): Promise<StepReport> {
  const started = Date.now();
  const base = { job_id: job.id, kind: job.kind, step: job.step };

  // The cap reads FAILURES, never attempts. A long job is claimed many times while succeeding.
  if (overFailureCap(job)) {
    await failJob(job.id, `failed after ${job.failures} attempts at step ${job.step ?? "start"}`);
    return { ...base, outcome: "failures_exceeded", ms: Date.now() - started };
  }

  const kind = KIND_BY_NAME.get(job.kind);
  if (!kind) {
    await failJob(job.id, `unknown kind "${job.kind}"`);
    return { ...base, outcome: "unknown_kind", ms: Date.now() - started };
  }

  const step = job.step ?? kind.first;
  let outcome;
  try {
    outcome = await kind.run({ job, step, args: job.args, progress: job.progress });
  } catch (e) {
    // A throwing step is a FAILURE, counted, not (yet) a failed job: the lease is released and the
    // next claim retries the same step, up to the cap. ONE statement both counts it and decides
    // whether that count is terminal, so the throw that ends a job is counted like any other —
    // the branch this replaces called failJob, which never incremented, and lost it.
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    const after = await recordFailure({
      id: job.id,
      step,
      progress: job.progress,
      error: `step ${step} failed after ${job.failures + 1} attempts: ${msg}`,
      maxFailures: MAX_FAILURES,
    });
    return { ...base, step, outcome: "failed", ms: Date.now() - started, ...(after ? { failures: after.failures } : {}) };
  }

  // The cancel boundary. Re-read rather than trust the row we were handed.
  const current = await readJob(job.id);
  if (!current || current.status === "cancelled") {
    return { ...base, step, outcome: "cancelled", ms: Date.now() - started };
  }

  if (outcome.kind === "done") {
    await finishJob(job.id, outcome.result);
    return { ...base, step, outcome: "done", ms: Date.now() - started };
  }
  if (outcome.kind === "fail") {
    await failJob(job.id, outcome.error);
    return { ...base, step, outcome: "failed", ms: Date.now() - started };
  }
  await saveStep(job.id, outcome.step, outcome.progress);
  return { ...base, step, outcome: "advanced", ms: Date.now() - started };
}

/** One runner invocation: claim a batch and advance each by one step. Never throws. */
export async function runClaimedBatch(limit?: number): Promise<{ claimed: number; steps: StepReport[] }> {
  const jobs = await claimJobs(limit);
  const steps: StepReport[] = [];
  for (const job of jobs) {
    try {
      steps.push(await runOneStep(job));
    } catch (e) {
      // runOneStep already handles a throwing STEP; reaching here means the persistence itself
      // failed. Say so and move on — one unwritable row must not stop the other two.
      console.error(
        "[jobs] step persistence failed",
        JSON.stringify({ job_id: job.id, err: String((e as Error)?.message ?? e).slice(0, 200) }),
      );
      steps.push({ job_id: job.id, kind: job.kind, step: job.step, outcome: "failed", ms: 0 });
    }
  }
  return { claimed: jobs.length, steps };
}

export { cancelJob };
