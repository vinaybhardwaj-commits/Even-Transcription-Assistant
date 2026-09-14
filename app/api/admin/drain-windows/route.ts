/**
 * /api/admin/drain-windows — Slice S1. The scheduled caller of the room drain.
 *
 * Per eligible window (closed, grid-aligned, with a room_day, closed within
 * AUTO_DRAIN_MAX_AGE_HOURS, not refused within AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES, no room_window job
 * already queued or running) this calls `drainRoomWindow`, which claims the window and submits the
 * `room_window` job. Newest first, at most AUTO_DRAIN_BATCH_LIMIT per call. See lib/stt/auto-drain.ts.
 *
 * SHIPS DARK. `ROOM_AUTO_DRAIN_ENABLED` is the on-switch. Unset, this is a clean no-op returning
 * `enqueued: 0`. The room's own Transcript switch still decides per window, inside the drain.
 *
 * TWO DOORS, TWO ACTORS.
 *   GET  — the cron. Bearer CRON_SECRET or Bearer MIGRATION_SECRET. Actor SYSTEM_ACTOR, via "cron".
 *          The bare `x-vercel-cron` header does not authorise (see /api/admin/diarize-windows).
 *   POST — the manual door. A SIGNED-IN ADMIN ONLY, resolved exactly as /api/admin/bench/drain does.
 *          Actor is that admin's id, via "admin_route". A manual drain spends, and spend is recorded
 *          against a person: a shared secret proves knowledge, not identity, so MIGRATION_SECRET is
 *          refused here rather than filed under an invented label. Automation belongs on GET.
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { isUsableActor, type RunActor } from "@/lib/stt/receipt";
import { enqueueAutoDrain, AUTO_DRAIN_BATCH_LIMIT, AUTO_DRAIN_MAX_AGE_HOURS, AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES, type AutoDrainResult } from "@/lib/stt/auto-drain";

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

/** The signed-in admin's id, as /api/admin/bench/drain resolves it. null = not signed in. */
async function guard(): Promise<string | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try {
    const c = await verifyAdminJwt(cookie);
    return String(c.admin_id ?? "");
  } catch {
    return null;
  }
}

/** Steps that mean the drain could not do its own work — not a per-window refusal. */
const FAILED_STEPS = new Set(["no_actor", "engine_failed"]);

/**
 * A step that fails the call. `join_failed` is a per-window outcome EXCEPT when the join service is not
 * configured: that fails every window forever, and a 200 over it is an always-green cron.
 */
function isFailure(r: AutoDrainResult["results"][number]): boolean {
  return FAILED_STEPS.has(r.step) || (r.step === "join_failed" && r.detail === "join_service_not_configured");
}

async function run(req: NextRequest, actor?: RunActor) {
  const p = req.nextUrl.searchParams;
  const rawLimit = Number(p.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(AUTO_DRAIN_BATCH_LIMIT, Math.trunc(rawLimit))
    : AUTO_DRAIN_BATCH_LIMIT;

  // ─── A FAILED DRAIN MUST NOT LOOK LIKE SUCCESS ─────────────────────────────────────────────
  // A bad flag value, an unusable actor, or a failed read or write throws; a drain that could not
  // submit names engine_failed; an unconfigured join service fails every window. Each returns
  // PIPELINE_FAILED. `enqueued: 0` on a 200 must only ever mean "nothing eligible" or "every window was
  // refused by name" (flag_off, wrong_state, ...), never "we could not look".
  let result;
  try {
    result = await enqueueAutoDrain(req.nextUrl.origin, { limit, ...(actor ? { actor } : {}) });
  } catch (e) {
    return respondError("PIPELINE_FAILED", `auto-drain failed: ${String((e as Error)?.message ?? e).slice(0, 160)} — no job refs are valid for this call`);
  }
  const failed = result.results.filter(isFailure);
  if (failed.length > 0) {
    return respondError(
      "PIPELINE_FAILED",
      `auto-drain had ${failed.length} failure(s) (${failed.map((r) => (r.detail ? `${r.step}:${r.detail}` : r.step)).join(",")}): considered=${result.considered} enqueued=${result.enqueued}`,
    );
  }
  return respondOk({ ...result, cap: limit, max_age_hours: AUTO_DRAIN_MAX_AGE_HOURS, refusal_cooldown_minutes: AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES });
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron or migration secret required");
  return run(req);
}

export async function POST(req: NextRequest) {
  const adminId = await guard();
  if (adminId === null) {
    return respondError("AUTH_REQUIRED", "a manual drain records spend against a person and requires a signed-in admin — a secret is not accepted on POST; the scheduled door is GET");
  }
  if (!isUsableActor(adminId)) return respondError("AUTH_REQUIRED", "admin_id_missing_from_token");
  return run(req, { actor: adminId, via: "admin_route" });
}
