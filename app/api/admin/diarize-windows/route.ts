/**
 * /api/admin/diarize-windows — ENQUEUE room diarization. It writes nothing itself.
 *
 * Per eligible window (closed, grid-aligned, with a room_day and a joined clip, not yet diarized
 * and not already queued) this submits a `diarize_window` job and returns the job refs. The job is
 * the only writer of `room_diarize_window` and `room_turn_speaker`. Speaker clustering has no
 * writer at all — see CLUSTERING_STATUS in lib/brain/state.ts.
 *
 * There is no `?dry=1` any more and no second path. `dry` used to diarize and store without
 * clustering, to accumulate calibration data; the job now stores that data on every run, so the
 * mode had nothing left to be different about.
 *
 * SHIPS DARK. `SPEAKER_CLUSTERS_ENABLED` is the on-switch for the scheduled enqueue. Unset, this is
 * a clean no-op. It exists because this route runs every five minutes and the job runner every
 * minute: without it, deploying this would start diarizing every closed window on the Mini.
 *
 * AUTH: `x-vercel-cron`, or Bearer CRON_SECRET / MIGRATION_SECRET on GET; admin cookie or Bearer
 * MIGRATION_SECRET on POST (the manual door).
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { enqueueDiarizeWindows, DIARIZE_BATCH_LIMIT } from "@/lib/stt/diarize-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Enqueueing is a handful of inserts; nothing here waits on the Mini. */
export const maxDuration = 60;

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

async function run(req: NextRequest, actor: string) {
  const p = req.nextUrl.searchParams;
  const rawLimit = Number(p.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(DIARIZE_BATCH_LIMIT, Math.trunc(rawLimit))
    : DIARIZE_BATCH_LIMIT;

  // ─── A FAILED ENQUEUE MUST NOT LOOK LIKE SUCCESS ───────────────────────────────────────────
  // Two ways to fail: a read that degraded (it records into `errors`), or a submit that threw (it
  // propagates). Either one returns PIPELINE_FAILED. `enqueued: []` on a 200 must only ever mean
  // "there was nothing eligible", never "we could not look" or "we could not queue".
  let result;
  try {
    result = await enqueueDiarizeWindows({ limit, origin: req.nextUrl.origin, actor });
  } catch (e) {
    return respondError("PIPELINE_FAILED", `diarize enqueue failed: ${String((e as Error)?.message ?? e).slice(0, 160)} — no job refs are valid for this call`);
  }
  if (result.errors.length > 0) {
    return respondError(
      "PIPELINE_FAILED",
      `diarize enqueue had ${result.errors.length} failure(s): scanned=${result.scanned} enqueued=${result.enqueued.length} — an empty list here is NOT "nothing eligible"`,
    );
  }
  return respondOk({ enabled: result.enabled, scanned: result.scanned, jobs: result.enqueued });
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron header or secret required");
  return run(req, "cron:diarize_windows");
}

export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run(req, "admin_route:diarize_windows");
}
