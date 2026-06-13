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
    const res = await fetch(`${origin}/${slug}/api/encounters/${id}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", "x-eta-internal": process.env.MIGRATION_SECRET as string },
      body: JSON.stringify({ force: false }),
      cache: "no-store",
    });
    if (res.body) { const r = res.body.getReader(); while (true) { const { done } = await r.read(); if (done) break; } }
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
    const rows = (await sql`
      SELECT e.id, c.slug, e.transcript_original FROM encounter e JOIN clinician c ON c.id = e.doctor_id
       WHERE e.id = ${manualId} AND e.deleted_at IS NULL LIMIT 1
    `) as Array<{ id: string; slug: string; transcript_original: string | null }>;
    if (!rows[0]) return respondError("NOT_FOUND", "encounter_not_found");
    // mark translated if a translation already exists (skip re-translate on resume)
    await sql`UPDATE encounter SET status = 'processing', translated = (transcript_raw IS NOT NULL) WHERE id = ${manualId}`;
    const ok = await resumeOne(origin, rows[0].slug, rows[0].id);
    return respondOk({ resumed: ok ? 1 : 0, encounter: manualId, mode: "manual" });
  }

  // Cron: oldest encounter stuck in 'processing' for > 4 minutes.
  const rows = (await sql`
    SELECT e.id, c.slug FROM encounter e JOIN clinician c ON c.id = e.doctor_id
     WHERE e.status = 'processing' AND e.deleted_at IS NULL
       AND e.recorded_at < now() - interval '4 minutes'
     ORDER BY e.recorded_at ASC LIMIT 1
  `) as Array<{ id: string; slug: string }>;
  if (!rows[0]) return respondOk({ resumed: 0 });
  const ok = await resumeOne(origin, rows[0].slug, rows[0].id);
  return respondOk({ resumed: ok ? 1 : 0, encounter: rows[0].id });
}
