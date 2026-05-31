/** GET /api/admin/stt-lab/runs/[id] — per-encounter engine transcripts + all scores + gold. */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const enc = (await sql`SELECT id, patient_label_raw, recorded_at, detected_language, note_type FROM encounter WHERE id = ${id} LIMIT 1`) as Array<Record<string, unknown>>;
  if (!enc[0]) return respondError("NOT_FOUND", "encounter_not_found");
  const runs = (await sql`
    SELECT engine, tier, transcript_english, transcript_original, note_text, latency_ms, error,
           judge_score, agreement_score, wer, cer, med_term_recall, is_winner, metrics_json
      FROM transcription_run
     WHERE encounter_id = ${id} AND mode='batch'
     ORDER BY tier, is_winner DESC, engine
  `) as unknown[];
  const gold = (await sql`SELECT reference_original, reference_english, reference_language, critical_terms_json, terms_model FROM stt_gold WHERE encounter_id = ${id} LIMIT 1`) as unknown[];
  return respondOk({ encounter: enc[0], runs, gold: gold[0] ?? null });
}
