/**
 * lib/spine/jobs.ts — the spine job queue over spine_job (migration 0173). SHADOW: nothing here is called by a live flow.
 *
 * CLAIM is copied from lib/jobs/store.ts: one statement selects with FOR UPDATE SKIP LOCKED and stamps the lease, so two runners never take one row
 * and neither waits on the other. EVERY WRITE after the claim matches the lease owner (plain equality: a null owner matches nothing).
 * Attempts count at claim. A budget / shadow / release report gives that attempt back. A permanent error is final on attempt 1.
 * The dead transition is made by one owner-matched UPDATE, so the sink sees it once.
 */
import { sql } from "@/lib/db";
import { queueOpsAlert } from "@/lib/alerts/ops-alert";
import { readModes, type Mode } from "./config";
import { breakerOpen, LEASE_MS, MAX_ATTEMPTS, resolveOutcome, type Outcome } from "./retry";

export type SpineJob = { job_id: number; encounter_id: string; stage: string; cut_version: string; input_key: string; attempts: number; lease_until: string | null; consult_uid?: string | null };
/** What a done report may carry (S6): a REF to the artefact (box path relative to the store, never a body) and its sha256. Becomes one spine_artefact row, create-only. */
export type ArtefactReport = { engine: string; version: string; cfg8: string; store: "r2" | "neon" | "box"; status: "ok" | "empty" | "failed" | "skipped"; sha256: string; bucket?: string | null; object_key?: string | null };
export type DeadJob = { job_id: number; stage: string; encounter_id: string; error_code: string | null };

/** D13 sink: a pluggable notifier. The default does nothing. */
export type Notifier = { dead(job: DeadJob): Promise<unknown> };
export const stubNotifier: Notifier = { dead: async () => undefined };
/** D13: at most one alert per STAGE per 6 h (the stage is the "room" in the dedupe key). Kind heal_escalated is the only one room_alert_outbox_kind_chk lets through; the Mini relay will present it as a room heal escalation for a "room" named spine-<stage> (relay side unverified). No ubus client is built here. */
export const DEAD_ALERT_DEDUPE_MINUTES = 6 * 60;
export const opsAlertNotifier: Notifier = {
  dead: (j) => queueOpsAlert({ kind: "heal_escalated", room_id: `spine-${j.stage}`, room_slug: `spine-${j.stage}`, minutes: null, reason: `dead_${j.stage}`, dedupe_minutes: DEAD_ALERT_DEDUPE_MINUTES }),
};

const num = (v: unknown): number => Number(v);
const toJob = (r: Record<string, unknown>, withUid = false): SpineJob => ({
  job_id: num(r.job_id), encounter_id: String(r.encounter_id), stage: String(r.stage), cut_version: String(r.cut_version), input_key: String(r.input_key),
  attempts: num(r.attempts), lease_until: r.lease_until == null ? null : new Date(r.lease_until as string).toISOString(),
  ...(withUid ? { consult_uid: r.consult_uid == null ? null : String(r.consult_uid) } : {}),
});

/**
 * Idempotent on (encounter_id, stage, cut_version, input_key). Returns the job id, or null when the key already exists.
 * S6 N3: a key processed in SHADOW is spent for live (status `shadow` is terminal). `requeueShadow` (the caller found the stage live) puts that one row back to
 * `queued` with attempts 0 and returns its id; a row in any other status is never touched. Without the flag, enqueue reads the stage mode itself when the key already exists (F4) and re-queues a
 * `shadow` row when the stage is live now. `unblock` (F3: a consult_uid link appeared) re-queues a row held as `blocked` (queued, next_attempt_at infinity).
 */
export async function enqueue(
  j: { encounter_id: string; stage: string; cut_version: string; input_key: string; priority?: number; requeueShadow?: boolean; unblock?: boolean },
  modeOf: (stage: string) => Promise<Mode> = async (s) => (await readModes([s])).stages[s] ?? "off",
): Promise<number | null> {
  const put = async (requeueShadow: boolean): Promise<number | null> => {
    const rows = (await sql`
      INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status, priority)
      VALUES (${j.encounter_id}, ${j.stage}, ${j.cut_version}, ${j.input_key}, 'queued', ${j.priority ?? 0}::int)
      ON CONFLICT ON CONSTRAINT spine_job_key_uq DO UPDATE
         SET status = 'queued', attempts = 0, next_attempt_at = NULL, lease_owner = NULL, lease_until = NULL,
             last_error_class = NULL, last_error_code = NULL, done_at = NULL
       WHERE (${requeueShadow}::boolean AND spine_job.status = 'shadow')
          OR (${j.unblock === true}::boolean AND spine_job.status = 'queued' AND spine_job.next_attempt_at = 'infinity'::timestamptz)
      RETURNING job_id`) as Array<{ job_id: unknown }>;
    return rows[0] ? num(rows[0].job_id) : null;
  };
  const first = await put(j.requeueShadow === true);
  if (first !== null || j.requeueShadow === true) return first;
  // F4: the key exists. A row spent in shadow goes back to queued when the stage is live NOW (the mode is read only on this path).
  return (await modeOf(j.stage)) === "live" ? put(true) : null;
}

/** Leased rows whose lease ran out on the LAST allowed attempt can never be claimed again: they die here (once, by the UPDATE). */
export async function reapExhausted(now: Date, notifier: Notifier = stubNotifier): Promise<number> {
  const rows = (await sql`
    WITH upd AS (
      UPDATE spine_job
         SET status = 'dead', done_at = ${now.toISOString()}::timestamptz, lease_owner = NULL, lease_until = NULL, last_error_class = 'transient', last_error_code = 'lease_expired'
       WHERE status = 'leased' AND attempts >= ${MAX_ATTEMPTS}::int AND lease_until < ${now.toISOString()}::timestamptz
      RETURNING job_id, stage, encounter_id
    ), tick AS (
      INSERT INTO spine_tick (kind, ticked_at, counts) SELECT 'attempt:' || stage, ${now.toISOString()}::timestamptz, '{"failed":1}'::jsonb FROM upd
    )
    SELECT job_id, stage, encounter_id FROM upd`) as Array<Record<string, unknown>>;
  for (const r of rows) await notifier.dead({ job_id: num(r.job_id), stage: String(r.stage), encounter_id: String(r.encounter_id), error_code: "lease_expired" });
  return rows.length;
}

/** `stages` is what the caller found allowed (config + breaker); an empty list claims nothing. */
export async function claimJobs(owner: string, stages: string[], limit: number, now: Date, leaseMs = LEASE_MS, withUid = false): Promise<SpineJob[]> {
  if (!owner || stages.length === 0 || limit < 1) return [];
  const at = now.toISOString();
  const rows = (await sql`
    WITH claimable AS (
      SELECT job_id
        FROM spine_job
       WHERE stage = ANY(${stages}::text[])
         AND attempts < ${MAX_ATTEMPTS}::int
         AND ((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ${at}::timestamptz))
              OR (status = 'leased' AND lease_until < ${at}::timestamptz))
       ORDER BY priority DESC, created_at, job_id
       LIMIT ${limit}::int
       FOR UPDATE SKIP LOCKED
    )
    UPDATE spine_job j
       SET status      = 'leased',
           attempts    = j.attempts + 1,
           lease_owner = ${owner}::text,
           lease_until = ${at}::timestamptz + make_interval(secs => ${Math.round(leaseMs / 1000)}::int)
      FROM claimable c
     WHERE j.job_id = c.job_id
    RETURNING j.job_id, j.encounter_id, j.stage, j.cut_version, j.input_key, j.attempts, j.lease_until,
      CASE WHEN ${withUid}::boolean THEN (SELECT l.value FROM spine_link l WHERE l.encounter_id = j.encounter_id AND l.key_kind = 'consult_uid' AND l.active ORDER BY l.created_at DESC LIMIT 1) END AS consult_uid`) as Array<Record<string, unknown>>;
  return rows.map((r) => toJob(r, withUid));
}

export type ReportResult = { ok: true; status: string; artefact?: "recorded" | "existing" | "conflict" } | { ok: false; error: "lease_lost" };

/**
 * `modeOf` (S6 N3): when a job claimed by a would_run runner is reported `shadow` but its stage has since gone live, it is re-queued (as `release`), not consumed as shadow.
 * `artefact` (S6): only on `done`. Create-only on (encounter, stage, engine, version, cfg8, cut_version): the same sha is idempotent; a DIFFERENT sha never overwrites, and the job fails permanent `sha_conflict`.
 */
export async function reportJob(
  a: { job_id: number; owner: string; outcome: Outcome; error_code?: string | null; artefact?: ArtefactReport | null; now: Date; rng: () => number },
  notifier: Notifier = stubNotifier,
  modeOf?: (stage: string) => Promise<Mode>,
): Promise<ReportResult> {
  const cur = (await sql`
    SELECT stage, encounter_id, attempts, cut_version FROM spine_job
     WHERE job_id = ${a.job_id}::bigint AND lease_owner = ${a.owner}::text AND status = 'leased'`) as Array<Record<string, unknown>>;
  if (!cur[0]) return { ok: false, error: "lease_lost" };
  const attempts = num(cur[0].attempts);
  let outcome: Outcome = a.outcome;
  let errorCode = a.error_code ?? null;
  if (outcome === "shadow" && modeOf && (await modeOf(String(cur[0].stage))) === "live") outcome = "release";
  let artefact: "recorded" | "existing" | "conflict" | undefined;
  if (outcome === "done" && a.artefact) {
    artefact = await recordArtefact(String(cur[0].encounter_id), String(cur[0].stage), String(cur[0].cut_version), a.artefact);
    if (artefact === "conflict") { outcome = "permanent"; errorCode = "sha_conflict"; }
  }
  const r = resolveOutcome(outcome, attempts, a.now, a.rng());
  const code = outcome === "done" || outcome === "shadow" || outcome === "release" ? null : errorCode;   // blocked keeps its code (no_consult_uid)
  // Breaker bookkeeping (no schema change): one spine_tick row 'attempt:<stage>' per finished attempt, written in the SAME statement as the owner-matched
  // UPDATE, so a lost lease records nothing. done = failed 0; transient / permanent / dead = failed 1. budget, shadow, release and blocked give the attempt back: not recorded (blocked is no failure of the engine, F3).
  const recorded = outcome === "done" || outcome === "transient" || outcome === "permanent";
  const failedTick = outcome === "done" ? 0 : 1;
  const upd = (await sql`
    WITH u AS (
    UPDATE spine_job
       SET status = ${r.status}::text,
           next_attempt_at = CASE WHEN ${r.hold === true}::boolean THEN 'infinity'::timestamptz ELSE ${r.nextAttemptAt ? r.nextAttemptAt.toISOString() : null}::timestamptz END,
           attempts = greatest(attempts + ${r.attemptsDelta}::int, 0),
           last_error_class = ${r.errorClass}::text,
           last_error_code = ${code}::text,
           done_at = ${r.doneAt ? r.doneAt.toISOString() : null}::timestamptz,
           lease_owner = NULL, lease_until = NULL
     WHERE job_id = ${a.job_id}::bigint AND lease_owner = ${a.owner}::text AND status = 'leased' AND attempts = ${attempts}::int
    RETURNING job_id, stage
    ), tick AS (
      INSERT INTO spine_tick (kind, ticked_at, counts)
      SELECT 'attempt:' || stage, ${a.now.toISOString()}::timestamptz, jsonb_build_object('failed', ${failedTick}::int) FROM u WHERE ${recorded}::boolean
    )
    SELECT job_id FROM u`) as Array<unknown>;
  if (upd.length === 0) return { ok: false, error: "lease_lost" };
  if (r.status === "dead") await notifier.dead({ job_id: a.job_id, stage: String(cur[0].stage), encounter_id: String(cur[0].encounter_id), error_code: code });
  return artefact ? { ok: true, status: r.status, artefact } : { ok: true, status: r.status };
}

async function recordArtefact(encounter_id: string, stage: string, cut_version: string, x: ArtefactReport): Promise<"recorded" | "existing" | "conflict"> {
  const ins = (await sql`
    INSERT INTO spine_artefact (encounter_id, stage, engine, version, cfg8, cut_version, store, bucket, object_key, sha256, status)
    VALUES (${encounter_id}, ${stage}, ${x.engine}, ${x.version}, ${x.cfg8}, ${cut_version}, ${x.store}, ${x.bucket ?? null}, ${x.object_key ?? null}, ${x.sha256}, ${x.status})
    ON CONFLICT ON CONSTRAINT spine_artefact_key_uq DO NOTHING
    RETURNING id`) as Array<unknown>;
  if (ins.length > 0) return "recorded";
  const cur = (await sql`
    SELECT sha256 FROM spine_artefact
     WHERE encounter_id = ${encounter_id} AND stage = ${stage} AND engine = ${x.engine} AND version = ${x.version} AND cfg8 = ${x.cfg8} AND cut_version = ${cut_version}`) as Array<{ sha256: string | null }>;
  return cur[0]?.sha256 === x.sha256 ? "existing" : "conflict";
}

/** Stages whose breaker is open now: derived at read time from the last 20 recorded ATTEMPT outcomes per stage (spine_tick kind 'attempt:<stage>'). */
export async function openBreakers(stages: string[], now: Date): Promise<string[]> {
  const open: string[] = [];
  for (const s of stages) {
    const rows = (await sql`
      SELECT CASE WHEN counts->>'failed' = '1' THEN 'failed' ELSE 'done' END AS status, ticked_at AS done_at FROM spine_tick
       WHERE kind = ${"attempt:" + s}::text
       ORDER BY ticked_at DESC, id DESC LIMIT 20`) as Array<{ status: string; done_at: string }>;
    if (breakerOpen(rows, now)) open.push(s);
  }
  return open;
}
