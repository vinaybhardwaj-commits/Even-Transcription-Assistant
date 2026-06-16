/**
 * Resume-processing cron + manual recovery.
 *
 * Long recordings (>~5min) can exceed a single serverless invocation's 300s
 * budget, so the finalize after() pipeline dies mid-run and the encounter is
 * stranded in 'processing'. /process is now RESUMABLE (skips translate/native/
 * note/CDS/diarize already done), so re-invoking it drives the encounter to
 * completion across a few ticks. This route does ONE encounter per tick (drained
 * to completion within its own 300s) — serialized, no concurrent double-runs.
 *
 * Auth: Vercel cron header (x-vercel-cron) or Bearer MIGRATION_SECRET.
 * Cron: pick the oldest encounter stuck in 'processing' > 4 min.
 * Manual recovery: ?id=enc_xxx resurrects that encounter (failed/processing) and resumes it.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 300;

async function resumeOne(origin: string, slug: string, id: string): Promise<boolean> {
  try {
    // Kick the resumable step machine (ONE step per invocation; self-chaining).
    const res = await fetch(`${origin}/${slug}/api/encounters/${id}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-eta-internal": process.env.MIGRATION_SECRET as string },
      body: JSON.stringify({ step: true }),
      cache: "no-store",
    });
    await res.text().catch(() => {});
    return true;
  } catch { return false; }
}

export async function GET(req: NextRequest) {
  const isCron = !!req.headers.get("x-vercel-cron");
  const auth = req.headers.get("authorization");
  const secretOk = !!process.env.MIGRATION_SECRET && auth === `Bearer ${process.env.MIGRATION_SECRET}`;
  if (!isCron && !secretOk) return respondError("AUTH_REQUIRED", "cron or migration secret required");
  if (!process.env.MIGRATION_SECRET) return respondError("PIPELINE_FAILED", "MIGRATION_SECRET not set");

  const origin = req.nextUrl.origin;
  const manualId = req.nextUrl.searchParams.get("id");

  if (manualId && secretOk) {
    // Manual recovery: resurrect (failed -> processing; keep transcripts/translated) and resume.
    // NOTE: clinician.url_slug IS the full public path (token already appended); do NOT re-concat url_token.
    const rows = (await sql`
      SELECT e.id, c.url_slug AS slug, e.transcript_original FROM encounter e JOIN clinician c ON c.id = e.doctor_id
       WHERE e.id = ${manualId} AND e.deleted_at IS NULL LIMIT 1
    `) as Array<{ id: string; slug: string; transcript_original: string | null }>;
    if (!rows[0]) return respondError("NOT_FOUND", "encounter_not_found");
    // ?reset=1 — full RE-PROCESS from the saved audio: clear the derived outputs
    // (note/CDS/translation/flag/diarize) so the step machine regenerates them via
    // the current pipeline (incl. the English Whisper-refine + guardrail). Use to
    // recover encounters that completed with an empty/garbled note before the fixes.
    const reset = req.nextUrl.searchParams.get("reset") === "1";
    if (reset) {
      await sql`UPDATE encounter SET status = 'processing', process_attempts = 0, processing_step_at = NULL,
                  translated = false, note_json = NULL, cdmss_json = NULL,
                  transcript_flag = NULL, transcript_flag_reason = NULL,
                  diarize_status = NULL, processing_pct = 0, processing_stages = NULL
                WHERE id = ${manualId}`;
    } else {
      // Resurrect: back to processing, fresh attempt budget. Let the step machine
      // decide what still needs doing (it skips already-completed steps).
      await sql`UPDATE encounter SET status = 'processing', process_attempts = 0, processing_step_at = NULL WHERE id = ${manualId}`;
    }
    const ok = await resumeOne(origin, rows[0].slug, rows[0].id);
    return respondOk({ resumed: ok ? 1 : 0, encounter: manualId, mode: reset ? "reset" : "manual" });
  }

  // Cron: oldest encounter stuck in 'processing' for > 4 minutes.
  const rows = (await sql`
    SELECT e.id, c.url_slug AS slug FROM encounter e JOIN clinician c ON c.id = e.doctor_id
     WHERE e.status IN ('processing','failed') AND e.deleted_at IS NULL
       AND e.recorded_at < now() - interval '4 minutes'
       AND e.recorded_at > now() - interval '30 days'  -- wide enough to drain back-catalogue recoveries (reset=1); bounded by process_attempts<15
       AND e.process_attempts < 15
     ORDER BY e.recorded_at ASC LIMIT 1
  `) as Array<{ id: string; slug: string }>;
  if (!rows[0]) return respondOk({ resumed: 0 });
  const ok = await resumeOne(origin, rows[0].slug, rows[0].id);
  return respondOk({ resumed: ok ? 1 : 0, encounter: rows[0].id });
}
