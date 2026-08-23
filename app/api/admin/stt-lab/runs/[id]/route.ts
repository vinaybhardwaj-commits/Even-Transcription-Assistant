/**
 * GET /api/admin/stt-lab/runs/[id] — one SUBJECT's engine transcripts, scores and gold.
 *
 * K4a C1 — `id` here is a SUBJECT id, which for an encounter is still the encounter id (0059
 * guarantees subject_id = encounter_id), so every existing link keeps working. The lookup no
 * longer refuses a subject that is not an encounter: it resolves whichever kind the runs say
 * it is, and returns the encounter block as null for a room window rather than 404-ing on it.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { subjectOf, type SubjectRowish } from "@/lib/stt/subject";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  // What kind of subject is this? Ask the runs, which is the only place that knows.
  const kindRows = (await sql`
    SELECT DISTINCT subject_type FROM transcription_run WHERE subject_id = ${id} LIMIT 2
  `) as Array<{ subject_type: string }>;
  const subjectType = kindRows[0]?.subject_type ?? "encounter";

  const enc = (await sql`
    SELECT id, patient_label_raw, recorded_at, detected_language, note_type
      FROM encounter WHERE id = ${id} LIMIT 1
  `) as Array<Record<string, unknown>>;
  const win = (await sql`
    SELECT id, session_id, start_ms, end_ms, source_mic, state, room_day_id
      FROM bench_window WHERE id = ${id} LIMIT 1
  `) as Array<Record<string, unknown>>;

  // Nothing anywhere knows this id.
  if (!enc[0] && !win[0] && kindRows.length === 0) return respondError("NOT_FOUND", "subject_not_found");

  const runs = (await sql`
    SELECT engine, tier, transcript_english, transcript_original, note_text, latency_ms, error,
           judge_score, agreement_score, wer, cer, med_term_recall, is_winner, metrics_json
      FROM transcription_run
     WHERE subject_id = ${id} AND mode='batch'
     ORDER BY tier, is_winner DESC, engine
  `) as unknown[];
  // Gold is encounter-only by construction (stt_gold.encounter_id). A room window has none,
  // and asking for one is answered null rather than left undefined.
  const gold = (await sql`
    SELECT reference_original, reference_english, reference_language, critical_terms_json, terms_model
      FROM stt_gold WHERE encounter_id = ${id} LIMIT 1
  `) as unknown[];

  const shape: SubjectRowish = {
    subject_type: subjectType,
    subject_id: id,
    patient_label_raw: enc[0]?.patient_label_raw,
    window_start_ms: win[0]?.start_ms,
    window_end_ms: win[0]?.end_ms,
    window_source_mic: win[0]?.source_mic,
    window_session_id: win[0]?.session_id,
  };

  return respondOk({
    subject: subjectOf(shape),
    // Kept under its original name so the existing UI keeps rendering. NULL for a room window,
    // which the UI already handles — it falls back to the id.
    encounter: enc[0] ?? null,
    window: win[0] ?? null,
    runs,
    gold: gold[0] ?? null,
  });
}
