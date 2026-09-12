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
 */
export const MAX_FAILURES = 3;
/** §3 — the lease a claim takes. Longer than any step, shorter than a human's patience. */
export const LEASE_MS = 240_000;
/** §3 — claims per runner invocation. Three steps of ~200 s never approach the route ceiling. */
export const CLAIM_BATCH = 3;
/** What a step may spend. Not enforced by a timer here — it is the contract a kind is written to. */
export const MAX_STEP_MS = 200_000;

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
  run: (ctx: StepContext) => Promise<StepOutcome>;
};

/** Thrown by `parseArgs`; the submit tool turns it into a refusal rather than a queued job. */
export class JobArgsError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}
