/** GET /api/admin/stt-lab/gold — gold set summary: labeled encounters, candidates, per-engine WER. */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

export async function GET(_req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const gold = (await sql`
    SELECT g.encounter_id, g.reference_language, g.terms_model, g.labeled_at,
           jsonb_array_length(g.critical_terms_json) AS terms,
           e.patient_label_raw, e.recorded_at
      FROM stt_gold g JOIN encounter e ON e.id = g.encounter_id
     ORDER BY g.labeled_at DESC
  `) as unknown[];

  const candidates = (await sql`
    SELECT e.id, e.patient_label_raw, e.recorded_at, e.detected_language,
           COUNT(DISTINCT tr.engine)::int AS engines
      FROM encounter e
      JOIN transcription_run tr ON tr.encounter_id = e.id AND tr.mode = 'batch' AND tr.tier = 'asr' AND tr.error IS NULL
     WHERE e.id NOT IN (SELECT encounter_id FROM stt_gold)
     GROUP BY e.id, e.patient_label_raw, e.recorded_at, e.detected_language
     ORDER BY e.recorded_at DESC NULLS LAST
     LIMIT 100
  `) as unknown[];

  const perEngine = (await sql`
    SELECT engine,
           COUNT(*) FILTER (WHERE wer IS NOT NULL)::int AS gold_n,
           ROUND(AVG(wer)::numeric, 3)::float8 AS avg_wer,
           ROUND(AVG(cer)::numeric, 3)::float8 AS avg_cer,
           ROUND(AVG(med_term_recall)::numeric, 3)::float8 AS avg_term_recall
      FROM transcription_run
     WHERE mode = 'batch' AND tier = 'asr' AND wer IS NOT NULL
     GROUP BY engine ORDER BY engine
  `) as unknown[];

  return respondOk({ gold, candidates, per_engine: perEngine });
}
