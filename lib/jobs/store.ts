/**
 * lib/jobs/store.ts — Tier 2 §3. Every statement that touches `scribe_job`, in one place.
 *
 * ALL SQL HERE IS INFERRED: this sandbox has no database, so each string below is written fail-safe
 * and reported verbatim in the build report for live validation.
 */

import { sql } from "@/lib/db";
import { customAlphabet } from "nanoid";
import { CLAIM_BATCH, LEASE_MS, MAX_ATTEMPTS, type JobRow, type JobStatus } from "./types";

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
    attempts: Number(r.attempts ?? 0),
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
              created_at, started_at, updated_at, finished_at, lease_until, attempts
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
export async function claimJobs(limit = CLAIM_BATCH, leaseMs = LEASE_MS): Promise<JobRow[]> {
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
           started_at  = COALESCE(j.started_at, now()),
           updated_at  = now()
      FROM claimable c
     WHERE j.id = c.id
    RETURNING j.id, j.kind, j.args, j.status, j.step, j.progress, j.result, j.error, j.actor,
              j.created_at, j.started_at, j.updated_at, j.finished_at, j.lease_until, j.attempts
  `) as Array<Record<string, unknown>>;
  return rows.map(normaliseJob);
}

/** A step finished and the machine continues. The lease is RELEASED: the next claim takes it. */
export async function saveStep(id: string, step: string, progress: Record<string, unknown>): Promise<void> {
  await sql`
    UPDATE scribe_job
       SET step        = ${step},
           progress    = ${JSON.stringify(progress)}::jsonb,
           lease_until = NULL,
           status      = 'running',
           updated_at  = now()
     WHERE id = ${id} AND status = 'running'
  `;
}

export async function finishJob(id: string, result: Record<string, unknown>): Promise<void> {
  await sql`
    UPDATE scribe_job
       SET status = 'done', result = ${JSON.stringify(result)}::jsonb,
           lease_until = NULL, finished_at = now(), updated_at = now()
     WHERE id = ${id}
  `;
}

export async function failJob(id: string, error: string): Promise<void> {
  await sql`
    UPDATE scribe_job
       SET status = 'failed', error = ${error.slice(0, 2000)},
           lease_until = NULL, finished_at = now(), updated_at = now()
     WHERE id = ${id}
  `;
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
              created_at, started_at, updated_at, finished_at, lease_until, attempts
  `) as Array<Record<string, unknown>>;
  return rows[0] ? normaliseJob(rows[0]) : null;
}

export async function listJobs(filter: { status?: JobStatus | null; kind?: string | null; limit: number }): Promise<JobRow[]> {
  const rows = (await sql`
    SELECT id, kind, args, status, step, progress, result, error, actor,
           created_at, started_at, updated_at, finished_at, lease_until, attempts
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
           created_at, started_at, updated_at, finished_at, lease_until, attempts
      FROM scribe_job
     WHERE id = ${id}
     LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows[0] ? normaliseJob(rows[0]) : null;
}

/** PURE — §3's bound. The claim that would be the fourth is refused, not run. */
export const overAttemptCap = (job: JobRow): boolean => job.attempts > MAX_ATTEMPTS;
