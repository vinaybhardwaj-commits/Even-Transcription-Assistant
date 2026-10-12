/**
 * POST /api/admin/fleet/releases/cohorts — put a registered device in named update cohorts (TS-H8 #45). ADMIN COOKIE ONLY.
 * Body: { device_id, cohorts: [home_office|audiometry|opd1, ...] } (replaces the device's memberships; [] clears them). One fleet_audit row, written in the same statement.
 * 200 {ok} · 400 bad_body|bad_device_id|bad_cohort · 401 admin_required · 404 unknown_device · 413 · 503 db
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { adminIdFromCookie } from "@/lib/fleet/admin-auth";
import { fleetError, fleetReply, readCapped } from "@/lib/fleet/http";
import { setDeviceCohorts } from "@/lib/fleet/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  const admin = await adminIdFromCookie();
  if (!admin) return fleetError(401, "admin_required");
  const text = await readCapped(req, 2048);
  if (text === null) return fleetError(413, "too_large");
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return fleetError(400, "bad_json");
  }
  if (typeof b !== "object" || b === null || Array.isArray(b)) return fleetError(400, "bad_body");
  const o = b as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "device_id" && k !== "cohorts")) return fleetError(400, "bad_body");
  if (typeof o.device_id !== "string" || !/^dev_[a-f0-9]{24}$/.test(o.device_id)) return fleetError(400, "bad_device_id");
  if (!Array.isArray(o.cohorts) || o.cohorts.length > 3 || !o.cohorts.every((c) => typeof c === "string")) return fleetError(400, "bad_cohort");
  try {
    const r = await setDeviceCohorts(sql as never, `operator:${admin}`, o.device_id, o.cohorts as string[]);
    if (r.ok) return fleetReply(200, { ok: true });
    return fleetError(r.reason === "unknown_device" ? 404 : r.reason === "db" ? 503 : 400, r.reason);
  } catch (e) {
    console.error("[admin-fleet-cohorts] database fault:", e instanceof Error ? e.name.slice(0, 32) : "error");
    return fleetError(503, "db");
  }
}
