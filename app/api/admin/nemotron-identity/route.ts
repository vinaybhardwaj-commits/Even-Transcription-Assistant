/**
 * /api/admin/nemotron-identity — ENQUEUE the ECAPA identity pass over stored Nemotron rows (epic #23, ticket c).
 * It writes nothing itself; the nemotron_identity job is the only writer of 0141's tables.
 *
 * SHIPS DARK: NEMOTRON_IDENTITY_ENABLED off (the shipped state) answers enabled:false and queues nothing.
 *
 * AUTH, as /api/admin/diarize-windows: Bearer CRON_SECRET or MIGRATION_SECRET on GET (the cron); admin cookie or
 * Bearer MIGRATION_SECRET on POST (the manual door).
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { enqueueNemotronIdentity, IDENTITY_BATCH_LIMIT } from "@/lib/diarize-nemotron/identity-enqueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Whole-header, constant-time. An empty or unset secret never authorises. */
function bearerIs(req: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const want = Buffer.from(`Bearer ${secret}`, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
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
  const raw = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(IDENTITY_BATCH_LIMIT, Math.trunc(raw)) : IDENTITY_BATCH_LIMIT;
  try {
    const r = await enqueueNemotronIdentity({ limit, origin: req.nextUrl.origin, actor });
    return respondOk({ enabled: r.enabled, centroid_set: r.centroid_set, scanned: r.scanned, jobs: r.enqueued });
  } catch (e) {
    // a bad flag or centroid-set value, a failed read or a failed submit: never a 200 that reads as "nothing to do"
    return respondError("PIPELINE_FAILED", `nemotron identity enqueue failed: ${e instanceof Error ? e.name : "error"} — no job refs are valid for this call`);
  }
}

export async function GET(req: NextRequest) {
  if (!(bearerIs(req, process.env.CRON_SECRET) || bearerIs(req, process.env.MIGRATION_SECRET))) {
    return respondError("AUTH_REQUIRED", "cron or migration secret required");
  }
  return run(req, "cron:nemotron_identity");
}

export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run(req, "admin_route:nemotron_identity");
}
