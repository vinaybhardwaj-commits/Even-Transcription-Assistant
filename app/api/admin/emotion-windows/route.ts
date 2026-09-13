/**
 * /api/admin/emotion-windows — ENQUEUE emotion scoring for diarized windows. It writes nothing itself.
 *
 * ITS OWN ROUTE AND ITS OWN CRON, not a second scan inside /api/admin/diarize-windows: a failed
 * emotion scan must not turn the diarize enqueue's answer into a failure, and the reverse. Separate
 * failure domains, the same way the two jobs are separate.
 *
 * SHIPS DARK. EMOTION_ENABLED unset is a clean no-op.
 *
 * AUTH: Bearer CRON_SECRET or Bearer MIGRATION_SECRET on GET; admin cookie or Bearer MIGRATION_SECRET
 * on POST. A bare x-vercel-cron header does not authorise (C2).
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { enqueueEmotionWindows } from "@/lib/emotion/enqueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function bearerIs(req: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const want = Buffer.from(`Bearer ${secret}`, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

async function run(req: NextRequest, actor: string) {
  try {
    const r = await enqueueEmotionWindows({ actor, origin: req.nextUrl.origin });
    return respondOk({ enabled: r.enabled, busy: r.busy, jobs: r.enqueued, exhausted: r.exhausted });
  } catch (e) {
    return respondError("PIPELINE_FAILED", `emotion enqueue failed: ${String((e as Error)?.message ?? e).slice(0, 200)} — no job refs are valid for this call`);
  }
}

export async function GET(req: NextRequest) {
  if (!(bearerIs(req, process.env.CRON_SECRET) || bearerIs(req, process.env.MIGRATION_SECRET))) {
    return respondError("AUTH_REQUIRED", "cron or migration secret required");
  }
  return run(req, "cron:emotion_windows");
}

export async function POST(req: NextRequest) {
  let ok = bearerIs(req, process.env.MIGRATION_SECRET);
  if (!ok) {
    const cookie = await readAdminCookie();
    if (cookie) {
      try { await verifyAdminJwt(cookie); ok = true; } catch { /* intentional: not an admin session, refused below */ }
    }
  }
  if (!ok) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run(req, "admin_route:emotion_windows");
}
