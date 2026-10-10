/**
 * lib/room-access/nemotron-identity.ts — every SQL statement of the ECAPA identity pass on stored Nemotron rows
 * (epic #23, ticket c). The only writer of diarize_nemotron_identity and diarize_nemotron_speaker (0141).
 * It lives here because it reads diarize_nemotron_window and bench_window, which only lib/room-access/ may name.
 *
 * Held-out: the job's guard places a row through its window (windowHeldOut: any placement, and the session span);
 * the enqueue chooser removes blindWindowIds() before its LIMIT and counts them (n_blind_excluded).
 */
import { sql } from "@/lib/db";
import { blindWindowIds } from "@/lib/room-access/check";
import { windowHeldOut, type HeldOutVerdict } from "@/lib/room-access/jobs";

export type IdentityRow = {
  id: number | string;
  window_id: string;
  status: string;
  turns_json: unknown;
  clip_r2_key: string | null;
  ist_date: string | null;
  room_id: string | null;
};

/** The speaker row as the job writes it (lib/diarize-nemotron/identity.ts SpeakerIdentity). */
export type IdentitySpeakerRow = {
  speaker_label: string;
  speech_ms: number;
  clinician_id: string | null;
  match_confidence: number | null;
  losing_clinician_id: string | null;
  losing_score: number | null;
  centroids_offered: number;
  attribution: string;
};

/** The pulse_room speaker row (lib/diarize-nemotron/identity.ts PulseRoomSpeaker). */
export type PulseRoomSpeakerRow = {
  speaker_label: string;
  speech_ms: number;
  decision: string;
  pulse_doctor_uid: string | null;
  best_cosine: number | null;
  runner_up_cosine: number | null;
  centroids_offered: number;
  attribution: string;
};

/** The job's held-out guard: a row id is placed through its window. A row that does not exist is not refused (the kind reports row_missing). */
export async function nemotronRowHeldOut(rowId: number): Promise<HeldOutVerdict | null> {
  const rows = (await sql`SELECT window_id FROM diarize_nemotron_window WHERE id = ${rowId} LIMIT 1`) as Array<{ window_id: string }>;
  const w = rows[0];
  if (!w) return null;
  return windowHeldOut(w.window_id);
}

export async function readIdentityRow(rowId: number): Promise<IdentityRow | null> {
  const found = (await sql`
    SELECT n.id, n.window_id, n.status, n.turns_json, w.clip_r2_key, rd.ist_date::text AS ist_date, rd.room_id
      FROM diarize_nemotron_window n
      JOIN bench_window w ON w.id = n.window_id
      LEFT JOIN room_day rd ON rd.id = w.room_day_id
     WHERE n.id = ${rowId}
     LIMIT 1
  `) as IdentityRow[];
  return found[0] ?? null;
}

/** Record a failed pass. `terminal` writes it at the attempt bound, so it is never offered again. Returns the stored count; 0 when the key already has an `ok` pass. */
export async function recordIdentityFailure(rowId: number, set: string, code: string, terminal: boolean, maxAttempts: number): Promise<number> {
  const first = terminal ? maxAttempts : 1;
  const rows = (await sql`
    INSERT INTO diarize_nemotron_identity (window_row_id, centroid_set, state, attempts, error_code)
    VALUES (${rowId}, ${set}, 'failed', ${first}, ${code})
    ON CONFLICT ON CONSTRAINT diarize_nemotron_identity_pk DO UPDATE
       SET attempts = CASE WHEN ${terminal} THEN GREATEST(diarize_nemotron_identity.attempts + 1, ${maxAttempts})
                           ELSE diarize_nemotron_identity.attempts + 1 END,
           error_code = EXCLUDED.error_code,
           updated_at = now()
     WHERE diarize_nemotron_identity.state = 'failed'
    RETURNING attempts
  `) as Array<{ attempts: number }>;
  return rows[0] ? Number(rows[0].attempts) : 0;
}

/** The pass and its speakers in one statement. Writes nothing when the key already has an `ok` pass. */
export async function recordIdentityOk(
  rowId: number, set: string, speakers: IdentitySpeakerRow[], centroidsOffered: number, embedded: number, trusted: boolean,
): Promise<boolean> {
  const rows = (await sql`
    WITH ident AS (
      INSERT INTO diarize_nemotron_identity
        (window_row_id, centroid_set, state, attempts, error_code, centroids_offered, speakers_embedded, shadow_trusted)
      VALUES (${rowId}, ${set}, 'ok', 1, NULL, ${centroidsOffered}, ${embedded}, ${trusted})
      ON CONFLICT ON CONSTRAINT diarize_nemotron_identity_pk DO UPDATE
         SET state = 'ok', attempts = diarize_nemotron_identity.attempts + 1, error_code = NULL,
             centroids_offered = EXCLUDED.centroids_offered, speakers_embedded = EXCLUDED.speakers_embedded,
             shadow_trusted = EXCLUDED.shadow_trusted, updated_at = now()
       WHERE diarize_nemotron_identity.state = 'failed'
      RETURNING window_row_id
    ), spk AS (
      INSERT INTO diarize_nemotron_speaker
        (window_row_id, centroid_set, speaker_label, speech_ms, clinician_id, match_confidence,
         losing_clinician_id, losing_score, centroids_offered, attribution)
      SELECT ident.window_row_id, ${set}, x.speaker_label, x.speech_ms, x.clinician_id, x.match_confidence,
             x.losing_clinician_id, x.losing_score, x.centroids_offered, x.attribution
        FROM ident, jsonb_to_recordset(${JSON.stringify(speakers)}::jsonb) AS x(
          speaker_label text, speech_ms integer, clinician_id text, match_confidence real,
          losing_clinician_id text, losing_score real, centroids_offered integer, attribution text)
      ON CONFLICT ON CONSTRAINT diarize_nemotron_speaker_pk DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ident)::int AS passes
  `) as Array<{ passes: number }>;
  return Number(rows[0]?.passes ?? 0) > 0;
}

/**
 * The pulse_room pass and its speakers in one statement (as recordIdentityOk). Suggest-only: clinician_id,
 * match_confidence and the losing candidate are written NULL by construction (0145 refuses anything else).
 */
export async function recordPulseRoomOk(
  rowId: number, speakers: PulseRoomSpeakerRow[], centroidsOffered: number, embedded: number,
): Promise<boolean> {
  const rows = (await sql`
    WITH ident AS (
      INSERT INTO diarize_nemotron_identity
        (window_row_id, centroid_set, state, attempts, error_code, centroids_offered, speakers_embedded, shadow_trusted)
      VALUES (${rowId}, 'pulse_room', 'ok', 1, NULL, ${centroidsOffered}, ${embedded}, NULL)
      ON CONFLICT ON CONSTRAINT diarize_nemotron_identity_pk DO UPDATE
         SET state = 'ok', attempts = diarize_nemotron_identity.attempts + 1, error_code = NULL,
             centroids_offered = EXCLUDED.centroids_offered, speakers_embedded = EXCLUDED.speakers_embedded,
             shadow_trusted = NULL, updated_at = now()
       WHERE diarize_nemotron_identity.state = 'failed'
      RETURNING window_row_id
    ), spk AS (
      INSERT INTO diarize_nemotron_speaker
        (window_row_id, centroid_set, speaker_label, speech_ms, clinician_id, match_confidence, losing_clinician_id, losing_score,
         centroids_offered, attribution, decision, pulse_doctor_uid, match_source, best_cosine, runner_up_cosine)
      SELECT ident.window_row_id, 'pulse_room', x.speaker_label, x.speech_ms, NULL, NULL, NULL, NULL,
             x.centroids_offered, x.attribution, x.decision, x.pulse_doctor_uid, 'pulse_room', x.best_cosine, x.runner_up_cosine
        FROM ident, jsonb_to_recordset(${JSON.stringify(speakers)}::jsonb) AS x(
          speaker_label text, speech_ms integer, decision text, pulse_doctor_uid text, best_cosine real, runner_up_cosine real,
          centroids_offered integer, attribution text)
      ON CONFLICT ON CONSTRAINT diarize_nemotron_speaker_pk DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ident)::int AS passes
  `) as Array<{ passes: number }>;
  return Number(rows[0]?.passes ?? 0) > 0;
}

/**
 * The enqueue chooser: stored `ok` rows with no `ok` pass for this set and fewer than `maxAttempts` failed attempts, and no open job.
 * New rows first. Held-out windows are removed BEFORE the LIMIT, so they never take a slot, and counted.
 */
export async function chooseIdentityRows(set: string, limit: number, maxAttempts: number): Promise<{ rows: Array<{ id: number; retry: boolean }>; n_blind_excluded: number }> {
  const blind = await blindWindowIds();
  const rows = (await sql`
    SELECT n.id, (i.window_row_id IS NOT NULL) AS retry
      FROM diarize_nemotron_window n
      LEFT JOIN diarize_nemotron_identity i ON i.window_row_id = n.id AND i.centroid_set = ${set}
     WHERE n.status = 'ok'
       AND n.window_id <> ALL(${blind}::text[])
       AND (i.window_row_id IS NULL OR (i.state = 'failed' AND i.attempts < ${maxAttempts}))
       AND NOT EXISTS (
         SELECT 1 FROM scribe_job j
          WHERE j.kind = 'nemotron_identity'
            AND j.args->>'row_id' = n.id::text
            AND j.args->>'centroid_set' = ${set}
            AND j.status IN ('queued', 'running')
       )
     ORDER BY (i.window_row_id IS NOT NULL) ASC, n.id ASC
     LIMIT ${limit}
  `) as Array<{ id: number | string; retry: boolean }>;
  return { rows: rows.map((r) => ({ id: Number(r.id), retry: r.retry === true })), n_blind_excluded: blind.length };
}
