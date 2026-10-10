/**
 * lib/room-access/pulse-doctor-voice.ts — every SQL statement of the Pulse-doctor room-print builder (0142).
 * The only writer of pulse_doctor_voice and pulse_doctor_voice_run. It lives here because it reads
 * eta_encounter_windows, diarize_nemotron_window and bench_window, which only lib/room-access/ may name.
 *
 * WHICH WINDOWS LABEL A DOCTOR. A stored `ok` Nemotron window belongs to Pulse doctor U when
 *   - consults of U (coalesce(warehouse_doctor_uid, doctor_uid), the anchors' precedence) cover at least half of it, and
 *   - NO other consult overlaps it: another doctor's, an unattributed one (no uid), or a multi_doctor one.
 * A consult with no t_close is not used (its end would be a guess). Held-out windows are removed before the LIMIT
 * (blindWindowIds, as every production chooser) and counted.
 *
 * Neon HTTP: one statement per call, every value bound.
 */
import { sql } from "@/lib/db";
import { blindWindowIds } from "@/lib/room-access/check";

export type DoctorWindow = { row_id: number; window_id: string; day: string; turns_json: unknown; clip_r2_key: string | null };

/** The windows that label Pulse doctor `uid`, newest first, from the last `days` days. */
export async function doctorWindows(uid: string, days: number, limit: number): Promise<{ windows: DoctorWindow[]; n_blind_excluded: number }> {
  const blind = await blindWindowIds();
  const rows = (await sql`
    WITH c AS (
      SELECT room_id, coalesce(warehouse_doctor_uid, doctor_uid) AS uid, (quality = 'multi_doctor') AS multi,
             (extract(epoch FROM t_open) * 1000)::bigint AS o, (extract(epoch FROM t_close) * 1000)::bigint AS e
        FROM eta_encounter_windows
       WHERE t_open >= now() - make_interval(days => ${days}::int) AND t_close IS NOT NULL AND t_close > t_open
    ), w AS (
      SELECT n.id AS row_id, n.window_id, bw.start_ms, bw.end_ms, rd.room_id, rd.ist_date::text AS day, n.turns_json, bw.clip_r2_key
        FROM diarize_nemotron_window n
        JOIN bench_window bw ON bw.id = n.window_id
        JOIN room_day rd ON rd.id = bw.room_day_id
       WHERE n.status = 'ok' AND bw.end_ms > bw.start_ms
         AND bw.start_ms >= (extract(epoch FROM now() - make_interval(days => ${days}::int)) * 1000)::bigint
         AND n.window_id <> ALL(${blind}::text[])
    )
    SELECT w.row_id, w.window_id, w.day, w.turns_json, w.clip_r2_key
      FROM w
     WHERE 2 * (SELECT coalesce(sum(least(w.end_ms, c.e) - greatest(w.start_ms, c.o)), 0) FROM c
                 WHERE c.room_id = w.room_id AND c.uid = ${uid} AND NOT c.multi AND c.o < w.end_ms AND c.e > w.start_ms)
           >= (w.end_ms - w.start_ms)
       AND NOT EXISTS (SELECT 1 FROM c WHERE c.room_id = w.room_id AND c.o < w.end_ms AND c.e > w.start_ms
                          AND (c.multi OR c.uid IS DISTINCT FROM ${uid}))
     ORDER BY w.start_ms DESC, w.window_id
     LIMIT ${limit}
  `) as Array<{ row_id: number | string; window_id: string; day: string; turns_json: unknown; clip_r2_key: string | null }>;
  return { windows: rows.map((r) => ({ ...r, row_id: Number(r.row_id) })), n_blind_excluded: blind.length };
}

/**
 * The Pulse doctors worth a build now: at least `minWindows` labelling windows (same rule as doctorWindows), no build
 * attempt in the last `cooldownHours`, and no open job. Most windows first.
 */
export async function doctorsToBuild(days: number, minWindows: number, cooldownHours: number, limit: number): Promise<{ uids: Array<{ uid: string; windows: number }>; n_blind_excluded: number }> {
  const blind = await blindWindowIds();
  const rows = (await sql`
    WITH c AS (
      SELECT room_id, coalesce(warehouse_doctor_uid, doctor_uid) AS uid, (quality = 'multi_doctor') AS multi,
             (extract(epoch FROM t_open) * 1000)::bigint AS o, (extract(epoch FROM t_close) * 1000)::bigint AS e
        FROM eta_encounter_windows
       WHERE t_open >= now() - make_interval(days => ${days}::int) AND t_close IS NOT NULL AND t_close > t_open
    ), w AS (
      SELECT n.window_id, bw.start_ms, bw.end_ms, rd.room_id
        FROM diarize_nemotron_window n
        JOIN bench_window bw ON bw.id = n.window_id
        JOIN room_day rd ON rd.id = bw.room_day_id
       WHERE n.status = 'ok' AND bw.end_ms > bw.start_ms
         AND bw.start_ms >= (extract(epoch FROM now() - make_interval(days => ${days}::int)) * 1000)::bigint
         AND n.window_id <> ALL(${blind}::text[])
    ), per AS (  -- per window: every consult overlapping it
      SELECT w.window_id, w.start_ms, w.end_ms, c.uid, c.multi, least(w.end_ms, c.e) - greatest(w.start_ms, c.o) AS cov
        FROM w JOIN c ON c.room_id = w.room_id AND c.o < w.end_ms AND c.e > w.start_ms
    ), owned AS (  -- windows overlapped by exactly one doctor's consults, none multi or unattributed, half covered
      SELECT window_id, min(uid) AS uid
        FROM per
       GROUP BY window_id, start_ms, end_ms
      HAVING count(DISTINCT uid) = 1 AND bool_and(uid IS NOT NULL) AND NOT bool_or(multi) AND 2 * sum(cov) >= (end_ms - start_ms)
    )
    SELECT o.uid, count(*)::int AS windows
      FROM owned o
     WHERE NOT EXISTS (SELECT 1 FROM pulse_doctor_voice_run r
                        WHERE r.pulse_doctor_uid = o.uid AND r.created_at > now() - make_interval(hours => ${cooldownHours}::int))
       AND NOT EXISTS (SELECT 1 FROM scribe_job j
                        WHERE j.kind = 'pulse_doctor_voice' AND j.args->>'pulse_doctor_uid' = o.uid AND j.status IN ('queued', 'running'))
     GROUP BY o.uid
    HAVING count(*) >= ${minWindows}
     ORDER BY count(*) DESC, o.uid
     LIMIT ${limit}
  `) as Array<{ uid: string; windows: number }>;
  return { uids: rows.map((r) => ({ uid: r.uid, windows: Number(r.windows) })), n_blind_excluded: blind.length };
}

export type VoiceWrite = {
  id: string;
  uid: string;
  actor: string;
  embedding: number[];
  embedding_model: string;
  n_windows: number;
  n_days: number;
  windows_offered: number;
  windows_embedded: number;
  support: number;
  runner_up_windows: number;
  nearest: { clinician_id: string; score: number } | null;
  n_blind_excluded: number;
  source: Record<string, unknown>;
};

/**
 * One statement: retire the active print (who and why), insert the next generation, and log the `built` run.
 * A racing second writer computes the same generation and fails on the UNIQUE; nothing forks (as voice_centroid).
 */
export async function writeDoctorVoice(v: VoiceWrite): Promise<{ id: string; generation: number; retired: number }> {
  const rows = (await sql`
    WITH retired AS (
      UPDATE pulse_doctor_voice
         SET retired_at = now(), retired_by = ${v.actor}, retired_reason = ${"superseded_by:" + v.id}
       WHERE pulse_doctor_uid = ${v.uid} AND embedding_model = ${v.embedding_model} AND retired_at IS NULL
      RETURNING id
    ), next_gen AS (
      SELECT coalesce(max(generation), 0) + 1 AS g FROM pulse_doctor_voice
       WHERE pulse_doctor_uid = ${v.uid} AND embedding_model = ${v.embedding_model}
    ), ins AS (
      INSERT INTO pulse_doctor_voice
        (id, pulse_doctor_uid, generation, embedding, embedding_model, embedding_dim, n_windows, n_days, windows_offered,
         support, runner_up_windows, nearest_clinician_id, nearest_score, source)
      SELECT ${v.id}, ${v.uid}, next_gen.g, ${v.embedding}::real[], ${v.embedding_model}, ${v.embedding.length}, ${v.n_windows},
             ${v.n_days}, ${v.windows_offered}, ${v.support}, ${v.runner_up_windows}, ${v.nearest?.clinician_id ?? null},
             ${v.nearest?.score ?? null}, ${JSON.stringify(v.source)}::jsonb
        FROM next_gen
      RETURNING id, generation
    ), run AS (
      INSERT INTO pulse_doctor_voice_run
        (pulse_doctor_uid, outcome, reason, windows_offered, windows_embedded, n_windows, n_days, runner_up_windows, n_blind_excluded, voice_id)
      SELECT ${v.uid}, 'built', NULL, ${v.windows_offered}, ${v.windows_embedded}, ${v.n_windows}, ${v.n_days}, ${v.runner_up_windows},
             ${v.n_blind_excluded}, ins.id
        FROM ins
      RETURNING id
    )
    SELECT ins.id, ins.generation, (SELECT count(*) FROM retired)::int AS retired, (SELECT count(*) FROM run)::int AS runs FROM ins
  `) as Array<{ id: string; generation: number; retired: number; runs: number }>;
  const r = rows[0];
  if (!r || Number(r.runs) !== 1) throw new Error("pulse_doctor_voice write returned no row");
  return { id: r.id, generation: Number(r.generation), retired: Number(r.retired) };
}

/** A refused or failed attempt. The active print, if any, is left exactly as it was. */
export async function recordDoctorVoiceRun(r: {
  uid: string; outcome: "refused" | "failed"; reason: string; windows_offered: number; windows_embedded: number;
  n_windows: number; n_days: number; runner_up_windows: number; n_blind_excluded: number;
}): Promise<void> {
  await sql`
    INSERT INTO pulse_doctor_voice_run
      (pulse_doctor_uid, outcome, reason, windows_offered, windows_embedded, n_windows, n_days, runner_up_windows, n_blind_excluded)
    VALUES (${r.uid}, ${r.outcome}, ${r.reason}, ${r.windows_offered}, ${r.windows_embedded}, ${r.n_windows}, ${r.n_days},
            ${r.runner_up_windows}, ${r.n_blind_excluded})
  `;
}
