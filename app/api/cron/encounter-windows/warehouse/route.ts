/**
 * GET /api/cron/encounter-windows/warehouse — fill eta_encounter_windows' warehouse_* / consulting_* columns from Pulse's
 * own consult record in the Even warehouse (Metabase db 13). Logic: lib/encounter-windows/warehouse-cron.ts and
 * lib/encounter-windows/warehouse-attribution.ts. Migration 0124 must be applied first.
 *
 * Every 2 minutes (vercel.json), no query string. `?hours=N` (1..720, default 36) is a backfill: it works through the
 * queue in batches of 500 for up to 50 s and reports complete=false when it stopped early; call again to continue.
 * BEARER, NOT COOKIE: CRON_SECRET unset -> 503, wrong bearer -> 401, bad hours -> 400. Response: counts only.
 */
import { handleWarehouseCron } from "@/lib/encounter-windows/warehouse-cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  return handleWarehouseCron(req);
}
