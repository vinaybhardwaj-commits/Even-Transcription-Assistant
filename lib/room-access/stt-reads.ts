/**
 * lib/room-access/stt-reads.ts — GUARD: the SQL of the STT MCP tools (scribe_route_tripwires, scribe_list_stt_runs, scribe_get_stt_run's window lookup, scribe_window_speakers), moved out of
 * lib/mcp/tools/stt.ts. Every read leaves out, or refuses, a window with ANY held-out placement.
 */
import { sql } from "@/lib/db";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";
import { guardRoomDay, guardWindow, rtsBlindRows, windowsBlindAny } from "./check";

const BLIND_DAYS_ARG = BLIND_ROOM_DAYS.map(([d]) => d);
const BLIND_ROOMS_ARG = BLIND_ROOM_DAYS.map(([, r]) => r);

/** scribe_route_tripwires: the per-engine figures over room-window runs, held-out windows (ANY placement) EXCLUDED in SQL, and how many runs that left out. */
export async function routeTripwireData(days: number, engine: string | null) {
  const rows = (await sql`
    SELECT tr.engine,
           COUNT(*)::int AS runs,
           COUNT(*) FILTER (WHERE tr.error IS NOT NULL)::int AS errors,
           COUNT(*) FILTER (WHERE tr.error IS NULL
                              AND COALESCE(length(COALESCE(tr.transcript_original, tr.transcript_english, '')), 0) = 0)::int AS empty_runs,
           SUM(COALESCE(length(COALESCE(tr.transcript_original, tr.transcript_english, '')), 0))::bigint AS chars,
           SUM(COALESCE((tr.metrics_json->>'audio_seconds')::float8, 0))::float8 AS audio_seconds,
           COUNT(*) FILTER (WHERE tr.metrics_json ? 'language_timeline')::int AS runs_with_timeline
      FROM transcription_run tr
     WHERE tr.subject_type = 'bench_window'
       AND tr.mode = 'batch' AND tr.tier = 'asr'
       AND tr.created_at >= NOW() - ((${days})::int || ' days')::interval
       AND (${engine ?? null}::text IS NULL OR tr.engine = ${engine ?? null})
       AND NOT EXISTS (SELECT 1 FROM bench_window w LEFT JOIN room_diarize_window dw ON dw.window_id = w.id WHERE w.id = tr.subject_id AND (
             EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
             OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
             OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
             OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id)))
     GROUP BY tr.engine
     ORDER BY tr.engine
  `) as Array<{ engine: string; runs: number; errors: number; empty_runs: number; chars: string | number; audio_seconds: number | null; runs_with_timeline: number }>;

  // The two per-span mixes. Precomputed at write time into the same key, so this sums small
  // objects instead of unnesting every span of every run in the window.
  const mixes = (await sql`
    SELECT tr.engine,
           COALESCE(SUM((tr.metrics_json->'language_timeline'->>'span_count')::int), 0)::int AS spans,
           jsonb_object_agg(k.key, k.total) FILTER (WHERE k.key IS NOT NULL) AS engine_mix
      FROM transcription_run tr
      LEFT JOIN LATERAL (
             SELECT e.key, SUM(e.value::int)::int AS total
               FROM jsonb_each_text(COALESCE(tr.metrics_json->'language_timeline'->'engine_mix', '{}'::jsonb)) e
              GROUP BY e.key
           ) k ON TRUE
     WHERE tr.subject_type = 'bench_window'
       AND tr.mode = 'batch' AND tr.tier = 'asr'
       AND tr.metrics_json ? 'language_timeline'
       AND tr.created_at >= NOW() - ((${days})::int || ' days')::interval
       AND (${engine ?? null}::text IS NULL OR tr.engine = ${engine ?? null})
       AND NOT EXISTS (SELECT 1 FROM bench_window w LEFT JOIN room_diarize_window dw ON dw.window_id = w.id WHERE w.id = tr.subject_id AND (
             EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
             OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
             OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
             OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id)))
     GROUP BY tr.engine
  `) as Array<{ engine: string; spans: number; engine_mix: Record<string, number> | null }>;

  const langMixes = (await sql`
    SELECT tr.engine,
           jsonb_object_agg(k.key, k.total) FILTER (WHERE k.key IS NOT NULL) AS language_mix
      FROM transcription_run tr
      LEFT JOIN LATERAL (
             SELECT e.key, SUM(e.value::int)::int AS total
               FROM jsonb_each_text(COALESCE(tr.metrics_json->'language_timeline'->'language_mix', '{}'::jsonb)) e
              GROUP BY e.key
           ) k ON TRUE
     WHERE tr.subject_type = 'bench_window'
       AND tr.mode = 'batch' AND tr.tier = 'asr'
       AND tr.metrics_json ? 'language_timeline'
       AND tr.created_at >= NOW() - ((${days})::int || ' days')::interval
       AND (${engine ?? null}::text IS NULL OR tr.engine = ${engine ?? null})
       AND NOT EXISTS (SELECT 1 FROM bench_window w LEFT JOIN room_diarize_window dw ON dw.window_id = w.id WHERE w.id = tr.subject_id AND (
             EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
             OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
             OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
             OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id)))
     GROUP BY tr.engine
  `) as Array<{ engine: string; language_mix: Record<string, number> | null }>;

  // K3-4: runs of a window with ANY held-out placement are left out of every figure above and counted here
  const blindN = (await sql`
    SELECT COUNT(*)::int AS n FROM transcription_run tr
     WHERE tr.subject_type = 'bench_window' AND tr.mode = 'batch' AND tr.tier = 'asr'
       AND tr.created_at >= NOW() - ((${days})::int || ' days')::interval
       AND (${engine ?? null}::text IS NULL OR tr.engine = ${engine ?? null})
       AND EXISTS (SELECT 1 FROM bench_window w LEFT JOIN room_diarize_window dw ON dw.window_id = w.id WHERE w.id = tr.subject_id AND (
             EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
             OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
             OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
             OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id)))
  `) as Array<{ n: number }>;

  return { rows, mixes, langMixes, blindN };
}

/** scribe_list_stt_runs: one row per subject (encounter or bench window); a window with ANY held-out placement is left out and counted. */
export async function listSttRunSubjects(limit: number) {
  const rows = (await sql`
    SELECT tr.subject_type, tr.subject_id, tr.subject_id AS id,
           e.patient_label_raw, e.recorded_at, e.detected_language, e.note_type,
           bw.start_ms AS window_start_ms, bw.end_ms AS window_end_ms,
           bw.source_mic AS window_source_mic, bw.session_id AS window_session_id,
           COUNT(DISTINCT tr.engine)::int AS engines,
           COUNT(*) FILTER (WHERE tr.error IS NOT NULL)::int AS errored,
           (SELECT w.engine FROM transcription_run w
             WHERE w.subject_type = tr.subject_type AND w.subject_id = tr.subject_id
               AND w.mode='batch' AND w.tier='asr' AND w.is_winner LIMIT 1) AS winner,
           (tr.subject_type = 'encounter'
             AND EXISTS(SELECT 1 FROM stt_gold g WHERE g.encounter_id = tr.subject_id)) AS has_gold,
           ROUND(AVG(tr.judge_score)::numeric, 2)::float8 AS avg_judge
      FROM transcription_run tr
      LEFT JOIN encounter e ON e.id = tr.encounter_id
      LEFT JOIN bench_window bw ON tr.subject_type = 'bench_window' AND bw.id = tr.subject_id
     WHERE tr.mode='batch' AND tr.tier='asr'
     GROUP BY tr.subject_type, tr.subject_id, e.patient_label_raw, e.recorded_at,
              e.detected_language, e.note_type, bw.start_ms, bw.end_ms, bw.source_mic, bw.session_id
     ORDER BY COALESCE(e.recorded_at, to_timestamp(bw.start_ms / 1000.0)) DESC NULLS LAST
     LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  // SWEEP (REL2-R3): a run whose subject is a bench window with ANY held-out placement is not listed (counted)
  const blindWins = await windowsBlindAny(rows.filter((r) => r.subject_type === "bench_window").map((r) => String(r.subject_id)));
  const visible = rows.filter((r) => !(r.subject_type === "bench_window" && blindWins.has(String(r.subject_id))));
  const nBlindExcluded = rows.length - visible.length;
  return { visible, nBlindExcluded };
}

/** The bench window row a run subject id names (placement-free metadata), or []. */
export async function benchWindowRow(id: string): Promise<Array<Record<string, unknown>>> {
  return (await sql`SELECT id, session_id, start_ms, end_ms, source_mic, state FROM bench_window WHERE id = ${id} LIMIT 1`) as Array<Record<string, unknown>>;
}

/** scribe_window_speakers: the turn rows of a window or room-day, after the held-out checks (S6-BLIND placement, B1 every row's own placement). */
export async function readTurnSpans(f: { windowId: string | null; roomDayId: string | null; limit: number }): Promise<{ error: string } | { spans: Array<{ speaker_idx: number; role: string | null; clinician_id: string | null }> }> {
  const { windowId, roomDayId, limit } = f;
  // S6-BLIND: placement first, content after. A held-out room-day is refused blind_room_day and an unplaced window window_unplaced, before room_turn_speaker is read.
  if (windowId) { const g = await guardWindow(windowId); if (g) return { error: g }; }
  if (roomDayId) { const g = await guardRoomDay(roomDayId); if (g) return { error: g }; }
  // B1: each turn row has placements of its own (rts.room_day_id) besides its window's: if ANY row asked for is held out by ANY of them, the whole answer is refused (fail closed), before a span is read
  if ((await rtsBlindRows({ windowId, roomDayId })) > 0) return { error: "blind_room_day" };

  const spans = (await sql`
    SELECT window_id, source_ref, speaker_idx, overlap_ms, room_day_id,
           clinician_id, role, match_confidence, created_at
      FROM room_turn_speaker
     WHERE (${windowId ?? null}::text IS NULL OR window_id = ${windowId ?? null})
       AND (${roomDayId ?? null}::text IS NULL OR room_day_id = ${roomDayId ?? null})
     ORDER BY window_id, source_ref
     LIMIT ${limit}
  `) as Array<{ speaker_idx: number; role: string | null; clinician_id: string | null }>;

  return { spans };
}
