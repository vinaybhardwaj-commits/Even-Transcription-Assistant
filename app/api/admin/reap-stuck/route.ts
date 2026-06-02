/**
 * POST /api/admin/reap-stuck — sweep encounters wedged in 'processing'.
 *
 * If the /process serverless call is killed/timed-out before it can write a
 * terminal status, the encounter is left 'processing' forever — invisible as a
 * failure and never retried. This reaper moves anything that has been
 * 'processing' longer than `minutes` (default 30; normal processing is < ~2 min
 * even with diarization) into a recoverable terminal state:
 *   - note_json present  -> 'draft_partial' (doctor can "use as-is and send")
 *   - no note yet        -> 'failed'
 * and records an audit_log row so it surfaces to admins.
 *
 * Auth: Bearer MIGRATION_SECRET (cron/manual) OR an admin cookie.
 * Body: { minutes?: number, dryRun?: boolean }.
 * Additive -- nothing in the doctor recording/submit path changes. Designed to
 * be safe to run on a schedule.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.MIGRATION_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return true;
  const cookie = await readAdminCookie();
  if (cookie) {
    try { await verifyAdminJwt(cookie); return true; } catch { /* fall through */ }
  }
  return false;
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return respondError("AUTH_REQUIRED", "admin or migration secret required");
  }

  let body: { minutes?: number; dryRun?: boolean } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty body ok */ }
  const minutes = Math.min(Math.max(Number(body.minutes) || 30, 5), 24 * 60);
  const dryRun = body.dryRun === true;

  // Candidates: still 'processing', not deleted, started long enough ago.
  // recorded_at is the proxy for "processing since" (finalize-upload flips to
  // 'processing' right after recording; no separate processing_started_at).
  let candidates: Array<{ id: string; has_note: boolean; recorded_at: string }>;
  try {
    candidates = (await sql`
      SELECT id, (note_json IS NOT NULL) AS has_note, recorded_at
        FROM encounter
       WHERE status = 'processing'
         AND deleted_at IS NULL
         AND recorded_at < NOW() - make_interval(mins => ${minutes})
       ORDER BY recorded_at ASC
       LIMIT 200
    `) as Array<{ id: string; has_note: boolean; recorded_at: string }>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }

  if (dryRun || candidates.length === 0) {
    return respondOk({
      dry_run: dryRun,
      minutes,
      stuck_count: candidates.length,
      stuck: candidates,
      reaped_partial: [],
      reaped_failed: [],
    });
  }

  // Flip to recoverable terminal states. Two scoped UPDATEs with the SAME
  // staleness predicate so we never touch a row that has since progressed.
  let reapedPartial: string[] = [];
  let reapedFailed: string[] = [];
  try {
    reapedPartial = ((await sql`
      UPDATE encounter SET status = 'draft_partial', updated_at = NOW()
       WHERE status = 'processing' AND deleted_at IS NULL
         AND recorded_at < NOW() - make_interval(mins => ${minutes})
         AND note_json IS NOT NULL
      RETURNING id
    `) as Array<{ id: string }>).map((r) => r.id);

    reapedFailed = ((await sql`
      UPDATE encounter SET status = 'failed', updated_at = NOW()
       WHERE status = 'processing' AND deleted_at IS NULL
         AND recorded_at < NOW() - make_interval(mins => ${minutes})
         AND note_json IS NULL
      RETURNING id
    `) as Array<{ id: string }>).map((r) => r.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }

  const total = reapedPartial.length + reapedFailed.length;
  if (total > 0) {
    await sql`
      INSERT INTO audit_log
        (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES
        ('system', 'reaper', 'encounter.reap_stuck', 'encounter', NULL,
         ${JSON.stringify({ minutes, reaped_partial: reapedPartial, reaped_failed: reapedFailed })}::jsonb)
    `.catch(() => {});
  }

  return respondOk({
    dry_run: false,
    minutes,
    stuck_count: total,
    reaped_partial: reapedPartial,
    reaped_failed: reapedFailed,
  });
}
