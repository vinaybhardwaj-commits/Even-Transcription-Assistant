/**
 * /api/admin/diarize-windows — the room diarize cron (PRD §7, Build 4 §A).
 *
 * Per newly closed window with a joined clip and no diarize row: fetch the clip, call the Mini's
 * diarize service through the depth-1 slot, write the speakers into clusters and bind the turns.
 *
 * SHIPS DARK. `SPEAKER_CLUSTERS_ENABLED` is the gate; unset, this is a clean no-op with one log
 * line and no database work at all. It is scheduled anyway so that turning it on is an env edit
 * rather than a deploy — and so the schedule itself is reviewable before it ever runs.
 *
 * AND IT STAYS DARK UNTIL THE THRESHOLD IS FROZEN. Even with the gate on, a pass that would write
 * clusters refuses while `SPEAKER_MATCH_THRESHOLD` is unset. The sequence PRD §7 asks for:
 *
 *   1. `SPEAKER_CLUSTERS_ENABLED=1`, then `POST ?dry=1` — diarizes and stores the service's
 *      answer, writes NO clusters and NO bindings.
 *   2. `GET /api/admin/speaker-calibration` — the sweep, read by the orchestrator and V.
 *   3. `SPEAKER_MATCH_THRESHOLD=<frozen value>`, then let the cron run for real.
 *
 * Step 1 exists so step 3 does not need a night of Mini time to re-diarize the same windows.
 *
 * EVERY 5 MINUTES, FOUR WINDOWS AT A TIME. The Mini's diarize service is single-worker and
 * serialises; the depth-1 slot means a second caller waits rather than piling on. A small batch
 * on a short cadence drains a backlog without ever holding the slot for a whole invocation.
 *
 * AUTH: the Build 1 cron pattern — `x-vercel-cron`, or Bearer CRON_SECRET / MIGRATION_SECRET on
 * GET; admin cookie or Bearer MIGRATION_SECRET on POST (the manual door).
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { runRoomDiarizePass, DIARIZE_BATCH_LIMIT } from "@/lib/stt/diarize-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A diarize call is minutes, and the slot wait is budgeted against this ceiling. */
export const maxDuration = 300;

function cronAuthorized(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") || "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  const migrationSecret = process.env.MIGRATION_SECRET;
  // An EMPTY secret must never authorise.
  if (migrationSecret && auth === `Bearer ${migrationSecret}`) return true;
  return false;
}

async function adminOrSecret(req: NextRequest): Promise<boolean> {
  const secret = process.env.MIGRATION_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return true;
  const cookie = await readAdminCookie();
  if (cookie) {
    try { await verifyAdminJwt(cookie); return true; } catch { /* fall through */ }
  }
  return false;
}

async function run(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const rawLimit = Number(p.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(DIARIZE_BATCH_LIMIT, Math.trunc(rawLimit))
    : DIARIZE_BATCH_LIMIT;
  // `dry` diarizes and stores, but clusters nothing — the data the threshold is chosen from.
  const dry = p.get("dry") === "1";
  const result = await runRoomDiarizePass({ limit, dry, origin: req.nextUrl.origin });
  return respondOk(result);
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron header or secret required");
  return run(req);
}

export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run(req);
}
