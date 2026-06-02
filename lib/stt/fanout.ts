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
import { scoreEncounter, scoreScribe, renderNoteText } from "./scoring";

const nano = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 12);
const runId = () => `trun_${nano()}`;

// Conservative placeholder rate for a PAID engine whose cost_per_min_usd hasn't
// been set by an admin yet, so its runs still accrue toward the daily budget
// instead of counting as free (which made the $5/day cap a no-op). Once the
// admin sets a real cost_per_min_usd, that exact value is used. Errs slightly
// high on purpose — the budget's job is to PAUSE runaway paid spend.
const DEFAULT_PAID_RATE_USD_PER_MIN = 0.02;

/** Best cost estimate for one run: the adapter's reported cost if any; else
 *  cost_per_min_usd × duration; else (paid, unpriced) a conservative default;
 *  free engines are 0. Returns a value so todaySpendUsd() can actually bind. */
function estimateCostUsd(engine: EngineRow, durationSeconds: number | null, adapterCostUsd: number | null): number | null {
  if (adapterCostUsd != null) return adapterCostUsd;
  if (!engine.is_paid) return 0;
  const rate = engine.cost_per_min_usd ?? DEFAULT_PAID_RATE_USD_PER_MIN;
  const mins = (durationSeconds ?? 0) / 60;
  return Number((rate * mins).toFixed(5));
}

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

type EncRow = { id: string; audio_object_key: string | null; detected_language: string | null; duration_seconds: number | null };

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
    SELECT id, audio_object_key, detected_language, duration_seconds FROM encounter WHERE id = ${encounterId} LIMIT 1
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
    const costUsd = estimateCostUsd(e, enc.duration_seconds, r.costUsd);
    try {
      await sql`
        INSERT INTO transcription_run
          (id, encounter_id, engine, stt_engine_id, mode, tier, detected_language,
           transcript_original, transcript_english, latency_ms, cost_usd, error, created_at)
        VALUES
          (${runId()}, ${encounterId}, ${e.id}, ${e.id}, 'batch', 'asr', ${r.language ?? enc.detected_language},
           ${r.original}, ${r.english}, ${r.latencyMs}, ${costUsd}, ${r.error}, NOW())
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

  // Reclaim ONLY jobs left 'running' by a killed/timed-out worker call — i.e.
  // claimed > 5 min ago (a worker call caps ~40s) or with no claim timestamp
  // (legacy rows). A still-in-flight job from a concurrent drain has a fresh
  // started_at and is left alone, so we don't yank a job another drain is
  // actively processing (the old blanket reset caused double-processing).
  await sql`
    UPDATE stt_fanout_job SET status = 'pending'
     WHERE status = 'running'
       AND (started_at IS NULL OR started_at < NOW() - INTERVAL '5 minutes')
  `;

  // Atomic claim: flip up to `limit` pending/failed jobs to 'running' in ONE
  // statement, locking the chosen rows with FOR UPDATE SKIP LOCKED so two
  // concurrent drains never grab the same encounter. RETURNING gives us exactly
  // the rows this call owns.
  const claim = (await sql`
    UPDATE stt_fanout_job SET status = 'running', attempts = attempts + 1, started_at = NOW()
     WHERE encounter_id IN (
       SELECT encounter_id FROM stt_fanout_job
        WHERE status IN ('pending', 'failed')
        ORDER BY enqueued_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING encounter_id
  `) as Array<{ encounter_id: string }>;

  const jobs: FanoutResult[] = [];
  for (const j of claim) {
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


/** Remove duplicate batch ASR rows (keep best per encounter+engine), then clear
 *  the scored_at marker on affected encounters so they re-score cleanly. */
export async function dedupRuns(): Promise<{ deleted: number; affected: number }> {
  const del = (await sql`
    WITH ranked AS (
      SELECT id, encounter_id,
             ROW_NUMBER() OVER (PARTITION BY encounter_id, engine, mode, tier
                                ORDER BY (error IS NULL) DESC, created_at DESC) AS rn
        FROM transcription_run WHERE mode='batch' AND tier='asr'
    )
    DELETE FROM transcription_run WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING encounter_id
  `) as Array<{ encounter_id: string }>;
  const affected = Array.from(new Set(del.map((r) => r.encounter_id)));
  if (affected.length > 0) {
    await sql`
      UPDATE transcription_run
         SET metrics_json = (COALESCE(metrics_json, '{}'::jsonb) - 'scored_at'),
             agreement_score = NULL, judge_score = NULL
       WHERE mode='batch' AND tier='asr' AND encounter_id = ANY(${affected})
    `;
  }
  return { deleted: del.length, affected: affected.length };
}


// ---- L7: scribe-tier fan-out (audio -> finished note) ----------------------

/** Run scribe-tier engines (ekascribe + the virtual even_pipeline) for one
 *  encounter, then rubric-score them vs the clinician note. */
export async function runScribeForEncounter(encounterId: string): Promise<{ encounter_id: string; inserted: number; errors: string[] }> {
  const rows = (await sql`
    SELECT id, audio_object_key, detected_language, duration_seconds, note_json
      FROM encounter WHERE id = ${encounterId} LIMIT 1
  `) as Array<{ id: string; audio_object_key: string | null; detected_language: string | null; duration_seconds: number | null; note_json: unknown }>;
  const enc = rows[0];
  if (!enc || !enc.note_json) return { encounter_id: encounterId, inserted: 0, errors: ["no_generated_note"] };

  const existing = (await sql`
    SELECT engine FROM transcription_run WHERE encounter_id = ${encounterId} AND tier = 'scribe' AND error IS NULL
  `) as Array<{ engine: string }>;
  const done = new Set(existing.map((r) => r.engine));

  const errors: string[] = [];
  let inserted = 0;

  // even_pipeline (virtual): the encounter's own generated note.
  if (!done.has("even_pipeline")) {
    try {
      await sql`
        INSERT INTO transcription_run
          (id, encounter_id, engine, stt_engine_id, mode, tier, note_text, note_json, latency_ms, error, created_at)
        VALUES (${runId()}, ${encounterId}, 'even_pipeline', 'even_pipeline', 'batch', 'scribe',
                ${renderNoteText(enc.note_json)}, ${JSON.stringify(enc.note_json)}::jsonb, 0, NULL, NOW())
      `;
      inserted++;
    } catch (e) { errors.push(`even_pipeline_insert: ${String(e).slice(0, 80)}`); }
  }

  // scribe engines with a generateNote() adapter (ekascribe).
  const engines = (await listEngines()).filter((e) => {
    if (!e.enabled || !e.fanout_enabled) return false;
    const caps = (e.capabilities_json ?? {}) as { tiers?: string[] };
    if (!caps.tiers || !caps.tiers.includes("scribe")) return false;
    const a = adapterFor(e.adapter_key);
    return !!a && typeof a.generateNote === "function";
  });
  const todo = engines.filter((e) => !done.has(e.id));
  if (todo.length > 0 && enc.audio_object_key) {
    let bytes: Buffer | null = null; let contentType = "audio/webm";
    try {
      const head = await headObject(enc.audio_object_key);
      contentType = head.content_type || "audio/webm";
      const b = await getObjectBytes(enc.audio_object_key);
      if (b) bytes = Buffer.from(b);
    } catch (e) { errors.push(`audio_load: ${String(e).slice(0, 80)}`); }
    if (bytes) {
      for (const e of todo) {
        await sql`DELETE FROM transcription_run WHERE encounter_id = ${encounterId} AND tier = 'scribe' AND engine = ${e.id} AND error IS NOT NULL`;
        const adapter = adapterFor(e.adapter_key)!;
        try {
          const r = await adapter.generateNote!(bytes, { contentType, language: enc.detected_language ?? undefined });
          const costUsd = estimateCostUsd(e, enc.duration_seconds, r.costUsd);
          await sql`
            INSERT INTO transcription_run
              (id, encounter_id, engine, stt_engine_id, mode, tier, note_text, note_json, latency_ms, cost_usd, error, created_at)
            VALUES (${runId()}, ${encounterId}, ${e.id}, ${e.id}, 'batch', 'scribe',
                    ${r.noteText}, ${r.note ? JSON.stringify(r.note) : null}::jsonb, ${r.latencyMs}, ${costUsd}, ${r.error}, NOW())
          `;
          inserted++;
          if (r.error) errors.push(`${e.id}: ${r.error}`);
        } catch (err) { errors.push(`${e.id}: ${String(err).slice(0, 80)}`); }
      }
    }
  }

  try { await scoreScribe(encounterId); } catch (e) { errors.push(`scribe_score: ${String(e).slice(0, 60)}`); }
  return { encounter_id: encounterId, inserted, errors };
}

/** Run scribe tier for up to `limit` encounters that have a generated note + audio but no scribe rows yet. */
export async function scribePending(limit = 3): Promise<{ processed: number; results: Array<{ encounter_id: string; inserted: number; errors: string[] }> }> {
  const encs = (await sql`
    SELECT e.id FROM encounter e
     WHERE e.note_json IS NOT NULL AND e.audio_object_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM transcription_run tr WHERE tr.encounter_id = e.id AND tr.tier = 'scribe' AND (tr.metrics_json ->> 'scored_at') IS NOT NULL)
     ORDER BY e.recorded_at DESC NULLS LAST
     LIMIT ${limit}
  `) as Array<{ id: string }>;
  const results = [];
  for (const e of encs) results.push(await runScribeForEncounter(e.id));
  return { processed: encs.length, results };
}
