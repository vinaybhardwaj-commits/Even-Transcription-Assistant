/**
 * lib/rubrics/evr/select.ts — S7-2: the run-time window selection for the evr_perturb bench. The bench FILE holds only the rule, a seed and a count; the ids are chosen here, inside the job.
 * Rule: closed consult windows opened on or after 2026-10-02 (the first day of eta_encounter_windows), with a warehouse prescription uid, in a room-day that is NOT held out (excluded in the
 * query, before the LIMIT), with a stored transcript (an overlapping bench window that has stt_turn cues, OR S7-2B a reb_track_index row of layer translate / stt with status ok for the consult); order md5(consult_key || seed); the first N.
 */
import { sql } from "@/lib/db";
import { BLIND_ROOM_DAYS } from "../blind-room-days";

export const EVR_FIRST_DAY = "2026-10-02";

export async function selectEvrWindows(n: number, seed: number): Promise<string[]> {
  const days = BLIND_ROOM_DAYS.map(([d]) => d), rooms = BLIND_ROOM_DAYS.map(([, r]) => r);
  const rows = (await sql`
    SELECT w.consult_key FROM eta_encounter_windows w
     WHERE w.t_close IS NOT NULL AND w.t_open >= ${EVR_FIRST_DAY}::date AND w.warehouse_prescription_uid IS NOT NULL AND w.consult_uid IS NOT NULL AND w.room_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM unnest(${days}::date[], ${rooms}::text[]) AS b(d, r) WHERE b.d = (w.t_open AT TIME ZONE 'Asia/Kolkata')::date AND b.r = w.room_id)
       -- SWEEP (REL2-R3): consult_uid is not unique (one row per machine): a consult is out if ANY row carrying its uid is on a held-out pair
       AND NOT EXISTS (SELECT 1 FROM eta_encounter_windows s, unnest(${days}::date[], ${rooms}::text[]) AS b2(d, r) WHERE s.consult_uid = w.consult_uid AND b2.d = (s.t_open AT TIME ZONE 'Asia/Kolkata')::date AND b2.r = s.room_id)
       AND (EXISTS (SELECT 1 FROM bench_window bw JOIN bench_session s ON s.id = bw.session_id
                    JOIN cue c ON c.room_day_id = bw.room_day_id AND c.type = 'stt_turn' AND (c.payload->'window'->>'start_ms')::bigint = bw.start_ms
                   WHERE s.room_id = w.room_id AND bw.start_ms < (extract(epoch FROM w.t_close) * 1000)::bigint AND bw.end_ms > (extract(epoch FROM w.t_open) * 1000)::bigint)
            OR EXISTS (SELECT 1 FROM reb_track_index x WHERE x.window_id = 'consult-' || w.consult_uid AND x.status = 'ok' AND x.shadow = false AND x.layer IN ('translate', 'stt')))
     ORDER BY md5(w.consult_key || ${String(seed)}::text), w.consult_key
     LIMIT ${Math.max(1, Math.min(200, n))}::int
  `) as Array<{ consult_key: string }>;
  return rows.map((r) => r.consult_key);
}
