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
 *
 * ?rediarize=1 (23 Aug 2026) — re-run DIARIZATION ONLY on one encounter.
 * diarize_status='failed' is terminal by design (needDiarize excludes it), so a historically
 * timed-out encounter can never be picked up again on its own. The only existing door was
 * ?reset=1, which clears note_json and cdmss_json — regenerating months-old clinical content to
 * fix a speaker label is not a trade anyone should make. This clears the diarization fields and
 * nothing else, and drives /process with {only:"diarize"} so no other step can run.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 300;

async function resumeOne(origin: string, slug: string, id: string, only?: string): Promise<boolean> {
  // Drive the step machine SYNCHRONOUSLY: each call runs ONE step IN-REQUEST (the /process
  // function stays alive while the heavy translate/CDS work executes — Vercel after() does
  // NOT reliably run the heavy translate step on fire-and-forget invocations). We loop the
  // sync calls here, within this route's own 300s budget, to drain the encounter to
  // completion. With note-first, the encounter reaches 'complete' after translate→note→
  // finalize; CDS+diarize enrichment follows if budget remains.
  const deadline = Date.now() + 250_000;
  let guard = 0;
  try {
    while (Date.now() < deadline && guard++ < 30) {
      const res = await fetch(`${origin}/${slug}/api/encounters/${id}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "x-eta-internal": process.env.MIGRATION_SECRET as string },
        body: JSON.stringify({ step: true, sync: true, ...(only ? { only } : {}) }),
        cache: "no-store",
      });
      const j = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> } & Record<string, unknown>;
      const d = (j && typeof j.data === "object" && j.data) ? j.data : j;
      const step = d?.step as string | undefined;
      if (step === "done") return true;
      if (d?.jobPending) { await new Promise((r) => setTimeout(r, 6000)); continue; } // long-file chunked job: poll
      if (d?.skipped === "locked") { await new Promise((r) => setTimeout(r, 2000)); continue; } // another worker holds the lock
      if (d?.progressed === true) continue; // drive the next step immediately
      break; // not progressed / error / unknown → stop; TTL + next tick + reaper handle it
    }
    return true;
  } catch { return false; }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  // Vercel cron auth: when CRON_SECRET is set, Vercel sends "Authorization: Bearer <CRON_SECRET>"
  // on every scheduled invocation. The legacy x-vercel-cron header is NOT reliably present on this
  // project (it 401'd every cron run, so nothing was ever resumed). Accept either signal.
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!req.headers.get("x-vercel-cron") || (!!cronSecret && auth === `Bearer ${cronSecret}`);
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
    const rediarize = req.nextUrl.searchParams.get("rediarize") === "1";
    if (rediarize) {
      // Diarization fields ONLY. status, note_json, cdmss_json, translated, transcripts and the
      // flag are all left exactly as they are; the per-step claim preserves 'complete'.
      // E31 batch 2, B1 — the previous run's speaker-tagged turns and roster go in the SAME statement. Left in place,
      // a re-run whose tag block failed held the new run's roster over the old run's turns, named against the old
      // roster. Safe for the EER matcher: it selects only diarize_status = 'complete', which this has just cleared.
      await sql`UPDATE encounter SET diarize_status = NULL, diarize_error = NULL,
                  tagged_transcript = NULL, speakers = NULL,
                  process_attempts = 0, processing_step_at = NULL
                WHERE id = ${manualId}`;
      await resumeOne(origin, rows[0].slug, rows[0].id, "diarize");
      // Report what actually happened rather than that the loop finished. A run that never got
      // the depth-1 slot leaves diarize_status='running' on purpose (it is retryable, not
      // failed), and the caller needs to be able to tell that apart from a success.
      const stateAfter = (await sql`
        SELECT diarize_status, diarize_error, diarize_timing,
               jsonb_array_length(COALESCE(speakers, '[]'::jsonb)) AS speaker_count
          FROM encounter WHERE id = ${manualId}
      `) as Array<{ diarize_status: string | null; diarize_error: string | null; diarize_timing: unknown; speaker_count: number }>;
      return respondOk({ encounter: manualId, mode: "rediarize", ...(stateAfter[0] ?? {}) });
    }
    if (reset) {
      // E31 batch 2 round 1b — as on the rediarize door above: the previous run's speaker-tagged turns, roster and
      // degraded-state code go in the SAME statement that clears diarize_status. Left in place, a reprocess whose tag
      // block failed held the new run's roster over the old run's turns, in admin and through MCP.
      await sql`UPDATE encounter SET status = 'processing', process_attempts = 0, processing_step_at = NULL,
                  translated = false, note_json = NULL, cdmss_json = NULL,
                  transcript_flag = NULL, transcript_flag_reason = NULL,
                  diarize_status = NULL, diarize_error = NULL,
                  tagged_transcript = NULL, speakers = NULL,
                  processing_pct = 0, processing_stages = NULL
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
       AND e.recorded_at > now() - interval '24 hours'  -- auto-heal only RECENT stuck encounters; back-catalogue recovery is a deliberate paced op (reset=1), not a standing cron, so it can't saturate the N=1 Mini router
       AND e.process_attempts < 15
     ORDER BY e.recorded_at ASC LIMIT 1
  `) as Array<{ id: string; slug: string }>;
  if (!rows[0]) return respondOk({ resumed: 0 });
  const ok = await resumeOne(origin, rows[0].slug, rows[0].id);
  return respondOk({ resumed: ok ? 1 : 0, encounter: rows[0].id });
}
