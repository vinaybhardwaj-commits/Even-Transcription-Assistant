/**
 * GET /api/cron/encounter-windows — recompute eta_encounter_windows. The logic is lib/encounter-windows/cron.ts
 * (shared with ./sweep/route.ts); this door's default is RECENT mode.
 *
 * TWO DOORS, NO QUERY STRING IN vercel.json:
 *   /api/cron/encounter-windows         (every 5 minutes)  the last 3 h: a consult is final within 90 min of opening (the
 *                                       cap) plus the 60 s pairing window, so 3 h is every window that can still change.
 *   /api/cron/encounter-windows/sweep   (hourly, minute 7) the last 48 h: catches events that arrived late (retry queues).
 * Manual calls: `?mode=recent|sweep` on this door; `?hours=N` (1..720) is a backfill on either door, and `?from=<ISO>`
 * restarts a stopped backfill.
 * Every mode refreshes through refreshWindowsByDay: the range is cut at IST midnights and each day is its own fetch and
 * its own transaction (each day reads events to the end of the whole range, so a consult opened before midnight keeps a
 * late close). A run stops starting new days after 50 s and reports complete=false with next_from; call again with
 * ?hours=N&from=<next_from> to continue.
 *
 * BEARER, NOT COOKIE — same shape as app/api/admin/room-watchdog/route.ts: Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` and carries no session. CRON_SECRET unset -> 503 and NOTHING runs; wrong
 * bearer -> 401. Unknown mode or a bad `hours` / `from` -> 400.
 *
 * Each refresh is idempotent (delete rows with t_open in range, insert fresh, one transaction per day), so a retried or
 * overlapping run converges on the same rows.
 *
 * Response: counts only — consults, unpaired_refs, by_quality, by_attribution, by_close_reason. No ids, no names.
 * A failure returns 500 { error: { code: "REFRESH_FAILED" } } and logs a generic reason; days already committed stay.
 */
import { handleCron } from "@/lib/encounter-windows/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  return handleCron(req);
}
