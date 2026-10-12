/**
 * GET /api/admin/fleet/releases — read-only: the rollout stage of every version and each device's cohorts and bucket. Admin cookie only. Nothing secret (no signatures, no keys).
 */
import { sql } from "@/lib/db";
import { adminIdFromCookie } from "@/lib/fleet/admin-auth";
import { fleetError, fleetReply } from "@/lib/fleet/http";
import { bucketOf } from "@/lib/fleet/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET() {
  if (!(await adminIdFromCookie())) return fleetError(401, "admin_required");
  try {
    const rollouts = (await sql`
      SELECT version, channel, pkg_url, pkg_sha256, pkg_size::text AS pkg_size, min_helper, cohort, rollout_pct, set_by,
             to_char(set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS set_at
        FROM fleet_release_rollout ORDER BY set_at DESC LIMIT 50
    `) as Array<Record<string, unknown>>;
    const devices = (await sql`
      SELECT d.device_id, d.machine, d.status, COALESCE((SELECT array_agg(c.cohort ORDER BY c.cohort) FROM fleet_device_cohort c WHERE c.device_id = d.device_id), ARRAY[]::text[]) AS cohorts
        FROM fleet_devices d ORDER BY d.machine LIMIT 100
    `) as Array<{ device_id: string; machine: string; status: string; cohorts: string[] }>;
    return fleetReply(200, {
      ok: true,
      rollouts,
      devices: devices.map((d) => ({ ...d, buckets: Object.fromEntries(rollouts.map((r) => [`${r.version}`, bucketOf(d.device_id, String(r.version))])) })),
    });
  } catch (e) {
    console.error("[admin-fleet-releases] database fault:", e instanceof Error ? e.name.slice(0, 32) : "error");
    return fleetError(503, "db");
  }
}
