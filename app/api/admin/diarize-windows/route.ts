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
 * SHIPS DARK. `ROOM_DIARIZE_ENABLED` is the on-switch for the scheduled enqueue.
 * (Renamed from SPEAKER_CLUSTERS_ENABLED in C2; the old name is ignored and logged.) Unset, this is
 * a clean no-op. It exists because this route runs every five minutes and the job runner every
 * minute: without it, deploying this would start diarizing every closed window on the Mini.
 *
 * AUTH: Bearer CRON_SECRET or Bearer MIGRATION_SECRET on GET; admin cookie or Bearer MIGRATION_SECRET
 * on POST (the manual door).
 *
 * THE BARE `x-vercel-cron` HEADER NO LONGER AUTHORISES. It is a request header: anyone can send
 * it, and whether Vercel strips a client-supplied copy is not something this route can check. Vercel
 * Cron sends `Authorization: Bearer ${CRON_SECRET}` on every scheduled call when CRON_SECRET is set,
 * which is the proof `/api/jobs/run` already requires.
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { enqueueDiarizeWindows, DIARIZE_BATCH_LIMIT } from "@/lib/stt/diarize-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Enqueueing is a handful of inserts; nothing here waits on the Mini. */
export const maxDuration = 60;

/** Whole-header, constant-time. An empty or unset secret never authorises. */
function bearerIs(req: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const want = Buffer.from(`Bearer ${secret}`, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

function cronAuthorized(req: NextRequest): boolean {
  return bearerIs(req, process.env.CRON_SECRET) || bearerIs(req, process.env.MIGRATION_SECRET);
}

async function adminOrSecret(req: NextRequest): Promise<boolean> {
  if (bearerIs(req, process.env.MIGRATION_SECRET)) return true;
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
  return respondOk({ enabled: result.enabled, scanned: result.scanned, jobs: result.enqueued, exhausted: result.exhausted });
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron or migration secret required");
  return run(req, "cron:diarize_windows");
}

export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run(req, "admin_route:diarize_windows");
}
