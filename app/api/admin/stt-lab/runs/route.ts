/** GET /api/admin/stt-lab/runs — encounters that have batch ASR runs (list view). */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

  const rows = (await sql`
    SELECT e.id, e.patient_label_raw, e.recorded_at, e.detected_language, e.note_type,
           COUNT(DISTINCT tr.engine)::int AS engines,
           COUNT(*) FILTER (WHERE tr.error IS NOT NULL)::int AS errored,
           (SELECT w.engine FROM transcription_run w WHERE w.encounter_id = e.id AND w.mode='batch' AND w.tier='asr' AND w.is_winner LIMIT 1) AS winner,
           EXISTS(SELECT 1 FROM stt_gold g WHERE g.encounter_id = e.id) AS has_gold,
           ROUND(AVG(tr.judge_score)::numeric, 2)::float8 AS avg_judge
      FROM encounter e
      JOIN transcription_run tr ON tr.encounter_id = e.id AND tr.mode='batch' AND tr.tier='asr'
     GROUP BY e.id, e.patient_label_raw, e.recorded_at, e.detected_language, e.note_type
     ORDER BY e.recorded_at DESC NULLS LAST
     LIMIT ${limit}
  `) as unknown[];
  return respondOk({ runs: rows });
}
