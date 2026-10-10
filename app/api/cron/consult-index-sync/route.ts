/**
 * /api/cron/consult-index-sync — hourly sync of CONSULT's name-free index (R2 eta-lab-results consult/index/) into consult_index (0147); the first run is the backfill of every consult already cut.
 *
 * AUTH: Bearer CRON_SECRET or Bearer MIGRATION_SECRET on GET (the schedule); admin cookie or Bearer MIGRATION_SECRET on POST (the manual door). The bare x-vercel-cron header authorises nothing.
 * 200 { ok, sync_id, manifest_rows, rows_read, rows_written, inserted, changed, rows_skipped, skipped }; a store/integrity/db failure is a non-200 PIPELINE_FAILED, so "0 rows" never means "could not look".
 * Counts and codes only; never a row, a uid list or a name.
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { syncConsultIndex } from "@/lib/consult-index/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function bearerIs(req: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const want = Buffer.from(`Bearer ${secret}`, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}
const cronAuthorized = (req: NextRequest): boolean => bearerIs(req, process.env.CRON_SECRET) || bearerIs(req, process.env.MIGRATION_SECRET);
async function adminOrSecret(req: NextRequest): Promise<boolean> {
  if (bearerIs(req, process.env.MIGRATION_SECRET)) return true;
  const cookie = await readAdminCookie();
  if (cookie) {
    try { await verifyAdminJwt(cookie); return true; } catch { /* fall through */ }
  }
  return false;
}

async function run() {
  let r;
  try {
    r = await syncConsultIndex();
  } catch (e) {
    return respondError("PIPELINE_FAILED", `consult index sync failed: ${String((e as Error)?.name ?? "error")}`);
  }
  if (!r.ok) return respondError("PIPELINE_FAILED", `consult index sync failed: ${r.error} (sync ${r.sync_id})`);
  return respondOk({ sync_id: r.sync_id, manifest_rows: r.manifest_rows, rows_read: r.rows_read, rows_written: r.rows_written, inserted: r.inserted, changed: r.changed, rows_skipped: r.rows_skipped, skipped: r.skipped });
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron or migration secret required");
  return run();
}
export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run();
}
