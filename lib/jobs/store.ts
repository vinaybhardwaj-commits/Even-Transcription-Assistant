/**
 * lib/jobs/store.ts — Tier 2 §3. Every statement that touches `scribe_job`, in one place.
 *
 * ALL SQL HERE IS INFERRED: this sandbox has no database, so each string below is written fail-safe
 * and reported verbatim in the build report for live validation.
 */

import { sql } from "@/lib/db";
import { customAlphabet } from "nanoid";
import { LEASE_MS, MAX_FAILURES, type JobRow, type JobStatus } from "./types";

const nano = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);
export const newJobId = (): string => `job_${nano()}`;

const asObject = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const p: unknown = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
};

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : null;

/** PURE — a row as the driver yields it, normalised. jsonb may arrive parsed or as text. */
export function normaliseJob(r: Record<string, unknown>): JobRow {
  return {
    id: String(r.id),
    kind: String(r.kind),
    args: asObject(r.args),
    status: String(r.status) as JobStatus,
    step: (r.step as string | null) ?? null,
    progress: asObject(r.progress),
    result: r.result === null || r.result === undefined ? null : asObject(r.result),
    error: (r.error as string | null) ?? null,
    actor: (r.actor as string | null) ?? null,
    created_at: iso(r.created_at) ?? "",
    started_at: iso(r.started_at),
    updated_at: iso(r.updated_at) ?? "",
    finished_at: iso(r.finished_at),
    lease_until: iso(r.lease_until),
    lease_owner: (r.lease_owner as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    failures: Number(r.failures ?? 0),
  };
}

export async function insertJob(input: {
  id: string;
  kind: string;
  args: Record<string, unknown>;
  actor: string | null;
}): Promise<JobRow> {
  const rows = (await sql`
    INSERT INTO scribe_job (id, kind, args, actor)
    VALUES (${input.id}, ${input.kind}, ${JSON.stringify(input.args)}::jsonb, ${input.actor})
    RETURNING id, kind, args, status, step, progress, result, error, actor,
              created_at, started_at, updated_at, finished_at, lease_until, lease_owner, attempts, failures
  `) as Array<Record<string, unknown>>;
  return normaliseJob(rows[0]!);
}

/**
 * §3 — CLAIM. The one statement the whole design rests on.
 *
 * `FOR UPDATE SKIP LOCKED` is why two runners on the same minute do not collide: each takes rows
 * the other has not locked and neither waits. Without SKIP LOCKED the second runner would BLOCK on
 * the first's rows and then run them again after it committed — the same step twice.
 *
 * A row is claimable when it is `queued`, or when it is `running` and NOT HELD — either the lease
 * expired (a runner died mid-step) or it is null (a step finished and released it). Both are the
 * same fact: nobody is working this row. An earlier version required `lease_until IS NOT NULL` on
 * the running branch, which made every job that successfully advanced a step unclaimable for ever —
 * caught by the resume test, which is exactly what that test is for.
 *
 * The UPDATE stamps a fresh lease and increments `attempts` in the same statement that selects the
 * rows, so there is no window in which a row is chosen but not yet held.
 */
export async function claimJobs(limit = 1, leaseMs = LEASE_MS, runner: string | null = null): Promise<JobRow[]> {
  const rows = (await sql`
    WITH claimable AS (
      SELECT id
        FROM scribe_job
       WHERE (status = 'queued'
              OR (status = 'running' AND (lease_until IS NULL OR lease_until < now())))
       ORDER BY created_at
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE scribe_job j
       SET status      = 'running',
           attempts    = j.attempts + 1,
           lease_until = now() + make_interval(secs => ${Math.round(leaseMs / 1000)}),
           lease_owner = ${runner},
           started_at  = COALESCE(j.started_at, now()),
           updated_at  = now()
      FROM claimable c
     WHERE j.id = c.id
    RETURNING j.id, j.kind, j.args, j.status, j.step, j.progress, j.result, j.error, j.actor,
              j.created_at, j.started_at, j.updated_at, j.finished_at, j.lease_until, j.lease_owner, j.attempts, j.failures
  `) as Array<Record<string, unknown>>;
  return rows.map(normaliseJob);
}

/** A step finished and the machine continues. The lease is RELEASED: the next claim takes it. */
/**
 * Fix-up 4 — EVERY MUTATING WRITE MATCHES THE LEASE OWNER, and returns how many rows it changed.
 *
 * `AND status = 'running'` proves the job is not terminal; it cannot prove the job is still MINE.
 * The Refuter's (c): with runner A's lease expired and runner B holding the row at a later step,
 * A's write matched — `running` was true — and B's live work was overwritten. The owner token is
 * what closes that, and it has to be on all four writes, because a stale runner reaching any one
 * of them is the same accident.
 *
 * Zero rows is not an error to swallow: it means the lease was lost, and the caller must abandon.
 */
export async function saveStep(id: string, step: string, progress: Record<string, unknown>, runner: string | null = null): Promise<number> {
  const rows = (await sql`
    UPDATE scribe_job
       SET step        = ${step},
           progress    = ${JSON.stringify(progress)}::jsonb,
           lease_until = NULL,
           lease_owner = NULL,
           status      = 'running',
           updated_at  = now()
     WHERE id = ${id} AND status = 'running' AND lease_owner IS NOT DISTINCT FROM ${runner}
    RETURNING id
  `) as Array<Record<string, unknown>>;
  return rows.length;
}

/**
 * §3, hardened by the Refuter — `AND status = 'running'` is the cancel boundary, in SQL.
 *
 * A cancel that lands while a step is in flight sets `cancelled`. Without this predicate the step's
 * own write would then set `done` over it and the cancel would be silently lost. With it, the write
 * matches no row and the cancel stands: the LAST WRITER DOES NOT WIN, the cancel does.
 */
export async function finishJob(id: string, result: Record<string, unknown>, runner: string | null = null): Promise<number> {
  const rows = (await sql`
    UPDATE scribe_job
       SET status = 'done', result = ${JSON.stringify(result)}::jsonb,
           lease_until = NULL, lease_owner = NULL, finished_at = now(), updated_at = now()
     WHERE id = ${id} AND status = 'running' AND lease_owner IS NOT DISTINCT FROM ${runner}
    RETURNING id
  `) as Array<Record<string, unknown>>;
  return rows.length;
}

/**
 * Fix-up 3 item 1 — `AND status = 'running'` is the guard, and it is the same one `finishJob` and
 * `saveStep` carry. A runner whose lease expired mid-step is still holding a `JobRow` it fetched
 * minutes ago; by the time it decides to fail the job, another runner may have reclaimed it (now
 * `running` again, at a later step) or a person may have cancelled it. Without this predicate that
 * stale runner could stamp `failed` over live work or over a cancel, and the LAST WRITER WOULD WIN.
 *
 * There is no per-runner lease TOKEN to match on — `lease_until` is a time, not an owner — so the
 * status guard is the strongest owner check available without a schema change. Flagged in the
 * report: a true owner match wants a `lease_owner` column, which is a migration this slice may not
 * write.
 */
export async function failJob(id: string, error: string, runner: string | null = null): Promise<number> {
  const rows = (await sql`
    UPDATE scribe_job
       SET status = 'failed', error = ${error.slice(0, 2000)},
           lease_until = NULL, lease_owner = NULL, finished_at = now(), updated_at = now()
     WHERE id = ${id} AND status = 'running' AND lease_owner IS NOT DISTINCT FROM ${runner}
    RETURNING id
  `) as Array<Record<string, unknown>>;
  return rows.length;
}

/**
 * §3 — cancel. Only `queued` or `running`, and a RUNNING job is honoured at the next step boundary:
 * the row is marked here, and `runOneStep` checks the status before it writes anything, so a step
 * already in flight finishes its work and then stops rather than being torn in half.
 */
export async function cancelJob(id: string): Promise<JobRow | null> {
  const rows = (await sql`
    UPDATE scribe_job
       SET status = 'cancelled', lease_until = NULL, finished_at = now(), updated_at = now()
     WHERE id = ${id} AND status IN ('queued', 'running')
    RETURNING id, kind, args, status, step, progress, result, error, actor,
              created_at, started_at, updated_at, finished_at, lease_until, lease_owner, attempts, failures
  `) as Array<Record<string, unknown>>;
  return rows[0] ? normaliseJob(rows[0]) : null;
}

export async function listJobs(filter: { status?: JobStatus | null; kind?: string | null; limit: number }): Promise<JobRow[]> {
  const rows = (await sql`
    SELECT id, kind, args, status, step, progress, result, error, actor,
           created_at, started_at, updated_at, finished_at, lease_until, lease_owner, attempts, failures
      FROM scribe_job
     WHERE (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null}::text)
       AND (${filter.kind ?? null}::text IS NULL OR kind = ${filter.kind ?? null}::text)
     ORDER BY created_at DESC
     LIMIT ${filter.limit}
  `) as Array<Record<string, unknown>>;
  return rows.map(normaliseJob);
}

export async function readJob(id: string): Promise<JobRow | null> {
  const rows = (await sql`
    SELECT id, kind, args, status, step, progress, result, error, actor,
           created_at, started_at, updated_at, finished_at, lease_until, lease_owner, attempts, failures
      FROM scribe_job
     WHERE id = ${id}
     LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows[0] ? normaliseJob(rows[0]) : null;
}

/**
 * PURE — §3's bound, on FAILURES. A job that has already thrown three times is failed rather than
 * run a fourth; a job that has merely been claimed many times is a long job and is left alone.
 */
export const overFailureCap = (job: JobRow): boolean => job.failures >= MAX_FAILURES;

/**
 * A step threw. Fix-up 3 item 2 — COUNT IT AND DECIDE TERMINALITY IN ONE STATEMENT.
 *
 * The bug this replaces: the runner branched on `job.failures + 1 >= cap` and, on the terminal
 * throw, called `failJob` — which sets `status` but never touches `failures`. So the third throw
 * was the one throw never counted and the row rested at `failures = 2, status = 'failed'`, which
 * reads as "it gave up early" rather than "it used its three".
 *
 * Incrementing first and then failing in a second statement would fix the count but open a window
 * where the row is `running` with a full failure count and another runner could claim it. So the
 * increment and the verdict are one UPDATE: `failures + 1` is computed once by Postgres and both
 * the new count and the resulting status are read off the same expression. Returns what the row
 * now holds, so the caller reports the truth rather than its own arithmetic.
 */
export async function recordFailure(input: {
  id: string;
  step: string;
  progress: Record<string, unknown>;
  error: string;
  maxFailures: number;
  runner?: string | null;
}): Promise<{ failures: number; status: JobStatus } | null> {
  const rows = (await sql`
    UPDATE scribe_job
       SET failures    = failures + 1,
           step        = ${input.step},
           progress    = ${JSON.stringify(input.progress)}::jsonb,
           lease_until = NULL,
           lease_owner = NULL,
           status      = CASE WHEN failures + 1 >= ${input.maxFailures} THEN 'failed' ELSE 'running' END,
           error       = CASE WHEN failures + 1 >= ${input.maxFailures} THEN ${input.error.slice(0, 2000)} ELSE error END,
           finished_at = CASE WHEN failures + 1 >= ${input.maxFailures} THEN now() ELSE finished_at END,
           updated_at  = now()
     WHERE id = ${input.id} AND status = 'running'
       AND lease_owner IS NOT DISTINCT FROM ${input.runner ?? null}
    RETURNING failures, status
  `) as Array<Record<string, unknown>>;
  const r = rows[0];
  return r ? { failures: Number(r.failures), status: String(r.status) as JobStatus } : null;
}
