/**
 * STT Engine Lab — offline fan-out (L1).
 *
 * For each submitted (or backfilled) encounter, run its canonical R2 audio
 * through every enabled + fanout_enabled engine that has an adapter and serves
 * the ASR tier, writing one transcription_run row per engine
 * (mode='batch', tier='asr') with latency + cost + error. Idempotent per
 * (encounter, engine). Never touches the doctor path; runs via after() on
 * submit and via the admin worker route for backfill/retries.
 */
import { sql } from "@/lib/db";
import { customAlphabet } from "nanoid";
import { getObjectBytes, headObject } from "@/lib/r2";
import { listEngines, adapterFor, type EngineRow } from "./registry";
import { scoreEncounter } from "./scoring";

const nano = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 12);
const runId = () => `trun_${nano()}`;

/** Enqueue a fan-out job for one encounter (no-op if a job already exists). */
export async function enqueueFanout(encounterId: string): Promise<void> {
  await sql`
    INSERT INTO stt_fanout_job (encounter_id, status)
    VALUES (${encounterId}, 'pending')
    ON CONFLICT (encounter_id) DO NOTHING
  `;
}

/** Enqueue every encounter that has audio and no job yet. Returns count enqueued. */
export async function enqueueBackfill(): Promise<number> {
  const r = (await sql`
    INSERT INTO stt_fanout_job (encounter_id, status)
    SELECT e.id, 'pending'
      FROM encounter e
     WHERE e.audio_object_key IS NOT NULL
    ON CONFLICT (encounter_id) DO NOTHING
    RETURNING encounter_id
  `) as Array<{ encounter_id: string }>;
  return r.length;
}

type EncRow = { id: string; audio_object_key: string | null; detected_language: string | null };

function asrEngines(engines: EngineRow[], allowPaid: boolean): EngineRow[] {
  return engines.filter((e) => {
    if (!e.enabled || !e.fanout_enabled) return false;
    if (!adapterFor(e.adapter_key)) return false;
    const caps = (e.capabilities_json ?? {}) as { tiers?: string[] };
    if (caps.tiers && !caps.tiers.includes("asr")) return false;
    if (!allowPaid && e.is_paid) return false;
    return true;
  });
}

export type FanoutResult = { encounter_id: string; inserted: number; skipped: number; errors: string[]; no_audio?: boolean };

/** Run all eligible engines on one encounter's audio (idempotent per engine). */
export async function runFanoutForEncounter(encounterId: string, opts?: { allowPaid?: boolean }): Promise<FanoutResult> {
  const allowPaid = opts?.allowPaid ?? true;
  const rows = (await sql`
    SELECT id, audio_object_key, detected_language FROM encounter WHERE id = ${encounterId} LIMIT 1
  `) as EncRow[];
  const enc = rows[0];
  if (!enc) return { encounter_id: encounterId, inserted: 0, skipped: 0, errors: ["encounter_not_found"] };
  if (!enc.audio_object_key) return { encounter_id: encounterId, inserted: 0, skipped: 0, errors: [], no_audio: true };

  const engines = asrEngines(await listEngines(), allowPaid);
  if (engines.length === 0) return { encounter_id: encounterId, inserted: 0, skipped: 0, errors: ["no_eligible_engines"] };

  // Which engines already have a batch run for this encounter? (idempotent)
  const existing = (await sql`
    SELECT engine FROM transcription_run
     WHERE encounter_id = ${encounterId} AND mode = 'batch' AND tier = 'asr' AND error IS NULL
  `) as Array<{ engine: string }>;
  const done = new Set(existing.map((r) => r.engine));
  const todo = engines.filter((e) => !done.has(e.id));
  if (todo.length === 0) return { encounter_id: encounterId, inserted: 0, skipped: engines.length, errors: [] };

  let bytes: Buffer | null = null;
  let contentType = "audio/webm";
  try {
    const head = await headObject(enc.audio_object_key);
    contentType = head.content_type || "audio/webm";
    const b = await getObjectBytes(enc.audio_object_key);
    if (b) bytes = Buffer.from(b);
  } catch (e) {
    return { encounter_id: encounterId, inserted: 0, skipped: 0, errors: [`audio_load_failed: ${String(e).slice(0, 100)}`] };
  }
  if (!bytes) return { encounter_id: encounterId, inserted: 0, skipped: 0, errors: ["audio_object_missing"] };

  // Drop any prior errored batch rows for the engines we are re-running (so a
  // retry replaces the failure rather than duplicating it).
  for (const e of todo) {
    await sql`DELETE FROM transcription_run WHERE encounter_id = ${encounterId} AND mode = 'batch' AND tier = 'asr' AND engine = ${e.id} AND error IS NOT NULL`;
  }

  const errors: string[] = [];
  let inserted = 0;
  const results = await Promise.all(todo.map(async (e) => {
    const adapter = adapterFor(e.adapter_key)!;
    try {
      const r = await adapter.transcribe(bytes as Buffer, { contentType, longForm: true });
      return { e, r };
    } catch (err) {
      return { e, r: { original: null, english: null, language: null, latencyMs: 0, costUsd: null, error: String(err).slice(0, 150) } };
    }
  }));

  for (const { e, r } of results) {
    if (r.error) errors.push(`${e.id}: ${r.error}`);
    try {
      await sql`
        INSERT INTO transcription_run
          (id, encounter_id, engine, stt_engine_id, mode, tier, detected_language,
           transcript_original, transcript_english, latency_ms, cost_usd, error, created_at)
        VALUES
          (${runId()}, ${encounterId}, ${e.id}, ${e.id}, 'batch', 'asr', ${r.language ?? enc.detected_language},
           ${r.original}, ${r.english}, ${r.latencyMs}, ${r.costUsd}, ${r.error}, NOW())
      `;
      inserted++;
    } catch (err) {
      errors.push(`${e.id}_insert: ${String(err).slice(0, 100)}`);
    }
  }
  // L2: reference-free scoring (agreement + LLM judge) over this encounter's runs.
  try { await scoreEncounter(encounterId); } catch (e) { errors.push(`score: ${String(e).slice(0, 80)}`); }

  return { encounter_id: encounterId, inserted, skipped: engines.length - todo.length, errors };
}

/** Today's batch spend (sum of known cost_usd). */
async function todaySpendUsd(): Promise<number> {
  const r = (await sql`
    SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spend
      FROM transcription_run
     WHERE mode = 'batch' AND created_at::date = (NOW() AT TIME ZONE 'UTC')::date
  `) as Array<{ spend: number }>;
  return r[0]?.spend ?? 0;
}

export type DrainResult = { processed: number; allowPaid: boolean; budgetUsd: number; spendUsd: number; jobs: FanoutResult[] };

/** Claim and process up to `limit` pending/failed jobs, respecting the daily budget. */
export async function drainFanout(limit = 5): Promise<DrainResult> {
  const cfg = (await sql`SELECT daily_budget_usd::float8 AS budget FROM stt_lab_config WHERE id = 1`) as Array<{ budget: number }>;
  const budgetUsd = cfg[0]?.budget ?? 5;
  const spendUsd = await todaySpendUsd();
  const allowPaid = spendUsd < budgetUsd;

  // Reclaim jobs left 'running' by a killed/timed-out worker call.
  await sql`UPDATE stt_fanout_job SET status = 'pending' WHERE status = 'running'`;

  const claim = (await sql`
    SELECT encounter_id FROM stt_fanout_job
     WHERE status IN ('pending', 'failed')
     ORDER BY enqueued_at ASC
     LIMIT ${limit}
  `) as Array<{ encounter_id: string }>;

  const jobs: FanoutResult[] = [];
  for (const j of claim) {
    await sql`UPDATE stt_fanout_job SET status = 'running', attempts = attempts + 1 WHERE encounter_id = ${j.encounter_id}`;
    try {
      const res = await runFanoutForEncounter(j.encounter_id, { allowPaid });
      jobs.push(res);
      const hardErr = res.errors.length > 0 && res.inserted === 0 && !res.no_audio;
      await sql`
        UPDATE stt_fanout_job
           SET status = ${hardErr ? "failed" : "done"}, completed_at = NOW(),
               error = ${res.errors.length ? res.errors.join("; ").slice(0, 300) : null}
         WHERE encounter_id = ${j.encounter_id}
      `;
    } catch (e) {
      await sql`UPDATE stt_fanout_job SET status = 'failed', error = ${String(e).slice(0, 300)} WHERE encounter_id = ${j.encounter_id}`;
      jobs.push({ encounter_id: j.encounter_id, inserted: 0, skipped: 0, errors: [String(e).slice(0, 150)] });
    }
  }
  return { processed: claim.length, allowPaid, budgetUsd, spendUsd, jobs };
}


export type FanoutStatus = {
  jobs: Record<string, number>;
  batch_runs: number;
  batch_ok: number;
  scored_runs: number;
  per_engine: Array<{ engine: string; runs: number; ok: number; avg_latency_ms: number | null; avg_judge: number | null; avg_agreement: number | null; wins: number }>;
};

/** Fast queue + batch-run summary (no processing). */
export async function fanoutStatus(): Promise<FanoutStatus> {
  const js = (await sql`SELECT status, COUNT(*)::int AS n FROM stt_fanout_job GROUP BY status`) as Array<{ status: string; n: number }>;
  const tot = (await sql`SELECT COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE error IS NULL)::int AS ok, COUNT(*) FILTER (WHERE agreement_score IS NOT NULL)::int AS scored FROM transcription_run WHERE mode='batch' AND tier='asr'`) as Array<{ runs: number; ok: number; scored: number }>;
  const pe = (await sql`
    SELECT engine, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE error IS NULL)::int AS ok,
           ROUND(AVG(latency_ms) FILTER (WHERE error IS NULL))::int AS avg_latency_ms,
           ROUND(AVG(judge_score)::numeric, 2)::float8 AS avg_judge,
           ROUND(AVG(agreement_score)::numeric, 3)::float8 AS avg_agreement,
           COUNT(*) FILTER (WHERE is_winner)::int AS wins
      FROM transcription_run WHERE mode='batch' AND tier='asr'
     GROUP BY engine ORDER BY engine
  `) as Array<{ engine: string; runs: number; ok: number; avg_latency_ms: number | null; avg_judge: number | null; avg_agreement: number | null; wins: number }>;
  const jobs: Record<string, number> = {};
  for (const r of js) jobs[r.status] = r.n;
  return { jobs, batch_runs: tot[0]?.runs ?? 0, batch_ok: tot[0]?.ok ?? 0, scored_runs: tot[0]?.scored ?? 0, per_engine: pe };
}


/** Reset every job to pending (idempotent re-run: successful engines are skipped). */
export async function resetAllJobs(): Promise<number> {
  const r = (await sql`UPDATE stt_fanout_job SET status = 'pending', error = NULL WHERE status <> 'pending' RETURNING encounter_id`) as Array<{ encounter_id: string }>;
  return r.length;
}
