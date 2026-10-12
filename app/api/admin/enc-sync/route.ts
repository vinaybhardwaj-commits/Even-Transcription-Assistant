/**
 * /api/admin/enc-sync — every 15 min, syncs the box's ENC export (R2 eta-lab-results enc/) into enc_room_day and enc_isolation.
 *
 * AUTH: Bearer CRON_SECRET or Bearer MIGRATION_SECRET on GET (the schedule); admin cookie or Bearer MIGRATION_SECRET on POST (the manual door).
 * 200 { ok, dates_in_manifest, dates_changed, dates_ok, room_days_written, isolations_written, rows_skipped, outcomes }; an unreadable store or manifest is a non-200 PIPELINE_FAILED.
 * Counts and codes only; never a row.
 */
import { NextRequest } from "next/server";
import { respondOk, respondError } from "@/lib/respond";
import { adminOrSecret, cronAuthorized } from "@/lib/enc/auth";
import { syncEnc } from "@/lib/enc/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function run() {
  let r;
  try {
    r = await syncEnc();
  } catch (e) {
    return respondError("PIPELINE_FAILED", `enc sync failed: ${String((e as Error)?.name ?? "error")}`);
  }
  if (!r.ok) return respondError("PIPELINE_FAILED", `enc sync failed: ${r.error}`);
  const { ok: _ok, ...counts } = r;
  return respondOk({ ok: true, ...counts });
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron or migration secret required");
  return run();
}
export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run();
}
