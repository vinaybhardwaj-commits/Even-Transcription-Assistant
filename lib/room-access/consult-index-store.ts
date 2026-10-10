/**
 * lib/room-access/consult-index-store.ts — the ONLY SQL on consult_index, consult_index_sync and consult_sarvam_result (migration 0150), plus the one bench_session read that places a consult in a session.
 *
 * Neon HTTP: one statement per call, tagged template, every value bound and CAST where it lands in a select list. The upsert is ONE statement per batch (a jsonb array of rows), and an unchanged row is not
 * rewritten. `sealed` can only be raised by a sync, never cleared. A result row is inserted ON CONFLICT DO NOTHING on its UNIQUE key: the second writer of the same cut changes nothing.
 */
import { sql } from "@/lib/db";
import type { IndexRow } from "@/lib/consult-index/parse";

export type StoredIndexRow = IndexRow & { synced_at: string; first_seen_at: string };

const BATCH = 200;

export async function startSync(): Promise<number> {
  const rows = (await sql`INSERT INTO consult_index_sync DEFAULT VALUES RETURNING id`) as Array<{ id: number | string }>;
  return Number(rows[0]!.id);
}

export async function finishSync(id: number, f: { status: "ok" | "failed"; error_code?: string | null; manifest_sha256?: string | null; manifest_rows?: number | null; rows_read?: number; rows_written?: number; rows_changed?: number; rows_skipped?: number; skipped?: Record<string, number> }): Promise<void> {
  await sql`
    UPDATE consult_index_sync
       SET finished_at = now(), status = ${f.status}::text, error_code = ${f.error_code ?? null}::text, manifest_sha256 = ${f.manifest_sha256 ?? null}::text, manifest_rows = ${f.manifest_rows ?? null}::int,
           rows_read = ${f.rows_read ?? 0}::int, rows_written = ${f.rows_written ?? 0}::int, rows_changed = ${f.rows_changed ?? 0}::int, rows_skipped = ${f.rows_skipped ?? 0}::int,
           skipped = ${JSON.stringify(f.skipped ?? {})}::jsonb
     WHERE id = ${id}
  `;
}

/**
 * Upsert rows (the BACKFILL is the first run: the mirror holds everything already cut). Returns how many rows were inserted and how many existing rows changed. An existing row is rewritten only if a field
 * differs; `sealed` is OR-ed (sticky); first_seen_at is kept; the bench session is the upstream's when it names one, else the session of that room that covers t0.
 */
export async function upsertIndexRows(rows: readonly IndexRow[], sourceSha: string): Promise<{ inserted: number; changed: number }> {
  let inserted = 0;
  let changed = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const out = (await sql`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows.slice(i, i + BATCH))}::jsonb)
          AS x(consult_uid text, room_id text, room_slug text, ist_date date, session_id text, t0_ms bigint, t1_ms bigint, clip_r2_key text, doctor_uid text, doctor_identified boolean,
               cut_version text, code_commit text, sealed boolean, voice_isolated boolean, minutes numeric, bytes bigint, quality text, coverage numeric)
      )
      INSERT INTO consult_index AS c (consult_uid, room_id, room_slug, ist_date, session_id, t0_ms, t1_ms, clip_r2_key, doctor_uid, doctor_identified, cut_version, code_commit, sealed,
                                      voice_isolated, minutes, bytes, quality, coverage, source_sha256)
      SELECT x.consult_uid, x.room_id, x.room_slug, x.ist_date,
             COALESCE(x.session_id, (SELECT s.id FROM bench_session s
                                      WHERE s.room_id = x.room_id AND s.started_at <= to_timestamp(x.t0_ms / 1000.0) AND COALESCE(s.ended_at, 'infinity'::timestamptz) >= to_timestamp(x.t0_ms / 1000.0)
                                      ORDER BY s.started_at DESC LIMIT 1)),
             x.t0_ms, x.t1_ms, x.clip_r2_key, x.doctor_uid, x.doctor_identified, x.cut_version, x.code_commit, COALESCE(x.sealed, false), x.voice_isolated, x.minutes, x.bytes, x.quality, x.coverage, ${sourceSha}::text
        FROM incoming x
      ON CONFLICT (consult_uid) DO UPDATE
         SET room_id = EXCLUDED.room_id, room_slug = EXCLUDED.room_slug, ist_date = EXCLUDED.ist_date, session_id = COALESCE(EXCLUDED.session_id, c.session_id),
             t0_ms = EXCLUDED.t0_ms, t1_ms = EXCLUDED.t1_ms, clip_r2_key = EXCLUDED.clip_r2_key, doctor_uid = EXCLUDED.doctor_uid, doctor_identified = EXCLUDED.doctor_identified,
             cut_version = EXCLUDED.cut_version, code_commit = EXCLUDED.code_commit, sealed = c.sealed OR EXCLUDED.sealed, voice_isolated = EXCLUDED.voice_isolated,
             minutes = EXCLUDED.minutes, bytes = EXCLUDED.bytes, quality = EXCLUDED.quality, coverage = EXCLUDED.coverage, source_sha256 = EXCLUDED.source_sha256, synced_at = now()
       WHERE (c.room_id, c.room_slug, c.ist_date, c.t0_ms, c.t1_ms, c.clip_r2_key, c.doctor_uid, c.doctor_identified, c.cut_version, c.code_commit, c.voice_isolated, c.minutes, c.bytes, c.quality, c.coverage)
             IS DISTINCT FROM (EXCLUDED.room_id, EXCLUDED.room_slug, EXCLUDED.ist_date, EXCLUDED.t0_ms, EXCLUDED.t1_ms, EXCLUDED.clip_r2_key, EXCLUDED.doctor_uid, EXCLUDED.doctor_identified,
                               EXCLUDED.cut_version, EXCLUDED.code_commit, EXCLUDED.voice_isolated, EXCLUDED.minutes, EXCLUDED.bytes, EXCLUDED.quality, EXCLUDED.coverage)
          OR (EXCLUDED.sealed AND NOT c.sealed)
      RETURNING (xmax = 0) AS inserted
    `) as Array<{ inserted: boolean }>;
    for (const r of out) (r.inserted ? (inserted += 1) : (changed += 1));
  }
  return { inserted, changed };
}


const toRow = (r: Record<string, unknown>): StoredIndexRow => ({
  consult_uid: String(r.consult_uid), room_id: String(r.room_id), room_slug: String(r.room_slug), ist_date: String(r.ist_date), session_id: (r.session_id as string | null) ?? null,
  t0_ms: Number(r.t0_ms), t1_ms: Number(r.t1_ms), clip_r2_key: String(r.clip_r2_key), doctor_uid: (r.doctor_uid as string | null) ?? null, doctor_identified: (r.doctor_identified as boolean | null) ?? null,
  cut_version: String(r.cut_version), code_commit: (r.code_commit as string | null) ?? null, sealed: r.sealed === true, voice_isolated: (r.voice_isolated as boolean | null) ?? null,
  minutes: r.minutes === null ? null : Number(r.minutes), bytes: r.bytes === null ? null : Number(r.bytes), quality: (r.quality as string | null) ?? null, coverage: r.coverage === null ? null : Number(r.coverage),
  synced_at: String(r.synced_at), first_seen_at: String(r.first_seen_at),
});

export async function getIndexRow(uid: string): Promise<StoredIndexRow | null> {
  const rows = (await sql`
    SELECT consult_uid, room_id, room_slug, ist_date::text AS ist_date, session_id, t0_ms::float8 AS t0_ms, t1_ms::float8 AS t1_ms, clip_r2_key, doctor_uid, doctor_identified, cut_version, code_commit, sealed, voice_isolated,
           minutes::float8 AS minutes, bytes::float8 AS bytes, quality, coverage::float8 AS coverage, synced_at::text AS synced_at, first_seen_at::text AS first_seen_at
      FROM consult_index WHERE consult_uid = ${uid}::text LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listIndexDay(date: string, room: string | null, limit: number): Promise<{ rows: StoredIndexRow[]; total: number }> {
  const rows = (await sql`
    SELECT consult_uid, room_id, room_slug, ist_date::text AS ist_date, session_id, t0_ms::float8 AS t0_ms, t1_ms::float8 AS t1_ms, clip_r2_key, doctor_uid, doctor_identified, cut_version, code_commit, sealed, voice_isolated,
           minutes::float8 AS minutes, bytes::float8 AS bytes, quality, coverage::float8 AS coverage, synced_at::text AS synced_at, first_seen_at::text AS first_seen_at,
           count(*) OVER ()::int AS total
      FROM consult_index
     WHERE ist_date = ${date}::date AND (${room}::text IS NULL OR room_slug = ${room}::text OR room_id = ${room}::text)
     ORDER BY t0_ms ASC
     LIMIT ${limit}::int
  `) as Array<Record<string, unknown>>;
  return { rows: rows.map(toRow), total: rows[0] ? Number(rows[0].total) : 0 };
}

export type LatestSync = { id: number; started_at: string; finished_at: string | null; status: string; error_code: string | null; manifest_rows: number | null; rows_read: number; rows_written: number; rows_changed: number; rows_skipped: number } | null;
export async function latestSync(): Promise<LatestSync> {
  const rows = (await sql`
    SELECT id::int AS id, started_at::text AS started_at, finished_at::text AS finished_at, status, error_code, manifest_rows, rows_read, rows_written, rows_changed, rows_skipped
      FROM consult_index_sync ORDER BY id DESC LIMIT 1
  `) as Array<Record<string, unknown>>;
  const r = rows[0];
  return r ? { id: Number(r.id), started_at: String(r.started_at), finished_at: (r.finished_at as string | null) ?? null, status: String(r.status), error_code: (r.error_code as string | null) ?? null,
    manifest_rows: r.manifest_rows === null ? null : Number(r.manifest_rows), rows_read: Number(r.rows_read), rows_written: Number(r.rows_written), rows_changed: Number(r.rows_changed), rows_skipped: Number(r.rows_skipped) } : null;
}

// ---- results ----------------------------------------------------------------------------------------------------------------------------------

export type ConsultResult = {
  consult_uid: string; cut_version: string; mode: string; english: boolean; num_speakers: number | null; job_id: string; result_r2_key: string; model_stt: string; model_translate: string; model_rev: string;
  pipeline_rev: string; language_code: string | null; duration_s: number | null; speaker_count: number; transcript_chars: number; english_chars: number; english_pass: string | null; t0_ms: number; created_at: string;
};

const resultOf = (r: Record<string, unknown>): ConsultResult => ({
  consult_uid: String(r.consult_uid), cut_version: String(r.cut_version), mode: String(r.mode), english: r.english === true, num_speakers: r.num_speakers === null ? null : Number(r.num_speakers), job_id: String(r.job_id),
  result_r2_key: String(r.result_r2_key), model_stt: String(r.model_stt), model_translate: String(r.model_translate), model_rev: String(r.model_rev), pipeline_rev: String(r.pipeline_rev),
  language_code: (r.language_code as string | null) ?? null, duration_s: r.duration_s === null ? null : Number(r.duration_s), speaker_count: Number(r.speaker_count), transcript_chars: Number(r.transcript_chars),
  english_chars: Number(r.english_chars), english_pass: (r.english_pass as string | null) ?? null, t0_ms: Number(r.t0_ms), created_at: String(r.created_at),
});

/** The stored result of exactly this cut and these options, or null. */
export async function findResult(uid: string, cutVersion: string, mode: string, english: boolean): Promise<ConsultResult | null> {
  const rows = (await sql`
    SELECT consult_uid, cut_version, mode, english, num_speakers, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, language_code, duration_s::float8 AS duration_s, speaker_count,
           transcript_chars, english_chars, english_pass, t0_ms::float8 AS t0_ms, created_at::text AS created_at
      FROM consult_sarvam_result
     WHERE consult_uid = ${uid}::text AND cut_version = ${cutVersion}::text AND mode = ${mode}::text AND english = ${english}::boolean
     LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows[0] ? resultOf(rows[0]) : null;
}

/** All stored results of one consult, newest first (every cut version). */
export async function listResults(uid: string): Promise<ConsultResult[]> {
  const rows = (await sql`
    SELECT consult_uid, cut_version, mode, english, num_speakers, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, language_code, duration_s::float8 AS duration_s, speaker_count,
           transcript_chars, english_chars, english_pass, t0_ms::float8 AS t0_ms, created_at::text AS created_at
      FROM consult_sarvam_result WHERE consult_uid = ${uid}::text ORDER BY created_at DESC, id DESC LIMIT 20
  `) as Array<Record<string, unknown>>;
  return rows.map(resultOf);
}

/** Record a finished result. The UNIQUE key makes this a no-op for a cut that already has one; returns whether THIS call wrote it. */
export async function recordResult(r: Omit<ConsultResult, "created_at">): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, num_speakers, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, language_code, duration_s,
                                       speaker_count, transcript_chars, english_chars, english_pass, t0_ms)
    VALUES (${r.consult_uid}::text, ${r.cut_version}::text, ${r.mode}::text, ${r.english}::boolean, ${r.num_speakers}::int, ${r.job_id}::text, ${r.result_r2_key}::text, ${r.model_stt}::text, ${r.model_translate}::text,
            ${r.model_rev}::text, ${r.pipeline_rev}::text, ${r.language_code}::text, ${r.duration_s}::numeric, ${r.speaker_count}::int, ${r.transcript_chars}::int, ${r.english_chars}::int, ${r.english_pass}::text, ${r.t0_ms}::bigint)
    ON CONFLICT ON CONSTRAINT consult_sarvam_result_once DO NOTHING
    RETURNING id
  `) as Array<{ id: number }>;
  return rows.length > 0;
}
