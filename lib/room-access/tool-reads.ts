/**
 * lib/room-access/tool-reads.ts — GUARD: the room-data SQL of the MCP tools and bearer / admin routes that used to carry it inline (s1b stt_windows, jev decisions, REB index, store stats, rooms list,
 * the admin STT-lab, bench-drain, speaker-calibration and bench-windows routes). Each read refuses a held-out target or leaves held-out rows out in SQL and counts them.
 */
import { sql } from "@/lib/db";
import { query } from "@/lib/brain/db";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";
import { guardSessionSpan, windowBlindAny } from "./check";

const HELD_DAYS = BLIND_ROOM_DAYS.map(([d]) => d);
const HELD_ROOMS = BLIND_ROOM_DAYS.map(([, r]) => r);
type Row = Record<string, unknown>;

// --- scribe_stt_windows -------------------------------------------------------------------------------------------------------------------
/** One window's description row (window + session + room). Placement is checked by the caller BEFORE this runs (windowBlindAny); an unknown window gives []. */
export async function windowDetailRow(windowId: string): Promise<Row[]> {
  return (await sql`
    SELECT w.id, w.session_id, w.room_day_id, w.start_ms, w.end_ms, w.source_mic, w.grid_aligned, w.state, w.closed_at, w.created_at,
           w.auto_drain_refused_at, w.auto_drain_refused_reason, s.room_id, r.name AS room_name, s.started_at AS session_started_at
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
      JOIN room r ON r.id = s.room_id
     WHERE w.id = ${windowId}::text
     LIMIT 1
  `) as Row[];
}

/** The windows of a room that START in an IST day window (the caller has refused a held-out (room, day)); the caller filters held-out placements per window. */
export async function windowsStartingIn(roomId: string, dayLo: number, dayHi: number, limit: number): Promise<Row[]> {
  return (await sql`
    SELECT w.id, w.room_day_id, w.start_ms, w.end_ms, w.source_mic, w.state, w.closed_at
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
     WHERE s.room_id = ${roomId}::text AND w.start_ms >= ${dayLo}::bigint AND w.start_ms < ${dayHi}::bigint
     ORDER BY w.start_ms
     LIMIT ${limit}
  `) as Row[];
}

// --- scribe_jev_decisions -----------------------------------------------------------------------------------------------------------------
/** Jev decisions, a decision about a held-out room-day or about a window with ANY held-out placement is never served (SQL). */
export async function listJevDecisions<T extends Row = Row>(f: { subjectType: string | null; subjectId: string | null; questionId: string | null; promptVersion: string | null; limit: number }) {
  return query<T>(
    `SELECT id, subject_type, subject_id, question_id, prompt_version, model, answer, probabilities,
            confidence, latency_ms, input_tokens, created_at
       FROM jev_decision
      WHERE ($1::text IS NULL OR subject_type = $1)
        AND ($2::text IS NULL OR subject_id = $2)
        AND ($3::text IS NULL OR question_id = $3)
        AND ($4::text IS NULL OR prompt_version = $4)
        AND NOT EXISTS (SELECT 1 FROM room_day r1, unnest($6::date[], $7::text[]) AS b(d, r) WHERE r1.id = jev_decision.subject_id AND b.d = r1.ist_date AND b.r = r1.room_id)
        AND NOT EXISTS (SELECT 1 FROM bench_window bw LEFT JOIN room_diarize_window dw ON dw.window_id = bw.id, room_day r1, unnest($6::date[], $7::text[]) AS b(d, r) WHERE bw.id = jev_decision.subject_id AND r1.id IN (bw.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
      ORDER BY created_at DESC
      LIMIT $5`,
    [f.subjectType, f.subjectId, f.questionId, f.promptVersion, f.limit, HELD_DAYS, HELD_ROOMS],
  );
}

// --- the REB track index (tool and bearer route) ------------------------------------------------------------------------------------------
/** A page of index rows (limit + 1 asked for by the caller). A row of a held-out (room, IST date) is never listed. */
export async function rebIndexRows(f: { cursor: number; windowId: string | null; day: string | null; layer: string | null; engine: string | null; roomId: string | null; withShadow: boolean; limit: number }): Promise<Row[]> {
  const { cursor, windowId, day, layer, engine, roomId, withShadow, limit } = f;
  return (await sql`
    SELECT id, window_id, to_char(ist_date, 'YYYY-MM-DD') AS ist_date, room_id, t0_ms, t1_ms, layer, engine, model, version, config_hash, shadow,
           status, reason, machine, r2_key, sha256, bytes, started_at, finished_at, indexed_at
      FROM reb_track_index
     WHERE id > ${cursor}
       AND (${windowId}::text IS NULL OR window_id = ${windowId})
       AND (${day}::text IS NULL OR ist_date = ${day}::date)
       AND (${layer}::text IS NULL OR layer = ${layer})
       AND (${engine}::text IS NULL OR engine = ${engine})
       AND (${roomId}::text IS NULL OR room_id = ${roomId})
       AND (${withShadow}::boolean OR shadow = false)
       AND NOT EXISTS (SELECT 1 FROM unnest(${HELD_DAYS}::date[], ${HELD_ROOMS}::text[]) AS b(d, r) WHERE b.d = reb_track_index.ist_date AND b.r = reb_track_index.room_id)
     ORDER BY id
     LIMIT ${limit + 1}
  `) as Row[];
}

/** The palimpsest writer (bearer route): insert the sent rows (idempotent on the key) and read back what is stored under each sent key. Writes only; it serves no reader. */
type RebKeyRow = { window_id: string; layer: string; engine: string; version: string; config_hash: string; shadow: boolean; sha256?: string | null };
export async function insertRebIndexRows(payload: string): Promise<{ ins: RebKeyRow[]; stored: RebKeyRow[] }> {
  const ins = (await sql`
    INSERT INTO reb_track_index (window_id, ist_date, room_id, t0_ms, t1_ms, layer, engine, model, version, config_hash, shadow, status, reason,
                                 machine, r2_key, sha256, bytes, started_at, finished_at)
    SELECT window_id, ist_date, room_id, t0_ms, t1_ms, layer, engine, model, version, config_hash, shadow, status, reason,
           machine, r2_key, sha256, bytes, started_at, finished_at
      FROM jsonb_to_recordset(${payload}::jsonb) AS r(
        window_id text, ist_date date, room_id text, t0_ms bigint, t1_ms bigint, layer text, engine text, model text, version text,
        config_hash text, shadow boolean, status text, reason text, machine text, r2_key text, sha256 text, bytes bigint,
        started_at timestamptz, finished_at timestamptz)
    ON CONFLICT ON CONSTRAINT reb_track_index_key DO NOTHING
    RETURNING window_id, layer, engine, version, config_hash, shadow`) as RebKeyRow[];
  const stored = (await sql`
    SELECT t.window_id, t.layer, t.engine, t.version, t.config_hash, t.shadow, t.sha256
      FROM reb_track_index t
      JOIN (SELECT DISTINCT window_id, layer, engine, version, config_hash, shadow
              FROM jsonb_to_recordset(${payload}::jsonb) AS r(window_id text, layer text, engine text, version text, config_hash text, shadow boolean)) k
        ON t.window_id = k.window_id AND t.layer = k.layer AND t.engine = k.engine AND t.version = k.version
       AND t.config_hash = k.config_hash AND t.shadow = k.shadow`) as RebKeyRow[];
  return { ins, stored };
}

// --- scribe_store_stats / scribe_list_rooms ----------------------------------------------------------------------------------------------
/** Bench session totals: held-out sessions (room-day span or window placement) are left out of both figures and counted. */
export async function benchSessionTotals(): Promise<{ total: number; byStatus: Record<string, number>; nBlindExcluded: number }> {
  const rows = (await sql`
    SELECT s.status, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE (EXISTS (SELECT 1 FROM unnest(${HELD_DAYS}::date[], ${HELD_ROOMS}::text[]) AS hb(d, r)
                  WHERE hb.r = s.room_id AND (hb.d::timestamp AT TIME ZONE 'Asia/Kolkata') <= GREATEST(s.started_at, s.ended_at, (SELECT max(hc.ended_at) FROM bench_chunk hc WHERE hc.session_id = s.id))
                    AND (hb.d::timestamp AT TIME ZONE 'Asia/Kolkata') + interval '1 day' > s.started_at)
        OR EXISTS (SELECT 1 FROM bench_window hw LEFT JOIN room_diarize_window hd ON hd.window_id = hw.id, room_day hr, unnest(${HELD_DAYS}::date[], ${HELD_ROOMS}::text[]) AS hb2(d, r)
                    WHERE hw.session_id = s.id AND hr.id IN (hw.room_day_id, hd.room_day_id) AND hb2.d = hr.ist_date AND hb2.r = hr.room_id)))::int AS held
      FROM bench_session s GROUP BY s.status ORDER BY s.status
  `) as Array<{ status: string; n: number; held: number }>;
  const byStatus: Record<string, number> = {};
  let total = 0, held = 0;
  for (const r of rows) { byStatus[r.status] = Number(r.n) - Number(r.held); total += Number(r.n) - Number(r.held); held += Number(r.held); }
  return { total, byStatus, nBlindExcluded: held };
}

/** Today's cues, split by the day's 0046 scratch flag (text + $1 date, run through the brain pool); a (room, day) that is a held-out pair is left out. */
export const SQL_CUES_TODAY_SPLIT =
  "SELECT COUNT(*) FILTER (WHERE d.scratch IS NOT TRUE)::int AS live_n, " +
  "COUNT(*) FILTER (WHERE d.scratch IS TRUE)::int AS scratch_n " +
  "FROM cue c JOIN room_day d ON d.id = c.room_day_id WHERE d.ist_date = $1::date " +
  "AND NOT EXISTS (SELECT 1 FROM unnest(" + "ARRAY[" + HELD_DAYS.map((d) => `'${d}'`).join(",") + "]::date[], ARRAY[" + HELD_ROOMS.map((r) => `'${r}'`).join(",") + "]::text[]) AS hb(d, r) WHERE hb.d = d.ist_date AND hb.r = d.room_id)";

/** scribe_list_rooms: each room with its last session's start and status; a held-out session is never the "last session". */
export async function roomsWithLastSession(includeScratch: boolean, scratchPrefix: string): Promise<Row[]> {
  return (await sql`
    SELECT r.id, r.slug, r.name, r.created_at, r.disabled_at,
           ls.started_at AS last_session_at, ls.status AS last_session_status
      FROM room r
      LEFT JOIN LATERAL (
        SELECT bs.started_at, bs.status
          FROM bench_session bs
         WHERE bs.room_id = r.id
           AND NOT (EXISTS (SELECT 1 FROM unnest(${HELD_DAYS}::date[], ${HELD_ROOMS}::text[]) AS hb(d, r)
                  WHERE hb.r = bs.room_id AND (hb.d::timestamp AT TIME ZONE 'Asia/Kolkata') <= GREATEST(bs.started_at, bs.ended_at, (SELECT max(hc.ended_at) FROM bench_chunk hc WHERE hc.session_id = bs.id))
                    AND (hb.d::timestamp AT TIME ZONE 'Asia/Kolkata') + interval '1 day' > bs.started_at)
        OR EXISTS (SELECT 1 FROM bench_window hw LEFT JOIN room_diarize_window hd ON hd.window_id = hw.id, room_day hr, unnest(${HELD_DAYS}::date[], ${HELD_ROOMS}::text[]) AS hb2(d, r)
                    WHERE hw.session_id = bs.id AND hr.id IN (hw.room_day_id, hd.room_day_id) AND hb2.d = hr.ist_date AND hb2.r = hr.room_id))
         ORDER BY bs.started_at DESC
         LIMIT 1
      ) ls ON true
     WHERE ${includeScratch}::boolean
        OR left(r.id, length(${scratchPrefix}::text)) <> ${scratchPrefix}::text
     ORDER BY r.created_at
  `) as Row[];
}

// --- admin routes ---------------------------------------------------------------------------------------------------------------------------
/** /api/admin/bench/windows: the windows of a session; a held-out session is refused. */
export async function adminSessionWindows(sessionId: string): Promise<{ error: "blind_room_day" } | { rows: Row[] }> {
  if ((await guardSessionSpan(sessionId)) === "blind_room_day") return { error: "blind_room_day" };
  const rows = (await sql`
    SELECT id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key,
           grid_aligned, state, closed_at, created_at
      FROM bench_window WHERE session_id = ${sessionId}
     ORDER BY start_ms ASC, source_mic ASC
  `) as Row[];
  return { rows };
}

/** /api/admin/stt-lab/runs[/id]: the bench window row of a run subject; a window with ANY held-out placement is refused. */
export async function adminWindowRow(id: string): Promise<{ error: "blind_room_day" } | { rows: Row[] }> {
  const rows = (await sql`
    SELECT id, session_id, start_ms, end_ms, source_mic, state, room_day_id
      FROM bench_window WHERE id = ${id} LIMIT 1
  `) as Row[];
  if (rows[0] && (await windowBlindAny(id))) return { error: "blind_room_day" };
  return { rows };
}

/** /api/admin/speaker-calibration: the stored diarize answers of a session's windows; a held-out session is refused. */
export async function adminDiarizeAnswers(sessionId: string): Promise<{ error: "blind_room_day" } | { rows: Array<{ window_id: string; speakers_json: unknown }> }> {
  if ((await guardSessionSpan(sessionId)) === "blind_room_day") return { error: "blind_room_day" };
  const rows = (await sql`
    SELECT d.window_id, d.speakers_json
      FROM room_diarize_window d
      JOIN bench_window w ON w.id = d.window_id
     WHERE w.session_id = ${sessionId}
       AND d.state = 'ok'
     ORDER BY w.start_ms ASC
  `) as Array<{ window_id: string; speakers_json: unknown }>;
  return { rows };
}

/** /api/admin/bench/drain: per-window drain/ASR status of a session (transcript LENGTHS only); a held-out session is refused. */
export async function adminDrainRows(sessionId: string): Promise<{ error: "blind_room_day" } | { rows: Row[]; roomId: string | null }> {
  if ((await guardSessionSpan(sessionId)) === "blind_room_day") return { error: "blind_room_day" };
  const rows = (await sql`
    SELECT w.id, w.start_ms, w.end_ms, w.source_mic, w.state, w.clip_r2_key, w.room_day_id,
           w.grid_aligned,
           j.state AS job_state, j.attempts, j.last_error,
           r.id AS run_id, r.engine, r.stt_engine_id, r.detected_language,
           r.latency_ms, r.metrics_json,
           length(r.transcript_original) AS transcript_chars
      FROM bench_window w
      LEFT JOIN stt_subject_job j
             ON j.subject_type = 'bench_window' AND j.subject_id = w.id AND j.tier = 'asr'
      LEFT JOIN transcription_run r
             ON r.subject_type = 'bench_window' AND r.subject_id = w.id
     WHERE w.session_id = ${sessionId}
     ORDER BY w.start_ms ASC, w.source_mic ASC
  `) as Row[];
  const srows = (await sql`SELECT room_id FROM bench_session WHERE id = ${sessionId} LIMIT 1`) as Array<{ room_id: string }>;
  return { rows, roomId: srows[0]?.room_id ?? null };
}


// --- scribe_tape_day ------------------------------------------------------------------------------------------------------------------------
const BLIND_DAYS = HELD_DAYS;
const BLIND_ROOMS = HELD_ROOMS;

/** scribe_tape_day: the per-room day rollup, held-out (room, IST day) rows EXCLUDED in SQL and counted. */
export async function tapeDayRows(day: string, roomId: string | null) {
  const rows = (await sql`
    SELECT room_id, ist_day, min_off, min_muted, min_zero_all_day, min_present, min_gated, min_withheld,
           consult_min_usable, consult_min_uncertain, consult_min_lost, n_consults, classifier_version, written_at
      FROM room_audio_day
     WHERE ist_day = ${day}::date AND (${roomId}::text IS NULL OR room_id = ${roomId}::text)
       AND NOT EXISTS (SELECT 1 FROM unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE b.d = room_audio_day.ist_day AND b.r = room_audio_day.room_id)
     ORDER BY room_id
     LIMIT 100
  `) as Array<Record<string, unknown>>;
  const blindN = (await sql`
    SELECT count(*)::int AS n FROM room_audio_day
     WHERE ist_day = ${day}::date AND EXISTS (SELECT 1 FROM unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE b.d = room_audio_day.ist_day AND b.r = room_audio_day.room_id)
  `) as Array<{ n: number }>;
  const nBlind = Number(blindN[0]?.n ?? 0);
  return { rows, nBlind };
}

/** The state segments of ONE room-day (the caller has already refused a held-out pair). */
export async function tapeDaySegments(roomId: string, day: string, max: number): Promise<Array<Record<string, unknown>>> {
  const seg = (await sql`
    SELECT state, ts_start, ts_end
      FROM room_audio_state
     WHERE room_id = ${roomId}::text AND ist_day = ${day}::date
     ORDER BY ts_start
     LIMIT ${max}
  `) as Array<Record<string, unknown>>;
  return seg;
}

/** /api/admin/measure-windows: how many windows still wait for the level measurement (counts only); held-out windows are left out. */
export async function measurePendingCount(): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n
      FROM bench_window w
     WHERE w.state IN ('closed', 'transcribing', 'transcribed', 'failed', 'silent')
       AND NOT EXISTS (SELECT 1 FROM stt_window_measure m WHERE m.window_id = w.id)
       AND NOT EXISTS (SELECT 1 FROM unnest(${HELD_DAYS}::date[], ${HELD_ROOMS}::text[]) AS hb(d, r), room_day hr
                        WHERE hb.d = hr.ist_date AND hb.r = hr.room_id AND (
                          hr.id = w.room_day_id
                          OR hr.id IN (SELECT hd.room_day_id FROM room_diarize_window hd WHERE hd.window_id = w.id)
                          OR hr.id IN (SELECT ht.room_day_id FROM room_turn_speaker ht WHERE ht.window_id = w.id)))
  `) as Array<{ n: number }>;
  return Number(rows[0]?.n) || 0;
}
