/**
 * lib/room-access/nemotron-lab-store.ts — the ONLY writer of nemotron_lab_run and nemotron_lab_item (migration 0143). LAB ONLY.
 *
 * Nothing here names room_diarize_window, room_turn_speaker or diarize_nemotron_window: a lab result lands in nemotron_lab_item and
 * nowhere else (tests/unit/nemotron-lab-pg.test.ts proves it by row counts). The only room table read is bench_window, for a window
 * input's clip key.
 *
 * Neon HTTP: one statement per call, tagged template, every value bound, CAST where it lands in a select list. Concurrency is
 * settled INSIDE single statements: a claim is one UPDATE over rows locked FOR UPDATE SKIP LOCKED; an ingest is one UPDATE whose
 * WHERE holds the worker's live lease.
 */
import { sql } from "@/lib/db";
import { LAB_DEADLINE_HOURS, LAB_ITEM_MAX_ATTEMPTS, specHash, type LabIngestBody, type LabInput, type LabSpec } from "@/lib/diarize-nemotron/lab";

/** How long a claim is the worker's alone (same as the production claim). */
export const LAB_LEASE_MINUTES = 15;
/** Codes after which another attempt cannot help. */
export const LAB_TERMINAL_CODES: ReadonlySet<string> = new Set(["decode_failed", "bad_spec", "frontend_failed", "embedder_unavailable"]);

export type LabItemState = "queued" | "ok" | "empty" | "failed";

type ItemSeed = { idx: number; source_kind: string; window_id: string | null; input_r2_key: string | null; span: unknown; clip_r2_key: string | null };

const seedOf = (inputs: readonly LabInput[]): ItemSeed[] =>
  inputs.map((x, idx) => ({
    idx,
    source_kind: x.kind,
    window_id: x.kind === "window" ? x.window_id : null,
    input_r2_key: x.kind === "r2_key" ? x.r2_key : null,
    span: x.kind === "span" ? { session_id: x.session_id, start_ms: x.start_ms, end_ms: x.end_ms, source: x.source } : null,
    clip_r2_key: x.kind === "r2_key" ? x.r2_key : null,
  }));

/**
 * Create the run and its items for a job. Idempotent on the job id (a replayed step inserts nothing new). A window input takes its
 * clip key from bench_window in the same statement; one with no clip stays NULL and `unresolvedWindowItems` reports it.
 */
export async function insertLabRun(jobId: string, spec: LabSpec, inputs: readonly LabInput[], actor: string | null): Promise<void> {
  await sql`
    WITH run AS (
      INSERT INTO nemotron_lab_run (job_id, spec, spec_hash, n_items, actor, deadline_at)
      VALUES (${jobId}::text, ${JSON.stringify(spec)}::jsonb, ${specHash(spec)}::text, ${inputs.length}::int, ${actor}::text,
              now() + make_interval(hours => ${LAB_DEADLINE_HOURS}::int))
      ON CONFLICT (job_id) DO NOTHING
      RETURNING job_id
    )
    INSERT INTO nemotron_lab_item (run_id, idx, source_kind, window_id, input_r2_key, span, clip_r2_key)
    SELECT ${jobId}::text, (e->>'idx')::int, e->>'source_kind', e->>'window_id', e->>'input_r2_key', e->'span',
           COALESCE(e->>'clip_r2_key', (SELECT w.clip_r2_key FROM bench_window w WHERE w.id = e->>'window_id'))
      FROM jsonb_array_elements(${JSON.stringify(seedOf(inputs))}::jsonb) e
    ON CONFLICT (run_id, idx) DO NOTHING
  `;
}

/** idx of window items whose window has no clip (or does not exist). */
export async function unresolvedWindowItems(jobId: string): Promise<number[]> {
  const rows = (await sql`
    SELECT idx FROM nemotron_lab_item WHERE run_id = ${jobId} AND source_kind = 'window' AND clip_r2_key IS NULL ORDER BY idx
  `) as Array<{ idx: number }>;
  return rows.map((r) => Number(r.idx));
}

export type SpanToCut = { idx: number; session_id: string; start_ms: number; end_ms: number; source: "primary" | "backup" };

/** Span items still waiting for their clip. */
export async function spansToCut(jobId: string): Promise<SpanToCut[]> {
  const rows = (await sql`
    SELECT idx, span FROM nemotron_lab_item WHERE run_id = ${jobId} AND source_kind = 'span' AND clip_r2_key IS NULL ORDER BY idx
  `) as Array<{ idx: number; span: { session_id: string; start_ms: number; end_ms: number; source: "primary" | "backup" } }>;
  return rows.map((r) => ({ idx: Number(r.idx), ...r.span }));
}

export async function setItemClip(jobId: string, idx: number, clipKey: string): Promise<void> {
  await sql`UPDATE nemotron_lab_item SET clip_r2_key = ${clipKey} WHERE run_id = ${jobId} AND idx = ${idx} AND clip_r2_key IS NULL`;
}

/** Items that can never finish (a cut that failed): recorded as failed rows so the run can end. */
export async function failLabItem(jobId: string, idx: number, code: string): Promise<void> {
  await sql`
    UPDATE nemotron_lab_item SET state = 'failed', error_code = ${code}, received_at = now()
     WHERE run_id = ${jobId} AND idx = ${idx} AND state = 'queued'
  `;
}

export type LabProgress = { total: number; queued: number; ok: number; empty: number; failed: number; deadline_passed: boolean };

export async function labProgress(jobId: string): Promise<LabProgress | null> {
  const rows = (await sql`
    SELECT r.n_items::int AS total,
           count(*) FILTER (WHERE i.state = 'queued')::int AS queued,
           count(*) FILTER (WHERE i.state = 'ok')::int AS ok,
           count(*) FILTER (WHERE i.state = 'empty')::int AS empty,
           count(*) FILTER (WHERE i.state = 'failed')::int AS failed,
           (r.deadline_at < now()) AS deadline_passed
      FROM nemotron_lab_run r LEFT JOIN nemotron_lab_item i ON i.run_id = r.job_id
     WHERE r.job_id = ${jobId}
     GROUP BY r.n_items, r.deadline_at
  `) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return { total: Number(r.total), queued: Number(r.queued), ok: Number(r.ok), empty: Number(r.empty), failed: Number(r.failed), deadline_passed: r.deadline_passed === true };
}

export type ClaimedLabItem = { run_id: string; idx: number; clip_r2_key: string; attempt: number; spec: LabSpec; spec_hash: string };

/**
 * Claim up to `limit` lab items for `workerId` (oldest run first). An item is offered when it has a clip, is still `queued`, its run
 * has not passed its deadline, and its lease is absent or expired with attempts left. Two workers racing: SKIP LOCKED hands each a
 * different row, and the UPDATE re-checks the lease.
 */
export async function claimLabItems(workerId: string, limit: number): Promise<ClaimedLabItem[]> {
  const rows = (await sql`
    WITH cand AS (
      SELECT i.run_id, i.idx
        FROM nemotron_lab_item i JOIN nemotron_lab_run r ON r.job_id = i.run_id
       WHERE i.state = 'queued' AND i.clip_r2_key IS NOT NULL AND r.deadline_at > now()
         AND (i.lease_until IS NULL OR i.lease_until < now()) AND i.attempts < ${LAB_ITEM_MAX_ATTEMPTS}::int
       ORDER BY r.created_at ASC, i.idx ASC
       LIMIT ${limit}::int
       FOR UPDATE OF i SKIP LOCKED
    ), upd AS (
      UPDATE nemotron_lab_item i
         SET worker_id = ${workerId}::text, claimed_at = now(), lease_until = now() + make_interval(mins => ${LAB_LEASE_MINUTES}::int), attempts = i.attempts + 1
        FROM cand
       WHERE i.run_id = cand.run_id AND i.idx = cand.idx AND i.state = 'queued' AND (i.lease_until IS NULL OR i.lease_until < now())
      RETURNING i.run_id, i.idx, i.clip_r2_key, i.attempts
    )
    SELECT upd.run_id, upd.idx, upd.clip_r2_key, upd.attempts, r.spec, r.spec_hash
      FROM upd JOIN nemotron_lab_run r ON r.job_id = upd.run_id
     ORDER BY r.created_at ASC, upd.idx ASC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    run_id: String(r.run_id),
    idx: Number(r.idx),
    clip_r2_key: String(r.clip_r2_key),
    attempt: Number(r.attempts),
    spec: r.spec as LabSpec,
    spec_hash: String(r.spec_hash),
  }));
}

/** Give a claim back without burning the attempt (a signing outage). */
export async function releaseLabClaim(workerId: string, runId: string, idx: number): Promise<void> {
  await sql`
    UPDATE nemotron_lab_item SET lease_until = now(), attempts = GREATEST(attempts - 1, 0)
     WHERE run_id = ${runId} AND idx = ${idx} AND worker_id = ${workerId} AND state = 'queued' AND lease_until > now()
  `;
}

export type LabItemForIngest = { spec: LabSpec; spec_hash: string; state: LabItemState };

export async function readLabItemForIngest(runId: string, idx: number): Promise<LabItemForIngest | null> {
  const rows = (await sql`
    SELECT r.spec, r.spec_hash, i.state FROM nemotron_lab_item i JOIN nemotron_lab_run r ON r.job_id = i.run_id
     WHERE i.run_id = ${runId} AND i.idx = ${idx} LIMIT 1
  `) as Array<{ spec: LabSpec; spec_hash: string; state: LabItemState }>;
  return rows[0] ? { spec: rows[0].spec, spec_hash: rows[0].spec_hash, state: rows[0].state } : null;
}

export type LabIngestOutcome =
  | { result: "stored"; state: LabItemState }
  | { result: "failure_recorded"; attempts: number }
  | { result: "unknown_item" }
  | { result: "spec_mismatch" }
  | { result: "already_done" }
  | { result: "no_live_claim" };

/**
 * Record the worker's answer for a claimed item. ok / empty store the result; a failure is recorded on the item and the lease
 * released so the item is offered again, until a terminal code or the last attempt makes it `failed`. The worker must hold the live lease.
 */
export async function recordLabIngest(b: LabIngestBody, d: { speaker_count: number; turn_count: number; speech_ms: number; overlap_ms: number }): Promise<LabIngestOutcome> {
  const item = await readLabItemForIngest(b.run_id, b.idx);
  if (!item) return { result: "unknown_item" };
  if (item.spec_hash !== b.spec_hash) return { result: "spec_mismatch" };
  if (item.state !== "queued") return { result: "already_done" };

  if (b.status !== "failed") {
    const rows = (await sql`
      UPDATE nemotron_lab_item
         SET state = ${b.status}::text, error_code = NULL, model = ${b.model}::text, model_rev = ${b.model_rev}::text, config = ${JSON.stringify(b.config)}::jsonb,
             audio_ms = ${b.audio_ms}::int, clip_sha256 = ${b.clip_sha256}::text, turns_json = ${JSON.stringify(b.turns)}::jsonb,
             speaker_count = ${d.speaker_count}::int, turn_count = ${d.turn_count}::int, speech_ms = ${d.speech_ms}::int, overlap_ms = ${d.overlap_ms}::int,
             probs_r2_key = ${b.probs_r2_key}::text, embeddings_r2_key = ${b.embeddings_r2_key}::text, embeddings_dims = ${b.embeddings_dims}::int,
             infer_s = ${b.infer_s}::real, received_at = now(), lease_until = now()
       WHERE run_id = ${b.run_id} AND idx = ${b.idx} AND worker_id = ${b.worker_id} AND state = 'queued' AND lease_until > now()
      RETURNING state
    `) as Array<{ state: LabItemState }>;
    return rows[0] ? { result: "stored", state: rows[0].state } : { result: "no_live_claim" };
  }

  const code = b.error_code!;
  const terminal = LAB_TERMINAL_CODES.has(code);
  const rows = (await sql`
    UPDATE nemotron_lab_item
       SET last_error_code = ${code}::text,
           failure_history = failure_history || jsonb_build_array(jsonb_build_object('at', now(), 'worker_id', ${b.worker_id}::text, 'error_code', ${code}::text)),
           state = CASE WHEN ${terminal}::boolean OR attempts >= ${LAB_ITEM_MAX_ATTEMPTS}::int THEN 'failed' ELSE 'queued' END,
           error_code = CASE WHEN ${terminal}::boolean OR attempts >= ${LAB_ITEM_MAX_ATTEMPTS}::int THEN ${code}::text ELSE NULL END,
           model = ${b.model}::text, model_rev = ${b.model_rev}::text, audio_ms = ${b.audio_ms}::int, clip_sha256 = ${b.clip_sha256}::text,
           received_at = CASE WHEN ${terminal}::boolean OR attempts >= ${LAB_ITEM_MAX_ATTEMPTS}::int THEN now() ELSE received_at END,
           lease_until = now()
     WHERE run_id = ${b.run_id} AND idx = ${b.idx} AND worker_id = ${b.worker_id} AND state = 'queued' AND lease_until > now()
    RETURNING state, attempts
  `) as Array<{ state: LabItemState; attempts: number }>;
  if (!rows[0]) return { result: "no_live_claim" };
  return rows[0].state === "failed" ? { result: "stored", state: "failed" } : { result: "failure_recorded", attempts: Number(rows[0].attempts) };
}

/** What the job's result carries: ids and counts only. */
export async function labItemSummaries(jobId: string): Promise<Array<{ idx: number; state: string; error_code: string | null; audio_ms: number | null; speaker_count: number; turn_count: number; has_probs: boolean; has_embeddings: boolean }>> {
  const rows = (await sql`
    SELECT idx, state, error_code, audio_ms, speaker_count, turn_count, (probs_r2_key IS NOT NULL) AS has_probs, (embeddings_r2_key IS NOT NULL) AS has_embeddings
      FROM nemotron_lab_item WHERE run_id = ${jobId} ORDER BY idx
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    idx: Number(r.idx), state: String(r.state), error_code: (r.error_code as string | null) ?? null, audio_ms: r.audio_ms === null ? null : Number(r.audio_ms),
    speaker_count: Number(r.speaker_count), turn_count: Number(r.turn_count), has_probs: r.has_probs === true, has_embeddings: r.has_embeddings === true,
  }));
}
