/**
 * GET /api/admin/bench/levels-retention/report — what retention WOULD delete, room by room.
 *
 * WHY (overnight order, 22-23 Sep: "a dry-run report route so we can see what it would delete
 * before it deletes anything"). POST .../levels-retention with `dryRun:true` already answers "how
 * many rows total" — this route answers "which rooms, how many each, and over what span" so an
 * operator deciding whether to set BENCH_LEVEL_RETENTION=on can see the shape of the deletion, not
 * just its size.
 *
 * READ-ONLY BY CONSTRUCTION: this file has no POST, no write path, and never calls
 * purgeOldLevelSamplesBatch. Nothing here can delete a row, however it is called or with whatever
 * body or flag — there is no flag to pass.
 *
 * Auth: the same admin cookie OR Bearer MIGRATION_SECRET as .../levels-retention.
 * No transcript text, no clinician or patient identity — bench_level_sample holds none; the
 * response is room ids, counts and dates only.
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import {
  LEVEL_RETENTION_DAYS,
  levelRetentionCutoffIstDate,
  countOldLevelSamples,
  oldLevelSamplesByRoom,
} from "@/lib/bench-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function adminOrSecret(req: NextRequest): Promise<boolean> {
  const secret = process.env.MIGRATION_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return true;
  const cookie = await readAdminCookie();
  if (cookie) {
    try {
      await verifyAdminJwt(cookie);
      return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

export async function GET(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "Sign in required");
  try {
    const cutoff = levelRetentionCutoffIstDate();
    const [total, by_room] = await Promise.all([countOldLevelSamples(cutoff), oldLevelSamplesByRoom(cutoff)]);
    return respondOk({
      cutoff_ist_date: cutoff,
      retention_days: LEVEL_RETENTION_DAYS,
      would_delete_total: total,
      would_delete_by_room: by_room,
      rooms_affected: by_room.length,
    });
  } catch (e) {
    console.warn("[bench-levels-retention-report] failed", JSON.stringify({ err: String((e as Error)?.message ?? e).slice(0, 200) }));
    return respondError("PIPELINE_FAILED", "levels_retention_report_failed");
  }
}
