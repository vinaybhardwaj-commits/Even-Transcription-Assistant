/**
 * POST /api/admin/fleet/releases/rollout — open a published room-app release to a rollout stage (TS-H8 #45). ADMIN COOKIE ONLY; nothing else can move a rollout (no cron, no worker).
 * Body: { version, channel, pkg_url, pkg_sha256, pkg_size, min_helper?, cohort, rollout_pct? } and nothing else. `cohort` is the stage the version is open to NOW:
 * home_office | audiometry | opd1 (devices an admin put in that cohort), pct (devices whose bucket is under rollout_pct), all. Moving a stage is another call with a new cohort/pct;
 * `pct` with rollout_pct 0 opens it to nobody (a halt). The version must be a published, un-withdrawn macOS release. The pkg fields are the admin's statement of what the helper
 * will download (the server validates their shape and host, not the bytes). One fleet_audit row per call, written in the same statement. Sends nothing to any Mac.
 * 200 {ok, from} · 400 bad_body|bad_* · 401 admin_required · 404 release_not_published · 413 · 503 db
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { adminIdFromCookie } from "@/lib/fleet/admin-auth";
import { fleetError, fleetReply, readCapped } from "@/lib/fleet/http";
import { setRollout, type RolloutInput } from "@/lib/fleet/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const KEYS = new Set(["version", "channel", "pkg_url", "pkg_sha256", "pkg_size", "min_helper", "cohort", "rollout_pct"]);

export async function POST(req: NextRequest) {
  const admin = await adminIdFromCookie();
  if (!admin) return fleetError(401, "admin_required");
  const text = await readCapped(req, 4096);
  if (text === null) return fleetError(413, "too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fleetError(400, "bad_json");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((k) => !KEYS.has(k))) return fleetError(400, "bad_body");
  try {
    const r = await setRollout(sql as never, `operator:${admin}`, body as RolloutInput);
    if (r.ok) return fleetReply(200, { ok: true, from: r.from });
    return fleetError(r.reason === "release_not_published" ? 404 : r.reason === "db" ? 503 : 400, r.reason);
  } catch (e) {
    console.error("[admin-fleet-rollout] database fault:", e instanceof Error ? e.name.slice(0, 32) : "error");
    return fleetError(503, "db");
  }
}
