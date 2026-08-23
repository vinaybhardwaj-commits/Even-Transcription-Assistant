/**
 * GET /api/admin/stt-lab/runs — subjects that have batch ASR runs (list view).
 *
 * K4a C1 — THE JOIN IS THE WHOLE CHANGE. This used to read `FROM encounter e JOIN
 * transcription_run tr ON tr.encounter_id = e.id`, which cannot express a run whose subject is
 * not an encounter, and which would DROP one silently rather than show it wrong: an inner join
 * from encounter simply never produces the row. It now starts from transcription_run and LEFT
 * JOINs outwards, so a bench_window run appears with its encounter columns NULL.
 *
 * Grouping is on (subject_type, subject_id), not on the encounter. `id` is still returned and
 * is still the encounter id for an encounter subject — 0059's CHECK guarantees
 * subject_id = encounter_id there — so the existing UI's links keep working untouched.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { subjectOf, type SubjectRowish } from "@/lib/stt/subject";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

  const rows = (await sql`
    SELECT tr.subject_type, tr.subject_id,
           tr.subject_id AS id,
           e.patient_label_raw, e.recorded_at, e.detected_language, e.note_type,
           bw.start_ms  AS window_start_ms,
           bw.end_ms    AS window_end_ms,
           bw.source_mic AS window_source_mic,
           bw.session_id AS window_session_id,
           COUNT(DISTINCT tr.engine)::int AS engines,
           COUNT(*) FILTER (WHERE tr.error IS NOT NULL)::int AS errored,
           (SELECT w.engine FROM transcription_run w
             WHERE w.subject_type = tr.subject_type AND w.subject_id = tr.subject_id
               AND w.mode='batch' AND w.tier='asr' AND w.is_winner LIMIT 1) AS winner,
           -- stt_gold is keyed on encounter_id, so a room window is never gold. Written as an
           -- explicit false rather than a join that would quietly be NULL.
           (tr.subject_type = 'encounter'
             AND EXISTS(SELECT 1 FROM stt_gold g WHERE g.encounter_id = tr.subject_id)) AS has_gold,
           ROUND(AVG(tr.judge_score)::numeric, 2)::float8 AS avg_judge
      FROM transcription_run tr
      LEFT JOIN encounter e ON e.id = tr.encounter_id
      LEFT JOIN bench_window bw ON tr.subject_type = 'bench_window' AND bw.id = tr.subject_id
     WHERE tr.mode='batch' AND tr.tier='asr'
     GROUP BY tr.subject_type, tr.subject_id, e.patient_label_raw, e.recorded_at,
              e.detected_language, e.note_type, bw.start_ms, bw.end_ms, bw.source_mic, bw.session_id
     -- One clock for both kinds: an encounter is placed by when it was recorded, a window by
     -- where it sits on the tape.
     ORDER BY COALESCE(e.recorded_at, to_timestamp(bw.start_ms / 1000.0)) DESC NULLS LAST
     LIMIT ${limit}
  `) as Array<Record<string, unknown>>;

  return respondOk({
    runs: rows.map((r) => ({ ...r, subject: subjectOf(r as SubjectRowish) })),
  });
}
