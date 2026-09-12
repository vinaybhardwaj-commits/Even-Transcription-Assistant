/**
 * lib/jobs/submit.ts — Tier 2 §3. Queue a job and kick the runner.
 *
 * SUBMIT MUST BE FAST (§3: an id in under two seconds), so it does exactly two things: validate the
 * args through the kind's own `parseArgs` and INSERT. It never touches R2, the Mini or the join
 * service — a submit that did real work would be the timeout problem again, wearing a job's name.
 *
 * THE KICK IS BEST-EFFORT, ALWAYS. `after()` runs the request's tail after the response is sent, so
 * a kick that fails cannot fail the submit; and if it never happens at all, the every-minute cron
 * picks the job up regardless. That is the whole reason there are two invocation paths.
 */

import { after } from "next/server";
import { KIND_BY_NAME, JOB_KIND_NAMES } from "./kinds";
import { insertJob, newJobId } from "./store";
import { JobArgsError, type JobRow } from "./types";

export class UnknownKindError extends Error {
  constructor(public kind: string) {
    super(`unknown kind "${kind}"`);
  }
}

/** Fire the runner without waiting for it. Never throws, never blocks the response. */
export function kickRunner(origin: string): void {
  const secret = process.env.JOBS_RUNNER_SECRET;
  if (!secret || !origin) return;
  try {
    after(async () => {
      try {
        await fetch(`${origin}/api/jobs/run`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(5_000),
        });
      } catch (e) {
        // The cron is the safety net; say it happened and move on.
        console.warn("[jobs] runner kick failed", JSON.stringify({ err: String((e as Error)?.message ?? e).slice(0, 160) }));
      }
    });
  } catch {
    /* `after` outside a request scope — the cron still covers it. */
  }
}

export async function submitJob(input: {
  kind: string;
  args: unknown;
  actor: string | null;
  origin?: string;
}): Promise<JobRow> {
  const kind = KIND_BY_NAME.get(input.kind);
  if (!kind) throw new UnknownKindError(input.kind);
  // Throws JobArgsError, which the tool turns into a refusal — a job that cannot run never queues.
  const args = kind.parseArgs(input.args);
  const job = await insertJob({ id: newJobId(), kind: kind.name, args, actor: input.actor });
  if (input.origin) kickRunner(input.origin);
  return job;
}

export { JobArgsError, JOB_KIND_NAMES };
