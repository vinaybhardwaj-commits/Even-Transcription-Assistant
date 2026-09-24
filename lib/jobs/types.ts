/**
 * lib/jobs/types.ts — Tier 2 §3. What a job is, and what a step machine must be.
 *
 * A KIND IS A STEP MACHINE, not a function. `run` is handed the job's args and the progress its
 * predecessor left, and returns EITHER the next step and the progress to carry, OR a result. It is
 * never handed a continuation and never loops: the runner owns the loop, one step per claim, so the
 * serverless ceiling belongs to the runner and not to the author of a kind.
 *
 * THE CONTRACT A STEP MUST KEEP:
 *  1. It finishes inside `MAX_STEP_MS` (~200 s), comfortably under the route's 300 s ceiling.
 *  2. It is RESUMABLE: everything the next step needs is in the returned `progress`, because the
 *     process running it may not exist a second later.
 *  3. It is IDEMPOTENT enough to be re-run. A runner killed after doing the work but before the
 *     write will be replayed from the same step, so a step that cannot tolerate that must make its
 *     own effect idempotent (a stable key, an upsert) rather than assume it runs once.
 *  4. It puts no audio and no transcript text in `progress`. Keys, counts and ids only.
 */

export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * §3, corrected by the Slice B Refuter — three FAILURES of repair, then stop.
 *
 * This used to bound on `attempts`, which counts CLAIMS. A healthy multi-step job raises attempts
 * once per step: a 61-minute stitch is one resolve plus three joins, so the fourth claim would have
 * been refused and the job failed while succeeding. The cap must count only steps that THREW.
 *
 * `failures` IS LIFETIME AND IS NEVER RESET (ruling, fix-up 3). A step that succeeds does not
 * forgive an earlier throw, so three flaky steps spread across a long job exhaust the budget just
 * as three consecutive ones do. That is deliberate: the counter bounds how much repair this job is
 * worth in total, not how much it is worth per step, and a job that has thrown three times has
 * earned a person's attention whether or not it limped forward in between. A caller who disagrees
 * re-submits, which mints a fresh row with a fresh count — and leaves the failed one on the record.
 */
export const MAX_FAILURES = 3;
/** §3 — the lease a claim takes. Longer than any step, shorter than a human's patience. */
export const LEASE_MS = 240_000;
/**
 * §3, corrected by the Refuter's (a) — the budget is JOBS PER INVOCATION, claimed ONE AT A TIME.
 *
 * It used to be a batch: claim three, then run them one after another. The arithmetic defeats the
 * lease — 3 x MAX_STEP_MS is 600 s against a 240 s lease — so by the time the third job's step
 * began, its lease had expired, another runner had legitimately claimed it, and both ran the same
 * step. Claiming one at a time means a lease is never older than one step when that step starts.
 */
export const MAX_JOBS_PER_INVOCATION = 3;

/**
 * The wall-clock an invocation may spend before it stops taking new work. Well under the route's
 * 300 s ceiling so the last step it starts can finish and persist.
 */
export const INVOCATION_BUDGET_MS = 240_000;
/**
 * What a step may spend. Not enforced by a timer here — it is the contract a kind is written to.
 *
 * INVARIANT, pinned by a test: `LEASE_MS > MAX_STEP_MS` with real margin. A step that may run for
 * longer than its own lease can have the row reclaimed underneath it while it works, which is how
 * the 600-s-vs-240-s batch shape produced two runners on one job. If either constant moves, the
 * test fails before the queue does.
 */
export const MAX_STEP_MS = 200_000;

/** The margin the invariant demands: a lease must outlast a step by at least this much. */
export const LEASE_MARGIN_MS = 30_000;

export type JobRow = {
  id: string;
  kind: string;
  args: Record<string, unknown>;
  status: JobStatus;
  step: string | null;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  actor: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  lease_until: string | null;
  /** Which runner invocation holds it. Every mutating write matches this. */
  lease_owner: string | null;
  /** Claims. Rises once per step on a healthy job — progress, not a retry budget. */
  attempts: number;
  /** Steps that threw. The cap reads this. */
  failures: number;
};

/** What one step returns. `next` continues the machine; `result` ends it; `fail` stops it for good. */
export type StepOutcome =
  | { kind: "next"; step: string; progress: Record<string, unknown> }
  | { kind: "done"; result: Record<string, unknown> }
  | { kind: "fail"; error: string };

export const nextStep = (step: string, progress: Record<string, unknown> = {}): StepOutcome => ({ kind: "next", step, progress });
export const doneWith = (result: Record<string, unknown>): StepOutcome => ({ kind: "done", result });
export const failWith = (error: string): StepOutcome => ({ kind: "fail", error });

export type StepContext = {
  job: JobRow;
  /** The runner invocation working this job — the token every write must carry. */
  runner?: string;
  /** The step the runner is executing — `job.step`, or the kind's `first` when the job is new. */
  step: string;
  args: Record<string, unknown>;
  progress: Record<string, unknown>;
  /** Cooperative cancellation: a kind doing work in pieces should check this between them. */
  signal?: AbortSignal;
};

export type JobKind = {
  name: string;
  /** The step a fresh job starts at. */
  first: string;
  /** Which MCP scope may submit this kind (§3: "scope per kind"). */
  scope: "read" | "invoke" | "write";
  /** PURE where it can be — validates and normalises args at SUBMIT, so a bad job never queues. */
  parseArgs: (raw: unknown) => Record<string, unknown>;
  /**
   * A scope that ONE ARGUMENT needs beyond the kind's own `scope` — for an argument that widens what the job may do
   * (V's ruling, 21 Sep 2026: `room_window`'s `switch_override` needs `write`, because it lets a job write a room whose own
   * Transcript switch is off). Called by `submitJob` on the PARSED args, so it sees exactly what would be stored and every
   * submit path meets it. Returns null when the args need nothing extra. It only ever ADDS a requirement: the kind's own
   * scope is still checked first, and a caller lacking the extra scope is refused with the same error a missing kind scope
   * gets, plus the name of the argument, so a refusal says which argument it was.
   */
  scopeForArgs?: (args: Record<string, unknown>) => { scope: "read" | "invoke" | "write"; arg: string } | null;
  run: (ctx: StepContext) => Promise<StepOutcome>;
  /**
   * REDUNDANCY-R1 — whether this step is BULK work, so pooled service calls inside it try the *_BULK_URLS
   * endpoints first. Absent = never bulk. Called by the runner once per step, inside the step's own error
   * handling, so a strict-env throw counts as a step failure like any other.
   */
  poolBulk?: (ctx: StepContext) => Promise<boolean>;
};

/** Thrown by `parseArgs`; the submit tool turns it into a refusal rather than a queued job. */
export class JobArgsError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}
