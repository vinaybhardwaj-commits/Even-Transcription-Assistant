import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { requireOps } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * POST /api/admin/wipe-smoke-residue
 *
 * Clears all smoke + test data so the system is ready to onboard real
 * physician data. Keeps the 4 super_admin profiles + 4 hospitals + the
 * shared positions catalogue + profile_hospital_roles intact.
 *
 * Extended in CR.5+ to cover the new credentialing tables (oppe_reviews,
 * privilege_requests, vc_prescreen_hospitals, incident_views) and to
 * drop the stale `positions.hospital_id` JOIN that v3.0a removed.
 *
 * Idempotent — safe to re-run; subsequent runs just confirm empty state.
 */
export async function POST(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const log: string[] = [];

  // 1. Rebadge V's profile to Hospital PM (positions catalogue is now shared
  //    network-wide; the v14 migration dropped positions.hospital_id).
  const hospitalPm = (await sql`
    SELECT id::text AS id FROM positions WHERE position_name = 'Hospital PM' LIMIT 1
  `) as Array<{ id: string }>;
  if (hospitalPm.length === 0) {
    return NextResponse.json({ ok: false, error: "Hospital PM position not found" }, { status: 500, headers: NO_STORE });
  }
  const newPositionId = hospitalPm[0].id;
  const updateProfile = (await sql`
    UPDATE profiles SET position_id = ${newPositionId}::uuid, updated_at = NOW()
    WHERE email = 'vinay.bhardwaj@even.in'
    RETURNING id::text AS id, email
  `) as Array<Record<string, unknown>>;
  log.push(`1. Rebadged V to Hospital PM (${updateProfile.length} profile updated)`);

  // 2. TRUNCATE in dependency order. Wipe NEW credentialing tables FIRST so
  //    DELETE FROM physicians at the end doesn't have to cascade through them.
  await sql`TRUNCATE privilege_requests RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE oppe_reviews        RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE incident_views      RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE incident_replies    RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE incidents           RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE clinical_metrics_monthly RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE qualifications      RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE privileges          RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE vc_observation_cases RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE vc_prescreen_hospitals RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE vc_prescreens       RESTART IDENTITY CASCADE`;
  log.push(`2. Truncated: privilege_requests, oppe_reviews, incident_views, incidents+replies, clinical_metrics_monthly, qualifications, privileges, vc_observation_cases, vc_prescreen_hospitals, vc_prescreens`);

  // 3. physicians + engagements last
  await sql`DELETE FROM physician_engagements`;
  await sql`DELETE FROM physicians`;
  log.push(`3. Cleared physician_engagements + physicians`);

  // Final state
  const counts = (await sql`
    SELECT
      (SELECT COUNT(*)::int FROM hospitals)              AS hospitals,
      (SELECT COUNT(*)::int FROM positions)              AS positions,
      (SELECT COUNT(*)::int FROM profiles)               AS profiles,
      (SELECT COUNT(*)::int FROM profile_hospital_roles) AS profile_hospital_roles,
      (SELECT COUNT(*)::int FROM physicians)             AS physicians,
      (SELECT COUNT(*)::int FROM physician_engagements)  AS engagements,
      (SELECT COUNT(*)::int FROM qualifications)         AS qualifications,
      (SELECT COUNT(*)::int FROM privileges)             AS privileges,
      (SELECT COUNT(*)::int FROM clinical_metrics_monthly) AS clinical_metrics,
      (SELECT COUNT(*)::int FROM incidents)              AS incidents,
      (SELECT COUNT(*)::int FROM incident_replies)       AS incident_replies,
      (SELECT COUNT(*)::int FROM incident_views)         AS incident_views,
      (SELECT COUNT(*)::int FROM vc_prescreens)          AS vc_prescreens,
      (SELECT COUNT(*)::int FROM vc_prescreen_hospitals) AS vc_prescreen_hospitals,
      (SELECT COUNT(*)::int FROM vc_observation_cases)   AS vc_observation_cases,
      (SELECT COUNT(*)::int FROM oppe_reviews)           AS oppe_reviews,
      (SELECT COUNT(*)::int FROM privilege_requests)     AS privilege_requests,
      (SELECT COUNT(*)::int FROM audit_log_v2)           AS audit_log_v2_total
  `) as Array<Record<string, number>>;

  const adminProfiles = (await sql`
    SELECT p.email, p.full_name, pos.position_name, p.is_super_admin
    FROM profiles p
    JOIN positions pos ON pos.id = p.position_id
    WHERE p.is_super_admin = true
    ORDER BY p.created_at
  `) as Array<Record<string, unknown>>;

  return NextResponse.json(
    { ok: true, log, counts: counts[0], super_admins: adminProfiles },
    { headers: NO_STORE },
  );
}
