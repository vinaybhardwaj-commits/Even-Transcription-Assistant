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

// The conservative rate for a PAID engine nobody has priced. This module had it right first —
// `is_paid` for the fact, this rate for the number — while the paid guard derived "paid" from the
// price and read every unpriced engine as free. The constant now lives in lib/stt/paid-engines.ts
// and is imported here, so the two can never disagree about NULL again.
import { DEFAULT_PAID_RATE_USD_PER_MIN } from "./paid-engines";
import { guardedTranscribe } from "./guarded-transcribe";

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
/**
 * K4a Part B — the queue is stt_subject_job now.
 *
 * stt_fanout_job is LEFT IN PLACE AND UNUSED, not dropped: it is the way back if this move
 * misbehaves. Retire it only once a FULL encounter fan-out has been observed running end to
 * end on the new table in production (0061 says the same, next to the table).
 *
 * The exported names are unchanged on purpose — `enqueueFanout` is called from two places on
 * the doctor path and this build has no business editing those call sites to rename a
 * function.
 */
export async function enqueueFanout(encounterId: string, tier = "asr"): Promise<void> {
  await enqueueSubject("encounter", encounterId, tier);
}

/** The general form. K4b will call this with ('bench_window', windowId). */
export async function enqueueSubject(subjectType: string, subjectId: string, tier = "asr"): Promise<void> {
  await sql`
    INSERT INTO stt_subject_job (subject_type, subject_id, tier, state)
    VALUES (${subjectType}, ${subjectId}, ${tier}, 'queued')
    ON CONFLICT (subject_type, subject_id, tier) DO NOTHING
  `;
}

/** Enqueue every encounter that has audio and no job yet. Returns count enqueued. */
export async function enqueueBackfill(): Promise<number> {
  const r = (await sql`
    INSERT INTO stt_subject_job (subject_type, subject_id, tier, state)
    SELECT 'encounter', e.id, 'asr', 'queued'
      FROM encounter e
     WHERE e.audio_object_key IS NOT NULL
    ON CONFLICT (subject_type, subject_id, tier) DO NOTHING
    RETURNING subject_id
  `) as Array<{ subject_id: string }>;
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
  // C1b fix-up 5 — DEFAULTS TO FALSE, and the flip is the point. This function is called on the
  // live doctor path (encounters/[id]/process) with no options at all, so the old `?? true` meant
  // every processed encounter fanned out to every enabled PAID engine with no budget check and
  // nobody asking — `drainFanout` checks the daily budget, these two call sites never did.
  //
  // Nothing is lost by the flip: both live call sites run `enqueueFanout(id)` first, so the job
  // stays on the queue and `drainFanout` still fans out the paid engines later, under the budget.
  // Paid comparisons keep arriving; they just stop arriving unattended and unbudgeted.
  const allowPaid = opts?.allowPaid ?? false;
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
     WHERE subject_type = 'encounter' AND subject_id = ${encounterId} AND mode = 'batch' AND tier = 'asr' AND error IS NULL
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

  // E31 C6 — EVERY ATTEMPT IS KEPT. This used to delete the prior errored batch rows for the engines being
  // re-run, "so a retry replaces the failure rather than duplicating it". A failed attempt is not a duplicate of
  // the retry that follows it: it is a separate attempt, and the leaderboard's reliability figure is per attempt.
  // Deleting it made an engine that needed three tries read as reliable as one that needed one. The "done" read
  // above still counts only error IS NULL rows, so a failed engine is still retried; it just no longer erases the
  // failure. With no delete here, an overlapping call can no longer remove another call's fresh row either.
  // True duplicates (a second SUCCESSFUL row for the same subject, engine, mode and tier) are dedupRuns' job.

  const errors: string[] = [];
  let inserted = 0;
  const results = await Promise.all(todo.map(async (e) => {
    const adapter = adapterFor(e.adapter_key)!;
    try {
      // CHOKEPOINT (fix-up item 3). Fan-out reaches PAID engines by design, so it must pass the
      // same gate as everything else: `allowPaid` IS this path's explicit opt-in — it is false by
      // default now and `drainFanout` sets it from the daily budget, so a paid run here is always
      // something a budget or a caller asked for. The guard adds the audit row and the per-call
      // duration cap that this path has never had.
      const g = await guardedTranscribe({
        adapter, engineId: e.id, audio: bytes as Buffer,
        durationMs: Math.round((enc.duration_seconds ?? 0) * 1000),
        explicitlyNamed: allowPaid,
        actor: "cron:stt_fanout",
        subject: `encounter:${encounterId}`,
        transcribeOpts: { contentType, longForm: true, ...(enc.detected_language ? { language: enc.detected_language } : {}) },
      });
      if (!g.ok) {
        return { e, r: { original: null, english: null, language: null, latencyMs: 0, costUsd: null, error: g.refusal.error } };
      }
      const r = g.result;
      return { e, r };
    } catch (err) {
      return { e, r: { original: null, english: null, language: null, latencyMs: 0, costUsd: null, error: String(err).slice(0, 150) } };
    }
  }));

  let langSkipped = 0;
  for (const { e, r } of results) {
    // An engine may DECLINE a clip by language (e.g. IndicConformer is Indic-only
    // and returns "skipped_non_indic" on English). Don't persist a row for that —
    // it would otherwise show as a failed run and skew the engine's reliability.
    if (r.error && r.error.startsWith("skipped")) { langSkipped++; continue; }
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

  return { encounter_id: encounterId, inserted, skipped: engines.length - todo.length + langSkipped, errors };
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
    UPDATE stt_subject_job SET state = 'queued'
     WHERE state = 'running'
       AND (started_at IS NULL OR started_at < NOW() - INTERVAL '5 minutes')
  `;

  // Atomic claim: flip up to `limit` pending/failed jobs to 'running' in ONE
  // statement, locking the chosen rows with FOR UPDATE SKIP LOCKED so two
  // concurrent drains never grab the same encounter. RETURNING gives us exactly
  // the rows this call owns.
  // The claim is keyed on the FULL primary key now, so two subjects that happen to share an
  // id across kinds can never claim each other. `tier` is in the key because ASR and scribe
  // are separate work for one subject and must fail independently.
  //
  // This drain still runs ENCOUNTER work only — runFanoutForEncounter is the only executor
  // that exists, and K4b owns the bench_window one — so the claim is filtered to encounters
  // rather than picking up a window it could not process and marking it failed.
  const claim = (await sql`
    UPDATE stt_subject_job SET state = 'running', attempts = attempts + 1, started_at = NOW()
     WHERE (subject_type, subject_id, tier) IN (
       SELECT subject_type, subject_id, tier FROM stt_subject_job
        WHERE state IN ('queued', 'failed') AND subject_type = 'encounter' AND tier = 'asr'
        ORDER BY queued_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING subject_id AS encounter_id
  `) as Array<{ encounter_id: string }>;

  const jobs: FanoutResult[] = [];
  for (const j of claim) {
    try {
      const res = await runFanoutForEncounter(j.encounter_id, { allowPaid });
      jobs.push(res);
      const hardErr = res.errors.length > 0 && res.inserted === 0 && !res.no_audio;
      await sql`
        UPDATE stt_subject_job
           SET state = ${hardErr ? "failed" : "done"}, finished_at = NOW(),
               last_error = ${res.errors.length ? res.errors.join("; ").slice(0, 300) : null}
         WHERE subject_type = 'encounter' AND subject_id = ${j.encounter_id} AND tier = 'asr'
      `;
    } catch (e) {
      await sql`UPDATE stt_subject_job SET state = 'failed', last_error = ${String(e).slice(0, 300)} WHERE subject_type = 'encounter' AND subject_id = ${j.encounter_id} AND tier = 'asr'`;
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
  const js = (await sql`SELECT state AS status, COUNT(*)::int AS n FROM stt_subject_job GROUP BY state`) as Array<{ status: string; n: number }>;
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
  const r = (await sql`UPDATE stt_subject_job SET state = 'queued', last_error = NULL WHERE state <> 'queued' RETURNING subject_id`) as Array<{ subject_id: string }>;
  return r.length;
}


/** Remove duplicate SUCCESSFUL batch ASR rows (keep the newest per encounter+engine; failed attempts are never
 *  duplicates and are never touched), then clear the scored_at marker on affected encounters so they re-score. */
export async function dedupRuns(): Promise<{ deleted: number; affected: number }> {
  const del = (await sql`
    WITH ranked AS (
      -- E31 C6 — SUCCESSFUL DUPLICATES ONLY. Every row beyond the first used to go, failed attempts included,
      -- so one click of "dedup" erased an engine's attempt history. A failed attempt is never a duplicate.
      SELECT id, encounter_id,
             ROW_NUMBER() OVER (PARTITION BY encounter_id, engine, mode, tier
                                ORDER BY created_at DESC) AS rn
        FROM transcription_run WHERE mode='batch' AND tier='asr' AND error IS NULL
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
    SELECT id, audio_object_key, detected_language, duration_seconds, note_json, note_type
      FROM encounter WHERE id = ${encounterId} LIMIT 1
  `) as Array<{ id: string; audio_object_key: string | null; detected_language: string | null; duration_seconds: number | null; note_json: unknown; note_type: string | null }>;
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
        // E31 C7 — EVERY ATTEMPT IS KEPT, as C6 above: no delete of the prior errored scribe row before a retry.
        const adapter = adapterFor(e.adapter_key)!;
        try {
          const r = await adapter.generateNote!(bytes, { contentType, language: enc.detected_language ?? undefined, template: enc.note_type ?? undefined });
          // language-declined (e.g. indicconformer_scribe on English) -> don't persist
          if (r.error && (r.error.startsWith("skipped") || r.error.startsWith("asr: skipped"))) continue;
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


/** Run scribe tier for up to `limit` encounters where an enabled scribe engine
 *  is missing a successful run (e.g. after adding a NEW scribe engine —
 *  scribePending skips already-scored encounters, this one does not). */
export async function scribeMissing(limit = 3): Promise<{ processed: number; results: Array<{ encounter_id: string; inserted: number; errors: string[] }> }> {
  const encs = (await sql`
    SELECT e.id FROM encounter e
     WHERE e.note_json IS NOT NULL AND e.audio_object_key IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM stt_engine se
          WHERE se.enabled AND se.fanout_enabled
            AND se.capabilities_json -> 'tiers' ? 'scribe'
            AND NOT EXISTS (
              -- ANY attempt counts (errored too) — else junk/silent clips
              -- (asr empty_transcript) get re-picked forever; retry those
              -- explicitly via {scribe:true, encounterId}.
              SELECT 1 FROM transcription_run tr
               WHERE tr.encounter_id = e.id AND tr.tier = 'scribe'
                 AND tr.engine = se.id
            )
       )
     ORDER BY e.recorded_at DESC NULLS LAST
     LIMIT ${limit}
  `) as Array<{ id: string }>;
  const results = [];
  for (const e of encs) results.push(await runScribeForEncounter(e.id));
  return { processed: encs.length, results };
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
