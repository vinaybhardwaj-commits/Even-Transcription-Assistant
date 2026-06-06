/**
 * POST /api/admin/stt-lab/run-fanout — drain the STT fan-out queue.
 * Auth: Bearer MIGRATION_SECRET (for cron/manual) OR an admin cookie.
 * Body: { limit?: number, backfill?: boolean }. With backfill=true, enqueue
 * every encounter that has audio first, then drain up to `limit` jobs.
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { drainFanout, enqueueBackfill, fanoutStatus, resetAllJobs, dedupRuns, scribePending, scribeMissing, runScribeForEncounter } from "@/lib/stt/fanout";
import { scorePending, resetScores } from "@/lib/stt/scoring";

export const runtime = "nodejs";
export const maxDuration = 300;

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.MIGRATION_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return true;
  const cookie = await readAdminCookie();
  if (cookie) { try { await verifyAdminJwt(cookie); return true; } catch { /* fall through */ } }
  return false;
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  let body: { limit?: number; backfill?: boolean; status?: boolean; reset?: boolean; score?: boolean; rescore?: boolean; dedup?: boolean; scribe?: boolean; missing?: boolean; encounterId?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty body ok */ }
  if (body.status) return respondOk(await fanoutStatus());
  if (body.dedup) return respondOk(await dedupRuns());
  if (body.scribe) {
    if (body.encounterId) return respondOk(await runScribeForEncounter(body.encounterId));
    const limit = Math.min(Math.max(Number(body.limit) || 3, 1), 10);
    if (body.missing) return respondOk(await scribeMissing(limit));
    return respondOk(await scribePending(limit));
  }
  if (body.rescore) { const cleared = await resetScores(); return respondOk({ rescore_cleared: cleared }); }
  if (body.score) {
    const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 25);
    return respondOk(await scorePending(limit));
  }
  let reset = 0;
  if (body.reset) reset = await resetAllJobs();
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 25);

  let enqueued = 0;
  if (body.backfill) enqueued = await enqueueBackfill();
  const drain = await drainFanout(limit);
  return respondOk({ enqueued, reset, ...drain });
}
