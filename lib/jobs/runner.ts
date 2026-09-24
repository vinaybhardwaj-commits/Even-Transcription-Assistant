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
import { INVOCATION_BUDGET_MS, LEASE_MS, MAX_FAILURES, MAX_JOBS_PER_INVOCATION, MAX_STEP_MS, type JobRow } from "./types";
import { errorCodeOf, jobError } from "./errors";
import { randomUUID } from "node:crypto";
import { withPoolContext } from "@/lib/service-pool";
import type { StepOutcome } from "./types";

/**
 * PURE — REDUNDANCY-R1: carry which endpoint served each pooled service onto the job. `served_by` is what this
 * step's calls actually used, merged over what earlier steps recorded in `progress.served_by`: a `next` step
 * carries it in its progress, a `done` job stores it on its result. A step that pooled nothing, in a job
 * that never has, returns the outcome untouched (the no-env identity), and a `fail` is a string, left as is.
 */
export function withServedBy(
  outcome: StepOutcome,
  priorProgress: Record<string, unknown> | null | undefined,
  served: Record<string, string>,
): StepOutcome {
  const prior = priorProgress?.served_by;
  const priorMap = prior && typeof prior === "object" ? (prior as Record<string, string>) : null;
  if (Object.keys(served).length === 0 && !priorMap) return outcome;
  if (outcome.kind === "next") {
    const carried = outcome.progress?.served_by;
    const base = carried && typeof carried === "object" ? (carried as Record<string, string>) : priorMap ?? {};
    return { ...outcome, progress: { ...outcome.progress, served_by: { ...base, ...served } } };
  }
  if (outcome.kind === "done") {
    const own = outcome.result?.served_by;
    const base = { ...(priorMap ?? {}), ...(own && typeof own === "object" ? (own as Record<string, string>) : {}) };
    return { ...outcome, result: { ...outcome.result, served_by: { ...base, ...served } } };
  }
  return outcome;
}

export type StepReport = {
  job_id: string;
  kind: string;
  step: string | null;
  /** What the row now holds, when a step threw. */
  failures?: number;
  outcome: "advanced" | "done" | "failed" | "cancelled" | "failures_exceeded" | "unknown_kind" | "lease_lost";
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
/**
 * Fix-up 5 item 3 — `runner` is REQUIRED here too. It is the token every write matches on, so a
 * default would reintroduce the backdoor one caller at a time.
 */
export async function runOneStep(job: JobRow, runner: string): Promise<StepReport> {
  const started = Date.now();
  const base = { job_id: job.id, kind: job.kind, step: job.step };

  // The cap reads FAILURES, never attempts. A long job is claimed many times while succeeding.
  if (overFailureCap(job)) {
    // Report what actually happened: zero rows means the lease was lost and this runner wrote
    // nothing, which is `lease_lost`, not `failures_exceeded`. The verdict's "two reports lie
    // about writes they did not make" — the only place "no best-effort branch" was not literal.
    const rows = await failJob(job.id, jobError("failures_exceeded", `after ${job.failures} attempts at step ${job.step ?? "start"}`), runner);
    return { ...base, outcome: rows === 0 ? "lease_lost" : "failures_exceeded", ms: Date.now() - started };
  }

  const kind = KIND_BY_NAME.get(job.kind);
  if (!kind) {
    const rows = await failJob(job.id, jobError("unknown_kind", job.kind), runner);
    return { ...base, outcome: rows === 0 ? "lease_lost" : "unknown_kind", ms: Date.now() - started };
  }

  const step = job.step ?? kind.first;
  let outcome;
  try {
    const ctx = { job, step, args: job.args, progress: job.progress, runner };
    // REDUNDANCY-R1 — every step runs inside a pool context: bulk routing in, served_by out. With no pool
    // configured nothing is recorded and the outcome is returned exactly as the kind produced it.
    const bulk = kind.poolBulk ? await kind.poolBulk(ctx) : false;
    const pooled = await withPoolContext({ bulk }, () => kind.run(ctx));
    outcome = withServedBy(pooled.value, job.progress, pooled.served_by);
  } catch (e) {
    // A throwing step is a FAILURE, counted, not (yet) a failed job: the lease is released and the
    // next claim retries the same step, up to the cap. ONE statement both counts it and decides
    // whether that count is terminal, so the throw that ends a job is counted like any other —
    // the branch this replaces called failJob, which never incremented, and lost it.
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    // The PROSE goes to the server log. The ROW gets a code plus a short, code-shaped summary —
    // never the downstream body, which can echo the audio (Refuter (e)).
    console.error("[jobs] step threw", JSON.stringify({ job_id: job.id, kind: job.kind, step, err: msg }));
    const after = await recordFailure({
      id: job.id,
      step,
      progress: job.progress,
      error: jobError("step_threw", `${step} failed after ${job.failures + 1} attempts`),
      maxFailures: MAX_FAILURES,
      runner,
    });
    // Zero rows means the lease was lost while the step ran: abandon, write nothing else.
    if (after === null) return { ...base, step, outcome: "lease_lost", ms: Date.now() - started };
    return { ...base, step, outcome: "failed", ms: Date.now() - started, failures: after.failures };
  }

  // The cancel boundary. Re-read rather than trust the row we were handed.
  const current = await readJob(job.id);
  if (!current || current.status === "cancelled") {
    return { ...base, step, outcome: "cancelled", ms: Date.now() - started };
  }

  // EVERY write below returns rows-changed, and zero means the lease was lost while this step ran:
  // another runner legitimately reclaimed the row and is working it. There is no "best effort"
  // branch — a runner that no longer owns a job writes nothing further for it and says so.
  const lost = (rows: number): StepReport | null =>
    rows === 0
      ? (console.warn(
          "[jobs] lease lost mid-step; abandoning",
          JSON.stringify({ job_id: job.id, kind: job.kind, step, runner }),
        ),
        { ...base, step, outcome: "lease_lost" as const, ms: Date.now() - started })
      : null;

  if (outcome.kind === "done") {
    return lost(await finishJob(job.id, outcome.result, runner)) ?? { ...base, step, outcome: "done", ms: Date.now() - started };
  }
  if (outcome.kind === "fail") {
    return lost(await failJob(job.id, outcome.error, runner)) ?? { ...base, step, outcome: "failed", ms: Date.now() - started };
  }
  return lost(await saveStep(job.id, outcome.step, outcome.progress, runner)) ?? { ...base, step, outcome: "advanced", ms: Date.now() - started };
}

/**
 * One runner invocation — Fix-up 4 item 3, on the Refuter's (a).
 *
 * CLAIM ONE, RUN ONE, REPEAT. The old shape claimed three rows up front and then ran them in
 * sequence, which meant the third job's step began against a lease taken three steps ago:
 * `3 x MAX_STEP_MS` is 600 s against a 240 s lease, so by its own declared step budget the queue
 * could hand one job to two runners. A step now NEVER begins against a lease claimed before an
 * earlier step in the same invocation, because each claim happens immediately before its own step.
 *
 * Two budgets stop the loop: `MAX_JOBS_PER_INVOCATION`, and the wall clock. The clock matters more
 * — three steps at the full step budget would exceed the route ceiling, so the loop stops taking
 * new work once there is not room for another step, and the cron picks the rest up next minute.
 *
 * ONE RUNNER ID PER INVOCATION, generated here and passed down. Not per call and not per job: it
 * identifies the process holding the leases, which is exactly the thing that can die.
 */
export async function runClaimedBatch(
  maxJobs = MAX_JOBS_PER_INVOCATION,
  budgetMs = INVOCATION_BUDGET_MS,
  now: () => number = Date.now,
): Promise<{ runner: string; claimed: number; steps: StepReport[] }> {
  const runner = randomUUID();
  const deadline = now() + budgetMs;
  const steps: StepReport[] = [];
  let claimed = 0;

  for (let i = 0; i < maxJobs; i++) {
    // Room for another step? If not, stop taking work rather than start one we cannot finish.
    if (now() + MAX_STEP_MS > deadline && i > 0) break;

    const batch = await claimJobs(1, LEASE_MS, runner);
    const job = batch[0];
    if (!job) break; // queue empty
    claimed += 1;
    try {
      steps.push(await runOneStep(job, runner));
    } catch (e) {
      // runOneStep handles a throwing STEP; reaching here means persistence itself failed.
      console.error(
        "[jobs] step persistence failed",
        JSON.stringify({ job_id: job.id, runner, err: String((e as Error)?.message ?? e).slice(0, 200) }),
      );
      steps.push({ job_id: job.id, kind: job.kind, step: job.step, outcome: "failed", ms: 0 });
    }
  }
  return { runner, claimed, steps };
}

export { cancelJob };
