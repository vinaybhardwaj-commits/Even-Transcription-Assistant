/**
 * GET /api/cron/encounter-windows/sweep — the hourly 48-hour sweep (vercel.json, minute 7, no query string).
 * Same handler as ../route.ts, forced into sweep mode (any ?mode= is ignored; ?hours=N still means a backfill).
 * Full contract: app/api/cron/encounter-windows/route.ts.
 */
import { handleCron } from "@/lib/encounter-windows/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  return handleCron(req, "sweep");
}
