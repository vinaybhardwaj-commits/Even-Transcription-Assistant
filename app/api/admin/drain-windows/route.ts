/**
 * /api/admin/drain-windows — Slice S1. The scheduled caller of the room drain.
 *
 * Per eligible window (closed, grid-aligned, with a room_day, closed within
 * AUTO_DRAIN_MAX_AGE_HOURS, no room_window job already queued or running) this calls
 * `drainRoomWindow`, which claims the window and submits the `room_window` job. Newest first, at
 * most AUTO_DRAIN_BATCH_LIMIT per call. See lib/stt/auto-drain.ts for why the cap is one.
 *
 * SHIPS DARK. `ROOM_AUTO_DRAIN_ENABLED` is the on-switch. Unset, this is a clean no-op returning
 * `enqueued: 0`. The room's own Transcript switch still decides per window, inside the drain.
 *
 * ACTOR: SYSTEM_ACTOR with via "cron", on both verbs — `enqueueAutoDrain` takes no actor.
 *
 * AUTH: Bearer CRON_SECRET or Bearer MIGRATION_SECRET on GET; admin cookie or Bearer MIGRATION_SECRET
 * on POST (the manual door). Copied from /api/admin/diarize-windows, including its reason: the bare
 * `x-vercel-cron` header does not authorise.
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { enqueueAutoDrain, AUTO_DRAIN_BATCH_LIMIT, AUTO_DRAIN_MAX_AGE_HOURS } from "@/lib/stt/auto-drain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The drain's guards, one claim and one job insert per window; the work itself is on the job. */
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

/** Steps that mean the drain could not do its own work — not a per-window refusal. */
const FAILED_STEPS = new Set(["no_actor", "engine_failed"]);

async function run(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const rawLimit = Number(p.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(AUTO_DRAIN_BATCH_LIMIT, Math.trunc(rawLimit))
    : AUTO_DRAIN_BATCH_LIMIT;

  // ─── A FAILED DRAIN MUST NOT LOOK LIKE SUCCESS ─────────────────────────────────────────────
  // A bad flag value or a failed scan throws; a drain that could not submit names engine_failed.
  // Either returns PIPELINE_FAILED. `enqueued: 0` on a 200 must only ever mean "nothing eligible"
  // or "every window was refused by name" (flag_off, wrong_state, ...), never "we could not look".
  let result;
  try {
    result = await enqueueAutoDrain(req.nextUrl.origin, { limit });
  } catch (e) {
    return respondError("PIPELINE_FAILED", `auto-drain failed: ${String((e as Error)?.message ?? e).slice(0, 160)} — no job refs are valid for this call`);
  }
  const failed = result.results.filter((r) => FAILED_STEPS.has(r.step));
  if (failed.length > 0) {
    return respondError(
      "PIPELINE_FAILED",
      `auto-drain had ${failed.length} failure(s) (${failed.map((r) => r.step).join(",")}): considered=${result.considered} enqueued=${result.enqueued}`,
    );
  }
  return respondOk({ ...result, cap: limit, max_age_hours: AUTO_DRAIN_MAX_AGE_HOURS });
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron or migration secret required");
  return run(req);
}

export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run(req);
}
